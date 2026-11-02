// Tauri 命令层：影视 CRUD / 聚合查询（首页卡片+详情）/ 进度 / 统计 / 设置 / SMB 服务器管理。
// 裁剪自 D:\ZEX lib.rs 的 Series 段，去掉 mpv 联动与磁盘管理。

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::{
    self, EPISODE_COLS, SEASON_COLS, SERIES_COLS, SERIES_ORDER, Episode, Season, Series,
    row_to_episode, row_to_season, row_to_series,
};
use crate::smb;
use crate::{AppError, AppResult, AppState};

// ─────────────────────────────────────────────
// Series CRUD
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_all_series(state: State<'_, AppState>) -> AppResult<Vec<Series>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!("SELECT {} FROM series {}", SERIES_COLS, SERIES_ORDER))?;
    let rows = stmt.query_map([], row_to_series)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn create_series(state: State<'_, AppState>, mut series: Series) -> AppResult<Series> {
    if series.id.is_empty() {
        series.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        // sort_order 取当前最大值 +1：新加的排在自定义顺序末尾
        "INSERT INTO series (id, title, aliases, overview, poster_path, bg_path, first_air_date,
         status, tmdb_id, tvdb_id, tags, favorite, vote_average, genres, media_type, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM series))",
        params![
            series.id, series.title, series.aliases, series.overview, series.poster_path,
            series.bg_path, series.first_air_date, series.status, series.tmdb_id,
            series.tvdb_id, series.tags, series.favorite as i32, series.vote_average, series.genres,
            if series.media_type.is_empty() { "tv".to_string() } else { series.media_type.clone() }
        ],
    )?;
    // 读回复用同一把锁：放锁再重取会给并发 delete 留出空隙
    conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series.id],
        row_to_series,
    )
    .map_err(AppError::from)
}

#[tauri::command(async)]
pub fn update_series(state: State<'_, AppState>, series: Series) -> AppResult<Series> {
    let conn = state.db.lock();
    let affected = conn.execute(
        "UPDATE series SET title = ?, aliases = ?, overview = ?, poster_path = ?, bg_path = ?,
         first_air_date = ?, status = ?, tmdb_id = ?, tvdb_id = ?, tags = ?, favorite = ?,
         vote_average = ?, genres = ?,
         media_type = CASE WHEN ? <> '' THEN ? ELSE media_type END,
         sort_order = CASE WHEN ? > 0 THEN ? ELSE sort_order END,
         updated_at = datetime('now') WHERE id = ?",
        params![
            series.title, series.aliases, series.overview, series.poster_path, series.bg_path,
            series.first_air_date, series.status, series.tmdb_id, series.tvdb_id,
            series.tags, series.favorite as i32, series.vote_average, series.genres,
            series.media_type, series.media_type,
            series.sort_order, series.sort_order, series.id
        ],
    )?;
    if affected == 0 {
        return Err(AppError::Custom("该影视已被删除".into()));
    }
    conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series.id],
        row_to_series,
    )
    .map_err(AppError::from)
}

#[tauri::command(async)]
pub fn reorder_series(state: State<'_, AppState>, ordered_ids: Vec<String>) -> AppResult<()> {
    let mut conn = state.db.lock();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE series SET sort_order = ?1 WHERE id = ?2")?;
        for (i, id) in ordered_ids.iter().enumerate() {
            stmt.execute(params![i as i64 + 1, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_series_favorite(state: State<'_, AppState>, series_id: String, favorite: bool) -> AppResult<()> {
    let conn = state.db.lock();
    let changed = conn.execute(
        "UPDATE series SET favorite = ?1 WHERE id = ?2",
        params![favorite as i32, series_id],
    )?;
    if changed == 0 {
        return Err(AppError::Custom("影视不存在".to_string()));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn delete_series(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM series WHERE id = ?", [&id])?;
    Ok(())
}

/// 清除所有影视数据：series/seasons/episodes 全表 + 磁盘上的封面图。
/// 刻意**不动** settings（TMDB Key/代理/语言）和 smb_servers（NAS 配置）——
/// 这个功能是给「刮削错了、想从头加一遍」用的，重填 32 位 Key 和 NAS 密码
/// 在遥控器上是场灾难。
/// 返回删掉的剧数，前端拿它提示结果。
#[tauri::command(async)]
pub fn clear_all_media(state: State<'_, AppState>) -> AppResult<i64> {
    let removed = {
        let mut conn = state.db.lock();
        let tx = conn.transaction()?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM series", [], |r| r.get(0))?;
        // 顺序无所谓（外键是 ON DELETE CASCADE），但显式删干净不依赖级联配置
        tx.execute("DELETE FROM episodes", [])?;
        tx.execute("DELETE FROM seasons", [])?;
        tx.execute("DELETE FROM series", [])?;
        tx.commit()?;
        count
    };

    // 封面图：delete_series 只删库行、图片会一直堆在磁盘上，这里一并清掉。
    // 失败不算清除失败——数据库已经空了，残留图片没有引用者，不影响使用
    let covers = state.data_dir.join("covers");
    if covers.is_dir() {
        if let Err(e) = std::fs::remove_dir_all(&covers) {
            log::warn!("清除封面目录失败（不影响数据清除）：{e}");
        }
    }
    let _ = std::fs::create_dir_all(&covers);

    log::info!("已清除全部影视数据，共 {removed} 部（设置与 NAS 配置保留）");
    Ok(removed)
}

// ─────────────────────────────────────────────
// Seasons / Episodes CRUD
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_seasons(state: State<'_, AppState>, series_id: String) -> AppResult<Vec<Season>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM seasons WHERE series_id = ? ORDER BY season_number",
        SEASON_COLS
    ))?;
    let rows = stmt.query_map([&series_id], row_to_season)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn create_season(state: State<'_, AppState>, mut season: Season) -> AppResult<Season> {
    if season.id.is_empty() {
        season.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO seasons (id, series_id, season_number, name, overview, poster_path, first_air_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            season.id, season.series_id, season.season_number, season.name,
            season.overview, season.poster_path, season.first_air_date
        ],
    )?;
    Ok(season)
}

#[tauri::command(async)]
pub fn delete_season(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM seasons WHERE id = ?", [&id])?;
    Ok(())
}

#[tauri::command(async)]
pub fn get_episodes(state: State<'_, AppState>, season_id: String) -> AppResult<Vec<Episode>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM episodes WHERE season_id = ? ORDER BY episode_number",
        EPISODE_COLS
    ))?;
    let rows = stmt.query_map([&season_id], row_to_episode)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn create_episode(state: State<'_, AppState>, mut episode: Episode) -> AppResult<Episode> {
    if episode.id.is_empty() {
        episode.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    conn.execute(
        "INSERT INTO episodes (id, series_id, season_id, episode_number, title, overview,
         still_path, air_date, runtime_minutes, local_path, watched_ms, last_watched_at, watched,
         vote_average)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            episode.id, episode.series_id, episode.season_id, episode.episode_number,
            episode.title, episode.overview, episode.still_path, episode.air_date,
            episode.runtime_minutes, episode.local_path, episode.watched_ms,
            episode.last_watched_at, episode.watched as i32, episode.vote_average
        ],
    )?;
    Ok(episode)
}

#[tauri::command(async)]
pub fn update_episode(state: State<'_, AppState>, episode: Episode) -> AppResult<Episode> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET episode_number = ?, title = ?, overview = ?, still_path = ?,
         air_date = ?, runtime_minutes = ?, local_path = ?, watched_ms = ?,
         last_watched_at = ?, watched = ?, vote_average = ? WHERE id = ?",
        params![
            episode.episode_number, episode.title, episode.overview, episode.still_path,
            episode.air_date, episode.runtime_minutes, episode.local_path, episode.watched_ms,
            episode.last_watched_at, episode.watched as i32, episode.vote_average, episode.id
        ],
    )?;
    Ok(episode)
}

#[tauri::command(async)]
pub fn delete_episode(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM episodes WHERE id = ?", [&id])?;
    Ok(())
}

// ─────────────────────────────────────────────
// 进度命令
// ─────────────────────────────────────────────

// 收尾动作（标记看完/整季/批量）：立刻跟肃正核心对一次账（见 sync.rs，内部合并去重）
fn push_sync(state: &State<'_, AppState>) {
    crate::sync::sync(state.app.clone());
}

#[tauri::command(async)]
pub fn update_watch_progress(state: State<'_, AppState>, episode_id: String, watched_ms: i64) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET watched_ms = ?, last_watched_at = datetime('now') WHERE id = ?",
        params![watched_ms, episode_id],
    )?;
    // 高频续播点不即时同步：回前台的对账会把它带上去，避免每秒往 NAS 写文件
    Ok(())
}

#[tauri::command(async)]
pub fn mark_episode_watched(state: State<'_, AppState>, episode_id: String, watched: bool) -> AppResult<()> {
    {
        let conn = state.db.lock();
        conn.execute(
            // 标记已看时清续播点；取消已看也清零（未看从 0 开始）
            "UPDATE episodes SET watched = ?1, watched_ms = 0, last_watched_at = CASE WHEN ?1 = 1
                THEN datetime('now') ELSE last_watched_at END WHERE id = ?2",
            params![watched as i32, episode_id],
        )?;
    }
    push_sync(&state);
    Ok(())
}

#[tauri::command(async)]
pub fn mark_season_watched(state: State<'_, AppState>, season_id: String, watched: bool) -> AppResult<()> {
    {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE episodes SET watched = ?1, watched_ms = 0, last_watched_at = CASE WHEN ?1 = 1
                THEN datetime('now') ELSE last_watched_at END WHERE season_id = ?2",
            params![watched as i32, season_id],
        )?;
    }
    push_sync(&state);
    Ok(())
}

/// 批量标记（详情页「标记此集及之前为已看」/ 整季）：单事务，要么全改要么全不改
#[tauri::command(async)]
pub fn mark_episodes_watched(state: State<'_, AppState>, episode_ids: Vec<String>, watched: bool) -> AppResult<()> {
    {
        let mut conn = state.db.lock();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE episodes SET watched = ?1, watched_ms = 0, last_watched_at = CASE WHEN ?1 = 1
                    THEN datetime('now') ELSE last_watched_at END WHERE id = ?2",
            )?;
            for id in &episode_ids {
                stmt.execute(params![watched as i32, id])?;
            }
        }
        tx.commit()?;
    }
    push_sync(&state);
    Ok(())
}

#[tauri::command(async)]
pub fn touch_episode_played(state: State<'_, AppState>, episode_id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE episodes SET last_watched_at = datetime('now') WHERE id = ?1",
        params![episode_id],
    )?;
    Ok(())
}

/// 手动触发一次肃正对账：设置里保存核心位置后立即同步一次（创建/更新核心文件，
/// 让对端马上能看到），不必等回前台。后台跑，立即返回。
#[tauri::command(async)]
pub fn trigger_sync(state: State<'_, AppState>) -> AppResult<()> {
    crate::sync::sync(state.app.clone());
    Ok(())
}

/// 关闭同步：删掉 NAS 上的核心文件（关了就清干净）。后台跑，立即返回。
#[tauri::command(async)]
pub fn sync_purge(state: State<'_, AppState>) -> AppResult<()> {
    crate::sync::purge(state.app.clone());
    Ok(())
}

// ─────────────────────────────────────────────
// 聚合查询（首页卡片 / Hero / 详情页）
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct NextEpisode {
    pub id: String,
    pub season_id: String,
    pub season_number: i32,
    pub episode_number: i32,
    pub title: String,
    pub still_path: String,
    pub local_path: String,
    pub runtime_minutes: i32,
    pub watched_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct SeriesCard {
    #[serde(flatten)]
    pub series: Series,
    pub season_count: i64,
    pub episode_count: i64,
    pub watched_count: i64,
    pub local_count: i64,
    pub last_watched_at: String,
    pub next_episode: Option<NextEpisode>,
}

#[derive(Debug, Serialize)]
pub struct SeasonWithEpisodes {
    #[serde(flatten)]
    pub season: Season,
    pub episodes: Vec<Episode>,
}

#[derive(Debug, Serialize)]
pub struct SeriesDetailData {
    #[serde(flatten)]
    pub series: Series,
    pub seasons: Vec<SeasonWithEpisodes>,
    pub next_episode: Option<NextEpisode>,
    pub episode_count: i64,
    pub watched_count: i64,
}

// 每部剧的第一条未看集：窗口函数在库内分组取第一条，只返回每剧 1 行
fn query_next_episodes(conn: &Connection) -> AppResult<HashMap<String, NextEpisode>> {
    let mut stmt = conn.prepare(
        "SELECT series_id, id, season_id, season_number, episode_number, title,
                still_path, local_path, runtime_minutes, watched_ms
         FROM (
             SELECT e.series_id, e.id, e.season_id, s.season_number, e.episode_number, e.title,
                    e.still_path, e.local_path, e.runtime_minutes, e.watched_ms,
                    ROW_NUMBER() OVER (
                        PARTITION BY e.series_id
                        ORDER BY s.season_number, e.episode_number
                    ) AS rn
             FROM episodes e JOIN seasons s ON s.id = e.season_id
             WHERE e.watched = 0
         )
         WHERE rn = 1",
    )?;
    let mut out: HashMap<String, NextEpisode> = HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            NextEpisode {
                id: row.get(1)?,
                season_id: row.get(2)?,
                season_number: row.get(3)?,
                episode_number: row.get(4)?,
                title: row.get(5)?,
                still_path: row.get(6)?,
                local_path: row.get(7)?,
                runtime_minutes: row.get(8)?,
                watched_ms: row.get(9)?,
            },
        ))
    })?;
    for row in rows {
        let (series_id, ep) = row?;
        out.insert(series_id, ep);
    }
    Ok(out)
}

#[tauri::command(async)]
pub fn get_series_library(state: State<'_, AppState>) -> AppResult<Vec<SeriesCard>> {
    let conn = state.db.lock();

    let all: Vec<Series> = {
        let mut stmt = conn.prepare(&format!("SELECT {} FROM series {}", SERIES_COLS, SERIES_ORDER))?;
        let rows = stmt.query_map([], row_to_series)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let mut season_counts: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT series_id, COUNT(*) FROM seasons GROUP BY series_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (k, v) = row?;
            season_counts.insert(k, v);
        }
    }

    // (总集数, 已看数, 有文件数, 最近观看时间)
    let mut ep_stats: HashMap<String, (i64, i64, i64, String)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT series_id, COUNT(*), COALESCE(SUM(watched), 0),
                    COALESCE(SUM(CASE WHEN local_path <> '' THEN 1 ELSE 0 END), 0),
                    COALESCE(MAX(last_watched_at), '')
             FROM episodes GROUP BY series_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?),
            ))
        })?;
        for row in rows {
            let (k, v) = row?;
            ep_stats.insert(k, v);
        }
    }

    let mut next_map = query_next_episodes(&conn)?;

    Ok(all
        .into_iter()
        .map(|series| {
            let stats = ep_stats.get(&series.id).cloned().unwrap_or((0, 0, 0, String::new()));
            SeriesCard {
                season_count: *season_counts.get(&series.id).unwrap_or(&0),
                episode_count: stats.0,
                watched_count: stats.1,
                local_count: stats.2,
                last_watched_at: stats.3,
                next_episode: next_map.remove(&series.id),
                series,
            }
        })
        .collect())
}

#[tauri::command(async)]
pub fn get_series_detail(state: State<'_, AppState>, series_id: String) -> AppResult<SeriesDetailData> {
    let conn = state.db.lock();

    let series = conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series_id],
        row_to_series,
    )?;

    let seasons: Vec<Season> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM seasons WHERE series_id = ? ORDER BY season_number",
            SEASON_COLS
        ))?;
        let rows = stmt.query_map([&series_id], row_to_season)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let episodes: Vec<Episode> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM episodes WHERE series_id = ? ORDER BY episode_number",
            EPISODE_COLS
        ))?;
        let rows = stmt.query_map([&series_id], row_to_episode)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let episode_count = episodes.len() as i64;
    let watched_count = episodes.iter().filter(|e| e.watched).count() as i64;

    // 一次遍历按季分桶（SQL 已按集号排序，桶内天然有序）
    let mut by_season: HashMap<String, Vec<Episode>> = HashMap::with_capacity(seasons.len());
    for ep in episodes {
        by_season.entry(ep.season_id.clone()).or_default().push(ep);
    }

    let mut next_episode: Option<NextEpisode> = None;
    let mut out = Vec::with_capacity(seasons.len());
    for season in seasons {
        let mine = by_season.remove(&season.id).unwrap_or_default();
        if next_episode.is_none() {
            if let Some(e) = mine.iter().find(|e| !e.watched) {
                next_episode = Some(NextEpisode {
                    id: e.id.clone(),
                    season_id: e.season_id.clone(),
                    season_number: season.season_number,
                    episode_number: e.episode_number,
                    title: e.title.clone(),
                    still_path: e.still_path.clone(),
                    local_path: e.local_path.clone(),
                    runtime_minutes: e.runtime_minutes,
                    watched_ms: e.watched_ms,
                });
            }
        }
        out.push(SeasonWithEpisodes { season, episodes: mine });
    }

    Ok(SeriesDetailData {
        series,
        seasons: out,
        next_episode,
        episode_count,
        watched_count,
    })
}

// ─────────────────────────────────────────────
// 统计（电视版只有影视）
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct TopEntry {
    pub id: String,
    pub name: String,
    pub sub: String,
    pub cover_path: String,
    pub wide_path: String,
    pub seconds: i64,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MediaStats {
    pub total_seconds: i64,
    pub play_count: i64,
    pub library_count: i64,
    pub played_count: i64,
    pub top: Vec<TopEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Stats {
    pub video: MediaStats,
    pub total_episodes: i64,
    pub total_watched_episodes: i64,
}

#[tauri::command(async)]
pub fn get_stats(state: State<'_, AppState>) -> AppResult<Stats> {
    let conn = state.db.lock();
    let scalar = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };

    const WALL_LIMIT: i64 = 60;

    // 时长口径：剧集按集计——已看的按完整时长（runtime×60），没看完的按实际进度；
    // 电影不建 episodes，回退 series.total_seconds。
    //
    // v1 版本把上面这个 CASE WHEN 相关子查询同时塞进 SELECT/WHERE/ORDER BY，
    // 每行 3 次全 episodes 扫描——上万象时统计页要秒级，电视上像死机。
    // 改成一次 GROUP BY 聚合出每剧时长，Rust 侧 join 回 series 列表
    let movie_secs: HashMap<String, i64> = {
        let mut stmt = conn.prepare(
            "SELECT id, total_seconds FROM series WHERE media_type = 'movie' AND total_seconds > 0",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.filter_map(Result::ok).collect()
    };
    // (series_id → 按集累计的秒数)：已看按 runtime 全长、没看完按实际进度
    let tv_secs: HashMap<String, i64> = {
        let mut stmt = conn.prepare(
            "SELECT e.series_id, COALESCE(SUM(
                CASE WHEN e.watched = 1 THEN e.runtime_minutes * 60
                     ELSE e.watched_ms / 1000 END
             ), 0)
             FROM episodes e JOIN series s ON s.id = e.series_id
             WHERE s.media_type <> 'movie'
             GROUP BY e.series_id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.filter_map(Result::ok).collect()
    };
    let dur_of = |id: &str, media_type: &str| -> i64 {
        if media_type == "movie" {
            *movie_secs.get(id).unwrap_or(&0)
        } else {
            *tv_secs.get(id).unwrap_or(&0)
        }
    };

    let all_series: Vec<(String, String, String, String, String)> = {
        // (id, title, poster, bg, media_type) —— sub 文案下面拼
        let mut stmt = conn.prepare(
            "SELECT id, title, poster_path, bg_path, media_type FROM series ORDER BY title",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "tv".to_string()),
            ))
        })?;
        rows.filter_map(Result::ok).collect()
    };

    // 已看 x/y 集 文案（每个 series 一次子查询，但只跑一遍而非 3 遍）
    let ep_counts: HashMap<String, (i64, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT series_id, COUNT(*), COALESCE(SUM(watched), 0)
             FROM episodes GROUP BY series_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        })?;
        rows.filter_map(Result::ok).collect()
    };

    let mut top: Vec<TopEntry> = all_series
        .iter()
        .map(|(id, title, poster, bg, media_type)| {
            let (total_eps, watched_eps) = ep_counts.get(id).cloned().unwrap_or((0, 0));
            TopEntry {
                id: id.clone(),
                name: title.clone(),
                sub: format!("已看 {watched_eps}/{total_eps} 集"),
                cover_path: poster.clone(),
                wide_path: bg.clone(),
                seconds: dur_of(id, media_type),
                count: 0,
            }
        })
        .filter(|e| e.seconds > 0)
        .collect();
    top.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    top.truncate(WALL_LIMIT as usize);

    let total_seconds: i64 = top_matches_total(&movie_secs, &tv_secs, &all_series);

    Ok(Stats {
        video: MediaStats {
            total_seconds,
            play_count: 0,
            library_count: scalar("SELECT COUNT(*) FROM series"),
            played_count: all_series
                .iter()
                .filter(|(id, _, _, _, media_type)| dur_of(id, media_type) > 0)
                .count() as i64,
            top,
        },
        total_episodes: scalar("SELECT COUNT(*) FROM episodes"),
        total_watched_episodes: scalar("SELECT COUNT(*) FROM episodes WHERE watched = 1"),
    })
}

/// total_seconds = 所有有观看时长的剧的时长之和（含被 WALL_LIMIT 截掉的尾部）
fn top_matches_total(
    movie_secs: &HashMap<String, i64>,
    tv_secs: &HashMap<String, i64>,
    all_series: &[(String, String, String, String, String)],
) -> i64 {
    all_series
        .iter()
        .map(|(id, _, _, _, media_type)| {
            if media_type == "movie" {
                *movie_secs.get(id).unwrap_or(&0)
            } else {
                *tv_secs.get(id).unwrap_or(&0)
            }
        })
        .sum()
}

// ─────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let conn = state.db.lock();
    let result = conn.query_row(
        "SELECT value FROM settings WHERE key = ?",
        [&key],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

#[tauri::command(async)]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let conn = state.db.lock();
    db::setting_set(&conn, &key, &value)?;
    Ok(())
}

// ─────────────────────────────────────────────
// SMB 服务器管理（M2：增删改查；连接测试在 smb.rs）
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_smb_servers(state: State<'_, AppState>) -> AppResult<Vec<db::SmbServer>> {
    let conn = state.db.lock();
    let mut stmt = conn.prepare("SELECT id, name, host, port, username, password, created_at FROM smb_servers ORDER BY created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(db::SmbServer {
            id: r.get(0)?,
            name: r.get(1)?,
            host: r.get(2)?,
            port: r.get::<_, Option<i32>>(3)?.unwrap_or(445),
            username: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            password: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            created_at: r.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command(async)]
pub fn save_smb_server(state: State<'_, AppState>, server: db::SmbServer) -> AppResult<db::SmbServer> {
    let mut server = server;
    if server.id.is_empty() {
        server.id = Uuid::new_v4().to_string();
    }
    if server.port <= 0 {
        server.port = 445;
    }
    let conn = state.db.lock();
    // 密码传空 = 沿用旧密码（前端编辑时不回传密码）
    let old_password: Option<String> = conn
        .query_row(
            "SELECT password FROM smb_servers WHERE id = ?1",
            [&server.id],
            |r| r.get(0),
        )
        .optional()?;
    let password = if server.password.is_empty() { old_password.unwrap_or_default() } else { server.password };
    conn.execute(
        "INSERT INTO smb_servers (id, name, host, port, username, password, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, host = excluded.host, port = excluded.port,
            username = excluded.username, password = excluded.password",
        params![server.id, server.name, server.host, server.port, server.username, password],
    )?;
    Ok(db::SmbServer { password: String::new(), ..server })
}

#[tauri::command(async)]
pub fn delete_smb_server(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM smb_servers WHERE id = ?", [&id])?;
    Ok(())
}

// ─────────────────────────────────────────────
// App
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ─────────────────────────────────────────────
// SMB 浏览（M2）
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub async fn list_smb_shares(state: State<'_, AppState>, server_id: String) -> AppResult<Vec<smb::SmbShareInfoDto>> {
    // 短锁读 server 配置（不跨 await）
    let server = {
        let conn = state.db.lock();
        smb::read_server(&conn, &server_id)?
    };
    smb::list_shares(server).await
}

#[tauri::command(async)]
pub async fn list_smb_dir(
    state: State<'_, AppState>,
    server_id: String,
    share: String,
    path: String,
) -> AppResult<Vec<smb::SmbDirEntryDto>> {
    let server = {
        let conn = state.db.lock();
        smb::read_server(&conn, &server_id)?
    };
    smb::list_directory(server, &share, &path).await
}

// ─────────────────────────────────────────────
// 全自动添加（M2）：扫描 SMB 文件夹 → 解析季集 → 建剧/季/集
// TMDB 刮削由前端拿到 created series 后再调 auto_fetch_series_metadata 触发
// ─────────────────────────────────────────────

// rename_all 不能省：Tauri 只把「命令函数的参数名」做 camelCase→snake_case，
// 嵌套结构体的字段是 serde 原样反序列化的。前端传的是 { serverId, mediaType }，
// 少了这行就报 missing field `server_id`
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSeriesBySmbArgs {
    pub server_id: String,
    pub share: String,
    pub path: String,       // 剧根目录相对路径（空 = 共享根）
    pub title: String,      // 用户输入的剧名（空 = 用 path 的末段目录名，清洗后）
    pub media_type: String, // tv / movie / auto（auto = 按扫描到的视频文件数判定）
}

#[tauri::command(async)]
pub async fn add_series_by_smb(
    state: State<'_, AppState>,
    args: AddSeriesBySmbArgs,
) -> AppResult<Series> {
    // 标题：用户输入优先；否则用 path 末段目录名，清洗掉年份/分辨率/字幕组等噪声
    let title = if !args.title.trim().is_empty() {
        args.title.trim().to_string()
    } else {
        let folder = args
            .path
            .split('\\')
            .filter(|s| !s.is_empty())
            .next_back()
            .unwrap_or("未命名");
        let cleaned = smb::clean_folder_title(folder);
        if cleaned.is_empty() { folder.to_string() } else { cleaned }
    };

    // 扫描视频文件（解析季集）：先短锁读 server 配置，释放锁后再 async 扫描
    let server = {
        let conn = state.db.lock();
        smb::read_server(&conn, &args.server_id)?
    };
    let scanned = smb::scan_video_files(server, &args.share, &args.path).await?;

    if scanned.is_empty() {
        return Err(AppError::Custom("该文件夹没有发现视频文件".into()));
    }

    // 类型判定：auto = 单个视频文件当电影，多个当剧集（电视版「点文件夹直接添加」
    // 不问类型，判断放这里——扫完才知道文件数）
    let media_type = match args.media_type.as_str() {
        "movie" => "movie",
        "tv" => "tv",
        _ => if scanned.len() == 1 { "movie" } else { "tv" },
    };

    // 建剧
    let series_id = Uuid::new_v4().to_string();
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT INTO series (id, title, media_type, sort_order)
             VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM series))",
            params![series_id, title, media_type],
        )?;
    }

    // 建季/集（一个事务：大剧集上百次 INSERT，逐条自动提交既慢又会在中途失败时留半成品）
    {
        let mut conn = state.db.lock();
        let tx = conn.transaction()?;
        if media_type == "movie" {
            // 电影：单季单集，用第一个视频文件。季名留空 → 详情页走 i18n 回落
            let season_id = Uuid::new_v4().to_string();
            let ep_id = Uuid::new_v4().to_string();
            let first = &scanned[0];
            tx.execute(
                "INSERT INTO seasons (id, series_id, season_number) VALUES (?, ?, 1)",
                params![season_id, series_id],
            )?;
            tx.execute(
                "INSERT INTO episodes (id, series_id, season_id, episode_number, title, local_path)
                 VALUES (?, ?, ?, 1, ?, ?)",
                params![ep_id, series_id, season_id, smb::strip_ext(&first.file_name), smb::build_local_path(&args.server_id, &args.share, &first.rel_path)],
            )?;
        } else {
            // 剧集：按 season 分组建季，集按 episode_number 入库
            let mut seasons_map: std::collections::BTreeMap<i32, Vec<&smb::ScannedVideo>> = std::collections::BTreeMap::new();
            for v in &scanned {
                seasons_map.entry(v.season).or_default().push(v);
            }
            for (season_num, eps) in seasons_map {
                let season_id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO seasons (id, series_id, season_number) VALUES (?, ?, ?)",
                    params![season_id, series_id, season_num],
                )?;
                for ep in eps {
                    let ep_id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO episodes (id, series_id, season_id, episode_number, title, local_path)
                         VALUES (?, ?, ?, ?, ?, ?)",
                        params![ep_id, series_id, season_id, ep.episode, smb::strip_ext(&ep.file_name), smb::build_local_path(&args.server_id, &args.share, &ep.rel_path)],
                    )?;
                }
            }
        }
        tx.commit()?;
    }

    // 读回完整 Series 返回（前端据此触发 TMDB 刮削）
    let conn = state.db.lock();
    conn.query_row(
        &format!("SELECT {} FROM series WHERE id = ?", SERIES_COLS),
        [&series_id],
        row_to_series,
    )
    .map_err(AppError::from)
}

// ─────────────────────────────────────────────
// 播放（M3 占位：拉起系统播放器播本地 HTTP 流）
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub async fn play_episode(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    episode_id: String,
) -> AppResult<()> {
    crate::stream_server::play_episode(&state, &app, &episode_id).await
}

/// App 回前台时前端查询：当前有没有待回执的播放会话（看完了吗弹窗用）。
/// 有 → 返回 episode id 并清空（一次回执）；无 → None
#[tauri::command(async)]
pub fn take_current_episode() -> Option<String> {
    crate::stream_server::take_current_episode()
}

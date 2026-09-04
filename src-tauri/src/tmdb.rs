// TMDB 刮削：搜索候选 / 剧集详情 / 电影详情 / 季集 / 图片下载 / 全自动获取。
// 移植自 D:\ZEX lib.rs 的 TMDB 段，改写为独立模块 + HTTP 代理支持。
//
// 关键策略（与桌面版一致）：
// - FetchGuard 防重入（metadata_fetching AtomicBool，RAII 释放）
// - 中英合并：zh-CN 优先，overview 空时拉 en-US 补
// - CASE WHEN 只补空：TMDB 有值才覆盖本地，空值不清空已填数据
// - 并发下载 Semaphore(8)，进度事件 series-cover-progress
// - 图片落 data_dir/covers/，文件名 series_{id}.jpg / series_bg_{id}.jpg /
//   season_{id}.jpg / episode_{id}.jpg（与桌面版一致，covers 协议按文件名直读）

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Semaphore;

use crate::db::setting_get;
use crate::{AppError, AppResult, AppState};

const TMDB_BASE: &str = "https://api.tmdb.org/3";
const TMDB_IMG_BASE: &str = "https://image.tmdb.org/t/p";

// ─────────────────────────────────────────────
// 结构体
// ─────────────────────────────────────────────

#[derive(Deserialize)]
struct TmdbSearchResponse {
    #[serde(default)]
    results: Vec<TmdbSearchItem>,
}

#[derive(Deserialize)]
struct TmdbSearchItem {
    id: i64,
    #[allow(dead_code)]
    #[serde(default)]
    name: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    poster_path: Option<String>,
}

#[derive(Deserialize)]
struct TmdbSeasonResponse {
    #[allow(dead_code)]
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    air_date: Option<String>,
    #[serde(default)]
    episodes: Vec<TmdbEpisodeItem>,
}

#[derive(Deserialize)]
struct TmdbEpisodeItem {
    episode_number: i32,
    #[serde(default)]
    still_path: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    air_date: Option<String>,
    #[serde(default)]
    runtime: Option<i32>,
    #[serde(default)]
    vote_average: Option<f64>,
}

#[derive(Deserialize, Default)]
struct TmdbTvDetail {
    #[serde(default)] name: Option<String>,
    #[serde(default)] original_name: Option<String>,
    #[serde(default)] overview: Option<String>,
    #[serde(default)] poster_path: Option<String>,
    #[serde(default)] backdrop_path: Option<String>,
    #[serde(default)] first_air_date: Option<String>,
    #[serde(default)] status: Option<String>,
    #[serde(default)] vote_average: Option<f64>,
    #[serde(default)] genres: Vec<TmdbGenre>,
}

#[derive(Deserialize, Default)]
struct TmdbMovieDetail {
    #[serde(default)] title: Option<String>,
    #[serde(default)] original_title: Option<String>,
    #[serde(default)] overview: Option<String>,
    #[serde(default)] poster_path: Option<String>,
    #[serde(default)] backdrop_path: Option<String>,
    #[serde(default)] release_date: Option<String>,
    #[serde(default)] runtime: Option<i32>,
    #[serde(default)] status: Option<String>,
    #[serde(default)] vote_average: Option<f64>,
    #[serde(default)] genres: Vec<TmdbGenre>,
}

#[derive(Deserialize)]
struct TmdbGenre {
    name: String,
}

// search 命令返回的候选（前端 TmdbPickerModal 用）
#[derive(Debug, Serialize)]
pub struct TmdbSearchResult {
    pub id: i64,
    pub name: String,
    pub original_name: String,
    pub overview: String,
    pub date: String,
    pub poster_url: String,
    pub vote_average: f64,
}

// tv/movie 搜索结果统一形状（alias 把 movie 的 title/release_date 映射成 tv 的）
#[derive(Deserialize)]
struct TmdbMultiItem {
    id: i64,
    #[serde(default, alias = "title")]
    name: Option<String>,
    #[serde(default, alias = "original_title")]
    original_name: Option<String>,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default, alias = "release_date")]
    first_air_date: Option<String>,
    #[serde(default)]
    vote_average: Option<f64>,
}

#[derive(Deserialize)]
struct TmdbMultiResponse {
    #[serde(default)]
    results: Vec<TmdbMultiItem>,
}

#[derive(Clone, Serialize)]
struct SeriesCoverProgress {
    done: usize,
    total: usize,
}

struct TmdbImageJob {
    url: String,
    target: PathBuf,
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

fn is_blank(v: &Option<String>) -> bool {
    v.as_deref().unwrap_or("").trim().is_empty()
}

fn map_tmdb_status(status: &str) -> String {
    match status {
        "Returning Series" => "连载中",
        "Ended" => "已完结",
        "Canceled" | "Cancelled" => "已取消",
        "In Production" => "制作中",
        "Planned" => "筹备中",
        "Pilot" => "试播",
        "Released" => "已上映",
        "Post Production" => "后期制作",
        "Rumored" => "待定",
        other => other,
    }
    .to_string()
}

fn clean_search_title(title: &str) -> String {
    let re = regex::Regex::new(
        r"(?i)(?:s\d{1,2}e?\d*|\d{1,2}[x×]\d{1,2}|第\s*\d+\s*季|(?:19|20)\d{2}|1080p|720p|2160p|4k|bluray|web-?dl|hdr|x26[45]|h\.?26[45])",
    )
    .unwrap();
    re.replace_all(title.trim(), " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// 构建 reqwest client，注入 http_proxy 设置（电视版新增）
fn build_http_client(state: &AppState) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(15));
    let proxy = {
        let conn = state.db.lock();
        setting_get(&conn, "http_proxy")
    };
    if let Some(p) = proxy.filter(|s| !s.trim().is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(p.trim()).map_err(|e| AppError::Custom(format!("代理配置无效：{e}")))?);
    }
    builder.build().map_err(AppError::from)
}

fn read_api_key(state: &AppState) -> AppResult<String> {
    let conn = state.db.lock();
    let key = setting_get(&conn, "tmdb_api_key").unwrap_or_default();
    if key.trim().is_empty() {
        return Err(AppError::Custom("未配置 TMDB API Key，请在设置页填写".into()));
    }
    Ok(key)
}

// ─────────────────────────────────────────────
// TMDB API 调用
// ─────────────────────────────────────────────

/// 搜剧集取第一条，zh-CN→en-US 回退。返回 (id, name)
async fn tmdb_search_tv(client: &reqwest::Client, key: &str, query: &str) -> AppResult<Option<TmdbSearchItem>> {
    for lang in ["zh-CN", "en-US"] {
        let url = format!(
            "{TMDB_BASE}/search/tv?query={}&api_key={key}&language={lang}",
            urlencoding::encode(query)
        );
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(parsed) = resp.json::<TmdbSearchResponse>().await {
                    if let Some(first) = parsed.results.into_iter().next() {
                        return Ok(Some(first));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

/// 搜电影取第一条
async fn tmdb_search_movie(client: &reqwest::Client, key: &str, query: &str) -> AppResult<Option<i64>> {
    for lang in ["zh-CN", "en-US"] {
        let url = format!(
            "{TMDB_BASE}/search/movie?query={}&api_key={key}&language={lang}",
            urlencoding::encode(query)
        );
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(parsed) = resp.json::<TmdbSearchResponse>().await {
                    if let Some(first) = parsed.results.into_iter().next() {
                        return Ok(Some(first.id));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

/// 剧集详情：中文优先，overview 空时拉英文补
async fn tmdb_tv_detail(client: &reqwest::Client, key: &str, tmdb_id: i64) -> AppResult<TmdbTvDetail> {
    let zh = fetch_tv_detail(client, key, tmdb_id, "zh-CN").await?;
    if is_blank(&zh.overview) {
        let en = fetch_tv_detail(client, key, tmdb_id, "en-US").await?;
        let mut merged = zh;
        if is_blank(&merged.overview) {
            merged.overview = en.overview;
        }
        if merged.backdrop_path.is_none() {
            merged.backdrop_path = en.backdrop_path;
        }
        if merged.poster_path.is_none() {
            merged.poster_path = en.poster_path;
        }
        return Ok(merged);
    }
    Ok(zh)
}

async fn fetch_tv_detail(client: &reqwest::Client, key: &str, tmdb_id: i64, lang: &str) -> AppResult<TmdbTvDetail> {
    let url = format!("{TMDB_BASE}/tv/{tmdb_id}?api_key={key}&language={lang}");
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Ok(TmdbTvDetail::default());
    }
    Ok(resp.json::<TmdbTvDetail>().await.unwrap_or_default())
}

/// 电影详情：中文优先，overview 空时拉英文补
async fn tmdb_movie_detail(client: &reqwest::Client, key: &str, tmdb_id: i64) -> AppResult<TmdbMovieDetail> {
    let zh = fetch_movie_detail(client, key, tmdb_id, "zh-CN").await?;
    if is_blank(&zh.overview) {
        let en = fetch_movie_detail(client, key, tmdb_id, "en-US").await?;
        let mut merged = zh;
        if is_blank(&merged.overview) {
            merged.overview = en.overview;
        }
        if merged.backdrop_path.is_none() {
            merged.backdrop_path = en.backdrop_path;
        }
        if merged.poster_path.is_none() {
            merged.poster_path = en.poster_path;
        }
        return Ok(merged);
    }
    Ok(zh)
}

async fn fetch_movie_detail(client: &reqwest::Client, key: &str, tmdb_id: i64, lang: &str) -> AppResult<TmdbMovieDetail> {
    let url = format!("{TMDB_BASE}/movie/{tmdb_id}?api_key={key}&language={lang}");
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Ok(TmdbMovieDetail::default());
    }
    Ok(resp.json::<TmdbMovieDetail>().await.unwrap_or_default())
}

/// 季详情（含全部集）：中文优先，overview/集名/剧照空时拉英文按集号补
async fn tmdb_season_episodes(
    client: &reqwest::Client,
    key: &str,
    tmdb_id: i64,
    season_number: i32,
) -> AppResult<Option<TmdbSeasonResponse>> {
    let zh = fetch_season(client, key, tmdb_id, season_number, "zh-CN").await?;
    let zh = match zh {
        Some(s) => s,
        None => return Ok(None), // TMDB 无此季，本地季多于 TMDB 时静默跳过
    };
    // 判定是否需要英文：季简介空 或 任一集简介空
    let need_en = is_blank(&zh.overview) || zh.episodes.iter().any(|e| is_blank(&e.overview));
    if !need_en {
        return Ok(Some(zh));
    }
    let en = fetch_season(client, key, tmdb_id, season_number, "en-US").await?;
    if let Some(en) = en {
        let mut merged = zh;
        if is_blank(&merged.overview) {
            merged.overview = en.overview;
        }
        let en_by_num: std::collections::HashMap<i32, &TmdbEpisodeItem> =
            en.episodes.iter().map(|e| (e.episode_number, e)).collect();
        for ep in &mut merged.episodes {
            if let Some(en_ep) = en_by_num.get(&ep.episode_number) {
                if is_blank(&ep.overview) {
                    ep.overview = en_ep.overview.clone();
                }
                if is_blank(&ep.name) {
                    ep.name = en_ep.name.clone();
                }
                if ep.still_path.is_none() {
                    ep.still_path = en_ep.still_path.clone();
                }
            }
        }
        return Ok(Some(merged));
    }
    Ok(Some(zh))
}

async fn fetch_season(
    client: &reqwest::Client,
    key: &str,
    tmdb_id: i64,
    season_number: i32,
    lang: &str,
) -> AppResult<Option<TmdbSeasonResponse>> {
    let url = format!("{TMDB_BASE}/tv/{tmdb_id}/season/{season_number}?api_key={key}&language={lang}");
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    Ok(resp.json::<TmdbSeasonResponse>().await.ok())
}

// ─────────────────────────────────────────────
// 图片下载
// ─────────────────────────────────────────────

/// 下载单张图。target 已存在则跳过（幂等）。失败返回 None（静默降级）
async fn fetch_tmdb_image(client: &reqwest::Client, url: &str, target: &Path) -> Option<()> {
    if target.exists() {
        return Some(());
    }
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if let Some(parent) = target.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(target, &bytes).ok()?;
    Some(())
}

/// 并发下载（Semaphore 8 限流）。返回与 jobs 顺序对齐的成功标志
async fn download_tmdb_images(
    client: &reqwest::Client,
    jobs: Vec<TmdbImageJob>,
    mut on_done: impl FnMut(usize),
) -> Vec<bool> {
    let sem = Arc::new(Semaphore::new(8));
    let mut handles = Vec::with_capacity(jobs.len());
    for job in &jobs {
        let sem = sem.clone();
        let client = client.clone();
        let url = job.url.clone();
        let target = job.target.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.ok()?;
            fetch_tmdb_image(&client, &url, &target).await
        }));
    }
    let mut results = Vec::with_capacity(handles.len());
    for (i, h) in handles.into_iter().enumerate() {
        let ok = h.await.ok().flatten().is_some();
        results.push(ok);
        on_done(i + 1);
    }
    results
}

// ─────────────────────────────────────────────
// 进度
// ─────────────────────────────────────────────

fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit("series-cover-progress", SeriesCoverProgress { done, total });
}

// ─────────────────────────────────────────────
// 命令：search_tmdb
// ─────────────────────────────────────────────

#[tauri::command(async)]
pub async fn search_tmdb(
    state: State<'_, AppState>,
    query: String,
    media_type: String,
) -> AppResult<Vec<TmdbSearchResult>> {
    let key = read_api_key(&state)?;
    let client = build_http_client(&state)?;
    let kind = if media_type == "movie" { "movie" } else { "tv" };

    // 候选 query：原标题 + 去脏标题（去 SxxExx/年份/压制标记）
    let mut candidates = vec![query.trim().to_string()];
    let cleaned = clean_search_title(&query);
    if !cleaned.is_empty() && cleaned != query.trim() {
        candidates.push(cleaned);
    }

    for q in &candidates {
        if q.is_empty() {
            continue;
        }
        for lang in ["zh-CN", "en-US"] {
            let url = format!(
                "{TMDB_BASE}/search/{kind}?query={}&api_key={key}&language={lang}",
                urlencoding::encode(q)
            );
            let resp = match client.get(&url).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            if !resp.status().is_success() {
                continue;
            }
            let parsed = match resp.json::<TmdbMultiResponse>().await {
                Ok(p) => p,
                Err(_) => continue,
            };
            if parsed.results.is_empty() {
                continue;
            }
            // 命中即返回前 12 条
            let out: Vec<TmdbSearchResult> = parsed
                .results
                .into_iter()
                .take(12)
                .map(|r| TmdbSearchResult {
                    id: r.id,
                    name: r.name.unwrap_or_default(),
                    original_name: r.original_name.unwrap_or_default(),
                    overview: r.overview.unwrap_or_default(),
                    date: r.first_air_date.unwrap_or_default(),
                    poster_url: r
                        .poster_path
                        .map(|p| format!("{TMDB_IMG_BASE}/w185{p}"))
                        .unwrap_or_default(),
                    vote_average: r.vote_average.unwrap_or(0.0),
                })
                .collect();
            return Ok(out);
        }
    }
    Ok(Vec::new())
}

// ─────────────────────────────────────────────
// 命令：auto_fetch_series_metadata
// ─────────────────────────────────────────────

/// RAII 防重入 guard
struct FetchGuard {
    flag: Arc<std::sync::atomic::AtomicBool>,
}
impl FetchGuard {
    fn try_acquire(state: &AppState) -> AppResult<Self> {
        if state.metadata_fetching.swap(true, Ordering::SeqCst) {
            return Err(AppError::Custom("正在获取其他影视的元数据，请稍候".into()));
        }
        Ok(FetchGuard { flag: state.metadata_fetching.clone() })
    }
}
impl Drop for FetchGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

#[tauri::command(async)]
pub async fn auto_fetch_series_metadata(
    app: AppHandle,
    state: State<'_, AppState>,
    series_id: String,
    tmdb_id: Option<i64>,
) -> AppResult<String> {
    let _guard = FetchGuard::try_acquire(&state)?;

    // 短锁读 media_type
    let media_type = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT COALESCE(NULLIF(media_type,''),'tv') FROM series WHERE id=?1",
            [&series_id],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "tv".to_string())
    };

    if media_type == "movie" {
        auto_fetch_movie_inner(&app, &state, &series_id, tmdb_id).await
    } else {
        auto_fetch_series_inner(&app, &state, &series_id, tmdb_id).await
    }
}

async fn auto_fetch_series_inner(
    app: &AppHandle,
    state: &AppState,
    series_id: &str,
    tmdb_id_override: Option<i64>,
) -> AppResult<String> {
    // ── 阶段一：短锁读库（title/tmdb_id/seasons/episodes） ──
    let (title, local_tmdb_id, seasons, episodes) = {
        let conn = state.db.lock();
        let title: String = conn
            .query_row("SELECT title FROM series WHERE id=?1", [series_id], |r| r.get(0))
            .unwrap_or_default();
        let local_tmdb_id: i64 = conn
            .query_row("SELECT tmdb_id FROM series WHERE id=?1", [series_id], |r| r.get(0))
            .unwrap_or(0);
        let seasons: Vec<(String, i32)> = {
            let mut stmt = conn.prepare("SELECT id, season_number FROM seasons WHERE series_id=?1 ORDER BY season_number")?;
            let rows = stmt.query_map([series_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?)))?;
            rows.filter_map(Result::ok).collect()
        };
        let episodes: Vec<(String, String, i32)> = {
            let mut stmt = conn.prepare("SELECT id, season_id, episode_number FROM episodes WHERE series_id=?1")?;
            let rows = stmt.query_map([series_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i32>(2)?)))?;
            rows.filter_map(Result::ok).collect()
        };
        (title, local_tmdb_id, seasons, episodes)
    };

    // ── 阶段二：读 key + 定 TMDB id ──
    let key = read_api_key(state)?;
    let client = build_http_client(state)?;
    let tmdb_id = if let Some(id) = tmdb_id_override.filter(|&i| i > 0) {
        id
    } else if local_tmdb_id > 0 {
        local_tmdb_id
    } else {
        let mut found = None;
        for q in [title.trim(), &clean_search_title(&title)] {
            if q.is_empty() {
                continue;
            }
            if let Some(item) = tmdb_search_tv(&client, &key, q).await? {
                found = Some(item.id);
                break;
            }
        }
        found.ok_or_else(|| AppError::Custom(format!("TMDB 上没有找到「{title}」，可以改名后重试")))?
    };

    // ── 阶段三：剧集详情 + 季详情串行 + 构建图片任务 ──
    let detail = tmdb_tv_detail(&client, &key, tmdb_id).await?;
    let genres = detail.genres.iter().map(|g| g.name.clone()).collect::<Vec<_>>().join(" / ");
    let covers_dir = state.data_dir.join("covers");
    let _ = std::fs::create_dir_all(&covers_dir);

    let total = 2 + seasons.len() * 2 + episodes.len() * 2;
    emit_progress(app, 0, total);

    let mut jobs: Vec<TmdbImageJob> = Vec::new();
    // 系列海报 + 背景
    if let Some(p) = &detail.poster_path {
        jobs.push(TmdbImageJob {
            url: format!("{TMDB_IMG_BASE}/w500{p}"),
            target: covers_dir.join(format!("series_{series_id}.jpg")),
        });
    }
    if let Some(b) = &detail.backdrop_path {
        jobs.push(TmdbImageJob {
            url: format!("{TMDB_IMG_BASE}/w1280{b}"),
            target: covers_dir.join(format!("series_bg_{series_id}.jpg")),
        });
    }

    // 季元数据 + 集匹配
    struct SeasonMeta {
        id: String,
        name: String,
        overview: String,
        air_date: String,
    }
    struct EpisodeMeta {
        id: String,
        title: String,
        overview: String,
        air_date: String,
        runtime: i32,
        vote: f64,
    }
    let mut season_metas: Vec<SeasonMeta> = Vec::new();
    let mut episode_metas: Vec<EpisodeMeta> = Vec::new();

    let mut done = 2usize;
    for (season_id, season_number) in &seasons {
        let season_data = tmdb_season_episodes(&client, &key, tmdb_id, *season_number).await?;
        match season_data {
            None => {
                done += 2;
                emit_progress(app, done, total);
            }
            Some(s) => {
                season_metas.push(SeasonMeta {
                    id: season_id.clone(),
                    name: s.name.unwrap_or_default(),
                    overview: s.overview.unwrap_or_default(),
                    air_date: s.air_date.unwrap_or_default(),
                });
                if let Some(p) = &s.poster_path {
                    jobs.push(TmdbImageJob {
                        url: format!("{TMDB_IMG_BASE}/w500{p}"),
                        target: covers_dir.join(format!("season_{season_id}.jpg")),
                    });
                }
                // 该季本地集按 episode_number 匹配 TMDB 集
                let ep_by_num: std::collections::HashMap<i32, &TmdbEpisodeItem> =
                    s.episodes.iter().map(|e| (e.episode_number, e)).collect();
                for (ep_id, ep_season_id, ep_num) in &episodes {
                    if ep_season_id != season_id {
                        continue;
                    }
                    if let Some(tmdb_ep) = ep_by_num.get(ep_num) {
                        episode_metas.push(EpisodeMeta {
                            id: ep_id.clone(),
                            title: tmdb_ep.name.clone().unwrap_or_default(),
                            overview: tmdb_ep.overview.clone().unwrap_or_default(),
                            air_date: tmdb_ep.air_date.clone().unwrap_or_default(),
                            runtime: tmdb_ep.runtime.unwrap_or(0),
                            vote: tmdb_ep.vote_average.unwrap_or(0.0),
                        });
                        if let Some(still) = &tmdb_ep.still_path {
                            jobs.push(TmdbImageJob {
                                url: format!("{TMDB_IMG_BASE}/w342{still}"),
                                target: covers_dir.join(format!("episode_{ep_id}.jpg")),
                            });
                        }
                    }
                }
                done += 2;
                emit_progress(app, done, total);
            }
        }
    }

    // ── 阶段四：并发下载 ──
    let app_clone = app.clone();
    let _results = download_tmdb_images(&client, jobs, move |n| {
        emit_progress(&app_clone, n, total);
    })
    .await;

    // ── 阶段五：单事务写库（CASE WHEN 只补空） ──
    // 图片路径按「文件存在即写」判定（download_tmdb_images 成功 ⇔ 文件落盘）
    {
        let mut conn = state.db.lock();
        let tx = conn.transaction()?;
        // 季文字
        for sm in &season_metas {
            let poster = covers_dir.join(format!("season_{}.jpg", sm.id));
            let poster_path = if poster.exists() { poster.to_string_lossy().to_string() } else { String::new() };
            tx.execute(
                "UPDATE seasons SET
                    name = CASE WHEN ?1 <> '' THEN ?1 ELSE name END,
                    overview = CASE WHEN ?2 <> '' THEN ?2 ELSE overview END,
                    first_air_date = CASE WHEN ?3 <> '' THEN ?3 ELSE first_air_date END,
                    poster_path = CASE WHEN ?4 <> '' THEN ?4 ELSE poster_path END
                 WHERE id = ?5",
                params![sm.name, sm.overview, sm.air_date, poster_path, sm.id],
            )?;
        }
        // 集文字
        for em in &episode_metas {
            let still = covers_dir.join(format!("episode_{}.jpg", em.id));
            let still_path = if still.exists() { still.to_string_lossy().to_string() } else { String::new() };
            tx.execute(
                "UPDATE episodes SET
                    title = CASE WHEN ?1 <> '' THEN ?1 ELSE title END,
                    overview = CASE WHEN ?2 <> '' THEN ?2 ELSE overview END,
                    air_date = CASE WHEN ?3 <> '' THEN ?3 ELSE air_date END,
                    runtime_minutes = CASE WHEN ?4 > 0 THEN ?4 ELSE runtime_minutes END,
                    vote_average = CASE WHEN ?5 > 0 THEN ?5 ELSE vote_average END,
                    still_path = CASE WHEN ?6 <> '' THEN ?6 ELSE still_path END
                 WHERE id = ?7",
                params![em.title, em.overview, em.air_date, em.runtime, em.vote, still_path, em.id],
            )?;
        }
        // 剧集本体
        let poster = covers_dir.join(format!("series_{series_id}.jpg"));
        let bg = covers_dir.join(format!("series_bg_{series_id}.jpg"));
        let poster_path = if poster.exists() { poster.to_string_lossy().to_string() } else { String::new() };
        let bg_path = if bg.exists() { bg.to_string_lossy().to_string() } else { String::new() };
        let status = detail.status.as_deref().map(map_tmdb_status).unwrap_or_default();
        tx.execute(
            "UPDATE series SET
                overview = CASE WHEN ?1 <> '' THEN ?1 ELSE overview END,
                first_air_date = CASE WHEN ?2 <> '' THEN ?2 ELSE first_air_date END,
                status = CASE WHEN ?3 <> '' THEN ?3 ELSE status END,
                genres = CASE WHEN ?4 <> '' THEN ?4 ELSE genres END,
                vote_average = CASE WHEN ?5 > 0 THEN ?5 ELSE vote_average END,
                aliases = CASE WHEN aliases = '' THEN ?6 ELSE aliases END,
                title = CASE WHEN ?7 <> '' THEN ?7 ELSE title END,
                poster_path = CASE WHEN ?8 <> '' THEN ?8 ELSE poster_path END,
                bg_path = CASE WHEN ?9 <> '' THEN ?9 ELSE bg_path END,
                tmdb_id = ?10,
                updated_at = datetime('now')
             WHERE id = ?11",
            params![
                detail.overview.unwrap_or_default(),
                detail.first_air_date.unwrap_or_default(),
                status,
                genres,
                detail.vote_average.unwrap_or(0.0),
                detail.original_name.unwrap_or_default(),
                detail.name.unwrap_or_default(),
                poster_path,
                bg_path,
                tmdb_id,
                series_id,
            ],
        )?;
        tx.commit()?;
    }

    emit_progress(app, total, total);
    Ok(format!("已获取《{title}》的元数据"))
}

async fn auto_fetch_movie_inner(
    app: &AppHandle,
    state: &AppState,
    series_id: &str,
    tmdb_id_override: Option<i64>,
) -> AppResult<String> {
    // 短锁读 title + 本地 tmdb_id
    let (title, local_tmdb_id) = {
        let conn = state.db.lock();
        let title: String = conn.query_row("SELECT title FROM series WHERE id=?1", [series_id], |r| r.get(0)).unwrap_or_default();
        let local_tmdb_id: i64 = conn.query_row("SELECT tmdb_id FROM series WHERE id=?1", [series_id], |r| r.get(0)).unwrap_or(0);
        (title, local_tmdb_id)
    };

    let key = read_api_key(state)?;
    let client = build_http_client(state)?;
    let tmdb_id = if let Some(id) = tmdb_id_override.filter(|&i| i > 0) {
        id
    } else if local_tmdb_id > 0 {
        local_tmdb_id
    } else {
        let mut found = None;
        for q in [title.trim(), &clean_search_title(&title)] {
            if q.is_empty() {
                continue;
            }
            if let Some(id) = tmdb_search_movie(&client, &key, q).await? {
                found = Some(id);
                break;
            }
        }
        found.ok_or_else(|| AppError::Custom(format!("TMDB 上没有找到「{title}」，可以改名后重试")))?
    };

    let detail = tmdb_movie_detail(&client, &key, tmdb_id).await?;
    let genres = detail.genres.iter().map(|g| g.name.clone()).collect::<Vec<_>>().join(" / ");
    let covers_dir = state.data_dir.join("covers");
    let _ = std::fs::create_dir_all(&covers_dir);

    let total = 2usize;
    emit_progress(app, 0, total);

    // 电影重新刮削要覆盖旧图：下载前删旧
    let poster_target = covers_dir.join(format!("series_{series_id}.jpg"));
    let bg_target = covers_dir.join(format!("series_bg_{series_id}.jpg"));
    let _ = std::fs::remove_file(&poster_target);
    let _ = std::fs::remove_file(&bg_target);

    let mut jobs: Vec<TmdbImageJob> = Vec::new();
    if let Some(p) = &detail.poster_path {
        jobs.push(TmdbImageJob {
            url: format!("{TMDB_IMG_BASE}/w500{p}"),
            target: poster_target.clone(),
        });
    }
    if let Some(b) = &detail.backdrop_path {
        jobs.push(TmdbImageJob {
            url: format!("{TMDB_IMG_BASE}/w1280{b}"),
            target: bg_target.clone(),
        });
    }

    let app_clone = app.clone();
    let _results = download_tmdb_images(&client, jobs, move |n| {
        emit_progress(&app_clone, n, total);
    })
    .await;

    // 单事务写库
    {
        let mut conn = state.db.lock();
        let tx = conn.transaction()?;
        let poster_path = if poster_target.exists() { poster_target.to_string_lossy().to_string() } else { String::new() };
        let bg_path = if bg_target.exists() { bg_target.to_string_lossy().to_string() } else { String::new() };
        let status = detail.status.as_deref().map(map_tmdb_status).unwrap_or_default();
        tx.execute(
            "UPDATE series SET
                overview = CASE WHEN ?1 <> '' THEN ?1 ELSE overview END,
                first_air_date = CASE WHEN ?2 <> '' THEN ?2 ELSE first_air_date END,
                status = CASE WHEN ?3 <> '' THEN ?3 ELSE status END,
                genres = CASE WHEN ?4 <> '' THEN ?4 ELSE genres END,
                vote_average = CASE WHEN ?5 > 0 THEN ?5 ELSE vote_average END,
                aliases = CASE WHEN aliases = '' THEN ?6 ELSE aliases END,
                title = CASE WHEN ?7 <> '' THEN ?7 ELSE title END,
                poster_path = CASE WHEN ?8 <> '' THEN ?8 ELSE poster_path END,
                bg_path = CASE WHEN ?9 <> '' THEN ?9 ELSE bg_path END,
                tmdb_id = ?10,
                updated_at = datetime('now')
             WHERE id = ?11",
            params![
                detail.overview.clone().unwrap_or_default(),
                detail.release_date.clone().unwrap_or_default(),
                status,
                genres,
                detail.vote_average.unwrap_or(0.0),
                detail.original_title.clone().unwrap_or_default(),
                detail.title.clone().unwrap_or_default(),
                poster_path,
                bg_path,
                tmdb_id,
                series_id,
            ],
        )?;
        // 电影单集：runtime/title/air_date/still(用bg)/overview
        let still_path = if bg_target.exists() { bg_target.to_string_lossy().to_string() } else { String::new() };
        tx.execute(
            "UPDATE episodes SET
                runtime_minutes = CASE WHEN ?1 > 0 THEN ?1 ELSE runtime_minutes END,
                title = CASE WHEN ?2 <> '' THEN ?2 ELSE title END,
                air_date = CASE WHEN ?3 <> '' THEN ?3 ELSE air_date END,
                still_path = CASE WHEN ?4 <> '' THEN ?4 ELSE still_path END,
                overview = CASE WHEN ?5 <> '' THEN ?5 ELSE overview END
             WHERE series_id = ?6",
            params![
                detail.runtime.unwrap_or(0),
                detail.title.unwrap_or_default(),
                detail.release_date.unwrap_or_default(),
                still_path,
                detail.overview.unwrap_or_default(),
                series_id,
            ],
        )?;
        tx.commit()?;
    }

    emit_progress(app, total, total);
    Ok(format!("已获取《{title}》的元数据"))
}

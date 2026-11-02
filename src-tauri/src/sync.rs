// 肃正协议：跨端观看进度同步（电脑 D:\ZEX ⇄ 电视 D:\ZEX-TV）。
//
// 形态：以 NAS 上一个用户指定的「肃正核心」目录为媒介，每端只写自己那份
// core-<device_id>.json、读别人那份，按「自然键」字段级合并（后写者胜）。
// 不共享单个 sqlite（网络文件系统的锁在 SMB 上是坏的，迟早损库），
// 不搬 local_path（电视存 server\share\相对路径，桌面存 X:\… 盘符路径，格式不通）。
//
// 自然键：优先 (series.tmdb_id, season_number, episode_number)；无 tmdb 兜底用视频
// 文件 basename——两端指向 NAS 同一文件，basename 必然相同，绕开盘符/share 差异。
//
// 触发（见 lib.rs）：冷启动 setup() 拉一次；之后每次回前台（RunEvent::Resumed）都拉。
// 电视 singleTask 常驻、几乎不冷启，全靠 Resumed 兜住「重新打开软件」这一刻。
// 进度写库时置 sync_dirty；标记看完等收尾动作即时推送，零散续播点回前台时补推。

use std::sync::atomic::Ordering;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::smb;
use crate::{AppResult, AppState};

/// 快照结构版本：不认识的版本一律跳过而不是硬合并。
/// schema=2：季号修复版，与桌面端 D:\ZEX 对齐——兜底键从「文件名」改为「父目录/文件名」。
/// 两端一起升到 2 后，旧 schema=1 核心文件会被两端自动忽略、用各自正确进度重建（见
/// sync_once 的 schema 过滤），避免被压扁的错季旧键污染真实进度。
pub const SNAP_SCHEMA: u32 = 2;

/// 单集进度记录（字段名压到最短，快照可能有上千条）
#[derive(Serialize, Deserialize)]
struct Rec {
    #[serde(default)] tmdb_id: i64,
    #[serde(default)] s: i32,        // season_number
    #[serde(default)] e: i32,        // episode_number
    #[serde(default)] base: String,  // 视频文件 basename（兜底键）
    #[serde(default)] watched: bool,
    #[serde(default)] watched_ms: i64,
    #[serde(default)] at: String,    // last_watched_at（SQLite datetime，UTC，可字符串比较）
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    schema: u32,
    device: String,
    updated_at: String,
    episodes: Vec<Rec>,
}

// 跨端稳定键：文件路径的「父目录名/文件名」。两端指向 NAS 同一文件、路径尾必然一致，
// 比单纯 basename 多带一层父目录，能把 Season 1/01.mkv 与 Season 2/01.mkv 区分开
// （同名跨季不再串档）。必须与桌面端 D:\ZEX sync.rs 的 lasttwo 逐字一致。
fn lasttwo(p: &str) -> String {
    let n = p.replace('\\', "/");
    let mut it = n.rsplit('/');
    let file = it.next().unwrap_or("");
    match it.next() {
        Some(parent) if !parent.is_empty() => format!("{}/{}", parent, file),
        _ => file.to_string(),
    }
}

/// 本端稳定标识：settings.sync_device_id，首次生成后固定（决定自己那份文件名）
fn device_id(conn: &Connection) -> String {
    if let Some(id) = db::setting_get(conn, "sync_device_id") {
        if !id.is_empty() {
            return id;
        }
    }
    let id = format!("tv-{}", uuid::Uuid::new_v4());
    let _ = db::setting_set(conn, "sync_device_id", &id);
    id
}

/// 默认开；用户可在设置里关（写 "0"）
fn enabled(conn: &Connection) -> bool {
    db::setting_get(conn, "sync_enabled").map(|v| v != "0").unwrap_or(true)
}

/// 肃正核心落点：(server_id, share, dir)。share 由用户在设置里指定，未填 = 未配置 = 不同步。
/// dir 为相对 share 根的路径（可空 = 共享根，可多级）。server 默认取第一台 NAS。
fn target(conn: &Connection) -> Option<(String, String, String)> {
    let share = db::setting_get(conn, "sync_share").unwrap_or_default();
    let share = share.trim().to_string();
    if share.is_empty() {
        return None;
    }
    let dir = db::setting_get(conn, "sync_dir").unwrap_or_default().trim().to_string();
    let server_id = db::setting_get(conn, "sync_server_id")
        .filter(|s| !s.is_empty())
        .or_else(|| {
            conn.query_row(
                "SELECT id FROM smb_servers ORDER BY created_at LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
        })?;
    Some((server_id, share, dir))
}

/// 本端所有「有进度」的集 → 快照
fn build_snapshot(conn: &Connection, device: &str) -> Snapshot {
    let updated_at: String = conn
        .query_row("SELECT datetime('now')", [], |r| r.get(0))
        .unwrap_or_default();
    let mut episodes = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT s.tmdb_id, se.season_number, e.episode_number, e.local_path,
                e.watched, e.watched_ms, e.last_watched_at
         FROM episodes e
         JOIN seasons se ON se.id = e.season_id
         JOIN series s ON s.id = e.series_id
         WHERE (e.watched = 1 OR e.watched_ms > 0) AND e.last_watched_at <> ''",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            let lp: String = r.get(3)?;
            Ok(Rec {
                tmdb_id: r.get(0)?,
                s: r.get(1)?,
                e: r.get(2)?,
                base: lasttwo(&lp),
                watched: r.get::<_, i32>(4)? != 0,
                watched_ms: r.get(5)?,
                at: r.get(6)?,
            })
        }) {
            episodes = rows.filter_map(|r| r.ok()).collect();
        }
    }
    Snapshot { schema: SNAP_SCHEMA, device: device.to_string(), updated_at, episodes }
}

/// 把一批进度记录合并进本库：按自然键找到本地集，incoming 的 last_watched_at 更新才覆盖。返回改动条数。
fn merge(conn: &Connection, recs: &[Rec]) -> AppResult<usize> {
    use std::collections::HashMap;
    // 本地集索引：tmdb 三元组 + basename 各一份，值 =(本地集 id, 本地 last_watched_at)
    let mut by_key: HashMap<(i64, i32, i32), (String, String)> = HashMap::new();
    let mut by_base: HashMap<String, (String, String)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT e.id, s.tmdb_id, se.season_number, e.episode_number, e.local_path, e.last_watched_at
             FROM episodes e
             JOIN seasons se ON se.id = e.season_id
             JOIN series s ON s.id = e.series_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i32>(2)?,
                r.get::<_, i32>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (id, tmdb, s, e, lp, last) = row?;
            if tmdb > 0 {
                by_key.insert((tmdb, s, e), (id.clone(), last.clone()));
            }
            by_base.entry(lasttwo(&lp)).or_insert((id, last));
        }
    }
    let mut changed = 0usize;
    for rec in recs {
        // 先按 tmdb 三元组，miss 再退到文件名
        let local = if rec.tmdb_id > 0 { by_key.get(&(rec.tmdb_id, rec.s, rec.e)) } else { None }
            .or_else(|| by_base.get(&rec.base));
        if let Some((id, local_last)) = local {
            // 后写者胜：只有对端更新才覆盖；同时刻或更旧一律不动（幂等、不回退）
            if rec.at.as_str() > local_last.as_str() {
                conn.execute(
                    "UPDATE episodes SET watched = ?1, watched_ms = ?2, last_watched_at = ?3 WHERE id = ?4",
                    rusqlite::params![rec.watched as i32, rec.watched_ms, rec.at, id],
                )?;
                changed += 1;
            }
        }
    }
    Ok(changed)
}

// ─────────────────────────────────────────────
// 对外：一个共享文件的双向对账（读→并进本库→并回文件→整份原子覆盖）
// 单文件（肃正核心.json）：核心目录里就一份，两端进度的并集。
// db 锁只在同步代码段短暂持有，绝不跨 .await（否则 SMB 慢时全库卡死）。
// ─────────────────────────────────────────────

/// 核心文件名（放在用户指定的核心目录下）
const CORE_FILE: &str = "肃正核心.json";

/// 记录的自然键（并集去重用）：有 tmdb 用三元组，否则用文件名
fn canon(r: &Rec) -> String {
    if r.tmdb_id > 0 {
        format!("t:{}:{}:{}", r.tmdb_id, r.s, r.e)
    } else {
        format!("b:{}", r.base)
    }
}

/// 并集（后写者胜）：同一自然键保留 last_watched_at 最大的那条
fn union(file_recs: Vec<Rec>, my_recs: Vec<Rec>) -> Vec<Rec> {
    use std::collections::HashMap;
    let mut m: HashMap<String, Rec> = HashMap::new();
    for r in file_recs.into_iter().chain(my_recs) {
        let k = canon(&r);
        match m.get(&k) {
            Some(prev) if prev.at.as_str() >= r.at.as_str() => {}
            _ => {
                m.insert(k, r);
            }
        }
    }
    m.into_values().collect()
}

// SYNC_MAIN_PLACEHOLDER

/// 一次完整对账：读核心文件 → 把更新的进度并进本库 → 本库全量进度并回文件 → 原子覆盖写回。
async fn sync_once(app: &AppHandle) -> AppResult<()> {
    // 1. 读配置 + NAS（短锁）
    let (server, share, dir, dev) = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        if !enabled(&conn) {
            return Ok(());
        }
        let (server_id, share, dir) = match target(&conn) {
            Some(t) => t,
            None => return Ok(()), // 未配置肃正核心位置
        };
        let dev = device_id(&conn);
        (smb::read_server(&conn, &server_id)?, share, dir, dev)
    };
    // 2. 读回核心文件（首次不存在 = 空）
    let file_recs: Vec<Rec> = match smb::sync_read_one(server.clone(), &share, &dir, CORE_FILE).await? {
        Some(bytes) => match serde_json::from_slice::<Snapshot>(&bytes) {
            Ok(s) if s.schema == SNAP_SCHEMA => s.episodes,
            Ok(s) => {
                log::warn!("肃正核心 schema={} 不兼容，忽略后重写", s.schema);
                Vec::new()
            }
            Err(e) => {
                log::warn!("肃正核心解析失败（将重写）：{e}");
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    // 3. 并进本库 + 取本库全量进度（短锁，不跨 await）
    let (changed, my_recs, updated_at) = {
        let state = app.state::<AppState>();
        let conn = state.db.lock();
        let changed = merge(&conn, &file_recs)?;
        let snap = build_snapshot(&conn, &dev);
        (changed, snap.episodes, snap.updated_at)
    };
    // 4. 并集后整份覆盖写回（临时文件 + 改名 = 原子替换，安全版「删光重写」）
    let out = Snapshot {
        schema: SNAP_SCHEMA,
        device: dev,
        updated_at,
        episodes: union(file_recs, my_recs),
    };
    smb::sync_write(server, &share, &dir, CORE_FILE, &serde_json::to_vec(&out)?).await?;
    if changed > 0 {
        log::info!("肃正协议·合并 {changed} 条进度");
        let _ = app.emit("progress-synced", changed);
    }
    Ok(())
}

/// 触发一次对账。合并 + 去重：进行中再调只置 pending，让在跑的任务收尾时补跑一轮，
/// 保证同一时刻只有一个任务在读改写核心文件（不会自己和自己抢）。
/// 调用点：冷启动 setup、每次回前台 Resumed、标记看完等收尾动作。
pub fn sync(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        state.sync_pending.store(true, Ordering::Release);
        // 抢执行权；抢不到说明已有任务在跑，它会看到 pending 再补一轮
        if state
            .sync_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        loop {
            // 抓走 pending 就跑；跑的过程中新来的请求会再次置 pending
            while app.state::<AppState>().sync_pending.swap(false, Ordering::AcqRel) {
                if let Err(e) = sync_once(&app).await {
                    log::warn!("肃正协议·同步失败：{e}");
                }
            }
            app.state::<AppState>().sync_running.store(false, Ordering::Release);
            // 收尾竞态：swap(false) 与 store(false) 之间若又来请求，抢回执行权补跑
            let state = app.state::<AppState>();
            if state.sync_pending.load(Ordering::Acquire)
                && state
                    .sync_running
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                continue;
            }
            break;
        }
    });
}

/// 关闭同步时删掉 NAS 上的核心文件（best-effort，后台任务）。
/// 配置位置仍在（只是 sync_enabled 关了），所以能定位到文件删掉。
pub fn purge(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let prep = {
            let state = app.state::<AppState>();
            let conn = state.db.lock();
            let (server_id, share, dir) = match target(&conn) {
                Some(t) => t,
                None => return, // 没配置过位置，无从删起
            };
            match smb::read_server(&conn, &server_id) {
                Ok(s) => (s, share, dir),
                Err(_) => return,
            }
        };
        let (server, share, dir) = prep;
        match smb::sync_delete(server, &share, &dir, CORE_FILE).await {
            Ok(()) => log::info!("肃正协议·已删除核心文件"),
            Err(e) => log::info!("肃正协议·删除核心文件跳过（可能本就不存在）：{e}"),
        }
    });
}





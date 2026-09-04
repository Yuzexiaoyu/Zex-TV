// 数据层：SQLite 四表（series/seasons/episodes/settings）+ DTO + 行映射。
// 裁剪自 D:\ZEX 的 init_database 与列常量，去掉 games/tracks/playlists 全家。

use std::path::Path;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::AppError;

pub type DbResult<T> = Result<T, AppError>;

// ─────────────────────────────────────────────
// 建库与迁移
// ─────────────────────────────────────────────

pub fn init_database(db_path: &Path) -> DbResult<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;

         CREATE TABLE IF NOT EXISTS series (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             aliases TEXT DEFAULT '',
             overview TEXT DEFAULT '',
             poster_path TEXT DEFAULT '',
             bg_path TEXT DEFAULT '',
             first_air_date TEXT DEFAULT '',
             status TEXT DEFAULT 'airing',
             tmdb_id INTEGER DEFAULT 0,
             tvdb_id INTEGER DEFAULT 0,
             tags TEXT DEFAULT '[]',
             favorite INTEGER DEFAULT 0,
             vote_average REAL DEFAULT 0,
             genres TEXT DEFAULT '',
             sort_order INTEGER DEFAULT 0,
             media_type TEXT DEFAULT 'tv',
             total_seconds INTEGER DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now')),
             updated_at TEXT DEFAULT (datetime('now'))
         );

         CREATE TABLE IF NOT EXISTS seasons (
             id TEXT PRIMARY KEY,
             series_id TEXT NOT NULL,
             season_number INTEGER NOT NULL,
             name TEXT DEFAULT '',
             overview TEXT DEFAULT '',
             poster_path TEXT DEFAULT '',
             first_air_date TEXT DEFAULT '',
             FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
         );

         CREATE TABLE IF NOT EXISTS episodes (
             id TEXT PRIMARY KEY,
             series_id TEXT NOT NULL,
             season_id TEXT NOT NULL,
             episode_number INTEGER NOT NULL,
             title TEXT DEFAULT '',
             overview TEXT DEFAULT '',
             still_path TEXT DEFAULT '',
             air_date TEXT DEFAULT '',
             runtime_minutes INTEGER DEFAULT 0,
             local_path TEXT DEFAULT '',
             watched_ms INTEGER DEFAULT 0,
             last_watched_at TEXT DEFAULT '',
             watched INTEGER DEFAULT 0,
             vote_average REAL DEFAULT 0,
             FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
             FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE
         );

         CREATE TABLE IF NOT EXISTS settings (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );

         CREATE INDEX IF NOT EXISTS idx_seasons_series_id ON seasons(series_id);
         CREATE INDEX IF NOT EXISTS idx_episodes_season_id ON episodes(season_id);
         CREATE INDEX IF NOT EXISTS idx_episodes_series_id ON episodes(series_id);

         -- SMB 服务器表（电视版新增）：episodes.local_path 由 server_id 与 share 及相对路径拼成
         CREATE TABLE IF NOT EXISTS smb_servers (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             host TEXT NOT NULL,
             port INTEGER DEFAULT 445,
             username TEXT DEFAULT '',
             password TEXT DEFAULT '',
             created_at TEXT DEFAULT (datetime('now'))
         );
        ",
    )?;
    Ok(conn)
}

// ─────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Series {
    pub id: String,
    pub title: String,
    pub aliases: String,
    pub overview: String,
    pub poster_path: String,
    pub bg_path: String,
    pub first_air_date: String,
    pub status: String,
    pub tmdb_id: i64,
    pub tvdb_id: i64,
    pub tags: String,
    pub favorite: bool,
    #[serde(default)]
    pub vote_average: f64,
    #[serde(default)]
    pub genres: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "default_media_type")]
    pub media_type: String,
    #[serde(default)]
    pub total_seconds: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn default_media_type() -> String {
    "tv".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Season {
    pub id: String,
    pub series_id: String,
    pub season_number: i32,
    pub name: String,
    pub overview: String,
    pub poster_path: String,
    pub first_air_date: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Episode {
    pub id: String,
    pub series_id: String,
    pub season_id: String,
    pub episode_number: i32,
    pub title: String,
    pub overview: String,
    pub still_path: String,
    pub air_date: String,
    pub runtime_minutes: i32,
    pub local_path: String,
    pub watched_ms: i64,
    pub last_watched_at: String,
    pub watched: bool,
    #[serde(default)]
    pub vote_average: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SmbServer {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i32,
    pub username: String,
    pub password: String,
    pub created_at: String,
}

// ─────────────────────────────────────────────
// 列常量与行映射（SELECT 顺序与 row.get(n) 对齐的唯一权威）
// ─────────────────────────────────────────────

pub const SERIES_COLS: &str = "id, title, aliases, overview, poster_path, bg_path, first_air_date, \
                               status, tmdb_id, tvdb_id, tags, favorite, vote_average, genres, \
                               sort_order, media_type, created_at, updated_at, total_seconds";

// sort_order = 0（从未拖动过）排末尾，其余按位次；同位次按标题稳定排序
pub const SERIES_ORDER: &str = "ORDER BY CASE WHEN sort_order = 0 THEN 1 ELSE 0 END, sort_order, title";

pub fn row_to_series(row: &rusqlite::Row) -> rusqlite::Result<Series> {
    Ok(Series {
        id: row.get(0)?,
        title: row.get(1)?,
        aliases: row.get(2)?,
        overview: row.get(3)?,
        poster_path: row.get(4)?,
        bg_path: row.get(5)?,
        first_air_date: row.get(6)?,
        status: row.get(7)?,
        tmdb_id: row.get(8)?,
        tvdb_id: row.get(9)?,
        tags: row.get(10)?,
        favorite: row.get::<_, i32>(11)? != 0,
        vote_average: row.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
        genres: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
        sort_order: row.get::<_, Option<i64>>(14)?.unwrap_or(0),
        media_type: row
            .get::<_, Option<String>>(15)?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_media_type),
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        total_seconds: row.get::<_, Option<i64>>(18)?.unwrap_or(0),
    })
}

pub const SEASON_COLS: &str = "id, series_id, season_number, name, overview, poster_path, first_air_date";

pub fn row_to_season(row: &rusqlite::Row) -> rusqlite::Result<Season> {
    Ok(Season {
        id: row.get(0)?,
        series_id: row.get(1)?,
        season_number: row.get(2)?,
        name: row.get(3)?,
        overview: row.get(4)?,
        poster_path: row.get(5)?,
        first_air_date: row.get(6)?,
    })
}

pub const EPISODE_COLS: &str = "id, series_id, season_id, episode_number, title, overview, still_path, \
                                air_date, runtime_minutes, local_path, watched_ms, last_watched_at, \
                                watched, vote_average";

pub fn row_to_episode(row: &rusqlite::Row) -> rusqlite::Result<Episode> {
    Ok(Episode {
        id: row.get(0)?,
        series_id: row.get(1)?,
        season_id: row.get(2)?,
        episode_number: row.get(3)?,
        title: row.get(4)?,
        overview: row.get(5)?,
        still_path: row.get(6)?,
        air_date: row.get(7)?,
        runtime_minutes: row.get(8)?,
        local_path: row.get(9)?,
        watched_ms: row.get(10)?,
        last_watched_at: row.get(11)?,
        watched: row.get::<_, i32>(12)? != 0,
        vote_average: row.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
    })
}

const SMB_SERVER_COLS: &str = "id, name, host, port, username, password, created_at";

fn row_to_smb_server(row: &rusqlite::Row) -> rusqlite::Result<SmbServer> {
    Ok(SmbServer {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get::<_, Option<i32>>(3)?.unwrap_or(445),
        username: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        password: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        created_at: row.get(6)?,
    })
}

// ─────────────────────────────────────────────
// settings 读写（库内小工具，命令层薄封装）
// ─────────────────────────────────────────────

pub fn setting_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

pub fn setting_set(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

pub fn smb_server_by_id(conn: &Connection, id: &str) -> DbResult<SmbServer> {
    conn.query_row(
        &format!("SELECT {} FROM smb_servers WHERE id = ?", SMB_SERVER_COLS),
        [id],
        row_to_smb_server,
    )
    .map_err(AppError::from)
}

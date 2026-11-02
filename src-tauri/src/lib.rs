// ZEX TV —— 影视库电视版（海信 GX27 Android）
//
// 后端模块化：db（数据层）/ commands（Tauri 命令层）；M2 起追加
// tmdb（刮削）/ smb（NAS 客户端）/ stream_server（本地 HTTP 流）。
//
// 遥控器按键（含 Back→Escape 改造）在 MainActivity.kt 里统一转成键盘事件
// 送进 WebView；covers 自定义协议复用桌面版同款（http://covers.localhost/）。

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;
use percent_encoding::percent_decode_str;
use rusqlite::Connection;
use tauri::http::Response;
use tauri::Manager;
use thiserror::Error;

mod commands;
mod db;
mod smb;
mod stream_server;
mod sync;
mod tmdb;

// ─────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("App error: {0}")]
    Custom(String),
}

// Tauri 命令返回 Err 时，前端拿到的是序列化后的字符串；不能直接序列化枚举
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

// ─────────────────────────────────────────────
// App State
// ─────────────────────────────────────────────

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub data_dir: PathBuf,
    /// TMDB 抓取全局锁：同一时刻只允许一个刮削在跑（前端切库后组件状态丢失，
    /// 防重入必须落在后端；guard 析构自动释放）。M2 启用。
    pub metadata_fetching: Arc<AtomicBool>,
    /// 肃正协议：同步任务在跑 / 有待跑请求。两个原子做「合并去重 + 串行化」，
    /// 保证同一时刻只有一个任务读改写核心文件（见 sync.rs）
    pub sync_running: Arc<AtomicBool>,
    pub sync_pending: Arc<AtomicBool>,
    /// 供命令层写库后触发肃正对账（AppHandle 可克隆、Send+Sync）
    pub app: tauri::AppHandle,
}

// ─────────────────────────────────────────────
// 出厂默认设置（首次启动预填，用户之后可改）
// ─────────────────────────────────────────────

const DEFAULT_SETTINGS: &[(&str, &str)] = &[
    // TMDB API Key（刮削必填；电视上用遥控器输入 32 位 key 太折磨，出厂内置）
    ("tmdb_api_key", "b55f6dfddd74ecddfc53144c69d4c62d"),
];

// 出厂预填的 NAS 服务器（smb_servers 表）。id 固定，重复导入天然幂等
const DEFAULT_SMB_SERVER: (&str, &str, &str, i32, &str, &str) = (
    "nas-default",
    "我的 NAS",
    "192.168.5.151",
    445,
    "雨泽小鱼",
    "Myt200761",
);

fn seed_default_settings(conn: &Connection) {
    // settings 表全空 = 首次启动（或用户清空全部设置），补默认值。
    // 只在 key 不存在时写入，不覆盖用户已改过的值
    let has_any: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM settings", [], |r| r.get(0))
        .unwrap_or(false);
    if !has_any {
        for (k, v) in DEFAULT_SETTINGS {
            let _ = db::setting_set(conn, k, v);
        }
        log::info!("已预填出厂默认设置（{} 项）", DEFAULT_SETTINGS.len());
    }

    // NAS 服务器：不存在同名 id 才插入（用户删过就不自动复活）
    let (id, name, host, port, user, pass) = DEFAULT_SMB_SERVER;
    let exists: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM smb_servers WHERE id = ?1", [id], |r| r.get(0))
        .unwrap_or(false);
    if !exists {
        let _ = conn.execute(
            "INSERT INTO smb_servers (id, name, host, port, username, password)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, name, host, port, user, pass],
        );
        log::info!("已预填出厂 NAS 服务器 {host}");
    }
}

// ─────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 电视上无控制台，stderr 走 logcat；正式版日志收口到 warn，调试版留 info。
    // 想临时看细节：设环境变量 RUST_LOG=debug 覆盖，无需改代码重编
    let default_level = if cfg!(debug_assertions) { "info" } else { "warn" };
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_level))
        .format_timestamp_millis()
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 本地图片协议：http://covers.localhost/<编码后的封面文件名>
        // 回调运行时 AppState 一定已 manage（setup 早跑完），这里每次请求取一次
        .register_uri_scheme_protocol("covers", |ctx, request| {
            let state = ctx.app_handle().state::<AppState>();
            let covers_dir = state.data_dir.join("covers");
            serve_covers_file(&covers_dir, &request)
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            fs::create_dir_all(data_dir.join("covers"))?;
            let db_path = data_dir.join("zex-tv.db");
            log::info!("ZEX TV data dir: {:?}", data_dir);
            log::info!("ZEX TV database: {:?}", db_path);
            let conn = db::init_database(&db_path)?;
            seed_default_settings(&conn);
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                data_dir,
                metadata_fetching: Arc::new(AtomicBool::new(false)),
                sync_running: Arc::new(AtomicBool::new(false)),
                sync_pending: Arc::new(AtomicBool::new(false)),
                app: app.handle().clone(),
            });
            // 冷启动先对账一次（电视几乎不冷启，日常主要靠回前台的 Resumed 兜）
            crate::sync::sync(app.handle().clone());
            log::info!("ZEX TV started successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Series
            commands::get_all_series,
            commands::create_series,
            commands::update_series,
            commands::reorder_series,
            commands::set_series_favorite,
            commands::delete_series,
            commands::clear_all_media,
            // Seasons
            commands::get_seasons,
            commands::create_season,
            commands::delete_season,
            // Episodes
            commands::get_episodes,
            commands::create_episode,
            commands::update_episode,
            commands::delete_episode,
            // Progress
            commands::update_watch_progress,
            commands::mark_episode_watched,
            commands::mark_season_watched,
            commands::mark_episodes_watched,
            commands::touch_episode_played,
            // Library / Detail
            commands::get_series_library,
            commands::get_series_detail,
            // Stats
            commands::get_stats,
            // Settings
            commands::get_setting,
            commands::set_setting,
            // SMB Servers
            commands::get_smb_servers,
            commands::save_smb_server,
            commands::delete_smb_server,
            // SMB 浏览（M2）
            commands::list_smb_shares,
            commands::list_smb_dir,
            commands::add_series_by_smb,
            // TMDB 刮削（M2）
            tmdb::search_tmdb,
            tmdb::auto_fetch_series_metadata,
            // 播放（M3）
            commands::play_episode,
            commands::take_current_episode,
            // 肃正协议（跨端进度同步）
            commands::trigger_sync,
            commands::sync_purge,
            // App
            commands::get_version,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ZEX TV")
        .run(|_app, event| match event {
            // Android：从系统播放器回到 App（Activity onResume → tao Event::Resume）。
            // tao 刻意忽略首个 onResume（冷启动那次），所以只有「从播放器回来」才触发，
            // 冷启动不会误弹回执框。此时若仍有未回执的播放会话，通知前端弹「看完了吗」。
            // 桌面端 WindowEvent::Resumed 不存在（mobile-only 变体），cfg 隔离——
            // 因此桌面编译下 _app 在唯一使用分支被剔除，前缀下划线即无警告。
            #[cfg(mobile)]
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Resumed,
                ..
            } => {
                use tauri::Emitter;
                let app = _app;
                let _ = app.emit("app-resumed", ());
                // 回到 App = 播放结束，停掉播放期间的前台服务（见 stream_server.rs）
                crate::stream_server::stop_stream_service(app);
                // 肃正协议：回前台就是「重新打开软件」这一刻——跟核心文件对一次账。
                // 电视 singleTask 常驻不冷启，冷启动的 setup 那次跑不到，全靠这里。
                crate::sync::sync(app.clone());
            }
            _ => {}
        });
}

// ─────────────────────────────────────────────
// covers 协议：封面图按文件名直读 data_dir/covers/
// 缓存策略与桌面版一致——?v= 版本号强缓存、否则 ETag 协商缓存
// ─────────────────────────────────────────────

fn serve_covers_file(covers_dir: &Path, request: &tauri::http::Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let encoded = request.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(encoded).decode_utf8_lossy().to_string();
    let file_name = Path::new(&decoded)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = covers_dir.join(&file_name);
    if file_name.is_empty() || !path.exists() || !path.starts_with(covers_dir) {
        return Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap();
    }

    // 文件名在重新刮削后会被原地覆盖、名字不变 —— 只有带 ?v= 版本号的请求
    //（见前端 coverSrc）才能强缓存；不带版本号的用 mtime+size 做 ETag 走协商缓存，
    // 命中时回 304 不读文件内容
    let versioned = request.uri().query().map(|q| q.contains("v=")).unwrap_or(false);
    let etag = fs::metadata(&path).ok().and_then(|m| {
        let len = m.len();
        let ms = m
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis();
        Some(format!("\"{:x}-{:x}\"", ms, len))
    });
    let cache_control = if versioned {
        "public, max-age=31536000, immutable"
    } else {
        "public, no-cache"
    };
    if let Some(tag) = &etag {
        let matched = request
            .headers()
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(',').any(|e| e.trim() == tag.as_str()))
            .unwrap_or(false);
        if matched {
            return Response::builder()
                .status(304)
                .header("Cache-Control", cache_control)
                .header("ETag", tag.clone())
                .header("Access-Control-Allow-Origin", "*")
                .body(Cow::Borrowed(&b""[..]))
                .unwrap();
        }
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            return Response::builder()
                .status(404)
                .body(Cow::Borrowed(&b"not found"[..]))
                .unwrap()
        }
    };
    // TMDB 下载的 still 可能是 PNG，按魔数判真实类型（文件名统一 .jpg 便于共享复用）
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    };
    let mut builder = Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", cache_control)
        .header("Access-Control-Allow-Origin", "*");
    if let Some(tag) = etag {
        builder = builder.header("ETag", tag);
    }
    builder.body(Cow::Owned(bytes)).unwrap()
}

// SMB 客户端：连 NAS、列共享、列目录、扫描视频文件。
// 基于 smb2 crate（纯 Rust，Android 交叉编译无痛）。
// 注意：smb2 的所有方法都是 async（返回 impl Future），本模块全部 async。
//
// 电视版片源是局域网 NAS/PC 的 SMB 共享。episodes.local_path 约定格式：
//   "server_id\share\相对路径"（反斜杠分隔；后端解析时 split）

use regex::Regex;
use serde::Serialize;
use smb2::{ClientConfig, DirectoryEntry, SmbClient};
use urlencoding::encode;

use crate::db::{self, SmbServer};
use crate::{AppError, AppResult};

// 命令层用的 DTO（避免 smb2 的 ShareInfo/DirectoryEntry 跨边界泄漏，且 serde 友好）
#[derive(Debug, Serialize, Clone)]
pub struct SmbShareInfoDto {
    pub name: String,
    pub comment: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SmbDirEntryDto {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
    pub created: String,
    pub modified: String,
}

impl From<DirectoryEntry> for SmbDirEntryDto {
    fn from(e: DirectoryEntry) -> Self {
        SmbDirEntryDto {
            name: e.name,
            size: e.size,
            is_directory: e.is_directory,
            created: format!("{:?}", e.created),
            modified: format!("{:?}", e.modified),
        }
    }
}

// 视频扩展名（与桌面版 scan_video_folder 一致）
const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "rmvb"];

// 六个集数正则（优先级从上到下，首个命中即停）
static RE_S_E: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"[Ss](\d{1,2})[Ee](\d{1,3})").unwrap()
});
static RE_X: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"(\d{1,2})[xX](\d{1,3})").unwrap()
});
static RE_EP: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"[Ee][Pp]?(\d{1,3})").unwrap()
});
static RE_CHINESE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"第(\d{1,3})[集话話]").unwrap()
});
static RE_BRACKET: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"\[(\d{1,3})\]").unwrap()
});
static RE_NUMBER: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"(?:^|[^\d])(\d{1,3})(?:[^\d]|$)").unwrap()
});

// 目录名里的季号：`Season 2` / `S02` / `第二季` / `第 2 季`。
// 桌面版只看文件名，`Season 1\01.mkv` 和 `Season 2\01.mkv` 会全塌进第 1 季且集号撞车；
// 电视版补上父目录兜底（文件名里的 SxxExx 仍然优先，两者都没有才算第 1 季）
static RE_DIR_SEASON: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"(?i)(?:season|s)\s*(\d{1,2})\b").unwrap()
});
static RE_DIR_SEASON_CN: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"第\s*(\d{1,2})\s*季").unwrap()
});
// 中文数字季（「第二季」「第十季」「第二十一季」）
static RE_DIR_SEASON_CN_NUM: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"第\s*([一二三四五六七八九十]{1,4})\s*季").unwrap()
});

/// 中文数字 → 整数（只覆盖 1..=99，季号够用）
fn cn_numeral(s: &str) -> Option<i32> {
    const DIGITS: [(char, i32); 10] = [
        ('零', 0), ('一', 1), ('二', 2), ('三', 3), ('四', 4),
        ('五', 5), ('六', 6), ('七', 7), ('八', 8), ('九', 9),
    ];
    let digit = |c: char| DIGITS.iter().find(|(d, _)| *d == c).map(|(_, v)| *v);

    let chars: Vec<char> = s.chars().collect();
    match chars.as_slice() {
        // 「十」
        ['十'] => Some(10),
        // 「十二」
        ['十', b] => digit(*b).map(|v| 10 + v),
        // 「二十」
        [a, '十'] => digit(*a).map(|v| v * 10),
        // 「二十一」
        [a, '十', b] => Some(digit(*a)? * 10 + digit(*b)?),
        // 「三」
        [a] => digit(*a),
        _ => None,
    }
}

/// 从目录名提取季号（`Season 2` / `S02` / `第二季` / `第 2 季`）。
/// 只在文件名给不出季号时用作兜底
fn parse_dir_season(dir_name: &str) -> Option<i32> {
    if let Some(c) = RE_DIR_SEASON_CN.captures(dir_name) {
        return c[1].parse().ok();
    }
    if let Some(c) = RE_DIR_SEASON_CN_NUM.captures(dir_name) {
        return cn_numeral(&c[1]);
    }
    if let Some(c) = RE_DIR_SEASON.captures(dir_name) {
        return c[1].parse().ok();
    }
    None
}

// 标题清洗：文件夹名常带年份/分辨率/压制/字幕组标记，直接当剧名会很脏，
// 也会让 TMDB 搜不到。规则对齐桌面版 clean_search_title，另加去括号内容
static RE_TITLE_NOISE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(
        r"(?i)(?:s\d{1,2}e?\d*|\d{1,2}[x×]\d{1,2}|第\s*\d+\s*季|(?:19|20)\d{2}|1080p|720p|2160p|4k|blu-?ray|web-?dl|webrip|hdtv|hdr|remux|x26[45]|h\.?26[45]|aac|dts|flac|10bit|8bit)",
    )
    .unwrap()
});
// 成对的方括号/圆括号及其内容（字幕组、压制信息多在里面）
static RE_TITLE_BRACKETS: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"[\[\(【（][^\]\)】）]*[\]\)】）]").unwrap()
});

/// 文件夹名 → 干净剧名。去括号内容 → 去噪声词 → 分隔符转空格 → 收敛空白。
/// 清洗后为空（整个名字都是噪声）时返回空串，调用方回落原名
pub fn clean_folder_title(folder: &str) -> String {
    let no_brackets = RE_TITLE_BRACKETS.replace_all(folder, " ");
    let no_noise = RE_TITLE_NOISE.replace_all(&no_brackets, " ");
    no_noise
        .replace(['.', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches('-')
        .trim()
        .to_string()
}

/// 解析文件名 → (季, 集, 季号是否可信)。六个正则按优先级首个命中即停；全不命中返回 None。
/// 第三个返回值 = 季号来自文件名内的 SxxExx/1x01（可信），false 表示季号是硬编码的 1，
/// 调用方可用父目录名（`Season 2`）兜底
fn parse_episode(file_name: &str) -> Option<(i32, i32, bool)> {
    if let Some(c) = RE_S_E.captures(file_name) {
        Some((c[1].parse().unwrap_or(1), c[2].parse().unwrap_or(1), true))
    } else if let Some(c) = RE_X.captures(file_name) {
        Some((c[1].parse().unwrap_or(1), c[2].parse().unwrap_or(1), true))
    } else if let Some(c) = RE_EP.captures(file_name) {
        Some((1, c[1].parse().unwrap_or(1), false))
    } else if let Some(c) = RE_CHINESE.captures(file_name) {
        Some((1, c[1].parse().unwrap_or(1), false))
    } else if let Some(c) = RE_BRACKET.captures(file_name) {
        Some((1, c[1].parse().unwrap_or(1), false))
    } else if let Some(c) = RE_NUMBER.captures(file_name) {
        Some((1, c[1].parse().unwrap_or(1), false))
    } else {
        None
    }
}

// ─────────────────────────────────────────────
// 路径分隔符
// ─────────────────────────────────────────────

/// 本模块内部（含 `local_path`、`ScannedVideo::rel_path`）一律用反斜杠分隔，
/// 但 smb2 crate 只认正斜杠——传反斜杠会得到 STATUS_OBJECT_NAME_NOT_FOUND
/// （实测：`恶搞之家/恶搞之家：第6季` 列得出 16 条，`恶搞之家\恶搞之家：第6季` 直接报错；
/// 顶层目录没有分隔符所以看起来是好的，一往下钻就全军覆没）。
/// 所以每个进 smb2 的路径都过一遍这里，内部约定不动。
fn to_smb_path(path: &str) -> String {
    path.replace('\\', "/")
}

// ─────────────────────────────────────────────
// 连接辅助
// ─────────────────────────────────────────────

// connect_by_id 接收已读出的 SmbServer（调用方先短锁读出再释放，避免 db guard 跨 await）
async fn connect(server: SmbServer) -> AppResult<SmbClient> {
    let addr = format!("{}:{}", server.host, server.port);
    let client = SmbClient::connect(ClientConfig {
        addr,
        username: server.username.clone(),
        password: server.password.clone(),
        timeout: std::time::Duration::from_secs(15),
        domain: String::new(),
        auto_reconnect: true,
        compression: false,
        dfs_enabled: false,
        dfs_target_overrides: std::collections::HashMap::new(),
    })
    .await
    .map_err(|e| AppError::Custom(format!("SMB 连接失败：{e}")))?;
    Ok(client)
}

/// 短锁读 server 配置（不跨 await）
pub fn read_server(conn: &rusqlite::Connection, server_id: &str) -> AppResult<SmbServer> {
    db::smb_server_by_id(conn, server_id)
}

// ─────────────────────────────────────────────
// 命令实现（被 commands.rs 调用，全部 async）
// ─────────────────────────────────────────────

/// 列出某服务器的所有共享
pub async fn list_shares(server: SmbServer) -> AppResult<Vec<SmbShareInfoDto>> {
    let mut client = connect(server).await?;
    let shares = client
        .list_shares()
        .await
        .map_err(|e| AppError::Custom(format!("列共享失败：{e}")))?;
    Ok(shares.into_iter().map(|s| SmbShareInfoDto { name: s.name, comment: s.comment }).collect())
}

/// 列出某共享下某路径的目录条目（path 为空 = 共享根）。过滤掉 . 和 ..
pub async fn list_directory(
    server: SmbServer,
    share: &str,
    path: &str,
) -> AppResult<Vec<SmbDirEntryDto>> {
    let mut client = connect(server).await?;
    let mut tree = client
        .connect_share(share)
        .await
        .map_err(|e| AppError::Custom(format!("连接共享 {share} 失败：{e}")))?;
    let entries = client
        .list_directory(&mut tree, &to_smb_path(path))
        .await
        .map_err(|e| AppError::Custom(format!("列目录失败：{e}")))?;
    Ok(entries
        .into_iter()
        .filter(|e| e.name != "." && e.name != "..")
        .map(SmbDirEntryDto::from)
        .collect())
}

/// 扫描某 SMB 文件夹下的所有视频文件，解析季集后返回。
/// 返回 ScannedVideo 列表（含相对路径、文件名、季、集），按 (season, episode) 排序。
pub async fn scan_video_files(
    server: SmbServer,
    share: &str,
    root: &str,
) -> AppResult<Vec<ScannedVideo>> {
    let mut client = connect(server).await?;
    let tree = client
        .connect_share(share)
        .await
        .map_err(|e| AppError::Custom(format!("连接共享 {share} 失败：{e}")))?;
    let mut out = Vec::new();
    // 显式栈迭代（async fn 不能直接递归，且 BFS/DFS 用栈更可控）。
    // 栈元素带「从 root 往下遇到的最近一个季目录号」：`恶搞之家\Season 2\01.mkv`
    // 这类文件名给不出季号，靠它兜底（否则各季的 01 全撞进第 1 季）
    let mut stack: Vec<(String, Option<i32>)> = vec![(root.to_string(), None)];
    // 列目录失败的原因（首个）：全扫下来一个视频都没有时，比「没发现视频文件」有用得多
    let mut first_err: Option<String> = None;
    while let Some((current, dir_season)) = stack.pop() {
        let mut tree_mut = tree.clone();
        let entries = match client.list_directory(&mut tree_mut, &to_smb_path(&current)).await {
            Ok(e) => e,
            Err(e) => {
                log::warn!("SMB 列目录失败 {current}: {e}");
                if first_err.is_none() {
                    first_err = Some(format!("{current}: {e}"));
                }
                continue;
            }
        };
        for entry in entries {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let child_path = if current.is_empty() {
                entry.name.clone()
            } else {
                format!("{current}\\{}", entry.name)
            };
            if entry.is_directory {
                if child_path.matches('\\').count() < 12 {
                    // 子目录自己是季目录就更新季号，否则沿用上层的（深层目录也能继承）
                    let next_season = parse_dir_season(&entry.name).or(dir_season);
                    stack.push((child_path, next_season));
                }
            } else if is_video(&entry.name) {
                if let Some((season, episode, season_trusted)) = parse_episode(&entry.name) {
                    // 文件名带 SxxExx 时以它为准；否则用父目录季号兜底
                    let season = if season_trusted { season } else { dir_season.unwrap_or(season) };
                    out.push(ScannedVideo {
                        rel_path: child_path,
                        file_name: entry.name,
                        season,
                        episode,
                        size: entry.size,
                    });
                }
            }
        }
    }
    // 一个都没扫到、且中途有列目录失败：把首个错误报出去。
    // 否则调用方只能说「没发现视频文件」，把权限/路径/编码问题全掩盖成同一句话
    if out.is_empty() {
        if let Some(e) = first_err {
            return Err(AppError::Custom(format!("扫描失败——{e}")));
        }
    }
    out.sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
    dedup_episodes(&mut out);
    Ok(out)
}

/// 同一 (季, 集) 有多个文件时只留一个——实测 NAS 上很常见：
/// 同集两个压制组（「霸王龙压制组」与「CHAOSPACE」各一份），或下载重复留下的
/// `xxx.mp4` + `xxx(1).mp4`。不去重就会给同一集插两条记录，详情页出现两个「第 12 集」。
///
/// 取舍规则（依次）：非 `(n)` 副本优先 → 文件大的优先（通常画质更好）→ 文件名字典序
/// （纯粹为了结果稳定：同样的 NAS 内容每次扫描要得到同样的选择）。
/// 要求入参已按 (season, episode) 排好序。
fn dedup_episodes(list: &mut Vec<ScannedVideo>) {
    // 先在每个 (季,集) 分组内把「最该留的」排到最前，再按 (季,集) 去重
    list.sort_by(|a, b| {
        a.season
            .cmp(&b.season)
            .then(a.episode.cmp(&b.episode))
            .then(is_dup_copy(&a.file_name).cmp(&is_dup_copy(&b.file_name)))
            .then(b.size.cmp(&a.size))
            .then(a.file_name.cmp(&b.file_name))
    });
    list.dedup_by(|a, b| a.season == b.season && a.episode == b.episode);
}

// 下载器给重名文件加的尾巴：`片名(1).mp4` / `片名 (2).mkv`。
// 同集里有原件时它就该被丢掉
static RE_DUP_COPY: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"\s*\(\d+\)\s*$").unwrap()
});

fn is_dup_copy(file_name: &str) -> bool {
    RE_DUP_COPY.is_match(&strip_ext(file_name))
}

#[derive(Debug, Clone)]
pub struct ScannedVideo {
    /// 相对共享根的完整路径（反斜杠分隔，如 "剧名\Season 1\ep01.mkv"）
    pub rel_path: String,
    pub file_name: String,
    pub season: i32,
    pub episode: i32,
    /// 字节数，同集多版本去重时选大的那个
    pub size: u64,
}

/// 去掉文件名扩展名（集标题入库用，与桌面版 `title: file_name.replace(/\.[^./\\]+$/, '')` 一致）
pub fn strip_ext(file_name: &str) -> String {
    match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.contains(['/', '\\']) => stem.to_string(),
        _ => file_name.to_string(),
    }
}

fn is_video(name: &str) -> bool {
    let lower = name.to_lowercase();
    VIDEO_EXTS.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

// ─────────────────────────────────────────────
// local_path 编解码
// ─────────────────────────────────────────────

/// 拼接 episodes.local_path：server_id\share\相对路径
pub fn build_local_path(server_id: &str, share: &str, rel_path: &str) -> String {
    if rel_path.is_empty() {
        format!("{server_id}\\{share}")
    } else {
        format!("{server_id}\\{share}\\{rel_path}")
    }
}

/// 解析 local_path → (server_id, share, 相对路径)
pub fn parse_local_path(local_path: &str) -> Option<(String, String, String)> {
    let parts: Vec<&str> = local_path.splitn(3, '\\').collect();
    if parts.len() < 2 {
        return None;
    }
    let server_id = parts[0].to_string();
    let share = parts[1].to_string();
    let rel = if parts.len() == 3 { parts[2].to_string() } else { String::new() };
    Some((server_id, share, rel))
}

/// 从库里取服务器，连接并打开 FileReader（M3 流媒体服务用）。
pub async fn open_reader(
    server: SmbServer,
    share: &str,
    rel_path: &str,
) -> AppResult<smb2::FileReader> {
    let mut client = connect(server).await?;
    let tree = client
        .connect_share(share)
        .await
        .map_err(|e| AppError::Custom(format!("连接共享 {share} 失败：{e}")))?;
    client
        .open_file_reader(&tree, &to_smb_path(rel_path))
        .await
        .map_err(|e| AppError::Custom(format!("打开文件 {rel_path} 失败：{e}")))
}

// 编码 host 给 URL 用——暂留，stream_server 可能需要
#[allow(dead_code)]
pub fn encode_host(host: &str) -> String {
    encode(host).to_string()
}

// 一次性诊断 #3：跑修好后的 scan_video_files，看真实 NAS 上的扫描结果。
// 验证两件事：(1) 反斜杠→正斜杠修好后能不能扫到文件；(2) 22 季的季号解析对不对
// （文件名给不出季号时，靠父目录名「恶搞之家：第6季」兜底）。
//
// lib.rs 里 mod smb/db 都是私有的，为诊断放宽可见性不值得——用 #[path] 把源文件
// 直接编进这个 example。smb.rs 依赖 db、AppError、AppResult，所以一并接上。

#[path = "../src/db.rs"]
mod db;
#[path = "../src/smb.rs"]
mod smb;

// smb.rs 用 `use crate::{AppError, AppResult}`，在 example 里 crate 根就是本文件
pub use error::{AppError, AppResult};

mod error {
    #[derive(Debug, thiserror::Error)]
    pub enum AppError {
        #[error("{0}")]
        Custom(String),
        #[error(transparent)]
        Sqlite(#[from] rusqlite::Error),
    }
    pub type AppResult<T> = Result<T, AppError>;
}

use db::SmbServer;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let share = args.get(1).cloned().unwrap_or_else(|| "硬盘1".into());
    let root = args.get(2).cloned().unwrap_or_else(|| "恶搞之家".into());

    let server = SmbServer {
        id: "diag".into(),
        name: "diag".into(),
        host: "192.168.5.151".into(),
        port: 445,
        username: "雨泽小鱼".into(),
        password: "Myt200761".into(),
        created_at: String::new(),
    };

    println!("== 扫描 {share}\\{root} ==");
    let t0 = std::time::Instant::now();
    let scanned = match smb::scan_video_files(server, &share, &root).await {
        Ok(s) => s,
        Err(e) => {
            println!("!! 扫描失败: {e}");
            return;
        }
    };
    println!("扫到 {} 个视频文件，耗时 {:?}\n", scanned.len(), t0.elapsed());

    if scanned.is_empty() {
        println!("!! 空结果");
        return;
    }

    // 按季汇总：季号是否连续、每季几集、集号有没有撞车
    let mut by_season: std::collections::BTreeMap<i32, Vec<&smb::ScannedVideo>> = Default::default();
    for v in &scanned {
        by_season.entry(v.season).or_default().push(v);
    }
    println!("== 分季汇总（{} 季）==", by_season.len());
    for (season, vids) in &by_season {
        let mut eps: Vec<i32> = vids.iter().map(|v| v.episode).collect();
        eps.sort_unstable();
        let uniq = {
            let mut u = eps.clone();
            u.dedup();
            u.len()
        };
        println!(
            "  第 {season} 季: {} 集, 集号 {}..{}{}",
            vids.len(),
            eps.first().unwrap_or(&0),
            eps.last().unwrap_or(&0),
            if eps.len() > uniq {
                format!("  !! {} 个集号重复", eps.len() - uniq)
            } else {
                String::new()
            }
        );
    }

    println!("\n== 抽样（看 rel_path 与解析结果）==");
    for v in scanned.iter().take(3) {
        println!("  S{:02}E{:02}  {}", v.season, v.episode, v.rel_path);
    }
    for v in scanned.iter().rev().take(2) {
        println!("  S{:02}E{:02}  {}", v.season, v.episode, v.rel_path);
    }

    println!("\n== 标题清洗 ==");
    println!("  剧名 {root:?} -> {:?}", smb::clean_folder_title(&root));
    println!("  集标题 -> {:?}", smb::strip_ext(&scanned[0].file_name));
}

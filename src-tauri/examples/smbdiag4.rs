// 一次性诊断 #4：查真实扫描结果里的三处异常。
//   (1) 第 1 季只 6 集且从 E02 起（别的季都是 1..N）——文件是不是本来就少？
//   (2) 第 21 季 5 个集号重复——同季同集号多文件（多版本？花絮？特典？）
//   (3) 第 11、18 季集数比集号范围少 1——中间缺集，还是有文件没被认出来？
// 关键：把「目录里所有文件」和「被 parse_episode 认出来的」两边对比，
// 才能区分「NAS 上就没有」和「有但正则没认出来」。

#[path = "../src/db.rs"]
mod db;
#[path = "../src/smb.rs"]
mod smb;

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

use smb2::{ClientConfig, SmbClient};

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "rmvb",
];
fn is_video(name: &str) -> bool {
    let l = name.to_lowercase();
    VIDEO_EXTS.iter().any(|e| l.ends_with(&format!(".{e}")))
}

#[tokio::main]
async fn main() {
    let server = db::SmbServer {
        id: "diag".into(),
        name: "diag".into(),
        host: "192.168.5.151".into(),
        port: 445,
        username: "雨泽小鱼".into(),
        password: "Myt200761".into(),
        created_at: String::new(),
    };

    // 先跑一次正式扫描，拿到「被认出来的」集合
    let scanned = smb::scan_video_files(server, "硬盘1", "恶搞之家")
        .await
        .expect("扫描失败");
    let recognized: std::collections::HashSet<String> =
        scanned.iter().map(|v| v.rel_path.clone()).collect();

    // 再自己裸列一遍目录，拿到「目录里所有视频文件」
    let mut client = SmbClient::connect(ClientConfig {
        addr: "192.168.5.151:445".into(),
        username: "雨泽小鱼".into(),
        password: "Myt200761".into(),
        timeout: std::time::Duration::from_secs(15),
        domain: String::new(),
        auto_reconnect: true,
        compression: false,
        dfs_enabled: false,
        dfs_target_overrides: std::collections::HashMap::new(),
    })
    .await
    .expect("连接失败");
    let mut tree = client.connect_share("硬盘1").await.expect("连共享失败");

    for season_dir in ["恶搞之家：第1季", "恶搞之家：第21季", "恶搞之家：第11季"] {
        let path = format!("恶搞之家/{season_dir}");
        println!("\n=== {season_dir} ===");
        let entries = match client.list_directory(&mut tree, &path).await {
            Ok(e) => e,
            Err(e) => {
                println!("  列目录失败: {e}");
                continue;
            }
        };
        let vids: Vec<&smb2::DirectoryEntry> =
            entries.iter().filter(|e| is_video(&e.name)).collect();
        let others: Vec<&smb2::DirectoryEntry> = entries
            .iter()
            .filter(|e| !e.is_directory && !is_video(&e.name))
            .collect();
        let subdirs: Vec<&smb2::DirectoryEntry> = entries
            .iter()
            .filter(|e| e.is_directory && e.name != "." && e.name != "..")
            .collect();

        println!(
            "  视频 {} 个, 非视频文件 {} 个, 子目录 {} 个",
            vids.len(),
            others.len(),
            subdirs.len()
        );
        if !subdirs.is_empty() {
            println!("  子目录: {:?}", subdirs.iter().map(|e| &e.name).collect::<Vec<_>>());
        }

        // 逐个视频文件：被认成了 SxxExx 几，还是压根没认出来
        let mut miss = 0;
        for v in &vids {
            let rel = format!("恶搞之家\\{season_dir}\\{}", v.name);
            if recognized.contains(&rel) {
                let hit = scanned.iter().find(|s| s.rel_path == rel).unwrap();
                println!("    S{:02}E{:02}  {}", hit.season, hit.episode, v.name);
            } else {
                miss += 1;
                println!("    !!未识别!!  {}", v.name);
            }
        }
        if miss > 0 {
            println!("  => {miss} 个视频文件没被 parse_episode 认出来");
        }
    }

    // 第 21 季重复集号：把撞车的挑出来看文件名差别
    println!("\n=== 第 21 季集号撞车明细 ===");
    let s21: Vec<&smb::ScannedVideo> = scanned.iter().filter(|v| v.season == 21).collect();
    let mut by_ep: std::collections::BTreeMap<i32, Vec<&smb::ScannedVideo>> = Default::default();
    for v in &s21 {
        by_ep.entry(v.episode).or_default().push(v);
    }
    for (ep, vs) in by_ep.iter().filter(|(_, vs)| vs.len() > 1) {
        println!("  E{ep:02} 有 {} 个文件:", vs.len());
        for v in vs {
            println!("      {}", v.file_name);
        }
    }
}

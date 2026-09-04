// 一次性诊断：直连 NAS，列共享 → 列根目录 → 进第一层子目录，打印每一步的真实错误。
// 存在的理由：scan_video_files 里列目录失败是 log::warn! + continue，在 Android 上
// 完全静默，最后只报「该文件夹没有发现视频文件」，分不清是真没文件还是列目录炸了。
//
// 跑法（宿主机，和 NAS 同网段）：
//   cargo run --example smbdiag [共享名] [子目录名]

use smb2::{ClientConfig, SmbClient};

const HOST: &str = "192.168.5.151";
const PORT: u16 = 445;
const USER: &str = "雨泽小鱼";
const PASS: &str = "Myt200761";

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "rmvb",
];

fn is_video(name: &str) -> bool {
    let lower = name.to_lowercase();
    VIDEO_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let want_share = args.get(1).cloned();
    let want_dir = args.get(2).cloned();

    println!("== 连接 {HOST}:{PORT} 用户 {USER} ==");
    let mut client = match SmbClient::connect(ClientConfig {
        addr: format!("{HOST}:{PORT}"),
        username: USER.to_string(),
        password: PASS.to_string(),
        timeout: std::time::Duration::from_secs(15),
        domain: String::new(),
        auto_reconnect: true,
        compression: false,
        dfs_enabled: false,
        dfs_target_overrides: std::collections::HashMap::new(),
    })
    .await
    {
        Ok(c) => c,
        Err(e) => {
            println!("!! 连接失败: {e}");
            return;
        }
    };
    println!("连接成功");

    let shares = match client.list_shares().await {
        Ok(s) => s,
        Err(e) => {
            println!("!! 列共享失败: {e}");
            return;
        }
    };
    println!("\n== 共享 ({}) ==", shares.len());
    for s in &shares {
        println!("  [{}] {}", s.name, s.comment);
    }

    // 选共享：命令行指定优先，否则跳过管理共享（IPC$/ADMIN$/C$ 之类）取第一个
    let share = match want_share.or_else(|| {
        shares
            .iter()
            .map(|s| s.name.clone())
            .find(|n| !n.ends_with('$'))
    }) {
        Some(s) => s,
        None => {
            println!("!! 没有可用共享");
            return;
        }
    };
    println!("\n== 使用共享: {share} ==");

    let mut tree = match client.connect_share(&share).await {
        Ok(t) => t,
        Err(e) => {
            println!("!! 连接共享失败: {e}");
            return;
        }
    };

    // 共享根 —— 用空串，和 scan_video_files 的 root="" 一致
    println!("\n== 列共享根 (path=\"\") ==");
    let root_entries = match client.list_directory(&mut tree, "").await {
        Ok(e) => e,
        Err(e) => {
            println!("!! 列根目录失败: {e}");
            return;
        }
    };
    for e in &root_entries {
        println!(
            "  {} {}{}",
            if e.is_directory { "[目录]" } else { "[文件]" },
            e.name,
            if is_video(&e.name) { "  <- 视频" } else { "" }
        );
    }

    // 选子目录：命令行指定优先，否则第一个非 . / .. 的目录
    let dir = match want_dir.or_else(|| {
        root_entries
            .iter()
            .filter(|e| e.is_directory && e.name != "." && e.name != "..")
            .map(|e| e.name.clone())
            .next()
    }) {
        Some(d) => d,
        None => {
            println!("\n根目录下没有子目录，诊断结束");
            return;
        }
    };

    // 关键一步：add_series_by_smb 传的就是这种「子目录名」路径。
    // 三种写法都试——不确定 smb2 要哪种，报错文本会告诉我们
    println!("\n== 列子目录，三种路径写法各试一次 ==");
    for p in [dir.clone(), format!("{dir}\\"), format!("\\{dir}")] {
        print!("  path={p:?} -> ");
        let mut t = tree.clone();
        match client.list_directory(&mut t, &p).await {
            Ok(entries) => {
                let vids = entries.iter().filter(|e| is_video(&e.name)).count();
                let dirs = entries.iter().filter(|e| e.is_directory).count();
                println!("OK, {} 条（{dirs} 目录, {vids} 视频）", entries.len());
                for e in entries.iter().take(8) {
                    println!(
                        "        {} {}{}",
                        if e.is_directory { "[目录]" } else { "[文件]" },
                        e.name,
                        if is_video(&e.name) { "  <- 视频" } else { "" }
                    );
                }
                if entries.len() > 8 {
                    println!("        ...（省略 {} 条）", entries.len() - 8);
                }
            }
            Err(e) => println!("失败: {e}"),
        }
    }

    // 再往下钻一层：季目录里的文件名长什么样，决定季集正则能不能命中
    println!("\n== 钻一层（{dir} 的第一个子目录）==");
    let mut t = tree.clone();
    if let Ok(entries) = client.list_directory(&mut t, &dir).await {
        if let Some(sub) = entries
            .iter()
            .find(|e| e.is_directory && e.name != "." && e.name != "..")
        {
            let p = format!("{dir}\\{}", sub.name);
            print!("  path={p:?} -> ");
            let mut t2 = tree.clone();
            match client.list_directory(&mut t2, &p).await {
                Ok(sub_entries) => {
                    let vids = sub_entries.iter().filter(|e| is_video(&e.name)).count();
                    println!("OK, {} 条（{vids} 视频）", sub_entries.len());
                    for e in sub_entries.iter().take(8) {
                        println!(
                            "        {} {}{}",
                            if e.is_directory { "[目录]" } else { "[文件]" },
                            e.name,
                            if is_video(&e.name) { "  <- 视频" } else { "" }
                        );
                    }
                }
                Err(e) => println!("失败: {e}"),
            }
        } else {
            println!("  没有子目录（视频文件应该直接躺在 {dir} 下）");
        }
    }
}

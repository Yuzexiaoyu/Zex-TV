// 一次性诊断 #2：为什么 `恶搞之家\恶搞之家：第6季` 列不出来。
// 列 `恶搞之家` 能拿到 22 个季目录，但拼上任何一个季目录名再列就 STATUS_OBJECT_NAME_NOT_FOUND。
// 嫌疑：目录名里的全角冒号「：」或其它非 ASCII 字符在拼路径/编码环节被搞坏了。
// 做法：把 list_directory 返回的 name 逐字节打出来，再用不同拼法各试一次。

use smb2::{ClientConfig, SmbClient};

#[tokio::main]
async fn main() {
    let mut client = SmbClient::connect(ClientConfig {
        addr: "192.168.5.151:445".to_string(),
        username: "雨泽小鱼".to_string(),
        password: "Myt200761".to_string(),
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

    let entries = client
        .list_directory(&mut tree, "恶搞之家")
        .await
        .expect("列 恶搞之家 失败");

    let dirs: Vec<String> = entries
        .iter()
        .filter(|e| e.is_directory && e.name != "." && e.name != "..")
        .map(|e| e.name.clone())
        .collect();

    println!("== 恶搞之家 下的 {} 个子目录，逐字符看 ==", dirs.len());
    for name in dirs.iter().take(3) {
        println!("  name = {name:?}");
        println!("    chars: {:?}", name.chars().collect::<Vec<_>>());
        println!("    utf8 bytes: {:?}", name.as_bytes());
        println!("    len={} chars={}", name.len(), name.chars().count());
    }

    let first = &dirs[0];

    // 各种拼法：看是「拼接」错了还是「这个名字本身」服务端不认
    println!("\n== 拼法对比 ==");
    let candidates: Vec<(String, String)> = vec![
        ("反斜杠拼接（当前实现）".into(), format!("恶搞之家\\{first}")),
        ("正斜杠拼接".into(), format!("恶搞之家/{first}")),
        ("只用子目录名（不带父）".into(), first.clone()),
    ];
    for (label, p) in candidates {
        print!("  {label}: {p:?} -> ");
        let mut t = tree.clone();
        match client.list_directory(&mut t, &p).await {
            Ok(es) => println!("OK, {} 条", es.len()),
            Err(e) => println!("失败: {e}"),
        }
    }

    // 换个不带全角冒号的目录试试：权力的游戏那个文件夹名里有方括号但没有冒号
    println!("\n== 对照组：另一个顶层目录（名字里没有全角冒号）==");
    let root = client.list_directory(&mut tree, "").await.expect("列根失败");
    for e in root
        .iter()
        .filter(|e| e.is_directory && !e.name.starts_with('.') && !e.name.starts_with('#'))
    {
        print!("  {:?} -> ", e.name);
        let mut t = tree.clone();
        match client.list_directory(&mut t, &e.name).await {
            Ok(es) => {
                println!("OK, {} 条", es.len());
                // 再钻一层，看是不是所有二层都失败
                if let Some(sub) = es
                    .iter()
                    .find(|s| s.is_directory && s.name != "." && s.name != "..")
                {
                    let p = format!("{}\\{}", e.name, sub.name);
                    print!("      二层 {p:?} -> ");
                    let mut t2 = tree.clone();
                    match client.list_directory(&mut t2, &p).await {
                        Ok(es2) => println!("OK, {} 条", es2.len()),
                        Err(err) => println!("失败: {err}"),
                    }
                }
            }
            Err(err) => println!("失败: {err}"),
        }
    }
}

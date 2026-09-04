// 一次性诊断 #5：TMDB 刮削链路端到端。
// 现象是真机上「没成功获取数据」，但 API Key 已内置、curl 直连 200，
// 所以要逐段跑一遍看断在哪：搜索 → 详情 → 季详情 → 图片下载。
// 用 tmdb.rs 里同样的 URL 拼法和同样的 reqwest 配置（15s 超时、无代理）。

use std::time::Duration;

const KEY: &str = "b55f6dfddd74ecddfc53144c69d4c62d";
const BASE: &str = "https://api.tmdb.org/3";
const IMG: &str = "https://image.tmdb.org/t/p";

#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("build client");

    // ── 1. 搜索：入库标题就是「恶搞之家」（clean_folder_title 后没变） ──
    println!("== 1. search/tv ==");
    for q in ["恶搞之家", "权力的游戏8季 + 龙族前传2季"] {
        let url = format!(
            "{BASE}/search/tv?query={}&api_key={KEY}&language=zh-CN",
            urlencoding::encode(q)
        );
        match client.get(&url).send().await {
            Ok(r) => {
                let st = r.status();
                let body = r.text().await.unwrap_or_default();
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                let first = v["results"].get(0);
                println!(
                    "  {q:?} -> HTTP {st}, 命中 {} 条, 第一条: id={:?} name={:?}",
                    v["results"].as_array().map(|a| a.len()).unwrap_or(0),
                    first.map(|f| f["id"].clone()),
                    first.map(|f| f["name"].clone()),
                );
            }
            Err(e) => println!("  {q:?} -> 请求失败: {e}  (is_timeout={})", e.is_timeout()),
        }
    }

    // ── 2. 剧集详情（Family Guy = 1434） ──
    println!("\n== 2. tv/1434 详情 ==");
    let url = format!("{BASE}/tv/1434?api_key={KEY}&language=zh-CN");
    match client.get(&url).send().await {
        Ok(r) => {
            let st = r.status();
            let v: serde_json::Value = r.json().await.unwrap_or_default();
            println!("  HTTP {st}");
            println!("  name={:?}", v["name"]);
            println!("  poster_path={:?}  backdrop_path={:?}", v["poster_path"], v["backdrop_path"]);
            println!("  number_of_seasons={:?}", v["number_of_seasons"]);
            println!("  overview 长度={}", v["overview"].as_str().unwrap_or("").chars().count());
            println!(
                "  seasons 数组={} 条",
                v["seasons"].as_array().map(|a| a.len()).unwrap_or(0)
            );
        }
        Err(e) => println!("  失败: {e}"),
    }

    // ── 3. 季详情（第 1 季） ──
    println!("\n== 3. tv/1434/season/1 ==");
    let url = format!("{BASE}/tv/1434/season/1?api_key={KEY}&language=zh-CN");
    match client.get(&url).send().await {
        Ok(r) => {
            let st = r.status();
            let v: serde_json::Value = r.json().await.unwrap_or_default();
            let eps = v["episodes"].as_array().cloned().unwrap_or_default();
            println!("  HTTP {st}, episodes={} 条", eps.len());
            for e in eps.iter().take(3) {
                println!(
                    "    E{:?} {:?} still={:?}",
                    e["episode_number"], e["name"], e["still_path"]
                );
            }
        }
        Err(e) => println!("  失败: {e}"),
    }

    // ── 4. 图片下载：这一步最可能在电视上炸（CDN 域名不同） ──
    println!("\n== 4. 图片下载 image.tmdb.org ==");
    let url = format!("{BASE}/tv/1434?api_key={KEY}&language=zh-CN");
    let poster = match client.get(&url).send().await {
        Ok(r) => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v["poster_path"].as_str().map(String::from)),
        Err(_) => None,
    };
    match poster {
        Some(p) => {
            let img_url = format!("{IMG}/w500{p}");
            println!("  URL: {img_url}");
            match client.get(&img_url).send().await {
                Ok(r) => {
                    let st = r.status();
                    let bytes = r.bytes().await.map(|b| b.len()).unwrap_or(0);
                    println!("  -> HTTP {st}, {bytes} 字节");
                }
                Err(e) => println!("  -> 下载失败: {e}  (is_timeout={})", e.is_timeout()),
            }
        }
        None => println!("  拿不到 poster_path，跳过"),
    }
}

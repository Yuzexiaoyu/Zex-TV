// 本地 HTTP 流媒体服务（M3）：tiny_http 在 127.0.0.1:8765 起 HTTP 服务，
// 把 SMB 文件通过 FileReader read_at 转成可 Range 请求的 HTTP 流，喂给系统播放器。
//
// 播放链路：
//   前端 playEpisode(episodeId)
//   → 后端查 episode.local_path → 拆 server_id/share/rel_path → 连 SMB 开 FileReader
//   → tiny_http 起服务（流式分块转发）→ ACTION_VIEW + video/* 拉起系统播放器
//     （Windows 走 opener；Android 走 JNI 调 PlayerLauncher，见 launch_player）
//   → 播放器退出、用户回到 App（RunEvent Resumed，见 lib.rs）→ 弹「看完了吗」
//
// 设计要点（v2 重写，修掉 v1 的四个致命问题）：
//   1. 流式响应：v1 把 Range 的整个区间一次性 read_at 进 Vec——`bytes=0-` 直接
//      分配整个文件（数 GB）的内存，电视必 OOM。现在自定义 Read 适配器按
//      CHUNK（512KB）分块从 SMB 拉数据，tiny_http 的 raw_print 走 io::copy
//      边拉边写 socket，内存峰值 ≈ 一个块。
//   2. 生命周期：v1 的 stop_active 只摘 ACTIVE 里的 Arc，serve_loop 线程自己
//      还 clone 着 Arc → Server 永不 Drop → 端口 8765 占死，第二次播放
//      Server::http 直接 AddrInUse 必失败。现在改为「代际」模式：每次播放
//      生成新代（generation 计数），旧代通过 ActiveStream::Drop 主动关闭
//      （调 server.unblock() + 停标记，recv 立即返回 Err 退出循环），
//      等所有 Arc 引用（本函数/监听线程/各连接处理线程的 Response reader）
//      归零后 Server 自然 Drop，端口释放。play 前主动 drop ACTIVE 里的旧代并
//      短暂等待端口空闲，AddrInUse 时重试几轮兜底并发竞态。
//   3. 并发：v1 单线程串行处理请求——播放器并发开多条连接（探测+拉流）时，
//      一条大读卡住整条队列，其余连接超时黑屏。tiny_http 的 recv 是全局队列，
//      这里一个监听线程接请求、每个请求 spawn 独立线程处理，互不阻塞。
//   4. SMB 句柄：v1 的 FileReader 从不 close（smb2 的 Drop 不发 CLOSE，句柄
//      泄漏到会话结束，NAS 上限 8192 个打开文件迟早耗尽）。现在代际退出时
//      显式 close（close 消耗 self，用 Option 持有、take 后发送）。
//
// HTTP 细节：
//   - GET/HEAD 支持（ExoPlayer 系播放器会先 HEAD 探活；tiny_http 对 HEAD 自动不发 body）
//   - Range: bytes=start-end / start- / suffix 按规范解析，未知格式按全量 200 回
//   - 单块上限 4MB：个别播放器会发超大 Range（如整段），块内分批拉、绝不整段入内存
//
// 电视系统播放器进度不可回传，回 App 后弹「看完了吗」确认框手动标记（前端处理）。

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server};

use crate::db;
use crate::smb;
use crate::{AppError, AppResult, AppState};

/// SMB → 内存的单块大小：太小网络往返多吞吐低，太大占内存+播放器首块慢。512KB 实测均衡
const CHUNK: u64 = 512 * 1024;

// 全局：当前活跃的流（同一时刻只服务一个播放会话）。
// 每次播放新起一代；旧代由 play_episode 显式 retire，等引用归零自然清理
struct ActiveStream {
    server: Server,
    /// SMB reader。close 消耗 self，用 Option 持有以便代际退出时取出发 CLOSE。
    /// 读取路径只借 &self（read_at 是 &self），Mutex 只为 take() 时的独占。
    reader: Mutex<Option<smb2::FileReader>>,
    size: u64,
    content_type: String,
    /// 停止标记：置位后监听线程退出 recv 循环、响应 reader 停止继续拉数据
    stopped: AtomicBool,
    /// 全局代际计数：跨代关闭时避免误关新代
    generation: u64,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE: Mutex<Option<Arc<ActiveStream>>> = Mutex::new(None);

/// 播放一集：开 SMB reader → 起 HTTP 流 → 拉起系统播放器
pub async fn play_episode(state: &AppState, app: &AppHandle, episode_id: &str) -> AppResult<()> {
    // 查 episode 的 local_path + series media_type
    let local_path = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT local_path FROM episodes WHERE id = ?1",
            [episode_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| AppError::Custom("剧集不存在".into()))?
    };
    if local_path.is_empty() {
        return Err(AppError::Custom("该集还没有关联本地视频文件".into()));
    }

    let (server_id, share, rel_path) = smb::parse_local_path(&local_path)
        .ok_or_else(|| AppError::Custom(format!("local_path 格式无效：{local_path}")))?;

    // 开 SMB reader（先短锁读 server 配置，释放锁再 await）
    let server = {
        let conn = state.db.lock();
        db::smb_server_by_id(&conn, &server_id)?
    };
    let reader = smb::open_reader(server, &share, &rel_path).await?;
    let size = reader.size();
    if size == 0 {
        return Err(AppError::Custom("视频文件为空（0 字节）".into()));
    }
    let content_type = guess_content_type(&rel_path);
    // 意图 MIME 按扩展名给具体类型（如 video/mp4）：intent 带具体类型时，过滤器
    // 只声明 video/* 的播放器也接得住；反过来 intent 带 video/* 时，只声明具体
    // 类型的播放器（电视自带常见）匹配不上——Android 意图匹配只认过滤器侧通配。
    // 此处先算成 owned String：content_type 随后 move 进 ActiveStream
    let intent_mime = match content_type.as_str() {
        "application/octet-stream" => "video/*".to_string(), // 未知扩展名退通配
        ct => ct.to_string(),
    };

    // 停掉旧代（释放 SMB 句柄 + 让旧请求尽快收尾）
    retire_active();

    // 起服务：绑 127.0.0.1:0（系统分配随机空闲端口），从 server_addr 取实际端口。
    // v1 固定 8765：旧代引用未归零时端口仍被占，第二次播放 AddrInUse 必失败；
    // 随机端口从根上消除这一竞态，不再需要等待/重试
    let http = Server::http("127.0.0.1:0")
        .map_err(|e| AppError::Custom(format!("起流服务失败：{e}")))?;
    let port = http
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| AppError::Custom("流服务地址解析失败".into()))?;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let stream = Arc::new(ActiveStream {
        server: http,
        reader: Mutex::new(Some(reader)),
        size,
        content_type,
        stopped: AtomicBool::new(false),
        generation,
    });
    *ACTIVE.lock() = Some(stream.clone());

    // 拿当前 tokio runtime handle，供同步线程里 block_on 调 async read_at
    let runtime_handle = tokio::runtime::Handle::current();

    // 监听线程：只负责从队列收请求，每个请求 spawn 独立线程处理
    // （tiny_http 把所有连接的请求都推进同一个队列；串行处理会让一条大读
    //  卡死其它连接的探测请求 → 播放器超时黑屏）
    std::thread::spawn(move || {
        listen_loop(stream, runtime_handle);
    });

    // 拉起系统播放器。URL 必须带真实文件名：海信自带播放器靠 URL 扩展名识别
    // 容器格式，裸根路径 "/" 会被匹配到但秒退——「App 退后台、播放器不出画面」
    // 即此症状。文件名 percent-encode 进路径（服务端不校验路径，见 handle_request）
    let filename = rel_path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("video");
    let url = format!("http://127.0.0.1:{port}/{}", urlencoding::encode(filename));
    launch_player(app, &url, &intent_mime)?;

    // 回执改由 App 回前台触发（lib.rs 里 RunEvent Resumed → emit "app-resumed"，
    // 前端收到且有未回执的播放会话时弹「看完了吗」）。这里只登记当前会话：
    *CURRENT_EPISODE.lock().unwrap() = episode_id.to_owned();

    Ok(())
}

/// 当前播放会话（回执用）。空串 = 无会话。
/// 拉起播放器时写入；App 回前台时前端经 take_current_episode 取走（一次回执）
static CURRENT_EPISODE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// App 回前台 / 前端查询「当前有没有待回执的播放」时调用：
/// 有 → 返回 episode id 并清空（一次回执），无 → None
pub fn take_current_episode() -> Option<String> {
    let mut cur = CURRENT_EPISODE.lock().unwrap();
    let id = std::mem::take(&mut *cur);
    if id.is_empty() { None } else { Some(id) }
}

// ─────────────────────────────────────────────
// 服务循环（监听线程）
// ─────────────────────────────────────────────

fn listen_loop(stream: Arc<ActiveStream>, runtime_handle: tokio::runtime::Handle) {
    while !stream.stopped.load(Ordering::Acquire) {
        let request = match stream.server.recv() {
            Ok(r) => r,
            Err(_) => break, // server 被关闭（unblock / drop 路径）
        };
        let stream = stream.clone();
        let rt = runtime_handle.clone();
        std::thread::spawn(move || {
            handle_request(stream, rt, request);
        });
    }
    log::debug!("stream server 监听线程退出（gen={}）", stream.generation);
}

fn handle_request(stream: Arc<ActiveStream>, runtime_handle: tokio::runtime::Handle, request: tiny_http::Request) {
    // 只处理 GET/HEAD，其它回 405（HEAD：tiny_http 自动不发 body，只回头）
    let is_head = *request.method() == Method::Head;
    if !is_head && *request.method() != Method::Get {
        let _ = request.respond(Response::empty(405));
        return;
    }

    // 解析 Range 头（兼容 bytes=start-end / start- / suffix-length）
    let range_header: Option<String> = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let (start, end) = match parse_range(range_header.as_deref(), stream.size) {
        Some((s, e)) => {
            // end 开区间（bytes=N-）→ 到文件尾；闭区间夹到 size-1
            let e = e.unwrap_or(stream.size.saturating_sub(1)).min(stream.size.saturating_sub(1));
            (s, e)
        }
        None => (0, stream.size.saturating_sub(1)), // 不认识的格式按全量 200 回
    };
    if start > end || start >= stream.size {
        // 请求区间完全在文件外：按 RFC 回 416 + Content-Range 指明总量
        let mut resp = Response::empty(416);
        let _ = resp.add_header(
            Header::from_bytes(
                &b"Content-Range"[..],
                format!("bytes */{}", stream.size).as_bytes(),
            )
            .unwrap(),
        );
        let _ = request.respond(resp);
        return;
    }
    let length = end - start + 1;
    let status: u16 = if range_header.is_some() { 206 } else { 200 };

    // 流式 reader：SmbStreamReader 内部按 CHUNK 分块 read_at
    let body = SmbStreamReader {
        stream: stream.clone(),
        runtime_handle,
        offset: start,
        remaining: length,
        buffer: Vec::new(),
        buf_pos: 0,
    };

    let mut resp = Response::new(
        tiny_http::StatusCode::from(status),
        Vec::new(),
        body,
        Some(length as usize),
        None,
    );
    let _ = resp.add_header(
        Header::from_bytes(&b"Content-Type"[..], stream.content_type.as_bytes()).unwrap(),
    );
    let _ = resp.add_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap());
    let _ = resp.add_header(
        Header::from_bytes(
            &b"Content-Range"[..],
            format!("bytes {start}-{end}/{}", stream.size).as_bytes(),
        )
        .unwrap(),
    );
    let _ = request.respond(resp);
}

// ─────────────────────────────────────────────
// 流式 body：按块从 SMB 拉，不整段入内存
// ─────────────────────────────────────────────

/// Read 适配器：tiny_http 的 raw_print 对 body 走 io::copy —— 每次 read(buf)
/// 返回一小块。io::copy 的 buf 只有 8KB 级，若每 8KB 发一次 SMB READ 往返
/// 吞吐会被延迟拖垮；所以内部按 CHUNK（512KB）聚合：缓冲耗尽才走网络，
/// 从缓冲顺序拷给调用方。内存峰值 ≈ 一个块，与文件总大小无关（v1 是整个
/// Range 区间一次 read_at 进 Vec —— 播放器 `bytes=0-` 探测直接分配数 GB，OOM）。
///
/// 播放器拖进度条会弃掉旧连接：io::copy 遇 BrokenPipe/ConnectionReset 返回，
/// reader 随响应被 Drop，remaining 丢弃即停止拉取（v1 是继续把整段拉完）
struct SmbStreamReader {
    stream: Arc<ActiveStream>,
    runtime_handle: tokio::runtime::Handle,
    /// 当前块内的游标位置（绝对文件偏移）
    offset: u64,
    /// 本响应还剩多少字节
    remaining: u64,
    /// 块缓冲（SMB 拉回的 512KB），buf_pos 是已消费位置
    buffer: Vec<u8>,
    buf_pos: usize,
}

impl SmbStreamReader {
    /// 从 SMB 拉下一块填充 buffer。失败时返回 io 错误——tiny_http 的
    /// respond 会把半途断流如实写给播放器（比吞错误假装 EOF 好：
    /// 播放器会按网络错误重试，而不是把截断的文件当正常播完）
    fn fetch_block(&mut self) -> io::Result<()> {
        let want = CHUNK.min(self.remaining);
        let offset = self.offset;
        // 拿 Arc 克隆 + stopped 标志副本进 async 块，避免借用 self 跨 await
        let stream = self.stream.clone();
        let data = self
            .runtime_handle
            .block_on(async move {
                // stopped 检查放 await 前：retire_active 置位后不再发起网络读
                if stream.stopped.load(Ordering::Acquire) {
                    return Ok(Vec::new());
                }
                // &self 借 reader（只读路径），锁只在 borrow 瞬间持有；
                // close 的 take() 在 retire_active，与这里天然互斥
                let guard = stream.reader.lock();
                match guard.as_ref() {
                    Some(reader) => reader.read_at(offset, want).await,
                    None => Ok(Vec::new()),
                }
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("SMB 读取失败：{e}")))?;
        self.buffer = data;
        self.buf_pos = 0;
        Ok(())
    }
}

impl Read for SmbStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0); // 本响应区间发完
        }
        // 缓冲耗尽 → 拉下一块
        if self.buf_pos >= self.buffer.len() {
            if self.stream.stopped.load(Ordering::Acquire) {
                return Ok(0);
            }
            self.fetch_block()?;
            if self.buffer.is_empty() {
                // SMB 端 EOF / 已停：短流收尾（不装作正常结束，播放器自行判断）
                return Ok(0);
            }
        }
        // 从缓冲拷给调用方（每次拷 min(buf.len(), 块内剩余)）
        let avail = self.buffer.len() - self.buf_pos;
        let n = avail.min(buf.len()).min(self.remaining as usize);
        if n == 0 {
            return Ok(0);
        }
        buf[..n].copy_from_slice(&self.buffer[self.buf_pos..self.buf_pos + n]);
        self.buf_pos += n;
        self.offset += n as u64;
        self.remaining -= n as u64;
        Ok(n)
    }
}

// ─────────────────────────────────────────────
// 关闭与清理
// ─────────────────────────────────────────────

/// 请求退役当前代：标记停止 + unblock recv + 发 SMB CLOSE。
/// 引用（各连接线程）可能还在跑，它们读到 stopped 后尽快收尾
fn retire_active() {
    let old = ACTIVE.lock().take();
    let Some(stream) = old else { return };
    stream.stopped.store(true, Ordering::Release);
    // unblock 让监听线程的 recv 立刻返回 Err 退出
    stream.server.unblock();
    // SMB CLOSE：句柄立即还给 NAS（不必等引用归零）
    if let Some(reader) = stream.reader.lock().take() {
        let rt = tokio::runtime::Handle::current();
        // close 是 async；在当前（tauri runtime）线程上直接执行会与监听线程的
        // block_on 抢同一个 runtime —— spawn 到 runtime 上异步跑，不阻塞本调用
        let _ = rt.spawn(async move {
            if let Err(e) = reader.close().await {
                log::warn!("SMB reader 关闭失败（句柄将由会话回收）：{e}");
            }
        });
    }
    log::debug!("已退役流 gen={}", stream.generation);
}

// Range 解析：返回 Some((start, end_or_open))，end 为 None 表示开区间（到文件尾）。
// 不在此处夹取边界——start 是否越界（该回 416）由调用方结合 size 判定；
// suffix 形式（bytes=-N）这里算出等效 start
fn parse_range(range: Option<&str>, size: u64) -> Option<(u64, Option<u64>)> {
    let range = range?;
    let spec = range.strip_prefix("bytes=")?.trim();
    // 多区间（bytes=0-1,5-6）取第一段：流媒体场景罕见，播放器普遍不用
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // suffix：最后 N 字节（等效 start = size - N，end 开区间）
        let n: u64 = b.parse().ok()?;
        return Some((size.saturating_sub(n.min(size)), None));
    }
    let start: u64 = a.parse().ok()?;
    let end: Option<u64> = if b.is_empty() { None } else { b.parse().ok() };
    Some((start, end))
}

fn guess_content_type(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".mp4") {
        "video/mp4".to_string()
    } else if lower.ends_with(".mkv") {
        "video/x-matroska".to_string()
    } else if lower.ends_with(".webm") {
        "video/webm".to_string()
    } else if lower.ends_with(".mov") {
        "video/quicktime".to_string()
    } else if lower.ends_with(".avi") {
        "video/x-msvideo".to_string()
    } else if lower.ends_with(".ts") {
        "video/mp2t".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

/// 拉起系统播放器
///
/// Windows（开发态）：opener 插件走系统默认处理器即可。
/// Android：opener 插件只发「纯 data」的 ACTION_VIEW——http 意图不带 MIME 只有
/// 浏览器能接，电视上没有浏览器，必然 No Activity found。改经 wry 的 JniHandle
/// 在主线程调 PlayerLauncher（video/* MIME + 已知播放器包名链），详见
/// PlayerLauncher.kt。ndk_context 在 tauri v2 的 glue 里不初始化，别用它。
fn launch_player(app: &AppHandle, url: &str, mime: &str) -> AppResult<()> {
    #[cfg(target_os = "android")]
    {
        android_launch_player(app, url, mime)
            .map_err(|e| AppError::Custom(format!("拉起播放器失败：{e}")))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = mime;
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::Custom(format!("拉起播放器失败：{e}")))
    }
}

/// Android：把 JNI 调用派发到 wry 主线程（exec 无回执，用 channel 把结果带回）。
/// 5s 收不到结果按超时报错——绝不让命令静默挂起（前端弹窗只认 Err 返回）。
#[cfg(target_os = "android")]
fn android_launch_player(app: &AppHandle, url: &str, mime: &str) -> Result<(), String> {
    use std::sync::mpsc;
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let url = url.to_string();
    let mime = mime.to_string();
    window
        .with_webview(move |platform_webview| {
            platform_webview.jni_handle().exec(move |env, activity, _webview| {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    jni_call_launcher(env, activity, &url, &mime)
                }))
                .unwrap_or_else(|_| Err("JNI 调用内部异常".to_string()));
                let _ = tx.send(result);
            });
        })
        .map_err(|e| format!("with_webview 派发失败：{e}"))?;

    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => Err("拉起播放器超时（主线程无响应）".to_string()),
    }
}

/// 在主线程 JNIEnv 上调 PlayerLauncher.launch：null 成功 / String 失败文案。
/// 注意：exec 回调里没有 Java 栈帧，FindClass 落到系统类加载器、看不到应用类
/// （wry 自己也绕道 activity.classLoader.loadClass，见其 find_class 实现），
/// 必须先经 Activity 的 ClassLoader 把 PlayerLauncher 加载成 JClass 再调
#[cfg(target_os = "android")]
fn jni_call_launcher(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    url: &str,
    mime: &str,
) -> Result<(), String> {
    use jni::objects::{JClass, JString, JValue};

    // 每步失败都要清 pending exception：带着它返回 Java 帧 = 整个进程崩溃
    let loader = env.call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[]);
    if loader.is_err() {
        let _ = env.exception_clear();
    }
    let loader = loader
        .map_err(|e| format!("取 ClassLoader 失败：{e}"))?
        .l()
        .map_err(|e| format!("ClassLoader 返回值异常：{e}"))?;

    let name = env
        .new_string("com.zex.tv.PlayerLauncher")
        .map_err(|e| format!("构造类名失败：{e}"))?;
    let class = env.call_method(
        &loader,
        "loadClass",
        "(Ljava/lang/String;)Ljava/lang/Class;",
        &[JValue::Object(&name)],
    );
    if class.is_err() {
        let _ = env.exception_clear();
    }
    let class = class
        .map_err(|e| format!("加载 PlayerLauncher 类失败：{e}"))?
        .l()
        .map_err(|e| format!("loadClass 返回值异常：{e}"))?;
    let class = JClass::from(class);

    let jurl = env
        .new_string(url)
        .map_err(|e| format!("构造 JString 失败：{e}"))?;
    let jmime = env
        .new_string(mime)
        .map_err(|e| format!("构造 JString 失败：{e}"))?;
    let call = env.call_static_method(
        class,
        "launch",
        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
        &[JValue::Object(activity), JValue::Object(&jurl), JValue::Object(&jmime)],
    );
    // Java 侧抛了异常的话必须清掉（Kotlin 侧已 catch Throwable，这里是双保险）
    if call.is_err() {
        let _ = env.exception_clear();
    }
    let result = call.map_err(|e| format!("PlayerLauncher.launch 调用失败：{e}"))?;

    let ret = result
        .l()
        .map_err(|e| format!("launch 返回值异常：{e}"))?;
    if ret.is_null() {
        Ok(())
    } else {
        let jmsg = JString::from(ret);
        let msg: String = env
            .get_string(&jmsg)
            .map_err(|e| format!("读取错误文案失败：{e}"))?
            .into();
        Err(msg)
    }
}

// ─────────────────────────────────────────────
// 测试（纯逻辑部分：Range 解析）
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn range_basics() {
        // 无头 → None（调用方走全量 200）
        assert_eq!(parse_range(None, 1000), None);
        // bytes=0-1023 闭区间
        assert_eq!(parse_range(Some("bytes=0-1023"), 10_000), Some((0, Some(1023))));
        // bytes=500- 开区间
        assert_eq!(parse_range(Some("bytes=500-"), 10_000), Some((500, None)));
        // suffix：最后 100 字节
        assert_eq!(parse_range(Some("bytes=-100"), 10_000), Some((9900, None)));
        // suffix 大于文件：整个文件
        assert_eq!(parse_range(Some("bytes=-99999"), 1000), Some((0, None)));
        // 多区间取第一段
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 1000), Some((0, Some(1))));
        // 垃圾格式 → None（全量 200 兜底）
        assert_eq!(parse_range(Some("items=0-1"), 1000), None);
        assert_eq!(parse_range(Some("bytes=abc"), 1000), None);
        // start 越界由调用方判 416，这里原样返回
        assert_eq!(parse_range(Some("bytes=5000-"), 1000), Some((5000, None)));
    }
}

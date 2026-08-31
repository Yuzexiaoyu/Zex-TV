// ZEX TV —— 影视库电视版（海信 GX27 Android）
//
// M0：最小可运行壳。功能在 M1 起按计划书裁剪自 D:\ZEX。
//
// Android 遥控器 Back 键：WebView 默认把它当历史后退/退出，需要在
// gen/android 的 MainActivity 拦截并转发为 "back-key" 事件（M0 验证后实现）。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_version])
        .run(tauri::generate_context!())
        .expect("error while running ZEX TV");
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

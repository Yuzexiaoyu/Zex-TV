# ZEX TV Android 打包脚本（标准 CLI 流程）
# 用法：powershell -File scripts\build-android.ps1 [-Release]
# 说明：绕开 tauri CLI 直接 gradlew 不可行——rustBuild 任务要回调 tauri CLI 的
# WebSocket 服务拿构建参数（addr 文件在 `tauri android build` 启动时写入），
# 必须走 `npx tauri android build`。此脚本只负责补齐 JDK/SDK 环境变量。
#（符号链接需 Windows 开发者模式，已开启）
param(
  [switch]$Release
)

$ErrorActionPreference = 'Stop'

$env:JAVA_HOME = 'F:\SDK\jdk-17'
$env:ANDROID_HOME = 'F:\SDK'
$env:ANDROID_SDK_ROOT = 'F:\SDK'
$env:NDK_HOME = 'F:\SDK\ndk\27.2.12479018'
$env:ANDROID_NDK_HOME = 'F:\SDK\ndk\27.2.12479018'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$cmdArgs = @('tauri', 'android', 'build', '--target', 'aarch64')
if ($Release) { Write-Host '==> android build 默认即 release（--debug 才是可选项）' }

Write-Host "==> npx $($cmdArgs -join ' ')" -ForegroundColor Cyan
& npx @cmdArgs
if ($LASTEXITCODE -ne 0) { throw 'tauri android build 失败' }

# 拷到项目根方便取用
$apkDir = 'src-tauri\gen\android\app\build\outputs\apk\universal\release'
$apk = Get-ChildItem $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($apk) {
  Copy-Item $apk.FullName "$root\ZEX-TV.apk" -Force
  Write-Host ""
  Write-Host "==> 打包成功！" -ForegroundColor Green
  Write-Host "APK: $root\ZEX-TV.apk"
  Write-Host "大小: $([math]::Round((Get-Item "$root\ZEX-TV.apk").Length / 1MB, 1)) MB"
} else {
  Write-Host 'APK 未找到，检查 src-tauri/gen/android/app/build/outputs/apk/' -ForegroundColor Yellow
}


# Omni 去水印助手 0.1.4

发布日期：2026-07-12

## 关键修复

- 视频处理命令改为异步 Tauri command。
- Node/FFmpeg 子进程放入 `tauri::async_runtime::spawn_blocking`。
- 图片处理同步迁移到后台阻塞任务。
- 处理期间 WebView 主线程不再被 `Command::output()` 占住。
- 窗口拖动、进度动画、队列状态和界面重绘可持续响应。

## 继承 0.1.3

- 多数采样帧持续检测，拦截字幕和 UI 误匹配。
- 8 帧成品复检、严格二次修复、失败关闭。
- Rust 强制校验 `verification-status: verified-removed`。
- 最小运行时依赖和内置 Node/静态 FFmpeg。

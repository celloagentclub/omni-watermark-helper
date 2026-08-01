# Omni 去水印助手

一个基于 Tauri、Node.js 和 FFmpeg 的本地桌面工具，用于处理 Gemini/Omni
生成内容右下角的可见水印。仓库包含同一套 macOS 与 Windows 源码，当前版本为
`0.1.5`。

> 仅处理你有权编辑和发布的内容，并自行确认用途符合相关服务条款及当地法律。

## 直接使用

### macOS Apple Silicon

普通用户可以直接到 [v0.1.5 Release](https://github.com/celloagentclub/omni-watermark-helper/releases/tag/v0.1.5)
下载 `Omni 去水印助手_0.1.5_arm64.dmg`，安装后打开使用，不需要安装 Node.js、
Rust 或 FFmpeg。

当前公开包适用于 Apple Silicon Mac。因为这个版本还没有 Developer ID 签名和 Apple
公证，首次打开时 macOS 可能会提示无法验证开发者：

- 推荐方式：在 Finder 中右键应用图标，选择“打开”，再确认打开。
- 也可以在“系统设置 -> 隐私与安全性”里找到拦截提示，选择“仍要打开”。
- 安装包 SHA-256：`005a479cca172ea429a82be79ec2c16f40d9f5ffe1f351dd9d8136369f08151a`。

### Windows

Windows x64 源码、Tauri 配置和 CI 编译检查已经放在仓库里，但当前还没有经过真实
Windows 电脑完整打包和干净机验收，因此暂不提供稳定 Windows 安装包。Windows 用户
可以先按下方开发说明从源码运行；正式安装包会在 Windows 真机问题修复后再发布。

## 交流群

欢迎加入“AI 视频生成交流群”交流使用体验、样本问题和打包反馈。二维码可能会过期，
失效后可以在 GitHub Issue 里留言提醒更新。

<img src="docs/wechat-ai-video-group.png" alt="AI 视频生成交流群微信二维码" width="320">

## 功能

- 支持 MP4、MOV、M4V、WebM 视频及 PNG、JPG、JPEG、WebP 图片。
- 视频处理在后台线程执行，长任务不会阻塞桌面界面。
- 视频提供标准（CRF 18）、高清（CRF 10）和无损编码（CRF 0）三档输出。
- 多帧定位水印，成品进行 8 帧复检；复检未通过时失败关闭，不发布未确认结果。
- 默认保留原音轨，结果写入源文件旁的 `去除水印` 文件夹。
- macOS Apple Silicon 已完成 DMG 打包；Windows x64 源码和构建配置已保留，待真机验收。

## 处理边界

透明水印优先按 alpha 合成公式反推原像素；复杂纹理或高反光区域会切换到形状
遮罩修复或混合策略：

```text
watermarked = alpha * white_logo + (1 - alpha) * original
original    = (watermarked - alpha * white_logo) / (1 - alpha)
```

视频处理依次执行抽帧、检测、策略选择、逐帧处理、音视频重组和成品复检。任何
自动方法都不能对任意未知视频作数学意义上的 100% 保证，因此程序只将严格复检
通过并返回 `verification-status: verified-removed` 的结果标记为成功。

## 项目结构

```text
src/                         图片和视频处理核心
ui/                          桌面界面
src-tauri/                   Tauri/Rust 桌面外壳
src-tauri/tauri.macos.conf.json
src-tauri/tauri.windows.conf.json
scripts/                     平台运行时准备脚本
cloudflare/                  可选的 Workers + D1 授权服务
```

macOS 和 Windows 使用同一份业务源码。平台差异只保留在 Tauri 配置和构建时生成
的 Node.js/FFmpeg 运行时中，二进制文件不会提交到 Git。

## 开发环境

通用依赖：

- Node.js 20 或 22
- Rust stable
- npm
- FFmpeg（仅直接运行命令行工具时需要；桌面安装包会内置）

macOS 还需要 Xcode Command Line Tools；Windows 还需要 Visual Studio C++ Build
Tools、WebView2 和 Tauri 所需的 MSI/NSIS 工具链。具体系统依赖参见
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。

安装依赖并检查 JavaScript：

```bash
npm ci
npm run check
cd src-tauri && cargo check
```

启动开发版：

```bash
npm run app:dev
```

也可以只预览界面：

```bash
npm run ui:serve
```

## macOS 构建

在 Apple Silicon Mac 上执行：

```bash
npm ci
npm run build:mac
```

脚本会安装应用内 Node 依赖、复制当前平台的 Node.js，并从仓库内附的 FFmpeg
8.1.2 与 x264 源码编译可再分发的静态 FFmpeg。产物位于
`src-tauri/target/release/bundle/`。

公开分发还需要 Developer ID Application 证书、Hardened Runtime、Apple
notarization 和 stapling。没有签名及公证的本地构建只能用于开发测试。

## Windows 构建

在 Windows x64 PowerShell 中执行：

```powershell
npm ci
npm run build:windows
```

脚本会准备 Windows 版 Node.js、FFmpeg 和应用运行时依赖，再生成 NSIS/MSI
安装包。如果系统 `PATH` 中没有可再分发的 GPL FFmpeg，请先通过
`OMNI_FFMPEG_PATH` 指定 `ffmpeg.exe`；脚本会拒绝带 `--enable-nonfree` 的构建。
Windows 安装包必须在真实 Windows 环境构建和验收；正式分发建议使用代码签名证书。

## 命令行

处理单个视频：

```bash
npm run clean:video -- "/path/to/video.mp4" --output "/path/to/output.mp4"
```

处理单张图片：

```bash
npm run clean:image -- "/path/to/image.png" --output "/path/to/output.png"
```

常用视频参数：

```text
--strategy auto          auto / alpha / shape-repair / hybrid
--alpha-gain 0.55        手动指定反向 alpha 强度
--position 600,1160,48   手动指定水印框
--crf 10                 指定 x264 CRF
--lossless               x264 无损输出
--keep-work              保留中间帧供排查
```

## 授权服务

桌面版当前接入可选的 Cloudflare Workers + D1 一机一码服务，公共服务端源码位于
`cloudflare/`。私钥、管理员令牌、真实 Wrangler 配置和激活码导出均被
`.gitignore` 排除。部署自己的服务时请从 `cloudflare/wrangler.toml.example`
创建本地配置，并替换客户端 API 地址及验签公钥。

## 开源许可

项目代码采用 [MIT License](LICENSE)。应用分发时使用的 FFmpeg/x264 受其各自
GPL 条款约束；许可证、构建说明和对应源码信息位于
`src-tauri/resources/third-party/`。依赖项目
[@pilio/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover)
采用 MIT License。

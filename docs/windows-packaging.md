# Windows 打包说明

本文档给 Windows 电脑上的 Codex 或维护者使用。当前 Windows 源码和 CI 检查已经可用，
但正式安装包仍建议在真实 Windows x64 机器完成打包和干净机验收后再公开标记为稳定版。

## 方式一：GitHub Actions 自动打包

仓库已经提供 `.github/workflows/windows-package.yml`。维护者可以在 GitHub 页面执行：

1. 打开仓库的 `Actions` 页面。
2. 选择 `Windows package`。
3. 点击 `Run workflow`，输入要打包的标签，例如 `v0.1.5`。
4. 构建完成后，下载 `omni-watermark-helper-<tag>-windows` artifact。
5. workflow 会把 NSIS `.exe` 上传到对应 GitHub Release，普通用户优先使用这个安装包。

这个 workflow 会在 Windows runner 上安装 Node.js、Rust 和 FFmpeg，并在打包前检查 FFmpeg
是否包含 `libx264`、PNG 编码器，且不包含 `--enable-nonfree`。

## 方式二：Windows 真机手工打包

### 环境要求

- Windows 10/11 x64
- Node.js 20 或 22
- Rust stable
- Visual Studio C++ Build Tools
- WebView2 Runtime
- Tauri Windows 打包依赖
- 可再分发的 GPL FFmpeg，必须包含 `libx264` 和 PNG 编码器，不能包含 `--enable-nonfree`

### 命令

在 PowerShell 中执行：

```powershell
git clone https://github.com/celloagentclub/omni-watermark-helper.git
cd omni-watermark-helper
git checkout v0.1.5
npm ci
$env:OMNI_FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
npm run build:windows
```

如果 `ffmpeg.exe` 已在系统 `PATH` 中，也可以不设置 `OMNI_FFMPEG_PATH`。使用 Chocolatey
时请指向 `C:\ProgramData\chocolatey\lib\ffmpeg\tools` 下的真实文件，不要指向
`C:\ProgramData\chocolatey\bin\ffmpeg.exe` shim。

### 产物位置

安装包会输出到：

```text
src-tauri\target\release\bundle\nsis\
src-tauri\target\release\bundle\msi\
```

一般优先给普通用户下载 NSIS `.exe` 安装包；MSI 更适合企业分发或自动化部署。
如果确实需要 MSI，使用 `npm run build:windows:msi` 单独构建；当前 GitHub runner 的
WiX `light.exe` 可能失败，所以 MSI 不作为本次自动发布的阻塞项。

## 验收清单

发布 Windows 安装包前，至少在一台干净 Windows 机器上验证：

- 安装包能正常安装和启动。
- 首次打开不会卡死；长视频处理时界面仍可响应。
- 输出目录自动创建在源文件旁的 `去除水印` 文件夹。
- 标准、高清、无损三个输出档位都能完成处理，且文件体积或编码参数存在差异。
- 处理成功时返回 `verification-status: verified-removed`。
- 复检失败时不应把结果标记为成功。
- 卸载后应用目录和快捷方式被正常移除。

## 已知提示

Windows 安装包当前未做代码签名，普通用户首次安装时可能看到 SmartScreen 或安全软件提醒。
这是签名状态问题，不代表源码不可用；正式面向更大范围分发前建议购买 Windows 代码签名证书。

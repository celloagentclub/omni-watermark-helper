use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "webm"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const LICENSE_PUBLIC_KEY_X: &str = "8H2WfEXZa910x8PRMuJ8ArJes9nbLFBtKO7th0ezuwc";
const LICENSE_PUBLIC_KEY_Y: &str = "vrqAXrTDv0CjwCddqq8oW730EBdFe6IHbJvQuJLY35o";

#[derive(Serialize)]
struct VideoFileInfo {
    name: String,
    path: String,
    size: u64,
    duration: u32,
    output_dir: String,
    output_path: String,
}

#[derive(Serialize)]
struct MediaFileInfo {
    name: String,
    path: String,
    size: u64,
    duration: u32,
    kind: String,
    output_dir: String,
    output_path: String,
}

#[derive(Serialize)]
struct CleanVideoResult {
    input_path: String,
    output_path: String,
    output_dir: String,
    output_size: u64,
    stdout: String,
}

#[derive(Serialize)]
struct LicenseState {
    active: bool,
    machine_code: String,
    offline_until: Option<String>,
    message: String,
    code: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredLicense {
    license: StoredLicenseBody,
    signature: String,
    code: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredLicenseBody {
    #[serde(rename = "licenseId")]
    license_id: Option<i64>,
    #[serde(rename = "machineCode")]
    machine_code: String,
    #[serde(rename = "offlineGraceDays")]
    offline_grace_days: Option<i64>,
    #[serde(rename = "issuedAt")]
    issued_at: Option<String>,
    #[serde(rename = "nextValidationAt")]
    next_validation_at: Option<String>,
    #[serde(rename = "offlineUntil")]
    offline_until: String,
    #[serde(rename = "licenseType")]
    license_type: Option<String>,
}

#[tauri::command]
fn license_api_url() -> &'static str {
    "https://omni-license-worker.omni-watermark-helper.workers.dev"
}

#[tauri::command]
fn machine_code() -> String {
    let basis = machine_fingerprint_basis();
    let digest = Sha256::digest(basis.as_bytes());
    let code = digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join("");
    format!("OMNI-{}-{}", &code[..6], &code[6..])
}

#[tauri::command]
fn save_license(app: tauri::AppHandle, payload: serde_json::Value) -> Result<LicenseState, String> {
    let license: StoredLicense =
        serde_json::from_value(payload).map_err(|error| format!("授权数据格式无效: {error}"))?;
    validate_stored_license(&license)?;

    let path = license_file_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建授权目录失败: {error}"))?;
    }
    let content = serde_json::to_string_pretty(&license)
        .map_err(|error| format!("保存授权数据失败: {error}"))?;
    fs::write(path, content).map_err(|error| format!("写入授权文件失败: {error}"))?;

    license_state(app)
}

#[tauri::command]
fn license_state(app: tauri::AppHandle) -> Result<LicenseState, String> {
    match read_stored_license(&app) {
        Ok(license) => match validate_stored_license(&license) {
            Ok(()) => Ok(LicenseState {
                active: true,
                machine_code: machine_code(),
                offline_until: Some(license.license.offline_until),
                message: "授权有效".to_string(),
                code: license.code,
            }),
            Err(message) => Ok(LicenseState {
                active: false,
                machine_code: machine_code(),
                offline_until: Some(license.license.offline_until),
                message,
                code: license.code,
            }),
        },
        Err(_) => Ok(LicenseState {
            active: false,
            machine_code: machine_code(),
            offline_until: None,
            message: "未激活".to_string(),
            code: None,
        }),
    }
}

#[tauri::command]
fn describe_videos(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<VideoFileInfo>, String> {
    require_active_license(&app)?;

    let mut videos = Vec::new();

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        collect_video_infos(&path, &mut videos)?;
    }

    Ok(videos)
}

#[tauri::command]
fn choose_videos(app: tauri::AppHandle) -> Result<Vec<VideoFileInfo>, String> {
    require_active_license(&app)?;

    let Some(paths) = rfd::FileDialog::new()
        .set_title("选择 Omni 视频")
        .add_filter("视频文件", &["mp4", "mov", "m4v", "webm"])
        .pick_files()
    else {
        return Ok(Vec::new());
    };

    let mut videos = Vec::new();
    for path in paths {
        collect_video_infos(&path, &mut videos)?;
    }

    Ok(videos)
}

#[tauri::command]
fn describe_media(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<MediaFileInfo>, String> {
    require_active_license(&app)?;

    let mut media = Vec::new();

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        collect_media_infos(&path, &mut media)?;
    }

    Ok(media)
}

#[tauri::command]
fn choose_media(app: tauri::AppHandle, kind: Option<String>) -> Result<Vec<MediaFileInfo>, String> {
    require_active_license(&app)?;

    let media_kind = kind.as_deref().unwrap_or("media");
    let dialog = rfd::FileDialog::new();
    let dialog = match media_kind {
        "image" => dialog
            .set_title("选择 Gemini 图片")
            .add_filter("图片文件", IMAGE_EXTENSIONS),
        "video" => dialog
            .set_title("选择 Omni 视频")
            .add_filter("视频文件", VIDEO_EXTENSIONS),
        _ => dialog.set_title("选择 Omni 视频或 Gemini 图片").add_filter(
            "视频或图片文件",
            &["mp4", "mov", "m4v", "webm", "png", "jpg", "jpeg", "webp"],
        ),
    };

    let Some(paths) = dialog.pick_files() else {
        return Ok(Vec::new());
    };

    let mut media = Vec::new();
    for path in paths {
        collect_media_infos(&path, &mut media)?;
    }

    Ok(media)
}

#[tauri::command]
async fn clean_video(
    app: tauri::AppHandle,
    input_path: String,
    quality: Option<String>,
) -> Result<CleanVideoResult, String> {
    tauri::async_runtime::spawn_blocking(move || clean_video_blocking(app, input_path, quality))
        .await
        .map_err(|error| format!("视频处理后台任务异常: {error}"))?
}

fn clean_video_blocking(
    app: tauri::AppHandle,
    input_path: String,
    quality: Option<String>,
) -> Result<CleanVideoResult, String> {
    require_active_license(&app)?;

    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!(
            "找不到源视频文件，请重新点击上传区选择文件: {}",
            input.display()
        ));
    }
    if !is_video_path(&input) {
        return Err(format!("不是支持的视频文件: {}", input.display()));
    }

    let output_path = default_output_path(&input)?;
    let runtime_root = runtime_root(&app)?;
    let script_path = runtime_root.join("src").join("omni-watermark.js");
    if !script_path.exists() {
        return Err(format!("找不到处理脚本: {}", script_path.display()));
    }

    let node = find_executable(&app, "node").ok_or_else(|| {
        "找不到 Node.js。当前版本需要本机安装 Node.js 才能执行视频处理。".to_string()
    })?;

    let mut args = vec![
        script_path.to_string_lossy().to_string(),
        input.to_string_lossy().to_string(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
    ];

    match quality.as_deref() {
        Some("lossless") => args.push("--lossless".to_string()),
        Some("high") => {
            args.push("--crf".to_string());
            args.push("10".to_string());
        }
        _ => {
            args.push("--crf".to_string());
            args.push("18".to_string());
        }
    }

    let output = Command::new(&node)
        .args(args)
        .current_dir(&runtime_root)
        .env("PATH", tool_path(&app))
        .output()
        .map_err(|error| format!("启动处理程序失败: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !stdout.contains("verification-status: verified-removed") {
        return Err("处理程序未返回成品复检通过标记，已阻止将结果标记为成功".to_string());
    }

    let metadata = fs::metadata(&output_path).map_err(|error| {
        format!(
            "处理完成但没有找到输出文件 {}: {error}",
            output_path.display()
        )
    })?;
    if metadata.len() == 0 {
        return Err(format!("输出文件为空: {}", output_path.display()));
    }
    let output_dir = output_path
        .parent()
        .ok_or_else(|| format!("无法识别输出文件夹: {}", output_path.display()))?;

    Ok(CleanVideoResult {
        input_path,
        output_path: output_path.to_string_lossy().to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        output_size: metadata.len(),
        stdout,
    })
}

#[tauri::command]
async fn clean_image(
    app: tauri::AppHandle,
    input_path: String,
) -> Result<CleanVideoResult, String> {
    tauri::async_runtime::spawn_blocking(move || clean_image_blocking(app, input_path))
        .await
        .map_err(|error| format!("图片处理后台任务异常: {error}"))?
}

fn clean_image_blocking(
    app: tauri::AppHandle,
    input_path: String,
) -> Result<CleanVideoResult, String> {
    require_active_license(&app)?;

    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!(
            "找不到源图片文件，请重新点击上传区选择文件: {}",
            input.display()
        ));
    }
    if !is_image_path(&input) {
        return Err(format!("不是支持的图片文件: {}", input.display()));
    }

    let output_path = default_image_output_path(&input)?;
    let runtime_root = runtime_root(&app)?;
    let script_path = runtime_root.join("src").join("omni-image-watermark.js");
    if !script_path.exists() {
        return Err(format!("找不到图片处理脚本: {}", script_path.display()));
    }

    let node = find_executable(&app, "node").ok_or_else(|| {
        "找不到 Node.js。当前版本需要本机安装 Node.js 才能执行图片处理。".to_string()
    })?;

    let args = vec![
        script_path.to_string_lossy().to_string(),
        input.to_string_lossy().to_string(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
        "--json".to_string(),
    ];

    let output = Command::new(&node)
        .args(args)
        .current_dir(&runtime_root)
        .env("PATH", tool_path(&app))
        .output()
        .map_err(|error| format!("启动图片处理程序失败: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }

    let metadata = fs::metadata(&output_path).map_err(|error| {
        format!(
            "处理完成但没有找到输出文件 {}: {error}",
            output_path.display()
        )
    })?;
    if metadata.len() == 0 {
        return Err(format!("输出文件为空: {}", output_path.display()));
    }
    let output_dir = output_path
        .parent()
        .ok_or_else(|| format!("无法识别输出文件夹: {}", output_path.display()))?;

    Ok(CleanVideoResult {
        input_path,
        output_path: output_path.to_string_lossy().to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        output_size: metadata.len(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

#[tauri::command]
fn open_output(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err(format!("输出路径不存在: {}", target.display()));
    }
    let open_target = if target.is_file() {
        target
            .parent()
            .ok_or_else(|| format!("无法识别输出文件夹: {}", target.display()))?
            .to_path_buf()
    } else {
        target
    };

    tauri_plugin_opener::open_path(open_target, None::<&str>)
        .map_err(|error| format!("打开输出文件夹失败: {error}"))
}

fn require_active_license(app: &tauri::AppHandle) -> Result<(), String> {
    let license =
        read_stored_license(app).map_err(|_| "请先激活授权后再使用处理功能".to_string())?;
    validate_stored_license(&license)
}

fn read_stored_license(app: &tauri::AppHandle) -> Result<StoredLicense, String> {
    let path = license_file_path(app)?;
    let content = fs::read_to_string(path).map_err(|error| format!("读取授权文件失败: {error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("授权文件格式无效: {error}"))
}

fn validate_stored_license(license: &StoredLicense) -> Result<(), String> {
    if license.signature.trim().is_empty() {
        return Err("授权签名缺失".to_string());
    }
    verify_license_signature(license)?;
    if license.license.machine_code != machine_code() {
        return Err("授权不属于本机".to_string());
    }
    if license.license.license_type.as_deref() != Some("perpetual") {
        return Err("授权类型无效".to_string());
    }
    Ok(())
}

fn verify_license_signature(stored: &StoredLicense) -> Result<(), String> {
    let signed_payload = stable_license_json(&stored.license)?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(stored.signature.as_bytes())
        .map_err(|_| "授权签名格式无效".to_string())?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| "授权签名格式无效".to_string())?;
    let public_key = license_public_key()?;

    public_key
        .verify(signed_payload.as_bytes(), &signature)
        .map_err(|_| "授权签名校验失败".to_string())
}

fn stable_license_json(license: &StoredLicenseBody) -> Result<String, String> {
    let value =
        serde_json::to_value(license).map_err(|error| format!("授权数据格式无效: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "授权数据格式无效".to_string())?;
    let mut keys = object.keys().collect::<Vec<_>>();
    keys.sort();

    let mut sorted = serde_json::Map::new();
    for key in keys {
        if let Some(value) = object.get(key) {
            sorted.insert(key.clone(), value.clone());
        }
    }

    serde_json::to_string(&serde_json::Value::Object(sorted))
        .map_err(|error| format!("授权数据签名内容无效: {error}"))
}

fn license_public_key() -> Result<VerifyingKey, String> {
    let x = URL_SAFE_NO_PAD
        .decode(LICENSE_PUBLIC_KEY_X.as_bytes())
        .map_err(|_| "授权公钥格式无效".to_string())?;
    let y = URL_SAFE_NO_PAD
        .decode(LICENSE_PUBLIC_KEY_Y.as_bytes())
        .map_err(|_| "授权公钥格式无效".to_string())?;

    if x.len() != 32 || y.len() != 32 {
        return Err("授权公钥长度无效".to_string());
    }

    let mut encoded = [0u8; 65];
    encoded[0] = 4;
    encoded[1..33].copy_from_slice(&x);
    encoded[33..65].copy_from_slice(&y);

    VerifyingKey::from_sec1_bytes(&encoded).map_err(|_| "授权公钥无法读取".to_string())
}

fn machine_fingerprint_basis() -> String {
    let mut parts = Vec::new();

    #[cfg(target_os = "macos")]
    {
        for command in ["/usr/sbin/ioreg", "ioreg"] {
            if let Some(value) = command_stdout(command, &["-rd1", "-c", "IOPlatformExpertDevice"])
            {
                if let Some(uuid) = value.lines().find_map(extract_ioplatform_uuid) {
                    parts.push(uuid);
                    break;
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(uuid) = command_stdout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystemProduct).UUID",
            ],
        ) {
            parts.push(uuid.to_string());
        } else if let Some(value) = command_stdout("wmic", &["csproduct", "get", "uuid"]) {
            if let Some(uuid) = value
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.eq_ignore_ascii_case("uuid"))
            {
                parts.push(uuid.to_string());
            }
        }
    }

    if parts.is_empty() {
        if let Ok(hostname) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
            parts.push(hostname);
        }
    }

    if parts.is_empty() {
        parts.push("omni-watermark-helper-fallback".to_string());
    }

    parts.join("|")
}

#[cfg(target_os = "macos")]
fn extract_ioplatform_uuid(line: &str) -> Option<String> {
    let marker = "\"IOPlatformUUID\" = \"";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn command_stdout(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn license_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    Ok(app_data_dir.join("license.json"))
}

fn collect_video_infos(path: &Path, videos: &mut Vec<VideoFileInfo>) -> Result<(), String> {
    if path.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(|error| format!("读取文件夹失败 {}: {error}", path.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取文件夹失败 {}: {error}", path.display()))?;
        entries.sort_by_key(|entry| entry.path());

        for entry in entries {
            let entry_path = entry.path();
            if entry_path.is_file() && is_video_path(&entry_path) {
                videos.push(video_info_for(&entry_path)?);
            }
        }
        return Ok(());
    }

    if path.is_file() && is_video_path(path) {
        videos.push(video_info_for(path)?);
    }

    Ok(())
}

fn video_info_for(path: &Path) -> Result<VideoFileInfo, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("读取视频信息失败 {}: {error}", path.display()))?;
    let output_path = default_output_path(path)?;
    let output_dir = output_path
        .parent()
        .ok_or_else(|| format!("无法计算输出文件夹: {}", path.display()))?;

    Ok(VideoFileInfo {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("video.mp4")
            .to_string(),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        duration: 10,
        output_dir: output_dir.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
    })
}

fn collect_media_infos(path: &Path, media: &mut Vec<MediaFileInfo>) -> Result<(), String> {
    if path.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(|error| format!("读取文件夹失败 {}: {error}", path.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取文件夹失败 {}: {error}", path.display()))?;
        entries.sort_by_key(|entry| entry.path());

        for entry in entries {
            let entry_path = entry.path();
            if entry_path.is_file() && is_media_path(&entry_path) {
                media.push(media_info_for(&entry_path)?);
            }
        }
        return Ok(());
    }

    if path.is_file() && is_media_path(path) {
        media.push(media_info_for(path)?);
    }

    Ok(())
}

fn media_info_for(path: &Path) -> Result<MediaFileInfo, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("读取文件信息失败 {}: {error}", path.display()))?;
    let kind = if is_video_path(path) {
        "video"
    } else {
        "image"
    };
    let output_path = if kind == "video" {
        default_output_path(path)?
    } else {
        default_image_output_path(path)?
    };
    let output_dir = output_path
        .parent()
        .ok_or_else(|| format!("无法计算输出文件夹: {}", path.display()))?;

    Ok(MediaFileInfo {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(if kind == "video" {
                "video.mp4"
            } else {
                "image.png"
            })
            .to_string(),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        duration: if kind == "video" { 10 } else { 0 },
        kind: kind.to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
    })
}

fn default_output_path(input_path: &Path) -> Result<PathBuf, String> {
    let parent = input_path
        .parent()
        .ok_or_else(|| format!("无法识别源视频文件夹: {}", input_path.display()))?;
    let stem = input_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| format!("无法识别源视频文件名: {}", input_path.display()))?;
    Ok(parent.join("去除水印").join(format!("{stem}_去水印.mp4")))
}

fn default_image_output_path(input_path: &Path) -> Result<PathBuf, String> {
    let parent = input_path
        .parent()
        .ok_or_else(|| format!("无法识别源图片文件夹: {}", input_path.display()))?;
    let stem = input_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| format!("无法识别源图片文件名: {}", input_path.display()))?;
    let extension = input_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("png");
    Ok(parent
        .join("去除水印")
        .join(format!("{stem}_去水印.{extension}")))
}

fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn is_media_path(path: &Path) -> bool {
    is_video_path(path) || is_image_path(path)
}

fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        if resource_dir.join("src").join("omni-watermark.js").exists() {
            return Ok(resource_dir);
        }
    }

    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("无法定位项目根目录")?
        .to_path_buf();
    if project_root.join("src").join("omni-watermark.js").exists() {
        return Ok(project_root);
    }

    Err("无法定位视频处理资源".to_string())
}

fn find_executable(app: &tauri::AppHandle, name: &str) -> Option<String> {
    let bundled_name = if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let resource_bin = app.path().resource_dir().ok().map(|dir| {
        dir.join("bin")
            .join(&bundled_name)
            .to_string_lossy()
            .to_string()
    });

    let mut candidates = Vec::new();
    if let Ok(value) = env::var(format!("OMNI_{}_PATH", name.to_uppercase())) {
        candidates.push(value);
    }
    if let Some(value) = resource_bin {
        candidates.push(value);
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
    ]);
    candidates.push(name.to_string());

    candidates
        .into_iter()
        .find(|candidate| candidate == name || Path::new(candidate).exists())
}

fn tool_path(app: &tauri::AppHandle) -> String {
    let current = env::var_os("PATH").unwrap_or_default();
    let mut paths = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("bin"));
        paths.push(resource_dir.join("node_modules").join("ffmpeg-static"));
    }
    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    paths.extend(env::split_paths(&current));

    env::join_paths(paths)
        .unwrap_or(current)
        .to_string_lossy()
        .to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            license_api_url,
            machine_code,
            save_license,
            license_state,
            describe_videos,
            choose_videos,
            describe_media,
            choose_media,
            clean_video,
            clean_image,
            open_output
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Omni 去水印助手");
}

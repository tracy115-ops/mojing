// asset.rs — 产物落盘后的清理与统计命令
//
// 与前端 src/services/video/asset-store.ts 对应。前端调 saveAsset() 把
// image/video/audio 落到 appDataDir/video-assets/<projectId>/<kind>/,
// 这里的命令负责:
//   - 按项目删(用户删 novel project 时级联清理)
//   - 按项目统计(给 UI 显示占用)
//   - 全清(给「设置 → 存储」用)

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
pub struct AssetStats {
    pub bytes: u64,
    pub files: u64,
}

#[derive(serde::Serialize)]
pub struct CleanResult {
    pub deleted_bytes: u64,
    pub deleted_files: u64,
}

/// 计算某个项目的 video-assets 子目录的绝对路径。
/// 不保证存在,只是路径。
fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let safe_id = sanitize_id(project_id);
    Ok(base.join("video-assets").join(safe_id))
}

fn all_assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("video-assets"))
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 递归列出目录下所有文件(不包含子目录本身)。
/// 目录不存在时返回空 Vec。
fn list_files_recursively(dir: &PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !dir.exists() {
        return out;
    }
    let mut stack = vec![dir.clone()];
    while let Some(p) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&p) {
            for ent in rd.flatten() {
                let path = ent.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
    }
    out
}

/// 递归删除目录,返回删掉的文件数和字节数(先 walk 再删,便于统计)
fn remove_dir_with_stats(dir: &PathBuf) -> Result<CleanResult, String> {
    if !dir.exists() {
        return Ok(CleanResult {
            deleted_bytes: 0,
            deleted_files: 0,
        });
    }
    let files = list_files_recursively(dir);
    let mut deleted_bytes = 0u64;
    let mut deleted_files = 0u64;
    for f in &files {
        if let Ok(meta) = f.metadata() {
            deleted_bytes += meta.len();
        }
        if std::fs::remove_file(f).is_ok() {
            deleted_files += 1;
        }
    }
    // 再删空目录
    let _ = std::fs::remove_dir_all(dir);
    Ok(CleanResult {
        deleted_bytes,
        deleted_files,
    })
}

#[tauri::command]
pub async fn asset_stats_project(
    app: AppHandle,
    project_id: String,
) -> Result<AssetStats, String> {
    let dir = project_dir(&app, &project_id)?;
    // spawn_blocking 避免大目录遍历阻塞 async runtime
    let files = tokio::task::spawn_blocking(move || list_files_recursively(&dir))
        .await
        .map_err(|e| format!("stats task panicked: {}", e))?;
    let mut bytes = 0u64;
    let mut count = 0u64;
    for f in files {
        if let Ok(meta) = f.metadata() {
            bytes += meta.len();
            count += 1;
        }
    }
    Ok(AssetStats {
        bytes,
        files: count,
    })
}

#[tauri::command]
pub async fn asset_clean_project(
    app: AppHandle,
    project_id: String,
) -> Result<CleanResult, String> {
    let dir = project_dir(&app, &project_id)?;
    tokio::task::spawn_blocking(move || remove_dir_with_stats(&dir))
        .await
        .map_err(|e| format!("clean task panicked: {}", e))?
}

#[tauri::command]
pub async fn asset_clean_all(app: AppHandle) -> Result<CleanResult, String> {
    let dir = all_assets_dir(&app)?;
    tokio::task::spawn_blocking(move || remove_dir_with_stats(&dir))
        .await
        .map_err(|e| format!("clean-all task panicked: {}", e))?
}

/// 读任意本地文件,返回 data: URI(`data:image/png;base64,xxxx`)。
///
/// 用途:某些 provider(Agnes Video)的 image 字段要 base64 而不是 URL,
/// 但我们的产物是落盘的文件、store 里只存 webview URL。调用方传 URL 进来,
/// 我们转回 base64 让 provider 能用。
///
/// 接受三种输入:
///   - 绝对路径(`C:\...\foo.png` 或 `/home/.../foo.png`)
///   - webview URL(`http://asset.localhost/...`,Tauri 2 的 convertFileSrc 输出)
///
/// 读取失败 / 文件不存在 → 返回 Err。文件 > 50MB → 拒绝(避免内存爆掉)。
#[tauri::command]
pub async fn asset_read_as_data_uri(path: String) -> Result<String, String> {
    let resolved = resolve_input_path(&path)?;
    let data = tokio::task::spawn_blocking(move || std::fs::read(&resolved))
        .await
        .map_err(|e| format!("read task panicked: {}", e))?
        .map_err(|e| format!("read file failed: {}", e))?;
    if data.len() > 50 * 1024 * 1024 {
        return Err(format!(
            "file too large ({} bytes, max 50MB)",
            data.len()
        ));
    }
    let mime = guess_mime_from_path(&path);
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let b64 = STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    pub exists: bool,
    pub bytes: u64,
}

/// 检查一个路径是否存在 + 大小。用于 compose 前过滤无效 clip。
#[tauri::command]
pub async fn asset_stat_path(path: String) -> Result<PathStat, String> {
    let resolved = resolve_input_path(&path)?;
    let stat = tokio::task::spawn_blocking(move || -> Result<PathStat, String> {
        match std::fs::metadata(&resolved) {
            Ok(m) => Ok(PathStat {
                exists: true,
                bytes: m.len(),
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PathStat {
                exists: false,
                bytes: 0,
            }),
            Err(e) => Err(format!("stat failed: {}", e)),
        }
    })
    .await
    .map_err(|e| format!("stat task panicked: {}", e))??;
    Ok(stat)
}

/// 把前端可能传进来的各种路径形式统一成文件系统绝对路径。
fn resolve_input_path(input: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    // webview URL: http://asset.localhost/<encoded> 或 https://asset.localhost/...
    if let Some(rest) = trimmed
        .strip_prefix("http://asset.localhost/")
        .or_else(|| trimmed.strip_prefix("https://asset.localhost/"))
    {
        let decoded = percent_decode(rest);
        return Ok(std::path::PathBuf::from(decoded));
    }
    Ok(std::path::PathBuf::from(trimmed))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn guess_mime_from_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else {
        "application/octet-stream"
    }
}

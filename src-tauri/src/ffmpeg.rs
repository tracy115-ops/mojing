// FFmpeg commands — video clip download + composition
// Uses ffmpeg-sidecar to auto-manage FFmpeg binary (no manual install).

use std::path::{Path, PathBuf};
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::version::ffmpeg_version;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct ProbeResult {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Check whether FFmpeg is available. Triggers auto-download on first call
/// (ffmpeg-sidecar handles caching in the user's data dir).
#[tauri::command]
async fn ffmpeg_probe() -> Result<ProbeResult, String> {
    // Run blocking work on a worker thread.
    let result = tokio::task::spawn_blocking(|| {
        match ffmpeg_version() {
            Ok(v) => ProbeResult { available: true, version: Some(v), error: None },
            Err(e) => ProbeResult {
                available: false,
                version: None,
                error: Some(format!("{:?}", e)),
            },
        }
    })
    .await
    .map_err(|e| format!("ffmpeg probe task panicked: {}", e))?;
    Ok(result)
}

#[derive(Serialize, Deserialize)]
pub struct DownloadResult {
    pub saved_path: String,
    pub bytes: u64,
}

/// Download a remote video URL (http/https) to local disk.
/// Used before composing — Tauri's fetch in webview can't easily save binary
/// streams to arbitrary paths outside sandbox.
#[tauri::command]
async fn ffmpeg_download_clip(url: String, dest_dir: String, filename: String) -> Result<DownloadResult, String> {
    let dest_path = Path::new(&dest_dir).join(&filename);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes = download_to_file(&url, &dest_path).await?;
    Ok(DownloadResult {
        saved_path: dest_path.to_string_lossy().to_string(),
        bytes,
    })
}

async fn download_to_file(url: &str, dest: &Path) -> Result<u64, String> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    use tokio::io::AsyncWriteExt;
    let mut stream = resp.bytes_stream();
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    let _ = total; // suppress unused warning
    Ok(written)
}

#[derive(Serialize, Deserialize)]
pub struct ComposeRequest {
    /// Ordered list of local clip paths to concatenate.
    pub clip_paths: Vec<String>,
    /// Optional subtitle track. Each entry maps to one clip (same length as clip_paths).
    pub subtitles: Vec<Option<String>>,
    /// Output path for the final composed video.
    pub output_path: String,
    /// Whether to hardcode subtitles into the video frame.
    pub hardcode_subtitles: bool,
}

#[derive(Serialize, Deserialize)]
pub struct ComposeResult {
    pub output_path: String,
    pub duration_seconds: Option<f64>,
}

/// Concatenate clips with optional hardcoded subtitles via FFmpeg.
/// Strategy: per-clip render (apply subtitle) → concat via filter_complex.
#[tauri::command]
async fn ffmpeg_compose_clips(req: ComposeRequest) -> Result<ComposeResult, String> {
    if req.clip_paths.is_empty() {
        return Err("No clips to compose".to_string());
    }
    if req.clip_paths.len() != req.subtitles.len() {
        return Err("clip_paths and subtitles length mismatch".to_string());
    }

    let req = tokio::task::spawn_blocking(move || compose_blocking(&req))
        .await
        .map_err(|e| format!("compose task panicked: {}", e))??;

    Ok(req)
}

fn compose_blocking(req: &ComposeRequest) -> Result<ComposeResult, String> {
    let out_path = PathBuf::from(&req.output_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Phase 1 simplified strategy:
    //   - If only 1 clip and no subtitle → just copy it to output_path
    //   - Else → use concat demuxer (requires same codec; Phase 1 assumes yes)
    //
    // Hardcoded subtitles + multi-clip with mixed codecs is a Phase 2 concern.
    if req.clip_paths.len() == 1 {
        let src = &req.clip_paths[0];
        let sub = req.subtitles[0].as_deref();

        if let Some(sub_text) = sub {
            if req.hardcode_subtitles {
                return render_single_with_subtitle(src, sub_text, &out_path);
            }
        }
        // plain copy
        std::fs::copy(src, &out_path).map_err(|e| e.to_string())?;
        return Ok(ComposeResult {
            output_path: out_path.to_string_lossy().to_string(),
            duration_seconds: None,
        });
    }

    // Multi-clip: use concat demuxer via temp file list
    let tmp_dir = std::env::temp_dir().join("mojing-video-compose");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let list_path = tmp_dir.join(format!("list_{}.txt", uuid::Uuid::new_v4()));

    let mut list_content = String::new();
    for p in &req.clip_paths {
        // concat demuxer format: file 'absolute/path'
        let abs = PathBuf::from(p);
        let abs = abs.canonicalize().unwrap_or(abs);
        list_content.push_str(&format!("file '{}'\n", abs.to_string_lossy()));
    }
    std::fs::write(&list_path, &list_content).map_err(|e| e.to_string())?;

    let mut cmd = FfmpegCommand::new();
    cmd.arg("-f").arg("concat").arg("-safe").arg("0")
        .input(list_path.to_string_lossy().to_string())
        .arg("-c").arg("copy")
        .output(out_path.to_string_lossy().to_string());

    let output = cmd.run().map_err(|e| format!("ffmpeg spawn failed: {:?}", e))?;
    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg failed: {}", stderr));
    }

    // best-effort cleanup
    let _ = std::fs::remove_file(&list_path);

    Ok(ComposeResult {
        output_path: out_path.to_string_lossy().to_string(),
        duration_seconds: None,
    })
}

/// Burn subtitle text into a single clip using the subtitles filter.
/// Uses drawtext for plain text (no .srt file needed) — wraps long lines.
fn render_single_with_subtitle(src: &str, text: &str, out: &Path) -> Result<ComposeResult, String> {
    // Escape special chars for drawtext
    let escaped = text
        .replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\\\'")
        .replace('%', "\\%");

    let filter = format!("drawtext=text='{}':fontcolor=white:fontsize=36:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-50", escaped);

    let mut cmd = FfmpegCommand::new();
    cmd.input(src.to_string())
        .arg("-vf").arg(filter)
        .arg("-c:a").arg("copy")
        .output(out.to_string_lossy().to_string());

    let output = cmd.run().map_err(|e| format!("ffmpeg spawn failed: {:?}", e))?;
    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg drawtext failed: {}", stderr));
    }
    Ok(ComposeResult {
        output_path: out.to_string_lossy().to_string(),
        duration_seconds: None,
    })
}

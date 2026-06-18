// FFmpeg commands — video clip download + composition
// Uses ffmpeg-sidecar to auto-manage FFmpeg binary (no manual install).

use std::path::{Path, PathBuf};
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::event::{FfmpegEvent, LogLevel};
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
pub async fn ffmpeg_probe() -> Result<ProbeResult, String> {
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
/// Tauri's webview fetch can't easily save binary streams to arbitrary paths
/// outside the sandbox, so we do it from Rust.
#[tauri::command]
pub async fn ffmpeg_download_clip(url: String, dest_dir: String, filename: String) -> Result<DownloadResult, String> {
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
    Ok(written)
}

#[derive(Serialize, Deserialize)]
pub struct ComposeRequest {
    pub clip_paths: Vec<String>,
    pub subtitles: Vec<Option<String>>,
    pub output_path: String,
    pub hardcode_subtitles: bool,
}

#[derive(Serialize, Deserialize)]
pub struct ComposeResult {
    pub output_path: String,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<u64>,
}

/// Concatenate clips with optional hardcoded subtitles via FFmpeg.
///
/// Strategy selection:
///   - 1 clip, no subtitle        → file copy (no re-encode)
///   - 1 clip, subtitle           → drawtext (re-encode video, copy audio)
///   - multi-clip, no subtitle    → concat demuxer (assumes codec-aligned;
///                                   on failure callers fall back to re-encode)
///   - multi-clip, with subtitle  → per-clip drawtext re-encode then concat
#[tauri::command]
pub async fn ffmpeg_compose_clips(req: ComposeRequest) -> Result<ComposeResult, String> {
    if req.clip_paths.is_empty() {
        return Err("No clips to compose".to_string());
    }
    if req.clip_paths.len() != req.subtitles.len() {
        return Err("clip_paths and subtitles length mismatch".to_string());
    }

    let result = tokio::task::spawn_blocking(move || compose_blocking(&req))
        .await
        .map_err(|e| format!("compose task panicked: {}", e))??;

    Ok(result)
}

fn compose_blocking(req: &ComposeRequest) -> Result<ComposeResult, String> {
    let out_path = PathBuf::from(&req.output_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let any_subtitle = req
        .subtitles
        .iter()
        .any(|s| s.as_deref().map(|t| !t.is_empty()).unwrap_or(false));

    if req.clip_paths.len() == 1 {
        let src = &req.clip_paths[0];
        let sub = req.subtitles[0].as_deref().filter(|t| !t.is_empty());

        if req.hardcode_subtitles {
            if let Some(text) = sub {
                let r = render_single_with_subtitle(src, text, &out_path)?;
                return Ok(attach_meta(r, &out_path));
            }
        }
        // No subtitle burn-in: file copy is lossless and instant.
        std::fs::copy(src, &out_path).map_err(|e| e.to_string())?;
        return Ok(attach_meta(
            ComposeResult {
                output_path: out_path.to_string_lossy().to_string(),
                duration_seconds: None,
                size_bytes: None,
            },
            &out_path,
        ));
    }

    if !any_subtitle || !req.hardcode_subtitles {
        // No subtitles to burn: concat demuxer with stream copy is fast & lossless.
        // Codec mismatch will surface as a runtime error and the caller can retry
        // with the re-encode path.
        let tmp_dir = std::env::temp_dir().join("mojing-video-compose");
        std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
        let list_path = tmp_dir.join(format!("list_{}.txt", uuid::Uuid::new_v4()));

        let mut list_content = String::new();
        for p in &req.clip_paths {
            let abs = PathBuf::from(p);
            let abs = abs.canonicalize().unwrap_or(abs);
            // Escape single quotes per concat demuxer rules.
            let escaped = abs.to_string_lossy().replace('\'', r"'\''");
            list_content.push_str(&format!("file '{}'\n", escaped));
        }
        std::fs::write(&list_path, &list_content).map_err(|e| e.to_string())?;

        let mut cmd = FfmpegCommand::new();
        cmd.arg("-y")
            .arg("-f").arg("concat").arg("-safe").arg("0")
            .input(list_path.to_string_lossy().to_string())
            .arg("-c").arg("copy")
            .output(out_path.to_string_lossy().to_string());

        let concat_result = run_to_completion(cmd, "ffmpeg concat");
        let _ = std::fs::remove_file(&list_path);
        concat_result?;

        return Ok(attach_meta(
            ComposeResult {
                output_path: out_path.to_string_lossy().to_string(),
                duration_seconds: None,
                size_bytes: None,
            },
            &out_path,
        ));
    }

    // Multi-clip + subtitle burn-in: re-encode each clip with drawtext, then concat.
    let r = compose_multishot_with_subtitles(req, &out_path)?;
    Ok(attach_meta(r, &out_path))
}

/// Burn subtitle text into a single clip using drawtext.
fn render_single_with_subtitle(src: &str, text: &str, out: &Path) -> Result<ComposeResult, String> {
    let escaped = escape_drawtext_text(text);

    let filter = format!(
        "drawtext=text='{}':fontcolor=white:fontsize=36:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-50",
        escaped
    );

    let mut cmd = FfmpegCommand::new();
    cmd.arg("-y")
        .input(src.to_string())
        .arg("-vf").arg(filter)
        .arg("-c:a").arg("copy")
        .output(out.to_string_lossy().to_string());

    run_to_completion(cmd, "ffmpeg drawtext")?;

    Ok(ComposeResult {
        output_path: out.to_string_lossy().to_string(),
        duration_seconds: None,
        size_bytes: None,
    })
}

/// Re-encode every clip with drawtext, then concat them via the concat demuxer.
/// Falls back to the same codec so concat with stream-copy works.
fn compose_multishot_with_subtitles(req: &ComposeRequest, out: &Path) -> Result<ComposeResult, String> {
    let tmp_dir = std::env::temp_dir().join("mojing-video-compose");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let job_id = uuid::Uuid::new_v4();
    let job_dir = tmp_dir.join(format!("job_{}", job_id));
    std::fs::create_dir_all(&job_dir).map_err(|e| e.to_string())?;

    let mut rendered_paths: Vec<PathBuf> = Vec::with_capacity(req.clip_paths.len());
    for (i, clip_src) in req.clip_paths.iter().enumerate() {
        let sub = req.subtitles[i].as_deref().filter(|t| !t.is_empty());
        let rendered = job_dir.join(format!("clip_{:04}.mp4", i));

        if let Some(text) = sub {
            let escaped = escape_drawtext_text(text);
            let filter = format!(
                "drawtext=text='{}':fontcolor=white:fontsize=36:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-50",
                escaped
            );
            let mut cmd = FfmpegCommand::new();
            cmd.arg("-y")
                .input(clip_src.to_string())
                .arg("-vf").arg(filter)
                .arg("-c:v").arg("libx264").arg("-preset").arg("veryfast").arg("-crf").arg("20")
                .arg("-c:a").arg("aac").arg("-b:a").arg("192k")
                .arg("-pix_fmt").arg("yuv420p")
                .output(rendered.to_string_lossy().to_string());
            run_to_completion(cmd, "ffmpeg drawtext+reencode")?;
        } else {
            // No subtitle for this clip; still need consistent codec for concat.
            let mut cmd = FfmpegCommand::new();
            cmd.arg("-y")
                .input(clip_src.to_string())
                .arg("-c:v").arg("libx264").arg("-preset").arg("veryfast").arg("-crf").arg("20")
                .arg("-c:a").arg("aac").arg("-b:a").arg("192k")
                .arg("-pix_fmt").arg("yuv420p")
                .output(rendered.to_string_lossy().to_string());
            run_to_completion(cmd, "ffmpeg reencode")?;
        }
        rendered_paths.push(rendered);
    }

    // Concat the re-encoded clips with stream copy (codec is now uniform).
    let list_path = job_dir.join("list.txt");
    let mut list_content = String::new();
    for p in &rendered_paths {
        let escaped = p.to_string_lossy().replace('\'', r"'\''");
        list_content.push_str(&format!("file '{}'\n", escaped));
    }
    std::fs::write(&list_path, &list_content).map_err(|e| e.to_string())?;

    let mut cmd = FfmpegCommand::new();
    cmd.arg("-y")
        .arg("-f").arg("concat").arg("-safe").arg("0")
        .input(list_path.to_string_lossy().to_string())
        .arg("-c").arg("copy")
        .output(out.to_string_lossy().to_string());

    let concat_result = run_to_completion(cmd, "ffmpeg concat post-render");
    let _ = std::fs::remove_dir_all(&job_dir);
    concat_result?;

    Ok(ComposeResult {
        output_path: out.to_string_lossy().to_string(),
        duration_seconds: None,
        size_bytes: None,
    })
}

/// Escape text for ffmpeg drawtext filter. Order matters.
fn escape_drawtext_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\\\'")
        .replace('%', "\\%")
}

/// Probe duration via ffprobe and stat file size, attach to the result.
fn attach_meta(mut r: ComposeResult, path: &Path) -> ComposeResult {
    if let Ok(meta) = std::fs::metadata(path) {
        r.size_bytes = Some(meta.len());
    }
    if let Some(dur) = probe_duration(path) {
        r.duration_seconds = Some(dur);
    }
    r
}

/// Run ffprobe to get stream/container duration in seconds.
fn probe_duration(path: &Path) -> Option<f64> {
    let path_str = path.to_string_lossy().to_string();
    // ffmpeg-sidecar gives us ffmpeg_version; we need ffprobe binary, which lives
    // alongside. Build path manually to avoid bundling another dep.
    let ffprobe = ffmpeg_sidecar::paths::ffmpeg_path()
        .parent()
        .map(|d| d.join("ffprobe"))
        .or_else(|| {
            // Fall back to PATH lookup.
            which_ffprobe()
        })?;

    let output = std::process::Command::new(ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            &path_str,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// Best-effort ffprobe lookup on PATH. Avoids pulling in `which` crate just for this.
fn which_ffprobe() -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec!["ffprobe.exe", "ffprobe"]
    } else {
        vec!["ffprobe"]
    };
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        for c in &candidates {
            let candidate = dir.join(c);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Spawn an FfmpegCommand, iterate events, surface errors and exit status.
/// ffmpeg-sidecar v2 API requires this manual event loop — there is no `.run()`.
fn run_to_completion(mut cmd: FfmpegCommand, label: &str) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} spawn failed: {:?}", label, e))?;
    let mut iter = child
        .iter()
        .map_err(|e| format!("{} iter failed: {:?}", label, e))?;

    let mut errors: Vec<String> = Vec::new();
    while let Some(event) = iter.next() {
        match event {
            FfmpegEvent::Log(LogLevel::Error, msg) => {
                errors.push(msg);
            }
            FfmpegEvent::Log(LogLevel::Warning, msg) => {
                // Surface warnings for debugging, but don't fail.
                eprintln!("[{}] warning: {}", label, msg);
            }
            FfmpegEvent::Progress(_) | FfmpegEvent::Log(_, _) => {
                // Ignore normal progress/log noise.
            }
            FfmpegEvent::Done => break,
            FfmpegEvent::Error(e) => {
                errors.push(format!("{:?}", e));
                break;
            }
            _ => {}
        }
    }

    if !errors.is_empty() {
        return Err(format!("{} failed: {}", label, errors.join("; ")));
    }
    Ok(())
}

// --- Audio merge (step 11) ---

#[derive(Serialize, Deserialize)]
pub struct MergeAudioRequest {
    pub video_path: String,
    pub audio_path: String,
    pub output_path: String,
}

#[derive(Serialize, Deserialize)]
pub struct MergeAudioResult {
    pub output_path: String,
}

/// Merge an audio track onto a video clip. The video keeps its visual track;
/// audio from `audio_path` replaces (or supplements) the original audio.
///
/// Strategy:
///   - Video stream: copy (no re-encode)
///   - Audio stream: encode to AAC (universal compatibility)
///   - Use the shorter of the two durations (-shortest)
#[tauri::command]
pub async fn ffmpeg_merge_audio(req: MergeAudioRequest) -> Result<MergeAudioResult, String> {
    let result = tokio::task::spawn_blocking(move || merge_audio_blocking(&req))
        .await
        .map_err(|e| format!("merge_audio task panicked: {}", e))??;
    Ok(result)
}

fn merge_audio_blocking(req: &MergeAudioRequest) -> Result<MergeAudioResult, String> {
    let out_path = PathBuf::from(&req.output_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut cmd = FfmpegCommand::new();
    cmd.arg("-y")
        .input(req.video_path.clone())
        .input(req.audio_path.clone())
        // Copy video without re-encoding (preserves quality, fast)
        .arg("-c:v").arg("copy")
        // Encode audio to AAC (universal compatibility)
        .arg("-c:a").arg("aac")
        .arg("-b:a").arg("192k")
        // Use the shorter stream's duration
        .arg("-shortest")
        // Map: video from input 0, audio from input 1
        .arg("-map").arg("0:v")
        .arg("-map").arg("1:a")
        .output(out_path.to_string_lossy().to_string());

    run_to_completion(cmd, "ffmpeg merge_audio")?;

    Ok(MergeAudioResult {
        output_path: out_path.to_string_lossy().to_string(),
    })
}

// --- Data URI → file (for audio merge input materialization) ---

#[derive(Serialize, Deserialize)]
pub struct WriteDataUriRequest {
    pub data_uri: String,
    pub output_path: String,
}

#[derive(Serialize, Deserialize)]
pub struct WriteDataUriResult {
    pub saved_path: String,
    pub bytes: u64,
}

/// Decode a `data:audio/...;base64,XXXX` URI and write to a local file.
/// Used by step-audio-merge to materialize TTS output before FFmpeg merge.
#[tauri::command]
pub async fn ffmpeg_write_data_uri(req: WriteDataUriRequest) -> Result<WriteDataUriResult, String> {
    let result = tokio::task::spawn_blocking(move || write_data_uri_blocking(&req))
        .await
        .map_err(|e| format!("write_data_uri task panicked: {}", e))??;
    Ok(result)
}

fn write_data_uri_blocking(req: &WriteDataUriRequest) -> Result<WriteDataUriResult, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let out_path = PathBuf::from(&req.output_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Strip optional `data:...;base64,` prefix
    let b64 = match req.data_uri.find(',') {
        Some(idx) if req.data_uri.starts_with("data:") => &req.data_uri[idx + 1..],
        _ => &req.data_uri,
    };

    let bytes = STANDARD.decode(b64).map_err(|e| format!("base64 decode failed: {}", e))?;
    std::fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;

    Ok(WriteDataUriResult {
        saved_path: out_path.to_string_lossy().to_string(),
        bytes: bytes.len() as u64,
    })
}

// --- Export to user-chosen path with optional resolution transcode ---

#[derive(Serialize, Deserialize)]
pub struct ExportRequest {
    pub source_path: String,
    pub output_path: String,
    /// Target vertical resolution. None/0 = keep original.
    /// Common values: 720, 1080, 1440, 2160.
    pub target_height: Option<u32>,
}

#[derive(Serialize, Deserialize)]
pub struct ExportResult {
    pub output_path: String,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<u64>,
}

/// Copy or transcode the final video to a user-chosen path.
/// If target_height is Some and differs from the source, re-encodes with scale.
/// Otherwise performs a stream copy (fast, lossless).
#[tauri::command]
pub async fn ffmpeg_export(req: ExportRequest) -> Result<ExportResult, String> {
    let result = tokio::task::spawn_blocking(move || export_blocking(&req))
        .await
        .map_err(|e| format!("export task panicked: {}", e))??;
    Ok(result)
}

fn export_blocking(req: &ExportRequest) -> Result<ExportResult, String> {
    let out_path = PathBuf::from(&req.output_path);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let need_scale = req.target_height.unwrap_or(0) > 0;

    if !need_scale {
        // Stream copy: instant and lossless.
        let mut cmd = FfmpegCommand::new();
        cmd.arg("-y")
            .input(req.source_path.clone())
            .arg("-c").arg("copy")
            .output(out_path.to_string_lossy().to_string());
        run_to_completion(cmd, "ffmpeg export copy")?;
    } else {
        // Re-encode with scale preserving aspect ratio (height = -2 keeps even width).
        let h = req.target_height.unwrap();
        let vf = format!("scale=-2:{}", h);
        let mut cmd = FfmpegCommand::new();
        cmd.arg("-y")
            .input(req.source_path.clone())
            .arg("-vf").arg(vf)
            .arg("-c:v").arg("libx264").arg("-preset").arg("medium").arg("-crf").arg("20")
            .arg("-c:a").arg("copy")
            .arg("-pix_fmt").arg("yuv420p")
            .output(out_path.to_string_lossy().to_string());
        run_to_completion(cmd, "ffmpeg export transcode")?;
    }

    let mut r = ExportResult {
        output_path: out_path.to_string_lossy().to_string(),
        duration_seconds: None,
        size_bytes: None,
    };
    if let Ok(meta) = std::fs::metadata(&out_path) {
        r.size_bytes = Some(meta.len());
    }
    if let Some(d) = probe_duration(&out_path) {
        r.duration_seconds = Some(d);
    }
    Ok(r)
}

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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct ComposeRequest {
    pub clip_paths: Vec<String>,
    pub subtitles: Vec<Option<String>>,
    pub output_path: String,
    pub hardcode_subtitles: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

    // 过滤掉无视频流的 clip(图片 / 0 字节 / HTML 错误页等)。
    // ffmpeg 拿到这些会报 "No streams found",直接整步失败。
    // 过滤后保留对应的 subtitle,顺序不变。
    let mut valid_paths: Vec<String> = Vec::new();
    let mut valid_subs: Vec<Option<String>> = Vec::new();
    for (i, p) in req.clip_paths.iter().enumerate() {
        let path = PathBuf::from(p);
        if !path.exists() {
            eprintln!("[compose] skip clip {}: file not exist: {}", i, p);
            continue;
        }
        if !probe_has_video_stream(&path) {
            eprintln!("[compose] skip clip {}: no video stream: {}", i, p);
            continue;
        }
        valid_paths.push(p.clone());
        valid_subs.push(req.subtitles[i].clone());
    }
    if valid_paths.is_empty() {
        return Err(format!(
            "合成失败:所有 {} 个 clip 都不是有效视频(无视频流或文件不存在)。\
             上游 video_generation 可能返回了图片或下载失败,请检查视频 provider 配置和额度。",
            req.clip_paths.len()
        ));
    }
    if valid_paths.len() < req.clip_paths.len() {
        eprintln!(
            "[compose] 过滤掉 {} 个无效 clip,剩 {} 个有效",
            req.clip_paths.len() - valid_paths.len(),
            valid_paths.len()
        );
    }
    // 用过滤后的列表替换原请求
    let filtered_req = ComposeRequest {
        clip_paths: valid_paths,
        subtitles: valid_subs,
        output_path: req.output_path.clone(),
        hardcode_subtitles: req.hardcode_subtitles,
    };
    let req = &filtered_req;

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
            .arg("-err_detect").arg("ignore_err")  // 容忍个别坏 packet,继续处理
            .arg("-f").arg("concat").arg("-safe").arg("0")
            .input(list_path.to_string_lossy().to_string())
            .arg("-c").arg("copy")
            .output(out_path.to_string_lossy().to_string());

        let concat_result = run_to_completion(cmd, "ffmpeg concat");
        let _ = std::fs::remove_file(&list_path);

        if let Err(e) = concat_result {
            // stream-copy 失败,降级到 re-encode 路径(用统一编码重编每片后 concat)。
            // 这是处理混合编码 / 部分损坏 clip 的兜底。
            eprintln!(
                "[compose] concat stream-copy 失败({}),降级到 re-encode: {}",
                e, out_path.to_string_lossy()
            );
            let reencode_req = ComposeRequest {
                clip_paths: req.clip_paths.clone(),
                subtitles: req.subtitles.clone(),
                output_path: req.output_path.clone(),
                // 强制走 re-encode 路径:随便给个非空字幕是不对的,
                // 直接调 compose_multishot_with_subtitles 但不实际烧字幕。
                hardcode_subtitles: false,
            };
            // 手动重编码每片到统一格式,再 concat
            return compose_reencode_only(&reencode_req, &out_path);
        }

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
    match compose_multishot_with_subtitles(req, &out_path) {
        Ok(r) => return Ok(attach_meta(r, &out_path)),
        Err(e) => {
            // 字幕路径失败,降级到无字幕 re-encode — 至少能拼出视频。
            eprintln!(
                "[compose] 字幕烧录路径失败,降级到 reencode-only(不带字幕): {}",
                e
            );
            let reencode_req = ComposeRequest {
                clip_paths: req.clip_paths.clone(),
                subtitles: req.subtitles.clone(),
                output_path: req.output_path.clone(),
                hardcode_subtitles: false,
            };
            let r = compose_reencode_only(&reencode_req, &out_path)?;
            return Ok(attach_meta(r, &out_path));
        }
    }
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

/// 兜底合成:对每个 clip 重编码到统一格式(libx264 + aac + yuv420p),
/// 然后用 concat demuxer 拼接。用于 stream-copy 失败时的降级路径。
/// 跳过编码失败的 clip(返回错误但继续处理剩余)。
fn compose_reencode_only(req: &ComposeRequest, out: &Path) -> Result<ComposeResult, String> {
    let tmp_dir = std::env::temp_dir().join("mojing-video-compose-reencode");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let job_id = uuid::Uuid::new_v4();
    let job_dir = tmp_dir.join(format!("job_{}", job_id));
    std::fs::create_dir_all(&job_dir).map_err(|e| e.to_string())?;

    let mut rendered_paths: Vec<PathBuf> = Vec::new();
    for (i, clip_src) in req.clip_paths.iter().enumerate() {
        let rendered = job_dir.join(format!("clip_{:04}.mp4", i));
        let mut cmd = FfmpegCommand::new();
        cmd.arg("-y")
            .arg("-err_detect").arg("ignore_err")
            .input(clip_src.to_string())
            .arg("-c:v").arg("libx264").arg("-preset").arg("veryfast").arg("-crf").arg("20")
            .arg("-c:a").arg("aac").arg("-b:a").arg("192k")
            .arg("-pix_fmt").arg("yuv420p")
            .output(rendered.to_string_lossy().to_string());
        match run_to_completion(cmd, "ffmpeg reencode fallback") {
            Ok(()) => {
                // 编码后校验:再次 probe 确认输出有视频流
                if probe_has_video_stream(&rendered) {
                    rendered_paths.push(rendered);
                } else {
                    eprintln!("[compose] re-encode 后仍无视频流,跳过 clip {}", i);
                }
            }
            Err(e) => {
                eprintln!("[compose] re-encode clip {} 失败,跳过: {}", i, e);
            }
        }
    }

    if rendered_paths.is_empty() {
        let _ = std::fs::remove_dir_all(&job_dir);
        return Err(format!(
            "合成失败:re-encode 后没有任何有效 clip(原 {} 个),上游 video_generation 可能全部返回了无效视频",
            req.clip_paths.len()
        ));
    }

    // concat re-encoded clips
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

    let concat_result = run_to_completion(cmd, "ffmpeg concat post-reencode");
    let _ = std::fs::remove_dir_all(&job_dir);
    concat_result?;

    Ok(ComposeResult {
        output_path: out.to_string_lossy().to_string(),
        duration_seconds: probe_duration(out),
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
    let mut first_failure_reason: Option<String> = None;
    for (i, clip_src) in req.clip_paths.iter().enumerate() {
        let sub = req.subtitles[i].as_deref().filter(|t| !t.is_empty());
        let rendered = job_dir.join(format!("clip_{:04}.mp4", i));

        // 编码命令统一加上 -err_detect ignore_err,容忍个别坏 packet。
        // 单个 clip 编码失败时跳过(不冒泡),让其余 clip 仍能拼出最终视频。
        let encode_result: Result<(), String> = if let Some(text) = sub {
            let escaped = escape_drawtext_text(text);
            let filter = format!(
                "drawtext=text='{}':fontcolor=white:fontsize=36:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-50",
                escaped
            );
            let mut cmd = FfmpegCommand::new();
            cmd.arg("-y")
                .arg("-err_detect").arg("ignore_err")
                .input(clip_src.to_string())
                .arg("-vf").arg(filter)
                .arg("-c:v").arg("libx264").arg("-preset").arg("veryfast").arg("-crf").arg("20")
                .arg("-c:a").arg("aac").arg("-b:a").arg("192k")
                .arg("-pix_fmt").arg("yuv420p")
                .output(rendered.to_string_lossy().to_string());
            run_to_completion(cmd, "ffmpeg drawtext+reencode")
        } else {
            // No subtitle for this clip; still need consistent codec for concat.
            let mut cmd = FfmpegCommand::new();
            cmd.arg("-y")
                .arg("-err_detect").arg("ignore_err")
                .input(clip_src.to_string())
                .arg("-c:v").arg("libx264").arg("-preset").arg("veryfast").arg("-crf").arg("20")
                .arg("-c:a").arg("aac").arg("-b:a").arg("192k")
                .arg("-pix_fmt").arg("yuv420p")
                .output(rendered.to_string_lossy().to_string());
            run_to_completion(cmd, "ffmpeg reencode")
        };

        match encode_result {
            Ok(()) => {
                // 编码后再 probe 一次,确认输出真有视频流
                if probe_has_video_stream(&rendered) {
                    rendered_paths.push(rendered);
                } else {
                    eprintln!("[compose] drawtext clip {} 编码后无视频流,跳过", i);
                    if first_failure_reason.is_none() {
                        // 帮用户诊断:看下源文件能不能 probe 出来时长 / 编码
                        first_failure_reason = Some(format!(
                            "clip {} 编码后无视频流。源文件可能损坏或不是有效视频。源:{}",
                            i, clip_src
                        ));
                    }
                }
            }
            Err(e) => {
                eprintln!("[compose] drawtext clip {} 编码失败,跳过: {}", i, e);
                if first_failure_reason.is_none() {
                    first_failure_reason = Some(format!("clip {} 编码失败:{}", i, e));
                }
            }
        }
    }

    if rendered_paths.is_empty() {
        let _ = std::fs::remove_dir_all(&job_dir);
        let diag = first_failure_reason.unwrap_or_else(|| "未知原因".to_string());
        return Err(format!(
            "合成失败:所有 {} 个 clip 编码后都无有效视频流。原因:{}。上游 video_generation 可能返回了图片或损坏文件,或 drawtext 滤镜失败(字体缺失/转义问题)。",
            req.clip_paths.len(), diag
        ));
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
/// Escape text for ffmpeg drawtext filter inside single-quoted `text='...'`.
///
/// drawtext 引号规则:
///   - 外层是单引号字符串,所以文本里的单引号必须用 `'\''`(关引号 → 转义引号 → 开引号)
///   - 反斜杠在引号内仍是转义符,先替成 `\\`
///   - 冒号 `:` 是 filter 选项分隔符,需要转义成 `\:`
///   - 百分号 `%` 用于 text expansion(如 `%{n}`),转义成 `\%`
///
/// 顺序很重要:先替换反斜杠(避免后续替换被它干扰)。
fn escape_drawtext_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "'\\''")
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
    let ffprobe = ffprobe_path()?;
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

/// 检测文件是否包含视频流(codec_type=video)。
/// 用于 compose 前过滤掉"伪视频"(实际是图片/HTML 错误页/0 字节),
/// 避免 ffmpeg 拿到坏文件报 "No streams found"。
fn probe_has_video_stream(path: &Path) -> bool {
    let path_str = path.to_string_lossy().to_string();
    let Some(ffprobe) = ffprobe_path() else {
        // ffprobe 找不到 → 不能校验,放行让 ffmpeg 自己处理(保留旧行为)
        return true;
    };
    let output = std::process::Command::new(ffprobe)
        .args([
            "-v", "error",
            "-select_streams", "v",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            &path_str,
        ])
        .output();
    let Ok(output) = output else { return true; };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    !stdout.trim().is_empty()
}

/// 拿到 ffprobe 可执行文件路径(优先 ffmpeg_sidecar 解压目录,其次 PATH)。
fn ffprobe_path() -> Option<PathBuf> {
    ffmpeg_sidecar::paths::ffmpeg_path()
        .parent()
        .map(|d| d.join("ffprobe"))
        .or_else(|| which_ffprobe())
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
#[serde(rename_all = "camelCase")]
pub struct MergeAudioRequest {
    pub video_path: String,
    pub audio_path: String,
    pub output_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAudioResult {
    pub output_path: String,
}

/// Merge an audio track onto a video clip. The video keeps its visual track;
/// TTS audio from `audio_path` is **mixed** with the video's original audio
/// (rather than replacing it), so provider-generated sound effects / ambience
/// are preserved alongside the narration.
///
/// Strategy:
///   - Video stream: copy (no re-encode)
///   - Audio: amix filter combines original + TTS (TTS at full volume,
///     original at 30% as background ambience)
///   - Encode mixed audio to AAC
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

    // 先探测视频是否带音轨 — 不带音轨就只 mux TTS 进去(原 map 1:a 路径),
    // 带音轨就走 amix 混合(避免原音丢失)。
    let has_audio = clip_has_audio_stream(&req.video_path).unwrap_or(false);

    let mut cmd = FfmpegCommand::new();
    cmd.arg("-y")
        .input(req.video_path.clone())
        .input(req.audio_path.clone());

    if has_audio {
        // 视频原本带音轨:amix 把两条音轨混合(TTS 主,原音降到 30% 做背景)。
        // duration=first 以输入 0(原视频音轨)为准 — amix 输出与视频同长,
        // 避免 TTS 比视频长时音视不同步。
        // 注意:-filter_complex 用不了 -c:v copy,必须重编码视频。
        cmd.arg("-filter_complex")
            .arg("[0:a]volume=0.30[a0];[1:a]volume=1.0[a1];[a0][a1]amix=inputs=2:duration=first[aout]")
            .arg("-map").arg("0:v")
            .arg("-map").arg("[aout]")
            .arg("-c:v").arg("libx264")
            .arg("-preset").arg("ultrafast")
            .arg("-pix_fmt").arg("yuv420p")
            .arg("-c:a").arg("aac")
            .arg("-b:a").arg("192k");
    } else {
        // 视频没有音轨:只把 TTS 接进去。
        // 关键:必须加 -shortest,以视频流时长为准截断。
        // 不加的话,当 TTS 比视频长(Doubao 关了 generate_audio,视频常 5s,
        // TTS 按文字长度可能 8-12s)时,输出 container 时长 = 音频时长,
        // 视频流提前结束 → 后半段无视频帧 → webview 播放器报告 0 时长 / 黑屏。
        cmd.arg("-c:v").arg("copy")
            .arg("-c:a").arg("aac")
            .arg("-b:a").arg("192k")
            .arg("-shortest")
            .arg("-map").arg("0:v")
            .arg("-map").arg("1:a");
    }

    cmd.output(out_path.to_string_lossy().to_string());

    run_to_completion(cmd, "ffmpeg merge_audio")?;

    Ok(MergeAudioResult {
        output_path: out_path.to_string_lossy().to_string(),
    })
}

/// 探测视频文件是否包含音频流。true = 有音频流,false = 纯视频。
/// 探测失败返回 None,调用方按"无音轨"处理(只 mux TTS)。
fn clip_has_audio_stream(path: &str) -> Result<bool, String> {
    let Some(ffprobe) = ffprobe_path() else {
        // ffprobe 找不到 — 保守起见认为无音轨,走 mux-only 路径
        return Ok(false);
    };
    let output = std::process::Command::new(ffprobe)
        .args([
            "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            path,
        ])
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;
    if !output.status.success() {
        return Ok(false);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(!stdout.trim().is_empty())
}

// --- Data URI → file (for audio merge input materialization) ---

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDataUriRequest {
    pub data_uri: String,
    pub output_path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub source_path: String,
    pub output_path: String,
    /// Target vertical resolution. None/0 = keep original.
    /// Common values: 720, 1080, 1440, 2160.
    pub target_height: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

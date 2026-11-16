use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frame_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frame_count: u32,
    pub duration_seconds: f64,
    pub size_bytes: u64,
}

struct RenderJob {
    config: RenderConfig,
    directory: PathBuf,
    output: PathBuf,
    written: AtomicU32,
    cancelled: AtomicBool,
    encoding: AtomicBool,
    operation: Mutex<()>,
    child: Mutex<Option<Child>>,
}
#[derive(Default, Clone)]
pub struct WorldRenderJobs(Arc<Mutex<HashMap<String, Arc<RenderJob>>>>);

impl WorldRenderJobs {
    fn get(&self, id: &str) -> Result<Arc<RenderJob>, String> {
        self.0
            .lock()
            .map_err(|_| "Render state unavailable")?
            .get(id)
            .cloned()
            .ok_or_else(|| "Render job no longer exists".into())
    }
    fn begin(&self, config: RenderConfig, cache: &Path, assets: &Path) -> Result<String, String> {
        if ![15, 24, 25, 30].contains(&config.fps)
            || config.width < 256
            || config.height < 256
            || config.width > 1920
            || config.height > 1920
            || config.width % 2 != 0
            || config.height % 2 != 0
            || config.frame_count == 0
            || config.frame_count > 60 * config.fps
        {
            return Err("Invalid frame render configuration".into());
        }
        if crate::ffmpeg::ffprobe_path().is_none() {
            return Err("FFprobe is required for frame render verification".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = cache.join(&id);
        std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let job = Arc::new(RenderJob {
            config,
            directory,
            output: assets.join(format!("{}-offline.mp4", id)),
            written: AtomicU32::new(0),
            cancelled: AtomicBool::new(false),
            encoding: AtomicBool::new(false),
            operation: Mutex::new(()),
            child: Mutex::new(None),
        });
        self.0
            .lock()
            .map_err(|_| "Render state unavailable")?
            .insert(id.clone(), job);
        Ok(id)
    }
    fn frame(&self, id: &str, index: u32, data: &str) -> Result<(), String> {
        let job = self.get(id)?;
        let _operation = job
            .operation
            .lock()
            .map_err(|_| "Render operation unavailable")?;
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        if job.encoding.load(Ordering::SeqCst)
            || index != job.written.load(Ordering::SeqCst)
            || index >= job.config.frame_count
        {
            return Err("Frames must be written once in sequence".into());
        }
        let encoded = data
            .strip_prefix("data:image/png;base64,")
            .ok_or("Expected a PNG frame")?;
        if encoded.len() > 32 * 1024 * 1024 {
            return Err("Frame exceeds size limit".into());
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid PNG frame")?;
        if bytes.len() < 33
            || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
            || &bytes[12..16] != b"IHDR"
            || u32::from_be_bytes(bytes[16..20].try_into().unwrap()) != job.config.width
            || u32::from_be_bytes(bytes[20..24].try_into().unwrap()) != job.config.height
        {
            return Err("PNG frame dimensions do not match the render".into());
        }
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(job.directory.join(format!("frame-{:06}.png", index)))
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        job.written.store(index + 1, Ordering::SeqCst);
        Ok(())
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let job = match self.get(id) {
            Ok(job) => job,
            Err(_) => return Ok(()),
        };
        job.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = job
            .child
            .lock()
            .map_err(|_| "Encoder state unavailable")?
            .as_mut()
        {
            let _ = child.kill();
        }
        let _operation = job
            .operation
            .lock()
            .map_err(|_| "Render operation unavailable")?;
        // The directory is created here from a generated UUID; no caller path is removed.
        if job.directory.exists() {
            std::fs::remove_dir_all(&job.directory).map_err(|e| e.to_string())?;
        }
        self.0
            .lock()
            .map_err(|_| "Render state unavailable")?
            .remove(id);
        Ok(())
    }
    fn finish(&self, id: &str) -> Result<RenderResult, String> {
        let job = self.get(id)?;
        if job.encoding.swap(true, Ordering::SeqCst) {
            return Err("Encoder already running".into());
        }
        let result = self.encode(&job);
        job.encoding.store(false, Ordering::SeqCst);
        if result.is_ok() {
            self.0
                .lock()
                .map_err(|_| "Render state unavailable")?
                .remove(id);
        }
        result
    }
    fn encode(&self, job: &RenderJob) -> Result<RenderResult, String> {
        let _operation = job
            .operation
            .lock()
            .map_err(|_| "Render operation unavailable")?;
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        if job.written.load(Ordering::SeqCst) != job.config.frame_count {
            return Err("Frame sequence is incomplete".into());
        }
        let partial = job.directory.join("encoded.mp4");
        let errors = job.directory.join("encode.log");
        let mut command = hidden_command(ffmpeg_sidecar::paths::ffmpeg_path());
        command
            .args(["-y", "-nostdin", "-v", "error", "-framerate"])
            .arg(job.config.fps.to_string())
            .args(["-start_number", "0", "-i"])
            .arg(job.directory.join("frame-%06d.png"))
            .arg("-frames:v")
            .arg(job.config.frame_count.to_string())
            .args([
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ])
            .arg(&partial)
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(&errors).map_err(|e| e.to_string())?);
        if !run_child(job, command)? {
            return Err(format!("Frame encoding failed: {}", error_tail(&errors)));
        }
        let metadata = job.directory.join("probe.json");
        let mut probe = hidden_command(crate::ffmpeg::ffprobe_path().ok_or("FFprobe unavailable")?);
        probe.args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,pix_fmt,nb_read_frames,avg_frame_rate:format=duration", "-of", "json"])
            .arg(&partial).stdout(std::fs::File::create(&metadata).map_err(|e| e.to_string())?).stderr(Stdio::null());
        if !run_child(job, probe)? {
            return Err("Encoded video could not be verified".into());
        }
        let info: serde_json::Value =
            serde_json::from_slice(&std::fs::read(metadata).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let video = &info["streams"][0];
        let duration = info["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .ok_or("Missing encoded duration")?;
        let frame_count = video["nb_read_frames"]
            .as_str()
            .and_then(|s| s.parse::<u32>().ok());
        let rate = video["avg_frame_rate"]
            .as_str()
            .and_then(|s| s.split_once('/'))
            .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok()?));
        let config = &job.config;
        if video["codec_name"] != "h264"
            || video["pix_fmt"] != "yuv420p"
            || video["width"] != config.width
            || video["height"] != config.height
            || frame_count != Some(config.frame_count)
            || rate
                .map(|r| (r - config.fps as f64).abs() > 1e-6)
                .unwrap_or(true)
            || !duration.is_finite()
            || (duration - config.frame_count as f64 / config.fps as f64).abs() > 0.02
        {
            return Err("Encoded video does not match the complete frame sequence".into());
        }
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        std::fs::create_dir_all(job.output.parent().ok_or("Missing asset directory")?)
            .map_err(|e| e.to_string())?;
        if job.output.exists() {
            return Err("Render output already exists".into());
        }
        let size_bytes = std::fs::metadata(&partial)
            .map_err(|e| e.to_string())?
            .len();
        std::fs::rename(&partial, &job.output).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&job.directory);
        Ok(RenderResult {
            output_path: job.output.to_string_lossy().into(),
            width: config.width,
            height: config.height,
            fps: config.fps,
            frame_count: config.frame_count,
            duration_seconds: duration,
            size_bytes,
        })
    }
}

fn hidden_command(path: PathBuf) -> Command {
    let mut command = Command::new(path);
    command.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn run_child(job: &RenderJob, mut command: Command) -> Result<bool, String> {
    {
        let mut slot = job.child.lock().map_err(|_| "Encoder state unavailable")?;
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        *slot = Some(command.spawn().map_err(|e| e.to_string())?);
    }
    loop {
        {
            let mut slot = job.child.lock().map_err(|_| "Encoder state unavailable")?;
            let child = slot.as_mut().ok_or("Encoder process missing")?;
            if job.cancelled.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                *slot = None;
                return Err("cancelled".into());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    *slot = None;
                    return Ok(status.success());
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    *slot = None;
                    return Err(error.to_string());
                }
                Ok(None) => {}
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn error_tail(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(1500)..]).into()
}

#[tauri::command]
pub async fn world_render_begin(
    app: tauri::AppHandle,
    jobs: tauri::State<'_, WorldRenderJobs>,
    config: RenderConfig,
) -> Result<String, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("world-renders");
    let assets = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("video-assets")
        .join("studio-library")
        .join("clip");
    let jobs = jobs.inner().clone();
    tokio::task::spawn_blocking(move || jobs.begin(config, &cache, &assets))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn world_render_frame(
    jobs: tauri::State<'_, WorldRenderJobs>,
    job_id: String,
    index: u32,
    data_uri: String,
) -> Result<(), String> {
    let jobs = jobs.inner().clone();
    tokio::task::spawn_blocking(move || jobs.frame(&job_id, index, &data_uri))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn world_render_finish(
    jobs: tauri::State<'_, WorldRenderJobs>,
    job_id: String,
) -> Result<RenderResult, String> {
    let jobs = jobs.inner().clone();
    tokio::task::spawn_blocking(move || jobs.finish(&job_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn world_render_cancel(
    jobs: tauri::State<'_, WorldRenderJobs>,
    job_id: String,
) -> Result<(), String> {
    let jobs = jobs.inner().clone();
    tokio::task::spawn_blocking(move || jobs.cancel(&job_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn roots() -> (PathBuf, PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("mojing-offline-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        (root.clone(), root.join("cache"), root.join("assets"))
    }
    fn config(count: u32) -> RenderConfig {
        RenderConfig {
            width: 256,
            height: 256,
            fps: 24,
            frame_count: count,
        }
    }
    fn png(color: &str) -> Vec<u8> {
        let output = hidden_command(ffmpeg_sidecar::paths::ffmpeg_path())
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c={}:s=256x256", color),
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-c:v",
                "png",
                "-",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    }
    fn data(bytes: &[u8]) -> String {
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }
    #[test]
    fn complete_frames_encode_and_verify_without_touching_other_files() {
        let (root, cache, assets) = roots();
        let jobs = WorldRenderJobs::default();
        let sentinel = root.join("keep.txt");
        std::fs::write(&sentinel, b"keep").unwrap();
        let id = jobs.begin(config(4), &cache, &assets).unwrap();
        let red = data(&png("red"));
        let blue = data(&png("blue"));
        assert!(jobs.frame(&id, 1, &red).is_err());
        assert!(jobs.finish(&id).is_err());
        assert!(jobs.frame(&id, 0, "data:image/png;base64,eA==").is_err());
        jobs.frame(&id, 0, &red).unwrap();
        assert!(jobs.frame(&id, 0, &red).is_err());
        for index in 1..4 {
            jobs.frame(&id, index, if index < 2 { &red } else { &blue })
                .unwrap();
        }
        let result = jobs.finish(&id).unwrap();
        assert_eq!(result.frame_count, 4);
        assert_eq!(result.width, 256);
        assert_eq!(result.fps, 24);
        assert!(result.size_bytes > 100);
        assert!((result.duration_seconds - 4.0 / 24.0).abs() < 0.001);
        assert!(!cache.join(&id).exists());
        assert!(jobs.get(&id).is_err());
        jobs.cancel(&id).unwrap();
        assert!(Path::new(&result.output_path).exists());
        for (index, channel) in [(0, 0), (3, 2)] {
            let image = hidden_command(ffmpeg_sidecar::paths::ffmpeg_path())
                .args([
                    "-v",
                    "error",
                    "-i",
                    &result.output_path,
                    "-vf",
                    &format!("select=eq(n\\,{})", index),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                ])
                .output()
                .unwrap();
            assert!(image.status.success());
            assert!(image.stdout.len() >= 3);
            assert!(image.stdout[channel] > 200);
            assert!(image.stdout[(channel + 1) % 3] < 20);
        }
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep");
        jobs.cancel("../keep.txt").unwrap();
        assert!(sentinel.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn encoder_failure_retains_frames_for_retry_and_cancel_discards_owned_cache() {
        let (root, cache, assets) = roots();
        let jobs = WorldRenderJobs::default();
        let bytes = png("green");
        let frame = data(&bytes);
        let id = jobs.begin(config(2), &cache, &assets).unwrap();
        jobs.frame(&id, 0, &frame).unwrap();
        jobs.frame(&id, 1, &frame).unwrap();
        let file = cache.join(&id).join("frame-000001.png");
        std::fs::write(&file, b"broken").unwrap();
        assert!(jobs.finish(&id).is_err());
        assert_eq!(jobs.get(&id).unwrap().written.load(Ordering::SeqCst), 2);
        assert!(file.exists());
        std::fs::write(file, &bytes).unwrap();
        assert!(jobs.finish(&id).is_ok());
        let cancelled = jobs.begin(config(2), &cache, &assets).unwrap();
        jobs.frame(&cancelled, 0, &frame).unwrap();
        jobs.cancel(&cancelled).unwrap();
        assert!(!cache.join(&cancelled).exists());
        assert!(jobs.frame(&cancelled, 1, &frame).is_err());
        for bad in [
            RenderConfig {
                fps: 0,
                ..config(1)
            },
            RenderConfig {
                width: 257,
                ..config(1)
            },
            config(1801),
        ] {
            assert!(jobs.begin(bad, &cache, &assets).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelling_a_running_encoder_kills_it_and_cleans_up() {
        let (root, cache, assets) = roots();
        let jobs = WorldRenderJobs::default();
        let id = jobs.begin(config(1), &cache, &assets).unwrap();
        let job = jobs.get(&id).unwrap();
        let worker_job = job.clone();
        let worker = std::thread::spawn(move || {
            let _operation = worker_job.operation.lock().unwrap();
            let mut command = hidden_command(ffmpeg_sidecar::paths::ffmpeg_path());
            command
                .args([
                    "-v",
                    "error",
                    "-re",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=s=16x16:r=24",
                    "-f",
                    "null",
                    "-",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            run_child(&worker_job, command)
        });
        for _ in 0..100 {
            if job.child.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(job.child.lock().unwrap().is_some());
        jobs.cancel(&id).unwrap();
        assert_eq!(worker.join().unwrap().unwrap_err(), "cancelled");
        assert!(job.child.lock().unwrap().is_none());
        assert!(!cache.join(id).exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

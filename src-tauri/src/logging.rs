// logging.rs — 滚动日志写入
//
// 设计:
//   - 路径:{app_data_dir}/mojing/logs/app.log
//   - 单文件最大 2MB,超过则滚动:app.log → app.log.1 → app.log.2 → app.log.3 (丢弃更老的)
//   - 所有写入追加 + 每行带 ISO8601 时间戳和 level 前缀
//   - 不依赖第三方 crate (避免 appender 锁定 Stdout),用 std::fs
//
// 跨平台路径靠 tauri::Manager::path().app_data_dir()。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 2 * 1024 * 1024; // 2 MB
const MAX_BACKUPS: u32 = 3;

/// 进程级文件锁,避免并发写交错。
/// 多次 invoke 在 tokio 线程池里跑,所以需要互斥。
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogWriteRequest {
    pub level: String, // "error" | "warn" | "info" | "debug"
    pub message: String,
    /// 可选:来源 (组件名 / 模块路径)
    pub source: Option<String>,
}

#[derive(serde::Serialize)]
pub struct LogWriteResult {
    pub path: String,
    pub rolled: bool,
}

/// 前端调用的命令。app_handle 由 Tauri 注入,用于拿 app_data_dir。
#[tauri::command]
pub fn log_write(app: AppHandle, req: LogWriteRequest) -> Result<LogWriteResult, String> {
    let _guard = LOG_LOCK.lock().map_err(|e| format!("log lock poisoned: {}", e))?;

    let log_dir = resolve_log_dir(&app)?;
    fs::create_dir_all(&log_dir).map_err(|e| format!("create log dir failed: {}", e))?;
    let log_path = log_dir.join("app.log");

    let rolled = rotate_if_needed(&log_path)?;

    let line = format_line(&req.level, &req.message, req.source.as_deref());
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open log failed: {}", e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("write log failed: {}", e))?;
    file.flush().ok();

    Ok(LogWriteResult {
        path: log_path.to_string_lossy().to_string(),
        rolled,
    })
}

/// 返回日志文件路径给前端 (用于在 UI 上"打开日志文件夹")。
#[tauri::command]
pub fn log_path(app: AppHandle) -> Result<String, String> {
    let dir = resolve_log_dir(&app)?;
    Ok(dir.join("app.log").to_string_lossy().to_string())
}

fn resolve_log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir failed: {:?}", e))?;
    Ok(base.join("logs"))
}

fn format_line(level: &str, message: &str, source: Option<&str>) -> String {
    let ts = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let lvl = level.trim().to_lowercase();
    let src = source
        .map(|s| format!("[{}] ", s))
        .unwrap_or_default();
    // 跨平台行尾规范化为 \n
    let body = message.replace('\r', " ").replace('\n', " ↵ ");
    format!("{} {:>5} {}{}\n", ts, lvl.to_uppercase(), src, body)
}

/// 若当前日志超过 MAX_BYTES,把 app.log.(N-1) → app.log.N,丢弃最末尾。
/// 用 std::fs 重命名,失败不致命 (容错)。
fn rotate_if_needed(log_path: &PathBuf) -> Result<bool, String> {
    let meta = match fs::metadata(log_path) {
        Ok(m) => m,
        Err(_) => return Ok(false), // 文件不存在,无需滚动
    };
    if meta.len() < MAX_BYTES {
        return Ok(false);
    }

    let parent = log_path.parent().ok_or("log path has no parent")?;
    // app.log.3 → 删除
    let oldest = parent.join(format!("app.log.{}", MAX_BACKUPS));
    if oldest.exists() {
        let _ = fs::remove_file(&oldest);
    }
    // 从 (N-1) 倒序到 1,统一升一级
    for i in (1..MAX_BACKUPS).rev() {
        let src = parent.join(format!("app.log.{}", i));
        let dst = parent.join(format!("app.log.{}", i + 1));
        if src.exists() {
            let _ = fs::rename(&src, &dst);
        }
    }
    // 当前 app.log → app.log.1
    let dst = parent.join("app.log.1");
    fs::rename(log_path, &dst).map_err(|e| format!("rotate rename failed: {}", e))?;
    Ok(true)
}

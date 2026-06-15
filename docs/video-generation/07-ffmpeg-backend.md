# 07 — Tauri FFmpeg 合成后端

## 设计目标

把 N 个 AI 生成的视频片段（clip）拼接成一段完整的视频，可选硬编码字幕。

## 技术选型

### 为什么不用前端 fetch 直接合成？

- Webview fetch 无法写任意本地路径（沙箱限制）
- FFmpeg 是 native binary，必须通过 Tauri Rust 后端调用
- 大文件拼接需要流式 IO，前端不适合

### 为什么用 ffmpeg-sidecar？

[`ffmpeg-sidecar`](https://github.com/nathanbabcock/ffmpeg-sidecar) 是 Rust crate，特点：
- **自动下载 FFmpeg 二进制**到用户 data dir（首次调用时）
- **跨平台**（Windows/macOS/Linux）
- 用户无需手动安装 FFmpeg
- 提供 high-level `FfmpegCommand` builder

vs 替代方案：
- 要求用户手动装 FFmpeg → 门槛高、不专业
- `std::process::Command` 调 PATH 上的 ffmpeg → 依赖系统环境

## 命令清单

文件：`src-tauri/src/ffmpeg.rs`

### 1. `ffmpeg_probe()`

检测 FFmpeg 是否可用。首次调用会触发 ffmpeg-sidecar 下载（约 80MB）。

```rust
#[tauri::command]
async fn ffmpeg_probe() -> Result<ProbeResult, String> {
    let result = tokio::task::spawn_blocking(|| {
        match ffmpeg_version() {
            Ok(v) => ProbeResult { available: true, version: Some(v), error: None },
            Err(e) => ProbeResult { available: false, version: None, error: Some(format!("{:?}", e)) },
        }
    }).await??;
    Ok(result)
}
```

返回：
```ts
interface ProbeResult {
  available: boolean;
  version?: string;
  error?: string;
}
```

### 2. `ffmpeg_download_clip(url, dest_dir, filename)`

下载远程视频 URL 到本地。webview fetch 不能写文件，必须走 Rust。

```rust
#[tauri::command]
async fn ffmpeg_download_clip(url: String, dest_dir: String, filename: String) 
    -> Result<DownloadResult, String>
```

实现用 `reqwest` streaming + `tokio::fs` 异步写入。

超时 300 秒（大视频兜底）。

### 3. `ffmpeg_compose_clips(req)`

核心命令：拼接 + 字幕。

```rust
#[derive(Serialize, Deserialize)]
pub struct ComposeRequest {
    pub clip_paths: Vec<String>,
    pub subtitles: Vec<Option<String>>,     // 与 clip_paths 等长
    pub output_path: String,
    pub hardcode_subtitles: bool,
}

#[tauri::command]
async fn ffmpeg_compose_clips(req: ComposeRequest) -> Result<ComposeResult, String>
```

## 合成策略（按 Phase 演进）

### Phase 1：concat demuxer copy（当前实现）

**假设**：所有 clip 同 codec、同分辨率、同 fps。

```rust
fn compose_blocking(req: &ComposeRequest) -> Result<ComposeResult, String> {
    // 单 clip 特殊路径：直接 copy 或加 drawtext 字幕
    if req.clip_paths.len() == 1 {
        return render_single_with_subtitle(...) or std::fs::copy(...);
    }

    // 多 clip：写 concat list 文件
    let list_content = req.clip_paths.iter()
        .map(|p| format!("file '{}'\n", canonicalize(p)))
        .collect::<String>();
    std::fs::write(&list_path, list_content)?;

    // FFmpeg concat demuxer
    FfmpegCommand::new()
        .arg("-f").arg("concat").arg("-safe").arg("0")
        .input(list_path)
        .arg("-c").arg("copy")  // 不重新编码，最快
        .output(output_path)
        .run()?;
}
```

**优点**：极速（不重新编码）
**缺点**：要求 clip 同 codec；不达标会失败

### Phase 1 字幕硬编码

单 clip 时用 drawtext filter：

```rust
let filter = format!(
    "drawtext=text='{escaped}':fontcolor=white:fontsize=36:\
     borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-50",
    escaped_text
);

FfmpegCommand::new()
    .input(src)
    .arg("-vf").arg(filter)
    .arg("-c:a").arg("copy")
    .output(out)
    .run()?;
```

字幕位置：底部居中，白色 + 黑描边（保证任何背景下可读）。

### Phase 2：re-encode + 字幕轨道

不同 codec 的 clip 必须 re-encode：

```rust
FfmpegCommand::new()
    .inputs(clip_paths)
    .arg("-filter_complex").arg("concat=n=N:v=1:a=1")
    .arg("-c:v").arg("libx264")
    .arg("-preset").arg("medium")
    .arg("-crf").arg("23")
    .arg("-c:a").arg("aac")
    .output(output_path)
    .run()?;
```

字幕：可选硬编码（drawtext）或软字幕（.srt 轨道）。

### Phase 3：转场特效

```rust
// 用 xfade filter 实现淡入淡出
let filter = format!(
    "xfade=transition=fade:duration=0.5:offset={}",
    offset_seconds
);
```

## 前端 IPC 封装

文件：`src/services/video/ffmpeg-bridge.ts`

```ts
export async function probeFFmpeg(): Promise<ProbeResult> {
  try {
    return await invoke<ProbeResult>('ffmpeg_probe', {});
  } catch (err) {
    return { available: false, error: String(err) };
  }
}

export async function downloadClip(url, destDir, filename): Promise<DownloadResult> {
  return invoke<DownloadResult>('ffmpeg_download_clip', { url, destDir, filename });
}

export async function composeClips(req: ComposeRequest): Promise<ComposeResult> {
  return invoke<ComposeResult>('ffmpeg_compose_clips', { req });
}
```

`isTauri()` 检测环境，非 Tauri 直接抛错让 pipeline 降级。

## 工作目录

```ts
async function getWorkDir(novelProjectId: string): Promise<string> {
  const { appDataDir } = await import('@tauri-apps/api/path');
  const base = await appDataDir();
  return `${base}/video-cache/${novelProjectId}`;
}
```

每个小说项目的视频缓存隔离在 `<appData>/video-cache/<novelId>/`。

## 错误处理

Rust 端把 FFmpeg stderr 返回给前端：

```rust
let output = cmd.run().map_err(|e| format!("ffmpeg spawn failed: {:?}", e))?;
if !output.success {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(format!("ffmpeg failed: {}", stderr));
}
```

前端 console.warn 显示，不中断 UI。

## Cargo.toml 依赖

```toml
ffmpeg-sidecar = "2"
reqwest = { version = "0.12", features = ["blocking", "stream"] }
futures-util = "0.3"
```

reqwest 拉 TLS/OpenSSL 等传递依赖，**首次 cargo build 较慢**（约 3-5 分钟）。

## 性能参考

| 场景 | 耗时 |
|------|------|
| 单 clip + 字幕 | ~2 秒 |
| 5 clip concat copy | ~1 秒 |
| 5 clip re-encode (H.264 medium) | ~30 秒 |
| 5 clip re-encode + xfade | ~60 秒 |

## 已知限制

1. **Phase 1 不支持混合 codec**：如果 Kling 和 Runway 输出的 mp4 编码不同，concat 会失败
2. **字幕只支持中文/英文 drawtext**：复杂格式（.ass）需 Phase 3
3. **不支持音频混合**：原生音频 clip 和 TTS 配音不能同时存在（Phase 3）
4. **无进度回调**：FFmpeg 跑期间前端没有细粒度进度（Phase 3 加 stderr 解析）

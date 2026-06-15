# 11 — 常见问题与排查

## 启动按钮禁用

**症状**：VideoGeneratorModal 的"开始生成"按钮灰色

**原因**：
1. 没选小说项目
2. 没选章节
3. **没配置 video provider**

**排查**：

```ts
// VideoGeneratorModal 里检查 hasVideoProvider
const videoEndpoints = useProviderStore((s) => s.endpoints.filter((e) => e.enabled));
const hasVideoProvider = videoEndpoints.length > 0;
```

**修复**：Settings → Providers → 新增 video endpoint（如 Kling baseUrl + apiKey）→ 启用。

---

## Rust 编译失败

### 错误：`ffmpeg-sidecar` 找不到

```
error: failed to select a version for `ffmpeg-sidecar`
```

**修复**：检查 `src-tauri/Cargo.toml`：
```toml
ffmpeg-sidecar = "2"
```

或降级到稳定版：
```toml
ffmpeg-sidecar = "1.1.2"
```

### 错误：reqwest 依赖冲突

reqwest 拉的 OpenSSL/hyper-tree 可能与现有依赖冲突。

**修复**：用 rustls 替代 OpenSSL：

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
```

### 错误：tokio feature 缺失

```
error: `tokio::task::spawn_blocking` requires `rt-multi-thread`
```

**修复**：`Cargo.toml` 已配置，确认没被覆盖：
```toml
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }
```

---

## FFmpeg 不可用

**症状**：compose 阶段降级，直接用第一个 clip 作占位

**排查**：

```ts
// 前端
const probe = await probeFFmpeg();
console.log(probe);
// { available: false, error: "..." }
```

**常见原因**：

1. **首次下载失败**（网络）
   - ffmpeg-sidecar 首次会从 GitHub 下载 FFmpeg 二进制（~80MB）
   - 国内网络可能慢/失败
   - **修复**：手动下载 FFmpeg 共享版放到 `<appData>/ffmpeg-sidecar/`

2. **Tauri 命令未注册**
   - `src-tauri/src/lib.rs` 检查：
     ```rust
     .invoke_handler(tauri::generate_handler![
         write_export_file,
         ffmpeg::ffmpeg_probe,
         ffmpeg::ffmpeg_download_clip,
         ffmpeg::ffmpeg_compose_clips
     ])
     ```

3. **非 Tauri 环境**
   - 浏览器开发模式（`pnpm dev`）下 FFmpeg 命令不可用
   - 必须 `pnpm tauri dev` 或 `pnpm tauri build`

---

## Kling API 错误

### 401 Unauthorized

API key 错误或过期。Settings → Providers 检查。

### 429 Too Many Requests

并发太高。降并发：

```ts
// pipeline.ts
const VIDEO_GENERATION_CONCURRENCY = 1;  // 从 2 降到 1
```

### 任务超时（10 分钟）

Kling 异步任务轮询最长 10 分钟。复杂 prompt 可能超时。

**修复**：缩短 prompt 或换更快的模型（如 Kling Std 替代 Pro）。

---

## 视频生成出来角色不一致

**这是 Phase 1 的预期行为**（直接 T2V，没有角色锚定）。

**Phase 2 解决方案**：见 [06-character-consistency.md](./06-character-consistency.md)

---

## 合成失败：codec 不匹配

**症状**：`ffmpeg_compose_clips` 返回 `concat demuxer failed`

**原因**：Phase 1 用 concat copy，假设所有 clip 同 codec。混合 Kling + Runway 输出时可能不一致。

**Phase 2 修复**：用 re-encode 模式：

```rust
// ffmpeg.rs compose_blocking()
FfmpegCommand::new()
    .arg("-f").arg("concat").arg("-safe").arg("0")
    .input(list_path)
    .arg("-c:v").arg("libx264")  // 强制 re-encode
    .arg("-c:a").arg("aac")
    .output(out_path)
    .run()?;
```

---

## 字幕乱码

**症状**：drawtext 渲染的中文显示为方块

**原因**：FFmpeg 默认字体不支持中文。

**修复**：指定中文字体文件：

```rust
// ffmpeg.rs render_single_with_subtitle()
let filter = format!(
    "drawtext=text='{escaped}':\
     fontfile='C\\:/Windows/Fonts/msyh.ttd':\
     fontcolor=white:fontsize=36...",
    escaped
);
```

或跨平台方案：用 `font-kit` crate 自动找系统字体。

---

## LLM 返回非 JSON

**症状**：storyboard-prompt 报 `Expected array`

**排查**：

```ts
const raw = response.content;
console.log(raw);  // 看实际返回
```

**修复**：
- `parseLLMJson` 已经做了 fallback（提取 `{...}` 或 `[...]`）
- 如果还是失败，温度降到 0.3 重试
- 极端情况：检查 LLM endpoint 是否支持 `responseFormat: 'json'`

---

## 性能问题

### 视频生成太慢

**预期**：每个 shot 30-90 秒。

**优化**：
- 用更快的模型（Kling Std vs Pro）
- 降并发到 1（避免被限速）
- 缩短 prompt（精简到 50 词以内）

### 首次 Rust 编译太慢

reqwest + ffmpeg-sidecar 拉很多依赖，首次 5-10 分钟正常。

**优化**：
- 用 `cargo check` 而非 `cargo build` 验证语法
- 启用 `cargo` 增量编译（默认已开）
- 用 sccache 缓存：`cargo install sccache && export RUSTC_WRAPPER=sccache`

---

## 数据丢失

### videoStore 重启后清空

**预期行为**：videoStore 不持久化（设计如此）。

如果需要持久化，修改 `src/stores/videoStore.ts`：

```ts
import { persist } from 'zustand/middleware';

export const useVideoStore = create(
  persist<VideoStoreState>(
    (set, get) => ({ /* ... */ }),
    { name: 'mojing-video-store' }
  )
);
```

注意：URL 过期后这些数据也没用，不建议持久化。

### 临时视频文件占空间

合成缓存在 `<appData>/video-cache/<novelId>/`。

**清理**：

```ts
// 新增清理命令（Phase 3）
async function clearVideoCache(novelId?: string) {
  const workDir = novelId
    ? `${await appDataDir()}/video-cache/${novelId}`
    : `${await appDataDir()}/video-cache`;
  await fs.rm(workDir, { recursive: true });
}
```

UI 加"清理缓存"按钮。

---

## 调试技巧

### 打开 DevTools

Tauri 开发模式默认开 DevTools。打包版需要：

```ts
// main.tsx 或 lib.rs
if (process.env.NODE_ENV === 'development') {
  // 自动打开 DevTools
}
```

### 查看 videoStore 状态

浏览器控制台：

```ts
useVideoStore.getState();
// 看完整状态
```

### 跟踪 Pipeline 执行

```ts
// pipeline.ts 已有 console.warn
// 加更多日志：
console.log(`[VideoPipeline] stage=${stage} progress=${progress}`);
```

### 强制单 stage 重跑

```ts
// 控制台
useVideoStore.getState().setStageStatus(novelId, 'video_generation', 'pending');
useVideoStore.getState().clearClips(novelId);  // Phase 3 待加
// 然后重新触发 pipeline
```

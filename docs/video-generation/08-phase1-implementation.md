# 08 — Phase 1 MVP 实现清单

**状态**：✅ 已完成（代码 + typecheck 通过）
**日期**：2026-06-15
**未做**：端到端真机测试（等 Bash classifier 恢复后跑 `pnpm tauri build`）

## 文件清单

### 新建

| 文件 | 行数 | 说明 |
|------|-----|------|
| `src/types/video.ts` | 154 | 类型定义：VideoStage、StoryboardShot、VideoProjectState 等 |
| `src/stores/videoStore.ts` | 230 | Zustand store |
| `src/services/video/chapter-slicer.ts` | 175 | 本地启发式切片 |
| `src/services/video/storyboard-prompt.ts` | 200 | LLM 批处理生成 videoPrompt |
| `src/services/video/pipeline.ts` | 280 | 4 阶段编排 |
| `src/services/video/ffmpeg-bridge.ts` | 60 | Tauri IPC 封装 |
| `src-tauri/src/ffmpeg.rs` | 200 | Rust 命令：probe/download/compose |
| `src/components/Video/VideoGeneratorModal.tsx` | 470 | 三阶段 UI（config/running/done） |

### 修改

| 文件 | 变更 |
|------|------|
| `src-tauri/Cargo.toml` | +ffmpeg-sidecar, reqwest, futures-util |
| `src-tauri/src/lib.rs` | 注册 3 个新 Tauri 命令 |
| `src/components/Novel/NovelView.tsx` | 底部工具栏加"生成视频"按钮 |
| `src/components/Video/VideoView.tsx` | 顶部加"从小说生成"入口（独立模式） |
| `src/i18n/locales/zh-CN.ts` | +43 个 `video.gen.*` keys |
| `src/i18n/locales/en-US.ts` | 同步英文翻译 |

## 实现要点

### 1. 章节切片（chapter-slicer.ts）

启发式规则（不调 LLM，<1 秒）：
- 段间空行 + 段落长度（targetWordsPerShot 默认 600 / 1200）
- 场景边界检测：`/^第二天\|^当晚\|^【...】/`
- 角色识别：从 `"xxx"说道` 模式提取说话人
- 场景/情绪识别：关键词匹配（intense/warm/melancholic/mysterious/hopeful）

### 2. 分镜 prompt（storyboard-prompt.ts）

LLM 批处理，6 个/批：
- `taskType: 'translation'`（reuse LLM 路由）
- temperature 0.6，maxTokens 4096
- System prompt 强制英文 videoPrompt（60-120 词）
- 必须含：scene setting / character appearance / action / camera / lighting / mood
- 失败 fallback：启发式生成的简单 prompt

### 3. 视频生成（pipeline.ts 的 runVideoGeneration）

并发池模式：

```ts
const queue = [...pending];
const workers: Promise<void>[] = [];
for (let w = 0; w < VIDEO_GENERATION_CONCURRENCY; w++) {  // =2
  workers.push(this.videoWorker(queue, spec, onDone));
}
await Promise.all(workers);
```

每个 worker 从 queue 取 shot，调 `providerRouter.generateVideo()`，失败 console.warn 不中断。

### 4. FFmpeg 合成（pipeline.ts 的 runComposing）

```
1. probeFFmpeg() — 检测可用
2. 下载远程 clip URL 到本地 (workDir)
3. composeClips() — 拼接 + 字幕硬编码
4. setFinalVideo(outputPath)
```

降级：FFmpeg 不可用时直接用第一个 clip URL 作占位。

### 5. UI 三阶段（VideoGeneratorModal.tsx）

- **config**：选小说 + 选章节 + 选规格（aspectRatio/shotDuration/videoTier/hardcodeSubtitles）
- **running**：Steps 进度条 + 分镜列表（含单 shot 状态）
- **done**：视频播放器 + clip 标签列表

复用性：`defaultNovelId` 可选 prop，从 NovelView 进入时预填，从 VideoView 进入时让用户选。

## 关键决策记录

### 为什么跳过 character_anchor / storyboard_image？

Phase 1 目标是**端到端跑通**，证明技术栈可行。
- 角色一致性需要 FLUX.2 多参考图（Phase 2）
- 分镜图需要人工审核 UI（Phase 2）
- 跳过这两步直接 T2V，画面会不一致但能跑

### 为什么用 concat copy 而不是 re-encode？

Kling 输出已经是 H.264 mp4，concat copy 不重新编码，**1 秒搞定**。
混合 codec 的场景 Phase 2 再处理。

### 为什么 videoStore 不持久化？

视频是临时产物，URL 过期就废了。
重生成即可，不值得占 localStorage 空间。

### 为什么不用 AbortController 真正中断？

Phase 1 的 abort 是协作式（设标志位），不能取消正在执行的 LLM/视频调用。
强制中断需要 Phase 3 加 AbortController + Tauri 取消机制。

## 已知问题

### 必须先配置 video provider

VideoGeneratorModal 检查 `videoEndpoints.length > 0`，没有则禁用启动按钮 + 显示警告。

配置路径：Settings → Providers → 添加 video endpoint（Kling baseUrl + apiKey）

### Rust 首次编译慢

新增 reqwest / futures-util / ffmpeg-sidecar，首次 `cargo build` 约 3-5 分钟。
之后增量编译 <30 秒。

### 单镜头失败的处理

当前只 console.warn，UI 不显眼。
Phase 3 改进：失败的 shot 在分镜列表标红 + 提供"重试"按钮。

## 端到端测试用例（待执行）

```bash
# 1. 配置 Kling provider（Settings → Providers）
#    baseUrl: https://api.klingai.com
#    apiKey: <your-key>
#    model: kling-v2

# 2. 创建一个小说，写至少 1 章内容（>1000 字）

# 3. NovelView 底部工具栏 → "生成视频"
#    选章节 → 默认规格 → 点"开始生成"

# 4. 观察进度：
#    - script_slicing: <1s
#    - storyboard_prompt: ~10s（LLM）
#    - video_generation: ~5min（按镜头数）
#    - composing: ~5s（FFmpeg）

# 5. 视频出现在 DonePane
```

预期：能播放，画面可能角色不一致（Phase 2 解决），字幕在底部。

# 04 — Pipeline 状态机

## 8 步流水线

```
idle → script_slicing → storyboard_prompt → [character_anchor]
    → [storyboard_image] → video_generation → voice_subtitle → composing → complete
                                                                          ↘ error
```

### Stage 定义

代码位置：`src/types/video.ts`

```ts
export type VideoStage =
  | 'idle'                // 初始态
  | 'script_slicing'      // 章节切片（本地启发式）
  | 'storyboard_prompt'   // 生成分镜 prompt（LLM）
  | 'character_anchor'    // 角色锚定图（Phase 2）
  | 'storyboard_image'    // 分镜关键帧图（Phase 2）
  | 'video_generation'    // T2V 或 I2V 生成
  | 'voice_subtitle'      // TTS 配音 + 字幕
  | 'composing'           // FFmpeg 拼接
  | 'complete'            // 完成
  | 'error';              // 失败
```

### Stage 状态

```ts
export type VideoStageStatus =
  | 'pending'            // 未开始
  | 'running'            // 进行中
  | 'awaiting_review'    // 等待人工审核（Phase 2/3 checkpoint）
  | 'completed'          // 已完成
  | 'skipped'            // 已跳过（Phase 1 跳过的 stage）
  | 'error';             // 失败

export interface VideoStageState {
  stage: VideoStage;
  status: VideoStageStatus;
  progress: number;       // 0-1
  startedAt?: string;
  completedAt?: string;
  error?: string;
}
```

## Phase 1 跳过的 Stage

```ts
export const PHASE1_SKIPPED_STAGES: ReadonlySet<VideoStage> = new Set([
  'character_anchor',
  'storyboard_image',
]);
```

`buildInitialStages()` 在 store 里把这两个 stage 标记为 `skipped`。

## 状态转换规则

### script_slicing
- **入口**：`initProject()` 后自动进入
- **行为**：`chapter-slicer.ts` 本地启发式切片，无 LLM 调用
- **输出**：`shots: StoryboardShot[]`（占位，videoPrompt 为空）
- **耗时**：<1 秒
- **错误处理**：极少失败（纯本地）

### storyboard_prompt
- **入口**：script_slicing 完成后
- **行为**：`storyboard-prompt.ts` 按 6 个/批调用 LLM，温度 0.6
- **输出**：填充每个 shot 的 `videoPrompt`、`narration`、`cameraMovement`、`mood`
- **进度**：`progress = done / total`
- **错误处理**：LLM 失败用 `fallbackShot()` 退化为启发式 prompt

### video_generation
- **入口**：storyboard_prompt 完成后
- **行为**：并发=2 worker pool 调用 `providerRouter.generateVideo()`
- **输出**：`clips: GeneratedClip[]`
- **进度**：`progress = done / total`，done 是已成功生成的 clip 数
- **错误处理**：单个 shot 失败标记 console.warn，不中断其他 shot；UI 显示缺失片段
- **耗时**：每 shot 约 30-90 秒（取决于模型）

### voice_subtitle（Phase 1 简化）
- **Phase 1**：跳过实际 TTS 生成，字幕直接从 shot.narration 提取
- **Phase 3**：实际调用 TTS Provider，生成 audio 文件

### composing
- **入口**：video_generation 完成后
- **行为**：
  1. `probeFFmpeg()` 检测可用性
  2. 把远程 clip URL 下载到本地临时目录
  3. `composeClips()` 调用 Rust 后端 FFmpeg 拼接 + 字幕
- **输出**：`finalVideoUrl` 指向本地 mp4 路径
- **降级**：FFmpeg 不可用时直接用第一个 clip URL 作占位

## 重入与重试

**关键设计**：pipeline 可重入，重试时跳过已完成 shot。

```ts
// pipeline.ts runVideoGeneration()
const pending = project.shots.filter((sh) => {
  const exists = project.clips.some((c) => c.shotId === sh.id);
  return !exists;  // 只处理未生成的
});
```

**手动重试单 shot**（Phase 3 待实施）：
```ts
// 用户在 UI 点"重试"按钮
videoStore.clearClip(shotId);
pipeline.runVideoGenerationForShot(shotId);
```

## 中断处理

`VideoPipeline.abort()` 设置 `aborted = true`，每个 stage 在循环开始检查：

```ts
private aborted = false;
abort() { this.aborted = true; }

async run() {
  await this.runScriptSlicing();
  if (this.aborted) return null;  // ← 检查
  await this.runStoryboardPrompt();
  if (this.aborted) return null;
  // ...
}
```

注意：当前 `abort()` 是协作式的，正在执行的 LLM/视频生成调用不会被强制取消（需要 Phase 3 加 AbortController）。

## 阶段进度计算

UI 通过订阅 store 显示进度：

```tsx
const project = useVideoStore((s) => s.projects[novelId]);
// 当前 stage 进度
const currentStageProgress = project.stages[project.currentStage]?.progress ?? 0;
// 总进度（粗略，按 stage 数加权）
const totalProgress = computeTotalProgress(project.stages);
```

`VIDEO_PIPELINE_STAGES`（types/video.ts）定义了展示顺序，UI 的 `Steps` 组件按此渲染。

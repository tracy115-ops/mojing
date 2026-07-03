# 13. 单步重跑(Single-Stage Rerun)

> 状态:已实现
> 关联代码:`src/services/video/core/stage-handlers.ts`、`src/services/video/core/pipeline-runner.ts`、`src/components/Video/StageInputEditor.tsx`、`src/components/Video/VideoPipelinePanel.tsx`

## 背景

视频流水线 14 步顺序执行,旧版只能「失败后从失败点重试整条链」(`VideoPipeline.forResume` + `resetStagesFrom`)。

新增能力:
1. 在任意已完成的 stage 上,改 prompt/seed/参数后**仅重跑这一步**
2. 或**重跑此步及后续所有步骤**(改了 keyframe → scene_image/video_generation 跟着重跑)

UI 布局:stage 详情面板改成「上方可编辑输入 + 下方产物 + 底部重跑按钮」。

## 数据层

### `src/types/video.ts`

新增 `StageInput` 接口(通用可编辑参数):

```typescript
interface StageInput {
  prompt?: string;
  seed?: number;
  resolution?: string;
  fps?: number;
  durationSeconds?: number;
  voiceId?: string;
  speed?: number;
  style?: string;
  anchorMode?: 'single' | 'turnaround';
  // 其他按需扩展
}
```

`VideoStageState` 加字段:`input?: StageInput`。

新增配置表 `STAGE_INPUT_FIELDS: Record<VideoStage, FieldDef[]>`,声明每个 stage 显示哪些可编辑字段(FieldDef = `{ key, label, type: 'text'|'number'|'textarea', placeholder? }`)。

### `src/stores/videoStore.ts`

- 新增 action:`setStageInput(pid, stage, patch: Partial<StageInput>)` — 浅合并写入 `stage.input`
- `resetStagesFrom` **保留 input**(只清产物和 status,不重置用户改过的参数)

## pipeline-runner 拆分

### `src/services/video/core/stage-handlers.ts`(新文件)

抽取 `runPipeline` 里每个 stage 的执行块成独立函数。

**`StageContext` 类型:**

```typescript
interface StageContext {
  pid: string;
  workingSpec: SceneSpec;
  options: PipelineOptions;
  videoGen: VideoGenOptions;
  callbacks?: PipelineCallbacks;
  shouldAbort?: () => boolean;
  clips: GeneratedClip[];  // 累积产物,跨 stage 传递
}
```

**Handler 注册表:**

```typescript
const STAGE_HANDLERS: Partial<Record<VideoStage, (ctx: StageContext) => Promise<StageResult | null>>> = {
  character_anchor: executeCharacterAnchor,
  voice_assignment: executeVoiceAssignment,
  scene_image: executeSceneImage,
  tts: executeTTS,
  keyframe_image: executeKeyframe,
  video_generation: executeVideoGen,
  audio_merge: executeAudioMerge,
  composing: executeCompose,
};
```

**`runPipeline` 重构:**

```typescript
for (const stage of VIDEO_PIPELINE_STAGES) {
  ctx.workingSpec = (await STAGE_HANDLERS[stage]?.(ctx)) ?? ctx.workingSpec;
}
```

保留原有 `isStageLiveCompleted` 跳过逻辑(放进每个 handler 开头)。

### 两个新导出 API

```typescript
// 单步重跑:只跑指定 stage,不推进 currentStage
export async function runSingleStage(pid: string, stage: VideoStage): Promise<boolean>

// 从指定 stage 跑到结尾
export async function runFromStage(pid: string, stage: VideoStage): Promise<boolean>
```

两者都:
1. 从 `store.getProject(pid)` 重建 `StageContext`(sceneSpec/spec/options 都从 store 读)
2. 检查依赖(`isStageLiveCompleted` 对前置 stage)
3. 调用 `STAGE_HANDLERS[stage]`
4. `runFromStage` 额外循环跑后续 stage

**Direct pure 模式**:`video_generation` 单步直出在 `DirectVideoModal.tsx` 是独立逻辑,不走 runPipeline。`runSingleStage` 对 Direct pure 项目的 `video_generation` 走 `providerRouter.generateVideo` 直接调用路径(复用 modal 里的逻辑,抽成共享函数)。

## UI 重构

### `src/components/Video/VideoPipelinePanel.tsx`

右侧产物区改成可展开的 stage 详情:

```
┌─ [stage 名称] [status tag] ──────────────────┐
│                                                │
│  ▼ 输入参数(可编辑)                            │
│  ┌──────────────────────────────────────────┐ │
│  │ Prompt: [textarea]   ← 来自 STAGE_INPUT_FIELDS │
│  │ Seed:   [number]                          │ │
│  │ [stage 专属参数...]                        │ │
│  └──────────────────────────────────────────┘ │
│                                                │
│  ▼ 产物                                        │
│  [现有 renderStageContent 复用]                 │
│                                                │
│  [仅重跑此步]  [重跑及后续]                     │
└────────────────────────────────────────────────┘
```

### `src/components/Video/StageInputEditor.tsx`(新组件)

接收 `stage` + `project`,根据 `STAGE_INPUT_FIELDS[stage]` 渲染表单,onChange 调 `setStageInput`。

重跑按钮调 `runSingleStage` / `runFromStage`,按钮 disabled 条件:stage 在 running / 没有前置依赖产物。

「重跑及后续」点击前 Popconfirm 提示「后续 N 步产物会被覆盖」。

## 输入参数回填策略

`populateStageInput(pid, stage, workingSpec)` 把「这次 stage 实际会用的参数」回填进 `stage.input`,让 UI 显示当前值而非空表单。

策略:**只填用户还没改过的字段**(避免覆盖用户编辑)。

| stage | 字段 | 来源 |
|---|---|---|
| `storyboard_prompt` | `prompt` | `firstShot.sourceText` |
| `character_anchor` | `style` | `workingSpec.meta.style` 或 `'cinematic'` |
| `character_anchor` | `anchorMode` | 默认 `'turnaround'` |
| `character_anchor` | `prompt` | `buildSamplePortraitPrompt(firstChar, style)` |
| `scene_image` | `style` / `prompt` | meta.style / `buildSampleScenePrompt` |
| `keyframe_image` | `prompt` | `firstShot.videoPrompt \|\| firstShot.narration` |
| `video_generation` | `resolution` / `fps` | `project.spec.resolution` / `fps` |
| `video_generation` | `durationSeconds` | `firstShot.durationSeconds` |

## 输入参数应用策略

`applyStageInput(ctx, stage)` 把用户改过的 `stage.input` 应用到 `workingSpec` / `videoGen`,让重跑真正生效。

| stage | 字段 | 应用位置 |
|---|---|---|
| `storyboard_prompt` | `prompt` | 所有 shots 的 `sourceText` |
| `keyframe_image` / `video_generation` | `prompt` | 所有 shots 的 `videoPrompt` |
| `character_anchor` / `scene_image` | `style` | `workingSpec.meta.style` |
| `video_generation` | `durationSeconds` | 所有 shots 的 `durationSeconds` |
| `video_generation` | `resolution` / `fps` | `videoGen.spec` |

## 复用现有

- `safeRunStage` / `withStageContext` / `setInputSummary` / `skipStage` — 全部保留
- `isStageLiveCompleted` — 用作依赖检查
- `VideoPipeline.forResume` — `runSingleStage`/`runFromStage` 内部构建 ctx 时复用其 store 重建逻辑
- `resetStagesFrom` — `runFromStage` 调用前清下游
- `renderStageContent` (`StageArtifactsModal.tsx`) — 产物区 UI 直接复用

## 风险与边界

- **workingSpec 累积语义**:每步输出是下步输入,`runSingleStage` 必须从 store 读完整 sceneSpec(含所有前置产物),否则下游崩。
- **用户预期**:「仅重跑此步」改了 keyframe 但 video_generation 还用旧图,这是预期行为,UI 要明确提示。

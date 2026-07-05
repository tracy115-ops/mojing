# 02. 模块架构与复用边界

## 分层(对齐视频工坊)

```
┌──────────────────────────────────────────────────┐
│  UI 层  ComicView / ComicWorkspace /             │
│         ComicPipelinePanel / StageInputEditor    │
├──────────────────────────────────────────────────┤
│  Store 层  comicStore (新)                       │
│            projectStore.comics[] (复用)          │
├──────────────────────────────────────────────────┤
│  Pipeline 层  ComicPipeline + stage-handlers     │
│               step-character-anchor (复用)       │
│               step-panel-script (新)             │
│               step-panel-image (新,参考 keyframe)│
│               step-page-compose (Phase 2)        │
│               step-dialogue-burn (Phase 2)       │
├──────────────────────────────────────────────────┤
│  Service 层  providerRouter (复用)               │
│              image-adapters (复用)               │
│              asset-store (复用)                  │
│              direct-scene-builder (抽象后复用)   │
├──────────────────────────────────────────────────┤
│  Tauri 层  asset.rs (复用)                       │
│            image-compose.rs (Phase 2 新,可选)   │
└──────────────────────────────────────────────────┘
```

## 文件清单

### 新增

| 文件 | 说明 |
|---|---|
| `src/types/comic.ts` | `ComicPipelineState` / `ComicStage` / `PanelSpec` / `ComicSceneSpec` |
| `src/stores/comicStore.ts` | 项目状态 + stage 进度 + 用户输入 |
| `src/services/comic/pipeline.ts` | `ComicPipeline.create / forResume / forRerun` |
| `src/services/comic/core/pipeline-runner.ts` | `runComicPipeline / runSingleStage / runFromStage` |
| `src/services/comic/core/stage-handlers.ts` | 每个 stage 的 handler(对齐 video) |
| `src/services/comic/core/step-panel-script.ts` | LLM 拆分镜 |
| `src/services/comic/core/step-panel-image.ts` | 每镜出图 |
| `src/services/comic/direct-panel-builder.ts` | Direct 模式 LLM 提取角色/场景 |
| `src/components/Comic/ComicPipelinePanel.tsx` | 侧栏 + stage 详情(对齐 VideoPipelinePanel) |
| `src/components/Comic/DirectComicModal.tsx` | Direct 模式入口(对齐 DirectVideoModal) |
| `src/components/Comic/ComicStageArtifactsModal.tsx` | stage 产物展示 |

### 复用(零改动)

| 现有模块 | 用途 |
|---|---|
| `src/services/providers/router.ts` | providerRouter.generateImage |
| `src/services/providers/image-adapters.ts` | 各图像 provider 实现 |
| `src/services/video/asset-store.ts` | saveAsset / toWebviewUrl / resolveLocalPath |
| `src/services/log.ts` | logger |
| `src/services/providers/invocation-context.ts` | pushStageContext |

### 复用(可能要小改)

| 现有模块 | 改动 |
|---|---|
| `src/services/video/core/step-character-anchor.ts` | 抽通用接口,comic/video 共用 |
| `src/services/video/direct-scene-builder.ts` | 抽 `direct-asset-builder.ts`,两个工坊共用 |
| `src/services/video/core/pipeline-runner.ts` | 不动,新写 `comic/pipeline-runner.ts`,架构平行 |

### Phase 2 新增

| 文件 | 说明 |
|---|---|
| `src/services/comic/core/step-page-compose.ts` | 多镜拼页(Canvas / Rust Sharp) |
| `src/services/comic/core/step-dialogue-burn.ts` | 对话气泡烧录 |
| `src-tauri/src/image_compose.rs`(可选) | 后端拼图(如果前端 Canvas 性能不够) |

## 类型层(`src/types/comic.ts`)

```typescript
export type ComicStage =
  | 'character_anchor'      // 可选
  | 'panel_script'          // 必须
  | 'panel_image'           // 必须
  | 'page_compose'          // Phase 2 可选
  | 'dialogue_burn';        // Phase 2 可选

export const COMIC_PIPELINE_STAGES: ComicStage[] = [
  'character_anchor',
  'panel_script',
  'panel_image',
  // 'page_compose',     // Phase 2
  // 'dialogue_burn',    // Phase 2
];

export interface ComicStageState {
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  progress?: number;
  error?: string;
  input?: ComicStageInput;        // 用户可编辑参数
  inputSummary?: StageInputSummary;
  startedAt?: string;
  completedAt?: string;
}

export interface ComicStageInput {
  prompt?: string;
  seed?: number;
  style?: string;
  panelCount?: number;
  // 其他按需扩展
}

export interface PanelSpec {
  id: string;
  index: number;
  description: string;          // 画面描述(prompt 主体)
  dialogue?: string;            // 对白/旁白
  characterIds: string[];       // 在场角色
  sceneId?: string;             // 场景 ID(Phase 2)
  layout?: 'single' | 'grid-2' | 'grid-4' | 'manga-row';
  imageUrl?: string;            // 产物 URL
  promptOverride?: string;      // 用户改过的 prompt
  seed?: number;
}

export interface ComicSceneSpec {
  meta: {
    style: string;              // 'manga' | 'western' | 'watercolor' | ...
    aspectRatio: string;        // '3:4' / '16:9' / '1:1'
    panelLayout: string;
  };
  characters?: ComicCharacter[];  // 复用现有类型
  scenes?: { id: string; name: string; description: string }[];
  panels: PanelSpec[];
}

export interface ComicProject {
  id: string;
  novelProjectId?: string;        // Novel 模式才填
  title: string;
  spec: ComicSceneSpec;
  options: ComicPipelineOptions;
  stages: Record<ComicStage, ComicStageState>;
  currentStage: ComicStage | 'complete';
  finalPageUrls: string[];        // 多页产物(单镜模式 = panels[].imageUrl)
  // ... UI 状态
}
```

## Store 层(`src/stores/comicStore.ts`)

完全平行 `videoStore.ts` 的接口:

```typescript
interface ComicStore {
  projects: Record<string, ComicProject>;
  activeProjectId: string | null;

  createProject(...): ComicProject;
  getProject(id): ComicProject | undefined;
  deleteProject(id): void;

  setSceneSpec(id, spec): void;
  setStageStatus(id, stage, status, patch?): void;
  setStageInput(id, stage, patch): void;
  setStageInputSummary(id, stage, summary): void;
  advanceToStage(id, stage): void;
  resetStagesFrom(id, stage): void;     // 保留 input,只清产物

  addPanel(id, panel): void;            // 类似 addClip
  updatePanel(id, panelId, patch): void;

  setFinalPages(id, urls: string[]): void;
}
```

## Pipeline 层架构(对齐 video)

### `ComicPipeline`(对应 `VideoPipeline`)

```typescript
export class ComicPipeline {
  static async create(opts: CreateComicOptions): Promise<string>;  // 返回 projectId
  static async forResume(pid: string): Promise<ComicPipeline>;
  static async forRerun(pid: string, fromStage: ComicStage): Promise<ComicPipeline>;

  async run(callbacks?: PipelineCallbacks): Promise<void>;
}
```

### `runComicPipeline`(对应 `runPipeline`)

```typescript
export async function runComicPipeline(
  pid: string,
  callbacks?: PipelineCallbacks,
): Promise<void> {
  const ctx = await buildContextFromStore(pid);
  for (const stage of COMIC_PIPELINE_STAGES) {
    if (!isStageEnabled(stage, ctx.options, ctx.workingSpec)) continue;
    if (isStageLiveCompleted(pid, stage)) continue;
    const result = await STAGE_HANDLERS[stage]?.(ctx);
    if (!result) break;
    if (result.spec) ctx.workingSpec = result.spec;
    if (result.panels) ctx.panels = result.panels;
  }
}
```

### `runSingleStage` / `runFromStage`

```typescript
export async function runSingleStage(pid: string, stage: ComicStage): Promise<boolean>;
export async function runFromStage(pid: string, stage: ComicStage): Promise<boolean>;
```

实现完全平行 video 的同名函数,从 store 重建 ctx,调 STAGE_HANDLERS[stage]。

## Provider 路由策略

不引入新 provider。在现有 `providerRouter.generateImage` 基础上加可选标记:

```typescript
// 调用方式
await providerRouter.generateImage({
  prompt: panel.description,
  referenceImages: panel.characterIds.map(id => characterAnchorMap[id].referenceImage),
  model: tierToDefaultModel('standard'),
  // 可选:comic 专用 tier,允许用户在设置里单独配
  endpointId: getComicImageEndpoint(),
});
```

`imageTier` 复用现有 `'value' | 'standard' | 'premium'`,Phase 1 不引入 `'comic'` tier。Phase 2 若需要"漫画专用图像 provider",再加:

```typescript
// settings 新增(Phase 2)
taskModels: {
  ...
  comicImage: { endpointId, model };
}
```

## 跨工坊共享:`direct-asset-builder.ts`(抽象层)

视频工坊的 `direct-scene-builder.ts` 做的事:LLM 把"用户主题"拆成"角色+场景+镜头"。漫画的 `direct-panel-builder.ts` 做的几乎一样,只是输出是 `panels[]` 而非 `shots[]`。

抽象方案(Phase 2 重构,Phase 1 各自实现):

```typescript
// src/services/shared/direct-asset-builder.ts
interface DirectBuildRequest {
  theme: string;
  userCharacters?: Character[];
  userScenes?: Scene[];
  outputGranularity: 'shots' | 'panels';   // video vs comic
  count?: number;                            // 镜数
}
interface DirectBuildResult {
  characters: Character[];
  scenes: Scene[];
  units: ShotSpec[] | PanelSpec[];          // 按 granularity 路由
}

export async function buildDirectScene(req: DirectBuildRequest): Promise<DirectBuildResult>;
```

Phase 1 不强行抽象,先把 comic 版跑通,Phase 2 再回头提取。

## Tauri 层

Phase 1 完全不用改 Rust(`asset.rs` 已经支持图片落盘)。

Phase 2 的 `page_compose`:
- **方案 A(推荐)**:前端 Canvas 拼,质量够用,无新依赖
- **方案 B(可选)**:`src-tauri/src/image_compose.rs` 用 `image` crate 拼图,加 Rust 依赖

只有当前端 Canvas 在大图(>4K)明显卡顿才考虑方案 B。

## 复用检查清单(Phase 1 启动前确认)

| 复用项 | 状态 | 备注 |
|---|---|---|
| `step-character-anchor` | ✅ 直接用 | 已支持 `anchorMode: 'single' \| 'turnaround'` |
| `asset-store.saveAsset` | ✅ 直接用 | kind 加 `'panel'` |
| `providerRouter.generateImage` | ✅ 直接用 | 不需要改 |
| `direct-scene-builder` | ⚠️ Phase 2 抽象 | Phase 1 各自实现 |
| `StageInputEditor` 组件 | ✅ 直接用 | 改 prop 类型为 ComicStage |
| `runSingleStage` 架构 | ✅ 复用模式 | 新写 comic 版 |
| i18n key 命名 | ✅ 复用规则 | `comic.pipeline.*` |

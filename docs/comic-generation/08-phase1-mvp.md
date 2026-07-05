# 08. Phase 1 MVP 实现清单

## 范围

**做:**
- Direct pure 模式(用户输入主题 + 角色)
- 一镜一图布局
- 6 步精简 pipeline:`character_anchor → panel_script → panel_image`(3 个 stage)
- ComicPipelinePanel(对齐 VideoPipelinePanel 侧栏布局)
- 单步重跑能力(平行复用 stage-handlers 架构)
- StageInputEditor(改 prompt/seed 单步重跑)

**不做:**
- Direct extract 模式
- Novel pipeline 模式
- page_compose(多镜拼页)
- dialogue_burn(对话气泡)
- 跨项目角色一致性

## 任务清单

### 1. 类型层(0.5h)

**新建 `src/types/comic.ts`:**

```typescript
export type ComicStage = 'character_anchor' | 'panel_script' | 'panel_image';
export const COMIC_PIPELINE_STAGES: ComicStage[] = [
  'character_anchor',
  'panel_script',
  'panel_image',
];

export interface ComicStageInput {
  prompt?: string;
  seed?: number;
  style?: string;
  panelCount?: number;
}

export interface PanelSpec {
  id: string;
  index: number;
  description: string;
  dialogue?: string;
  characterIds: string[];
  imageUrl?: string;
  promptOverride?: string;
  seed?: number;
}

export interface ComicSceneSpec {
  meta: {
    style: string;
    aspectRatio: string;
    panelLayout: string;
  };
  characters: ComicCharacter[];
  panels: PanelSpec[];
}

export interface ComicPipelineOptions {
  enableCharacterAnchor: boolean;
  characterAnchorLimit: number;
}

export interface ComicStageState {
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'error';
  progress?: number;
  error?: string;
  input?: ComicStageInput;
  inputSummary?: { headline: string; details?: string[] };
  startedAt?: string;
  completedAt?: string;
}

export interface ComicPipelineProject {
  id: string;
  novelProjectId?: string;
  title: string;
  sourceMode: 'pure' | 'extract' | 'novel';
  theme?: string;                    // pure 模式用户输入
  spec: ComicSceneSpec;
  options: ComicPipelineOptions;
  stages: Record<ComicStage, ComicStageState>;
  currentStage: ComicStage | 'complete';
  finalPageUrls: string[];
  createdAt: string;
  updatedAt: string;
}
```

`src/types/index.ts` 重新导出。

### 2. Store(1h)

**新建 `src/stores/comicStore.ts`:**

完全平行 `videoStore.ts` 的接口:

```typescript
interface ComicStore {
  projects: Record<string, ComicPipelineProject>;
  activeProjectId: string | null;

  createProject(input: CreateComicInput): ComicPipelineProject;
  getProject(id: string): ComicPipelineProject | undefined;
  deleteProject(id: string): void;

  setSceneSpec(id, spec: ComicSceneSpec): void;
  setStageStatus(id, stage, status, patch?): void;
  setStageInput(id, stage, patch: Partial<ComicStageInput>): void;
  setStageInputSummary(id, stage, summary): void;
  advanceToStage(id, stage): void;
  resetStagesFrom(id, stage): void;

  upsertPanel(id, panel: PanelSpec): void;

  setFinalPages(id, urls: string[]): void;
}
```

### 3. Pipeline(2-3h)

**新建 `src/services/comic/pipeline.ts`:**

```typescript
export class ComicPipeline {
  static async create(opts: CreateComicOptions): Promise<string>;
  // forResume / forRerun 同 video
}
```

**新建 `src/services/comic/core/pipeline-runner.ts`:**

```typescript
export async function runComicPipeline(pid: string, callbacks?): Promise<void>;
export async function runSingleStage(pid: string, stage: ComicStage): Promise<boolean>;
export async function runFromStage(pid: string, stage: ComicStage): Promise<boolean>;
```

**新建 `src/services/comic/core/stage-handlers.ts`:**

```typescript
export const STAGE_HANDLERS: Partial<Record<ComicStage, (ctx) => Promise<StageResult | null>>> = {
  character_anchor: executeCharacterAnchor,
  panel_script: executePanelScript,
  panel_image: executePanelImage,
};
```

`executeCharacterAnchor` 直接 import video 工坊的 `runCharacterAnchor`。

**新建 `src/services/comic/core/step-panel-script.ts`:**

LLM 调用,输出 PanelSpec[]。Prompt 模板见 [03-pipeline.md](./03-pipeline.md)。

**新建 `src/services/comic/core/step-panel-image.ts`:**

参考 `step-keyframe.ts`,并发出图:

```typescript
const PANEL_IMAGE_CONCURRENCY = 2;

export async function runPanelImage(
  panels: PanelSpec[],
  options: { characters; meta; novelProjectId },
  onProgress?,
  onPanel?,
  preExistingPanels?,
): Promise<{ panels: PanelSpec[]; failedPanelIds: string[] }>;
```

### 4. UI(2-3h)

**新建 `src/components/Comic/ComicPipelinePanel.tsx`:**

对齐 `VideoPipelinePanel`:
- 左侧:stage 列表 + 状态徽标 + 进度条
- 右侧:选中 stage 的详情区(StageInputEditor + 产物展示 + 重跑按钮)

**升级 `src/components/Comic/ComicWorkspace.tsx`:**

替换现有占位,改成:

```tsx
<div className="ws-layout">
  <ComicProjectList />  {/* 已有 ProjectList */}
  <ComicPipelinePanel projectId={pid} />
</div>
```

**升级 `src/components/Comic/CreateComicModal.tsx`:**

加字段:
- 主题 textarea(pure 模式必填)
- 角色列表(可空,空时 LLM 自动生成)
- panelCount 数字(默认 6)

**新建 `src/components/Comic/ComicStageArtifacts.tsx`:**

参考 `StageArtifactsModal.tsx`,展示每个 stage 的产物:
- character_anchor:角色立绘网格
- panel_script:PanelSpec 列表(description + dialogue)
- panel_image:分镜图网格

### 5. i18n(0.5h)

`zh-CN.ts` + `en-US.ts` 加:

```typescript
// 已有的 comic.* 保留,新增:
'comic.pipeline.title': '漫画流水线',
'comic.pipeline.character_anchor': '角色锚定',
'comic.pipeline.panel_script': '分镜脚本',
'comic.pipeline.panel_image': '分镜出图',
'comic.pipeline.rerunSingle': '仅重跑此步',
'comic.pipeline.rerunFromHere': '重跑及后续',
'comic.pipeline.inputSection': '输入参数',
'comic.theme': '主题',
'comic.themePlaceholder': '故事主题或核心冲突',
'comic.panelCount': '分镜数',
'comic.empty.panels': '尚未生成分镜,点击「生成」开始',
```

### 6. 项目层联动(0.5h)

`projectStore.ts` 已支持 `type: 'comic'`,检查 `ComicMetadata` 是否要升级成 `ComicPipelineProject`(或两者并存:`ComicMetadata` 给 ProjectList 显示用,`ComicPipelineProject` 给 pipeline 用)。

**建议方案:** `ComicPipelineProject` 独立存,`ComicMetadata` 保留作为 projectList 列表项的轻量描述(从 pipeline project 派生)。

### 7. 路由 / 入口(0.5h)

`MainLayout.tsx` 已经路由 `/comic` 到 `ComicView`,检查是否需要改侧栏链接文本(i18n key 已有 `sidebar.comics`)。

## 验收标准

### 必须通过

1. `pnpm tsc --noEmit` 零错误
2. `pnpm tauri build` 成功产出 exe
3. 在 ComicView 新建一个 pure 模式项目,主题"森林里的小红帽遇见大灰狼",3 个角色,4 镜 → 一键跑通 3 个 stage,产出 4 张分镜图
4. 改 `panel_image` stage 的某镜 prompt,点"仅重跑此步" → 该镜重新出图,其他镜不变
5. 关闭应用重开 → 项目状态完整恢复

### 加分项

6. 单步重跑在 character_anchor 改 prompt → 立绘重生成
7. panel_script 改 panelCount → 重新拆分镜(覆盖原 panels)
8. 失败兜底:断网时 panel_image 单镜失败不阻塞其余

## 工作量预估

| 任务 | 时长 |
|---|---|
| 类型 + Store | 1.5h |
| Pipeline + step-panel-script/image | 3h |
| UI(PipelinePanel + Workspace 改造) | 3h |
| i18n + 联调 | 1h |
| 调试 + 类型修 | 1.5h |
| **合计** | **10h(1-2 个工作日)** |

## 风险

| 风险 | 缓解 |
|---|---|
| LLM panel_script 输出 JSON 不规范 | 加 JSON repair 重试 + fallback 简单切分 |
| 角色 anchor 在多 reference 时 provider 报错 | adapter 层做 reference 数量限流(≤3) |
| 现有 ComicWorkspace 已有占位代码,改造冲突 | 先 git 看现状,逐文件替换 |
| ComicMetadata 与 ComicPipelineProject 字段冲突 | 接口分离,projectStore 只存元信息,pipeline 数据独立 |

## 启动前确认

- [ ] Phase 1 范围(3 stage + pure only)是否 OK?
- [ ] 默认 panelCount = 6 是否合理?
- [ ] 一镜一图先不做 page_compose,确认?
- [ ] 角色锚定默认 `anchorMode: 'turnaround'`(三视图)还是 `'single'`?
- [ ] ComicPipelineProject 是否独立持久化(不和 ProjectStore 的 comic metadata 合并)?

确认后开工。

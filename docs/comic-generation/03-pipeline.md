# 03. 漫画流水线状态机

## Stage 定义

```typescript
export const COMIC_PIPELINE_STAGES: ComicStage[] = [
  'character_anchor',
  'panel_script',
  'panel_image',
  // Phase 2:
  // 'page_compose',
  // 'dialogue_burn',
];
```

## Stage 转换图

```
┌──────────────────┐
│  pending         │
└────────┬─────────┘
         │ advanceToStage
         ▼
┌──────────────────┐  shouldAbort / 错误
│  running         │─────────────────┐
└────────┬─────────┘                 ▼
         │ 正常完成          ┌──────────────────┐
         ▼                   │  error           │
┌──────────────────┐         └──────────────────┘
│  completed       │
└──────────────────┘

特殊状态:
  - skipped:isStageEnabled 返回 false(如没角色 → 跳过 character_anchor)
```

## 各 Stage 详细

### Stage 1: `character_anchor`(可选)

**触发条件:** `options.enableCharacterAnchor && spec.characters?.length > 0`

**输入:**
- `spec.characters[].name / appearance / personality`
- `options.characterAnchorLimit`(默认 5)

**输出:**
- 每个 character 加上 `referenceImage`(立绘 URL)
- 可选三视图(`anchorMode: 'turnaround'`)

**实现:** 直接调 `step-character-anchor.ts`(从 video 工坊 import)。

**进度回调:** `(done, total) => void`,N 个角色并发(并发度复用 `CHARACTER_ANCHOR_CONCURRENCY`)。

### Stage 2: `panel_script`(必须)

**触发条件:** 总是跑

**输入:**
- Direct pure:`theme` + `characters[]` + 用户指定的 `panelCount`(默认 6)
- Direct extract:`pastedText` + `panelCount`
- Novel:`chapterContent` + `chapterCharacters[]` + `panelCount`

**LLM Prompt 模板:**

```
你是漫画分镜师。把以下素材拆成 {panelCount} 个分镜。

主题/章节内容:
{input}

角色:
{characters.map(c => `${c.name}: ${c.appearance}`).join('\n')}

输出 JSON,每镜字段:
- description: 画面描述(角色动作 / 表情 / 构图 / 场景)
- dialogue: 对白/旁白(可空)
- characterIds: 出场角色 ID 列表
- layout: 单镜 'single' / 网格 'grid-2' / 'grid-4' / 漫画条 'manga-row'

要求:
1. 每镜画面信息量足够 AI 出图(不能只写"角色出场")
2. 视觉节奏起伏(近景/远景/特写交替)
3. 角色动作要具体("右手举起杯子"优于"喝水")
4. 对白简短(单镜不超过 30 字)
```

**输出:** `PanelSpec[]`,写到 `spec.panels`。

**失败处理:** LLM 返回不合规 JSON → 重试 1 次 → 仍失败用 fallback(简单按段落切分)。

### Stage 3: `panel_image`(必须)

**触发条件:** 总是跑(`spec.panels.length > 0`)

**实现:** 类似 `step-keyframe.ts`,并发出图。

**单镜出图流程:**

```typescript
async function generatePanel(panel, ctx) {
  const referenceImages: string[] = [];
  for (const cid of panel.characterIds) {
    const char = ctx.characters.find(c => c.id === cid);
    if (char?.referenceImage) {
      referenceImages.push(await readAsDataUri(char.referenceImage));
    }
  }

  const response = await providerRouter.generateImage({
    prompt: buildPanelPrompt(panel, ctx.style),
    referenceImages,
    aspectRatio: ctx.meta.aspectRatio,
    style: ctx.meta.style,
  });

  return {
    ...panel,
    imageUrl: await saveAsset(ctx.pid, 'panel', response.imageData, `panel_${panel.index + 1}`),
  };
}
```

**Prompt 构造:**

```typescript
function buildPanelPrompt(panel, style) {
  return [
    panel.description,
    `, ${style} style`,
    ', comic panel composition',
    ', clean line art' if style === 'manga',
    ', high detail',
    ', no text, no watermark, no speech bubble',  // 对白靠 burn,不让 AI 画字
  ].join('');
}
```

**并发度:** `PANEL_IMAGE_CONCURRENCY = 2`(对齐 video 的 keyframe 并发)。

**断点续跑:** 复用 step-video-gen 的 `preExistingClips` 模式,已有 `imageUrl` 的 panel 跳过。

### Stage 4 (Phase 2): `page_compose`

详见 [05-panel-layout.md](./05-panel-layout.md)。

### Stage 5 (Phase 2): `dialogue_burn`

详见 [06-dialogue-burn.md](./06-dialogue-burn.md)。

## isStageEnabled 决策表

```typescript
export function isComicStageEnabled(
  stage: ComicStage,
  options: ComicPipelineOptions,
  spec: ComicSceneSpec,
): boolean {
  switch (stage) {
    case 'character_anchor':
      return !!options.enableCharacterAnchor && !!spec.characters?.length;
    case 'panel_script':
      return true;
    case 'panel_image':
      return spec.panels.length > 0;
    case 'page_compose':
      return !!options.enablePageCompose && spec.panels.length > 1;
    case 'dialogue_burn':
      return !!options.enableDialogueBurn && spec.panels.some(p => p.dialogue);
    default:
      return false;
  }
}
```

## 单步重跑与从某步重跑

完全平行 video 工坊:

| API | 说明 |
|---|---|
| `runSingleStage(pid, stage)` | 只跑指定 stage,不推进 currentStage |
| `runFromStage(pid, stage)` | 从指定 stage 跑到结尾 |

`resetStagesFrom` 同样**保留 stage.input**(用户改过的参数不丢)。

## PipelineCallbacks

```typescript
interface PipelineCallbacks {
  onStageChange?: (stage: ComicStage) => void;
  onStageProgress?: (stage: ComicStage, progress: number) => void;
  onPanelProgress?: (done: number, total: number) => void;
  onError?: (msg: string) => void;
}
```

## 失败兜底策略

| Stage | 失败处理 |
|---|---|
| `character_anchor` | 单个角色失败不阻塞,该角色 referenceImage 留空,panel_image 时不带 reference |
| `panel_script` | LLM 失败 → 整步失败,pipeline 停(用户必须修 prompt 或 provider) |
| `panel_image` | 单镜失败不阻塞,该镜 imageUrl 留空;全部失败才整步失败 |
| `page_compose` | 单页失败不阻塞,跳过该页 |
| `dialogue_burn` | 单镜失败不阻塞,保留无对白原图 |

## 进度展示

UI 用现有 `stage.progress` 字段(0-1)。stage 详情区显示:
- panel_script:`panel N / M`(LLM 流式输出 token 时无法精确进度,用"等待中" + spinner)
- panel_image:`panel N / M`,每完成一镜流式更新

## 状态持久化

Comic 项目持久化到 `projectStore`(localStorage),包含:
- `spec`(scene + panels)
- `stages`(每个 stage 的 status / progress / input / inputSummary)
- `currentStage`
- `finalPageUrls`

刷新 / 切换项目 / 关闭重开都能恢复。

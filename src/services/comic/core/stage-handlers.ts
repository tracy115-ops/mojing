// stage-handlers.ts — 漫画每个 stage 的 handler(平行 video 工坊 stage-handlers)
//
// 每个 handler 接收 StageContext,返回更新后的 spec + panels(如有变化)。
// handler 不负责「是否跳过」决策 — 那个决策留在 pipeline-runner 主体。

import { useComicStore } from '@/stores/comicStore';
import { logger } from '@/services/log';
import { pushStageContext, popStageContext } from '@/services/providers/invocation-context';
import type {
  ComicStage,
  ComicTrackedStage,
  ComicSceneSpec,
  ComicPanelSpec,
  ComicPageSpec,
  ComicCharacterAnchor,
  ComicStageInput,
} from '@/types/comic';
import { runPanelScript } from './step-panel-script';
import { runPanelImage } from './step-panel-image';
import { runPageCompose } from './step-page-compose';
import { runDialogueBurn } from './step-dialogue-burn';
import { runCharacterAnchor } from '@/services/video/core/step-character-anchor';

// --- Stage 执行上下文 ---

export interface StageContext {
  pid: string;
  workingSpec: ComicSceneSpec;
  /** 用户在创建项目时填的 theme / 章节文本(panel_script 用) */
  sourceText: string;
  /** 用户期望的分镜数 */
  panelCount: number;
  /** 是否启用 character_anchor */
  enableCharacterAnchor: boolean;
  characterAnchorLimit: number;
  /** style / aspectRatio / panelLayout(从 meta 派生,handler 内用) */
  style: string;
  aspectRatio: ComicSceneSpec['meta']['aspectRatio'];
  panelLayout: ComicSceneSpec['meta']['panelLayout'];
  callbacks?: PipelineCallbacks;
  shouldAbort?: () => boolean;
}

export interface StageResult {
  spec: ComicSceneSpec;
  panels?: ComicPanelSpec[];
  /** character_anchor 提取出的新角色(若用户初始没填) */
  extractedCharacters?: ComicCharacterAnchor[];
}

export interface PipelineCallbacks {
  onStageChange?: (stage: ComicStage) => void;
  onStageProgress?: (stage: ComicStage, progress: number) => void;
  onPanelProgress?: (done: number, total: number) => void;
  onError?: (msg: string) => void;
}

// --- 共用 helper ---

async function withStageContext<T>(
  pid: string,
  stage: ComicStage,
  fn: () => Promise<T>,
): Promise<T> {
  pushStageContext({ novelProjectId: pid, stage });
  try {
    return await fn();
  } finally {
    popStageContext();
  }
}

async function safeRunStage<T>(
  pid: string,
  stage: ComicStage,
  fn: () => Promise<T>,
): Promise<T | null> {
  void logger.info(`[comic/pipeline] ${stage} enter`, 'comic');
  const t0 = performance.now();
  try {
    const r = await fn();
    void logger.info(
      `[comic/pipeline] ${stage} ok (${Math.round(performance.now() - t0)}ms)`,
      'comic',
    );
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(
      `[comic/pipeline] ${stage} FAIL (${Math.round(performance.now() - t0)}ms): ${msg}`,
      'comic',
    );
    useComicStore.getState().setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  }
}

// --- Stage input 工具函数 ---

/**
 * 把「这次 stage 实际会用的参数」回填进 stage.input,让 UI 显示当前值而非空表单。
 * 策略:只填用户还没改过的字段(避免覆盖用户编辑)。
 */
export function populateStageInput(pid: string, stage: ComicTrackedStage, ctx: StageContext): void {
  const store = useComicStore.getState();
  const proj = store.getProject(pid);
  if (!proj) return;
  const existing = proj.stages[stage]?.input ?? {};
  const patch: Partial<ComicStageInput> = {};

  switch (stage) {
    case 'character_anchor': {
      const firstChar = ctx.workingSpec.characters[0];
      if (existing.anchorMode === undefined) patch.anchorMode = 'turnaround';
      if (existing.style === undefined) patch.style = ctx.style || 'manga';
      if (existing.prompt === undefined && firstChar) {
        patch.prompt = buildSamplePortraitPrompt(firstChar, ctx.style);
      }
      break;
    }
    case 'panel_script':
      if (existing.prompt === undefined) patch.prompt = ctx.sourceText.slice(0, 500);
      if (existing.panelCount === undefined) patch.panelCount = ctx.panelCount;
      break;
    case 'panel_image':
      if (existing.style === undefined) patch.style = ctx.style || 'manga';
      break;
    case 'dialogue_burn':
      if (existing.bubbleShape === undefined) patch.bubbleShape = 'oval';
      if (existing.bubbleFontSize === undefined) patch.bubbleFontSize = 36;
      break;
    case 'page_compose':
      if (existing.pagePadding === undefined) patch.pagePadding = 16;
      break;
  }

  if (Object.keys(patch).length > 0) {
    store.setStageInput(pid, stage, patch);
  }
}

function buildSamplePortraitPrompt(
  c: ComicCharacterAnchor,
  style?: string,
): string {
  const parts = [
    `character reference portrait of ${c.name}`,
    c.appearance,
    'neutral pose, plain background, soft studio lighting',
    'full body visible from head to knee',
    style ? `${style} style` : 'manga style',
    '8k detail, photorealistic',
    'no text, no watermark, no signature',
  ];
  return parts.join(', ');
}

/**
 * 把用户改过的 stage.input 应用到 workingSpec / ctx,让重跑真正生效。
 */
export function applyStageInput(
  ctx: StageContext,
  stage: ComicTrackedStage,
): StageContext {
  const store = useComicStore.getState();
  const proj = store.getProject(ctx.pid);
  if (!proj) return ctx;
  const input = proj.stages[stage]?.input;
  if (!input) return ctx;

  let { workingSpec, sourceText, panelCount, style } = ctx;
  let specChanged = false;
  let ctxChanged = false;

  // panel_script: prompt 改 → sourceText 改;panelCount 改 → ctx.panelCount 改
  if (stage === 'panel_script') {
    if (input.prompt !== undefined && input.prompt.trim()) {
      sourceText = input.prompt;
      ctxChanged = true;
    }
    if (input.panelCount !== undefined && input.panelCount > 0) {
      panelCount = input.panelCount;
      ctxChanged = true;
    }
  }

  // character_anchor / panel_image:style 改 → ctx.style + spec.meta.style 改
  if (
    input.style !== undefined &&
    (stage === 'character_anchor' || stage === 'panel_image')
  ) {
    style = input.style;
    workingSpec = {
      ...workingSpec,
      meta: { ...workingSpec.meta, style: input.style },
    };
    specChanged = true;
    ctxChanged = true;
  }

  if (!specChanged && !ctxChanged) return ctx;
  return { ...ctx, workingSpec, sourceText, panelCount, style };
}

// --- 3 个 stage handler ---

/** 步:角色锚定(character_anchor) */
export async function executeCharacterAnchor(
  ctx: StageContext,
): Promise<StageResult | null> {
  const { pid, workingSpec, characterAnchorLimit, style, callbacks } = ctx;
  const store = useComicStore.getState();
  callbacks?.onStageChange?.('character_anchor');
  store.advanceToStage(pid, 'character_anchor');
  store.setStageStatus(pid, 'character_anchor', 'running');
  populateStageInput(pid, 'character_anchor', ctx);
  store.setStageInputSummary(pid, 'character_anchor', {
    headline: `${workingSpec.characters.length} 个角色,limit=${characterAnchorLimit}`,
    details: workingSpec.characters
      .slice(0, 10)
      .map((c) => `${c.name} · ${c.appearance.slice(0, 40)}`),
  });

  const anchorChars = workingSpec.characters;
  // 用户改过的 anchorMode / prompt
  const proj0 = useComicStore.getState().getProject(pid);
  const anchorInput = proj0?.stages['character_anchor']?.input;
  const anchorMode = anchorInput?.anchorMode;
  const promptOverride =
    anchorInput?.prompt && anchorInput.prompt.trim() ? anchorInput.prompt : undefined;

  if (anchorChars.length === 0) {
    // 无角色直接 skip(避免 step-character-anchor 报错)
    store.setStageStatus(pid, 'character_anchor', 'skipped');
    return { spec: workingSpec };
  }

  // 直接复用 video 工坊的 runCharacterAnchor
  // 把 ComicCharacterAnchor 适配成 CharacterAnchor 兼容字段
  const videoCompatChars = anchorChars.map((c) => ({
    id: c.id,
    name: c.name,
    appearance: c.appearance,
    firstAppearShotIndex: c.firstAppearPanelIndex,
  }));
  const result = await safeRunStage(pid, 'character_anchor', () =>
    withStageContext(pid, 'character_anchor', () =>
      runCharacterAnchor(
        videoCompatChars,
        {
          style,
          imageTier: 'value',
          limit: characterAnchorLimit,
          novelProjectId: pid,
          anchorMode,
          promptOverride,
        },
        (done, total) => {
          store.setStageStatus(pid, 'character_anchor', 'running', {
            progress: done / total,
          });
          callbacks?.onStageProgress?.('character_anchor', done / total);
        },
      ),
    ),
  );
  if (!result) return null;

  // 把产物回填到 ComicCharacterAnchor(portraitImage / turnaroundImage)
  const idToAnchor = new Map(result.characters.map((c) => [c.id, c]));
  const newChars: ComicCharacterAnchor[] = workingSpec.characters.map((c) => {
    const updated = idToAnchor.get(c.id);
    if (!updated) return c;
    return {
      ...c,
      portraitImage: updated.portraitImage,
      turnaroundImage: updated.turnaroundImage,
    };
  });
  const spec: ComicSceneSpec = { ...workingSpec, characters: newChars };
  store.setSceneSpec(pid, spec);
  store.setStageStatus(pid, 'character_anchor', 'completed', { progress: 1 });
  return { spec };
}

/** 步:分镜脚本(panel_script) */
export async function executePanelScript(
  ctx: StageContext,
): Promise<StageResult | null> {
  const { pid, workingSpec, sourceText, panelCount, style, aspectRatio, callbacks } = ctx;
  const store = useComicStore.getState();
  callbacks?.onStageChange?.('panel_script');
  store.advanceToStage(pid, 'panel_script');
  store.setStageStatus(pid, 'panel_script', 'running');
  populateStageInput(pid, 'panel_script', ctx);
  store.setStageInputSummary(pid, 'panel_script', {
    headline: `${panelCount} 个分镜,主题 ${sourceText.length} 字`,
    details: sourceText.length > 80 ? [`${sourceText.slice(0, 80)}...`] : [sourceText],
  });

  const result = await safeRunStage(pid, 'panel_script', () =>
    withStageContext(pid, 'panel_script', () =>
      runPanelScript(sourceText, workingSpec.characters, {
        panelCount,
        style,
        aspectRatio,
      }),
    ),
  );
  if (!result) return null;

  // 如果 LLM 提取了新角色(用户初始没填角色),写入 spec
  let spec = workingSpec;
  if (result.extractedCharacters && result.extractedCharacters.length > 0) {
    spec = { ...workingSpec, characters: result.extractedCharacters };
    store.setSceneSpec(pid, spec);
  }
  store.setPanels(pid, result.panels);
  store.setStageStatus(pid, 'panel_script', 'completed', {
    progress: 1,
    error: result.degraded ? '使用 fallback 切分(LLM 调用失败)' : undefined,
  });
  return { spec, panels: result.panels, extractedCharacters: result.extractedCharacters };
}

/** 步:分镜出图(panel_image) */
export async function executePanelImage(
  ctx: StageContext,
): Promise<StageResult | null> {
  const { pid, workingSpec, style, aspectRatio, callbacks, shouldAbort } = ctx;
  const store = useComicStore.getState();
  callbacks?.onStageChange?.('panel_image');
  store.advanceToStage(pid, 'panel_image');
  store.setStageStatus(pid, 'panel_image', 'running');
  populateStageInput(pid, 'panel_image', ctx);

  const panelsToRun = workingSpec.panels;
  if (panelsToRun.length === 0) {
    store.setStageStatus(pid, 'panel_image', 'skipped');
    return { spec: workingSpec };
  }

  const alreadyDoneCount = panelsToRun.filter((p) => p.imageUrl).length;
  if (alreadyDoneCount > 0) {
    void logger.info(
      `[comic/pipeline] panel_image: 增量续跑 ${alreadyDoneCount}/${panelsToRun.length} 已有`,
      'comic',
    );
  }
  store.setStageInputSummary(pid, 'panel_image', {
    headline: `${panelsToRun.length} 个分镜待出图${
      alreadyDoneCount > 0 ? ` · 已有 ${alreadyDoneCount} 个,仅重跑剩余` : ''
    }`,
    details: panelsToRun
      .slice(0, 10)
      .map((p) => `镜 ${p.index + 1} · ${p.description.slice(0, 40)}`),
  });

  const result = await safeRunStage(pid, 'panel_image', () =>
    withStageContext(pid, 'panel_image', () =>
      runPanelImage(
        panelsToRun,
        {
          characters: workingSpec.characters,
          aspectRatio,
          style,
          novelProjectId: pid,
        },
        (done, total) => {
          const totalDone = done;
          const totalAll = Math.max(total, panelsToRun.length);
          store.setStageStatus(pid, 'panel_image', 'running', {
            progress: totalDone / totalAll,
          });
          callbacks?.onStageProgress?.('panel_image', totalDone / totalAll);
          callbacks?.onPanelProgress?.(totalDone, totalAll);
        },
        (panel) => store.upsertPanel(pid, panel),
        panelsToRun,
        shouldAbort,
      ),
    ),
  );
  if (!result) return null;

  // setFinalPages 触发 currentStage = 'complete'
  const finalUrls = result.panels
    .map((p) => p.imageUrl)
    .filter((u): u is string => !!u);
  store.setFinalPages(pid, finalUrls);

  const attempted = panelsToRun.length;
  const failed = result.failedPanelIds.length;
  const ok = attempted - failed;
  if (failed > 0) {
    store.setStageStatus(pid, 'panel_image', 'completed', {
      progress: 1,
      error: `部分失败:${ok}/${attempted} 成功,${failed} 个分镜未生成`,
    });
  } else {
    store.setStageStatus(pid, 'panel_image', 'completed', { progress: 1 });
  }
  return { spec: { ...workingSpec, panels: result.panels }, panels: result.panels };
}

/** 步 4:多镜拼页(page_compose)— 把 panels 按 panelLayout 拼成 pages */
export async function executePageCompose(
  ctx: StageContext,
): Promise<StageResult | null> {
  const { pid, workingSpec, panelLayout, callbacks } = ctx;
  const store = useComicStore.getState();
  callbacks?.onStageChange?.('page_compose');
  store.advanceToStage(pid, 'page_compose');
  store.setStageStatus(pid, 'page_compose', 'running');
  populateStageInput(pid, 'page_compose', ctx);

  const panelsWithImage = workingSpec.panels.filter((p) => p.imageUrl);
  if (panelsWithImage.length === 0) {
    store.setStageStatus(pid, 'page_compose', 'skipped');
    return { spec: { ...workingSpec, pages: undefined } };
  }

  store.setStageInputSummary(pid, 'page_compose', {
    headline: `${panelLayout} · ${panelsWithImage.length} 个分镜`,
  });

  const proj0 = useComicStore.getState().getProject(pid);
  const input = proj0?.stages['page_compose']?.input;

  const result = await safeRunStage(pid, 'page_compose', () =>
    withStageContext(pid, 'page_compose', () =>
      runPageCompose(
        workingSpec.panels,
        {
          novelProjectId: pid,
          layout: panelLayout,
          padding: input?.pagePadding,
        },
        (done, total) => {
          store.setStageStatus(pid, 'page_compose', 'running', {
            progress: total > 0 ? done / total : 0,
          });
          callbacks?.onStageProgress?.('page_compose', total > 0 ? done / total : 0);
        },
      ),
    ),
  );
  if (!result) return null;

  store.setPages(pid, result.pages);
  // page_compose 是最后一步,setFinalPages 触发 currentStage → 'complete'
  const finalUrls = result.pages
    .map((pg) => pg.imageUrl)
    .filter((u): u is string => !!u);
  store.setFinalPages(pid, finalUrls);
  store.setStageStatus(pid, 'page_compose', 'completed', { progress: 1 });
  return { spec: { ...workingSpec, pages: result.pages } };
}

/** 步 5:对白气泡烧录(dialogue_burn)— 在 page.imageUrl(或 panel.imageUrl) 上画气泡 */
export async function executeDialogueBurn(
  ctx: StageContext,
): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useComicStore.getState();
  callbacks?.onStageChange?.('dialogue_burn');
  store.advanceToStage(pid, 'dialogue_burn');
  store.setStageStatus(pid, 'dialogue_burn', 'running');
  populateStageInput(pid, 'dialogue_burn', ctx);

  const panelsToBurn = workingSpec.panels.filter(
    (p) => p.imageUrl && p.dialogue && p.dialogue.trim(),
  );
  const total = workingSpec.panels.length;
  if (panelsToBurn.length === 0) {
    store.setStageStatus(pid, 'dialogue_burn', 'skipped');
    return { spec: workingSpec };
  }

  store.setStageInputSummary(pid, 'dialogue_burn', {
    headline: `${panelsToBurn.length}/${total} 个分镜将对白烧录`,
  });

  // 用户改过的 bubbleShape / bubbleFontSize
  const proj0 = useComicStore.getState().getProject(pid);
  const input = proj0?.stages['dialogue_burn']?.input;

  const result = await safeRunStage(pid, 'dialogue_burn', () =>
    withStageContext(pid, 'dialogue_burn', () =>
      runDialogueBurn(
        workingSpec.panels,
        {
          novelProjectId: pid,
          bubbleShape: input?.bubbleShape,
          bubbleFontSize: input?.bubbleFontSize,
        },
        (done, all) => {
          store.setStageStatus(pid, 'dialogue_burn', 'running', {
            progress: all > 0 ? done / all : 0,
          });
          callbacks?.onStageProgress?.('dialogue_burn', all > 0 ? done / all : 0);
        },
        (panel) => store.upsertPanel(pid, panel),
      ),
    ),
  );
  if (!result) return null;

  // 烧录产物替换 panel.imageUrl;不在这里 setFinalPages — 后续 page_compose 才产出最终 pages[]
  const burnedCount = result.panels.filter(
    (p) => p.dialogue && p.dialogue.trim(),
  ).length;
  const skippedCount = result.skippedPanelIds.length;
  const errMsg =
    skippedCount > 0 ? `${skippedCount} 个分镜烧录失败` : undefined;
  store.setStageStatus(pid, 'dialogue_burn', 'completed', {
    progress: 1,
    error: errMsg,
  });
  void logger.info(
    `[comic/pipeline] dialogue_burn: burned=${burnedCount} skipped=${skippedCount}`,
    'comic',
  );

  return { spec: { ...workingSpec, panels: result.panels }, panels: result.panels };
}

// --- handler 注册表 ---

/** pipeline 处理的 stage 顺序 */
export const RUNTIME_STAGE_ORDER: ComicTrackedStage[] = [
  'character_anchor',
  'panel_script',
  'panel_image',
  'dialogue_burn',
  'page_compose',
];

export const STAGE_HANDLERS: Partial<
  Record<ComicStage, (ctx: StageContext) => Promise<StageResult | null>>
> = {
  character_anchor: executeCharacterAnchor,
  panel_script: executePanelScript,
  panel_image: executePanelImage,
  dialogue_burn: executeDialogueBurn,
  page_compose: executePageCompose,
};

/** stage → 是否启用 */
export function isStageEnabled(
  stage: ComicStage,
  ctx: { enableCharacterAnchor: boolean; workingSpec: ComicSceneSpec } | { enableCharacterAnchor: boolean; spec: ComicSceneSpec },
): boolean {
  const spec = 'workingSpec' in ctx ? ctx.workingSpec : ctx.spec;
  switch (stage) {
    case 'character_anchor':
      return ctx.enableCharacterAnchor && spec.characters.length > 0;
    case 'panel_script':
      return true;
    case 'panel_image':
      return spec.panels.length > 0;
    case 'dialogue_burn':
      // 至少一个 panel 有对白 + 至少一个 panel 有图
      return spec.panels.some((p) => p.dialogue && p.dialogue.trim()) &&
        spec.panels.some((p) => p.imageUrl);
    case 'page_compose':
      // single 模式不拼页(每镜一页 page.imageUrl = panel.imageUrl 直接复用,但也走一遍 store 落 pages)
      // 多镜模式:至少 1 个 panel 有图
      return spec.panels.some((p) => p.imageUrl);
    default:
      return false;
  }
}

/** 是否已"在线完成"(reset 后用 spec 重建判断)。 */
export function isStageLiveCompleted(
  proj: ReturnType<typeof useComicStore.getState>['projects'][string] | undefined,
  stage: ComicStage,
): boolean {
  if (!proj) return false;
  if (
    stage === 'idle' ||
    stage === 'complete' ||
    stage === 'error'
  ) {
    return false;
  }
  const s = proj.stages[stage];
  if (s?.status !== 'completed') return false;
  // 各 stage 的"产物是否还在"校验
  if (stage === 'character_anchor') {
    return proj.spec.characters.some((c) => c.portraitImage || c.turnaroundImage);
  }
  if (stage === 'panel_script') {
    return proj.spec.panels.length > 0;
  }
  if (stage === 'panel_image') {
    return proj.spec.panels.some((p) => p.imageUrl);
  }
  if (stage === 'dialogue_burn') {
    return proj.stages['dialogue_burn']?.status === 'completed';
  }
  if (stage === 'page_compose') {
    return (proj.spec.pages?.length ?? 0) > 0;
  }
  return false;
}

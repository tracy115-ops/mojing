// step-panel-image.ts — 漫画步 3:每镜出图
//
// 输入:ComicPanelSpec[] + 角色 anchors(立绘)
// 输出:更新后的 panels[](imageUrl 字段填好)
//
// 出图策略:
//   - 顺序无关,用并发池(并发度 2,平衡速度 / provider 限流)
//   - 每镜带 referenceImages:在场角色的 portraitImage(或 turnaroundImage)
//   - 单镜失败不阻塞,留空 imageUrl,UI 在面板标黄
//   - 断点续跑:已有 imageUrl 的 panel 跳过(支持失败重试时不重复出图)

import { providerRouter } from '@/services/providers';
import { logger } from '@/services/log';
import type {
  ComicPanelSpec,
  ComicCharacterAnchor,
} from '@/types/comic';
import type { AspectRatio } from '@/types/video';
import { saveAsset, readAsDataUri } from '@/services/video/asset-store';

const PANEL_IMAGE_CONCURRENCY = 2;

export interface PanelImageContext {
  characters: ComicCharacterAnchor[];
  aspectRatio: AspectRatio;
  style: string;
  novelProjectId: string;
}

export interface PanelImageResult {
  panels: ComicPanelSpec[];
  /** 出图失败的 panelId 列表 */
  failedPanelIds: string[];
}

/**
 * 步 3:并发跑所有分镜出图。
 *
 * 断点续跑:已有 imageUrl 的 panel 跳过(用于失败重试)。
 * 全部失败抛错,部分失败返回失败 ID 列表。
 */
export async function runPanelImage(
  panels: ComicPanelSpec[],
  ctx: PanelImageContext,
  onProgress?: (done: number, total: number) => void,
  /** 单镜完成回调,让 UI 流式看到产物 */
  onPanel?: (panel: ComicPanelSpec) => void,
  /** 已有产物的 panel(从 store 传入,支持断点续跑)。
   *  通常等于 panels 参数本身,但允许调用方明确控制跳过逻辑。 */
  preExisting?: ComicPanelSpec[],
  /** 中断信号(返回 true 时停止派发新出图任务) */
  shouldAbort?: () => boolean,
): Promise<PanelImageResult> {
  const existingByUrl = new Map<string, ComicPanelSpec>();
  for (const p of preExisting ?? []) {
    if (p.id && p.imageUrl) {
      existingByUrl.set(p.id, p);
    }
  }

  const toRun = panels.filter((p) => !existingByUrl.has(p.id));
  const skipped = panels.length - toRun.length;
  if (skipped > 0) {
    void logger.info(
      `[comic/panel-image] 增量续跑 ${skipped}/${panels.length} 已有,仅重跑剩余 ${toRun.length}`,
      'comic',
    );
  }

  if (toRun.length === 0) {
    onProgress?.(panels.length, panels.length);
    return { panels, failedPanelIds: [] };
  }

  const dims = aspectRatioToDims(ctx.aspectRatio);
  const charById = new Map(ctx.characters.map((c) => [c.id, c]));

  // 产物累积:用 Map 按 id 合并(避免并发竞态)
  const result = new Map<string, ComicPanelSpec>();
  for (const p of panels) result.set(p.id, { ...p });

  const failedPanelIds: string[] = [];
  let done = skipped;
  let lastErr: unknown = null;
  const total = panels.length;
  onProgress?.(done, total);

  const pending = toRun.slice();
  const worker = async (): Promise<void> => {
    while (pending.length > 0) {
      if (shouldAbort?.()) break;
      const panel = pending.shift();
      if (!panel) break;
      try {
        const updated = await generatePanel(panel, ctx, charById, dims);
        result.set(panel.id, updated);
        onPanel?.(updated);
      } catch (err) {
        void logger.warn(
          `[comic/panel-image] panel ${panel.id} 出图失败: ${err instanceof Error ? err.message : String(err)}`,
          'comic',
        );
        lastErr = err;
        failedPanelIds.push(panel.id);
      }
      done++;
      onProgress?.(done, total);
    }
  };

  const workers = Array.from(
    { length: Math.min(PANEL_IMAGE_CONCURRENCY, toRun.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // 全部失败抛错,让上游 stage 标 error
  if (toRun.length > 0 && failedPanelIds.length === toRun.length) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
    throw new Error(
      `所有 ${toRun.length} 个分镜出图都失败(已有 ${skipped} 个被跳过)。最近一次错误:${reason}`,
    );
  }

  // 保持原 panels 顺序
  const merged = panels.map((p) => result.get(p.id) ?? p);
  return { panels: merged, failedPanelIds };
}

// --- 单镜出图 ---

async function generatePanel(
  panel: ComicPanelSpec,
  ctx: PanelImageContext,
  charById: Map<string, ComicCharacterAnchor>,
  dims: { w: number; h: number },
): Promise<ComicPanelSpec> {
  // 收集在场角色立绘作 reference
  const referenceImages: string[] = [];
  for (const cid of panel.characterIds) {
    const c = charById.get(cid);
    if (!c) continue;
    // 优先 turnaround(三视图,信息更丰富),fallback portrait
    const refUrl = c.turnaroundImage ?? c.portraitImage;
    if (refUrl) {
      referenceImages.push(await readAsDataUri(refUrl));
    }
    // 多 reference 上限 3,避免 provider 拒绝
    if (referenceImages.length >= 3) break;
  }

  const prompt = buildPanelPrompt(panel, ctx.style);
  const response = await providerRouter.generateImage({
    taskType: 'storyboard',
    prompt,
    referenceImages,
    width: dims.w,
    height: dims.h,
  });

  const imageUrl = await saveAsset(
    ctx.novelProjectId,
    'keyframe', // 复用 video 的 'keyframe' kind,落盘目录已存在
    response.imageData,
    `comic_panel_${panel.index + 1}`,
  );

  return { ...panel, imageUrl };
}

// --- Prompt 构造 ---

function buildPanelPrompt(panel: ComicPanelSpec, style: string): string {
  const base = panel.promptOverride?.trim() || panel.description.trim();
  if (!base) {
    throw new Error(`panel ${panel.id} description 为空`);
  }
  const isChinese = /[\u4e00-\u9fa5]/.test(base);
  if (isChinese) {
    const shotMap: Record<string, string> = {
      'close-up': '特写视角',
      medium: '中景视角',
      wide: '远景视角',
      establishing: '全景空景视角',
    };
    const shotHint = panel.shotType && shotMap[panel.shotType] ? `，${shotMap[panel.shotType]}` : '';
    return [
      base,
      shotHint,
      style ? `，${style}风格` : '，漫画风格',
      '，漫画分镜构图，高细节，无文字，无水印，无对话框，无字幕',
    ].join('');
  }
  const shotHint = panel.shotType
    ? `, ${panel.shotType.replace('-', ' ')} shot composition`
    : '';
  return [
    base,
    shotHint,
    style ? `, ${style} style` : ', comic style',
    ', comic panel composition',
    ', high detail',
    ', no text, no watermark, no speech bubble, no caption',
  ].join('');
}

// --- Aspect Ratio → Dimensions ---

function aspectRatioToDims(ratio: AspectRatio): { w: number; h: number } {
  switch (ratio) {
    case '16:9':
      return { w: 1024, h: 576 };
    case '9:16':
      return { w: 576, h: 1024 };
    case '1:1':
      return { w: 768, h: 768 };
    default:
      return { w: 1024, h: 576 };
  }
}

/**
 * 单图独立重绘：针对漫画项目的特定单格 Panel 重新跑 Image 渲染 API 并存盘更新。
 */
export async function rerunSingleComicPanel(
  projectId: string,
  panelId: string,
): Promise<ComicPanelSpec | null> {
  const { useComicStore } = await import('@/stores/comicStore');
  const store = useComicStore.getState();
  const proj = store.projects[projectId];
  if (!proj || !proj.spec) return null;

  const panel = proj.spec.panels.find((p) => p.id === panelId);
  if (!panel) return null;

  const dims = aspectRatioToDims(proj.aspectRatio);
  const charById = new Map((proj.spec.characters ?? []).map((c) => [c.id, c]));

  const ctx: PanelImageContext = {
    characters: proj.spec.characters ?? [],
    aspectRatio: proj.aspectRatio,
    style: proj.style,
    novelProjectId: projectId,
  };

  try {
    const updated = await generatePanel(panel, ctx, charById, dims);
    store.upsertPanel(projectId, updated);
    return updated;
  } catch (err) {
    void logger.warn(`[comic] rerunSingleComicPanel failed panelId=${panelId}: ${String(err)}`, 'comic');
    return null;
  }
}


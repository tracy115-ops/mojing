// step-page-compose.ts — 漫画步 4:多镜拼页
//
// 输入:ComicPanelSpec[](已有 imageUrl)
// 输出:ComicPageSpec[](每页含拼好的 imageUrl + panelIds)
//
// 布局策略(Phase 2 MVP):
//   - 'single'    不拼,每镜一页(page.imageUrl = panel.imageUrl 直接复用)
//   - 'grid-2'    每页 2 镜(上下二分)
//   - 'grid-4'    每页 4 镜(2×2)
//   - 'manga-row' 每页 3 镜(横向三栏,适合横幅)
//
// 不满足一页所需的镜数时,最后一页允许"残页"(用已有镜凑,留白填背景)。
//
// 实现:纯前端 Canvas,槽位 + cover 裁切。

import { logger } from '@/services/log';
import { saveAsset, readAsDataUri } from '@/services/video/asset-store';
import type { ComicPanelSpec, ComicPageSpec } from '@/types/comic';

type PanelLayout = 'single' | 'grid-2' | 'grid-4' | 'manga-row';

export interface PageComposeContext {
  novelProjectId: string;
  layout: PanelLayout;
  /** 格子间距(像素,基于 1024 基准) */
  padding?: number;
}

export interface PageComposeResult {
  pages: ComicPageSpec[];
  /** 拼页失败的 panelId */
  failedPanelIds: string[];
}

const PAGE_W = 1024;

export async function runPageCompose(
  panels: ComicPanelSpec[],
  ctx: PageComposeContext,
  onProgress?: (done: number, total: number) => void,
): Promise<PageComposeResult> {
  const withImage = panels.filter((p) => p.imageUrl);
  if (withImage.length === 0) {
    return { pages: [], failedPanelIds: [] };
  }

  // single 模式:直接复用 panel.imageUrl,不消耗 canvas
  if (ctx.layout === 'single') {
    const pages: ComicPageSpec[] = withImage.map((p, i) => ({
      id: `page_${i + 1}`,
      pageNumber: i + 1,
      panelIds: [p.id],
      imageUrl: p.imageUrl!,
    }));
    onProgress?.(pages.length, pages.length);
    return { pages, failedPanelIds: [] };
  }

  // 多镜模式:按布局切页
  const perPage = ctx.layout === 'grid-2' ? 2 : ctx.layout === 'grid-4' ? 4 : 3;
  const chunks: ComicPanelSpec[][] = [];
  for (let i = 0; i < withImage.length; i += perPage) {
    chunks.push(withImage.slice(i, i + perPage));
  }

  const failedPanelIds: string[] = [];
  const pages: ComicPageSpec[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const page = await composePage(chunk, ctx, i + 1);
      pages.push(page);
    } catch (err) {
      void logger.warn(
        `[comic/page-compose] page ${i + 1} 拼页失败: ${err instanceof Error ? err.message : String(err)}`,
        'comic',
      );
      // 失败兜底:把这页所有 panel 当 single
      chunk.forEach((p) => failedPanelIds.push(p.id));
      chunk.forEach((p, idx) => {
        pages.push({
          id: `page_fallback_${i + 1}_${idx + 1}`,
          pageNumber: pages.length + 1,
          panelIds: [p.id],
          imageUrl: p.imageUrl!,
        });
      });
    }
    onProgress?.(i + 1, chunks.length);
  }

  return { pages, failedPanelIds };
}

// --- 单页拼图 ---

async function composePage(
  chunk: ComicPanelSpec[],
  ctx: PageComposeContext,
  pageNumber: number,
): Promise<ComicPageSpec> {
  const padding = ctx.padding ?? 16;
  const canvas = document.createElement('canvas');
  const { w, h } = computeCanvasSize(ctx.layout);
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas 2D context unavailable');

  // 1. 背景
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);

  // 2. 槽位
  const slots = computeSlots(chunk.length, ctx.layout, w, h, padding);

  // 3. 每镜绘制(cover 裁切)
  for (let i = 0; i < chunk.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const dataUri = await readAsDataUri(chunk[i].imageUrl!);
    const img = await loadImage(dataUri);
    drawImageCover(g, img, slot);
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.strokeRect(slot.x, slot.y, slot.w, slot.h);
  }

  // 4. 导出
  const dataUrl = canvas.toDataURL('image/png');
  const imageUrl = await saveAsset(
    ctx.novelProjectId,
    'keyframe',
    dataUrl,
    `comic_page_${pageNumber}`,
  );

  return {
    id: `page_${pageNumber}`,
    pageNumber,
    panelIds: chunk.map((p) => p.id),
    imageUrl,
  };
}

// --- 布局计算 ---

function computeCanvasSize(layout: PanelLayout): { w: number; h: number } {
  switch (layout) {
    case 'grid-2':
      return { w: PAGE_W, h: Math.round(PAGE_W * 1.4) }; // 5:7 竖向
    case 'grid-4':
      return { w: PAGE_W, h: Math.round(PAGE_W * 1.4) }; // 5:7 竖向
    case 'manga-row':
      return { w: PAGE_W, h: Math.round(PAGE_W * 9 / 16) }; // 16:9 横幅
    default:
      return { w: PAGE_W, h: PAGE_W };
  }
}

interface Slot { x: number; y: number; w: number; h: number }

function computeSlots(
  count: number,
  layout: PanelLayout,
  canvasW: number,
  canvasH: number,
  padding: number,
): Slot[] {
  if (layout === 'grid-2') {
    // 上下二分
    const cellH = (canvasH - padding * 3) / 2;
    const cellW = canvasW - padding * 2;
    return [
      { x: padding, y: padding, w: cellW, h: cellH },
      { x: padding, y: padding * 2 + cellH, w: cellW, h: cellH },
    ];
  }
  if (layout === 'grid-4') {
    // 2×2
    const cellW = (canvasW - padding * 3) / 2;
    const cellH = (canvasH - padding * 3) / 2;
    return [
      { x: padding, y: padding, w: cellW, h: cellH },
      { x: padding * 2 + cellW, y: padding, w: cellW, h: cellH },
      { x: padding, y: padding * 2 + cellH, w: cellW, h: cellH },
      { x: padding * 2 + cellW, y: padding * 2 + cellH, w: cellW, h: cellH },
    ];
  }
  if (layout === 'manga-row') {
    // 横向三栏
    const cellW = (canvasW - padding * 4) / 3;
    const cellH = canvasH - padding * 2;
    return [0, 1, 2].map((i) => ({
      x: padding + i * (cellW + padding),
      y: padding,
      w: cellW,
      h: cellH,
    }));
  }
  // single(理论不会到这里)
  return [{ x: 0, y: 0, w: canvasW, h: canvasH }];
}

// --- 图片绘制 ---

function drawImageCover(g: CanvasRenderingContext2D, img: HTMLImageElement, slot: Slot): void {
  const iw = img.width;
  const ih = img.height;
  const slotRatio = slot.w / slot.h;
  const imgRatio = iw / ih;
  let sx: number, sy: number, sw: number, sh: number;
  if (imgRatio > slotRatio) {
    // 图片更宽,左右裁
    sh = ih;
    sw = ih * slotRatio;
    sx = (iw - sw) / 2;
    sy = 0;
  } else {
    // 图片更高,上下裁
    sw = iw;
    sh = iw / slotRatio;
    sx = 0;
    sy = (ih - sh) / 2;
  }
  g.drawImage(img, sx, sy, sw, sh, slot.x, slot.y, slot.w, slot.h);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 注:src 已是 data URI(readAsDataUri 返回),无需 crossOrigin
    // 强行设 'anonymous' 会触发额外 CORS 校验,在 Tauri webview 里反而把 canvas 染污
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`loadImage failed: ${String(e)}`));
    img.src = src;
  });
}

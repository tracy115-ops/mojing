// step-dialogue-burn.ts — 漫画步 4:对白气泡烧录
//
// 输入:panels[](已有 imageUrl + dialogue)
// 输出:更新后的 panels[](imageUrl 替换为带气泡的新图)
//
// 策略(Phase 2 MVP):
//   - 纯前端 Canvas,不依赖 Rust / provider
//   - 每个 panel 一个气泡,默认放底部居中(bbox 由 characterIds 决定左右)
//   - 3 种形状:oval(角色对白)、rect(配角对白)、narration(旁白,黄色矩形)
//   - CJK 文字自动换行
//   - 字号自适应:用户可改 bubbleFontSize(默认 36px @1024 基准)
//   - 跳过:panel 无 dialogue / 无 imageUrl

import { logger } from '@/services/log';
import { saveAsset, readAsDataUri } from '@/services/video/asset-store';
import type { ComicPanelSpec } from '@/types/comic';

const BURN_CANVAS_W = 1024;
const DEFAULT_BUBBLE_FONT_SIZE = 36;
const FONT_FAMILY =
  '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';

export interface DialogueBurnContext {
  novelProjectId: string;
  /** 默认气泡形状 */
  bubbleShape?: 'oval' | 'rect' | 'narration';
  /** 默认字号 */
  bubbleFontSize?: number;
}

export interface DialogueBurnResult {
  panels: ComicPanelSpec[];
  /** 烧录失败的 panelId(无图 / 无对白 / canvas 异常) */
  skippedPanelIds: string[];
}

export async function runDialogueBurn(
  panels: ComicPanelSpec[],
  ctx: DialogueBurnContext,
  onProgress?: (done: number, total: number) => void,
  onPanel?: (panel: ComicPanelSpec) => void,
): Promise<DialogueBurnResult> {
  const toBurn = panels.filter((p) => p.imageUrl && p.dialogue && p.dialogue.trim());
  const skipped: string[] = panels
    .filter((p) => !(p.imageUrl && p.dialogue && p.dialogue.trim()))
    .map((p) => p.id);

  const result = new Map<string, ComicPanelSpec>();
  for (const p of panels) result.set(p.id, { ...p });

  let done = 0;
  const total = panels.length;
  onProgress?.(done, total);

  for (const panel of toBurn) {
    try {
      const burned = await burnPanel(panel, ctx);
      result.set(panel.id, burned);
      onPanel?.(burned);
    } catch (err) {
      void logger.warn(
        `[comic/dialogue-burn] panel ${panel.id} 烧录失败: ${err instanceof Error ? err.message : String(err)}`,
        'comic',
      );
      skipped.push(panel.id);
    }
    done++;
    onProgress?.(done, total);
  }

  const merged = panels.map((p) => result.get(p.id) ?? p);
  return { panels: merged, skippedPanelIds: skipped };
}

// --- 单镜烧录 ---

async function burnPanel(
  panel: ComicPanelSpec,
  ctx: DialogueBurnContext,
): Promise<ComicPanelSpec> {
  const dataUri = await readAsDataUri(panel.imageUrl!);
  const img = await loadImage(dataUri);

  const canvas = document.createElement('canvas');
  canvas.width = BURN_CANVAS_W;
  canvas.height = Math.round((BURN_CANVAS_W * img.height) / img.width);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas 2D context unavailable');

  // 1. 画底图
  g.drawImage(img, 0, 0, canvas.width, canvas.height);

  // 2. 画气泡
  const text = panel.dialogue!.trim();
  const shape = ctx.bubbleShape ?? 'oval';
  const fontSize = ctx.bubbleFontSize ?? DEFAULT_BUBBLE_FONT_SIZE;
  const isNarration = shape === 'narration' || panel.characterIds.length === 0;

  drawBubble(
    g,
    text,
    {
      shape: isNarration ? 'narration' : shape,
      fontSize,
      // 角色立绘偏向左侧 → 气泡靠右;反之靠左;旁白居中
      anchor: isNarration ? 'center' : panel.characterIds.length > 0 ? 'right' : 'left',
      canvasW: canvas.width,
      canvasH: canvas.height,
    },
  );

  // 3. 落盘
  const dataUrl = canvas.toDataURL('image/png');
  const newUrl = await saveAsset(
    ctx.novelProjectId,
    'keyframe',
    dataUrl,
    `comic_panel_burned_${panel.index + 1}`,
  );

  return { ...panel, imageUrl: newUrl };
}

// --- 气泡绘制 ---

interface DrawBubbleParams {
  shape: 'oval' | 'rect' | 'narration';
  fontSize: number;
  anchor: 'left' | 'right' | 'center';
  canvasW: number;
  canvasH: number;
}

function drawBubble(
  g: CanvasRenderingContext2D,
  text: string,
  params: DrawBubbleParams,
): void {
  const padding = 24;
  const bubbleW = Math.min(params.canvasW * 0.55, 480);
  const bubbleH = Math.max(params.fontSize * 3.2, 96);
  const margin = 32;

  // 横向锚点
  let bubbleX: number;
  if (params.anchor === 'left') {
    bubbleX = margin;
  } else if (params.anchor === 'right') {
    bubbleX = params.canvasW - bubbleW - margin;
  } else {
    bubbleX = (params.canvasW - bubbleW) / 2;
  }
  // 默认贴底
  const bubbleY = params.canvasH - bubbleH - margin;

  // 形状参数
  const isNarration = params.shape === 'narration';
  g.lineWidth = Math.max(2, Math.round(params.fontSize / 16));
  g.fillStyle = isNarration ? '#fef3c7' : '#ffffff';
  g.strokeStyle = isNarration ? '#d97706' : '#000000';

  if (params.shape === 'oval') {
    drawOval(g, bubbleX, bubbleY, bubbleW, bubbleH);
  } else if (params.shape === 'rect') {
    drawRoundedRect(g, bubbleX, bubbleY, bubbleW, bubbleH, 12);
  } else {
    // narration:矩形 + 无尾巴
    drawRoundedRect(g, bubbleX, bubbleY, bubbleW, bubbleH, 4);
  }

  // 文字(换行)
  g.fillStyle = '#000000';
  g.font = `${params.fontSize}px ${FONT_FAMILY}`;
  g.textBaseline = 'top';
  wrapAndDrawText(
    g,
    text,
    bubbleX + padding / 2,
    bubbleY + padding / 2,
    bubbleW - padding,
    bubbleH - padding,
    params.fontSize,
  );
}

function drawOval(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.beginPath();
  // ellipse:中心点 + 半轴
  g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}

function drawRoundedRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.lineTo(x + w - radius, y);
  g.quadraticCurveTo(x + w, y, x + w, y + radius);
  g.lineTo(x + w, y + h - radius);
  g.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  g.lineTo(x + radius, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - radius);
  g.lineTo(x, y + radius);
  g.quadraticCurveTo(x, y, x + radius, y);
  g.closePath();
  g.fill();
  g.stroke();
}

function wrapAndDrawText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  maxH: number,
  fontSize: number,
): void {
  const lineHeight = Math.round(fontSize * 1.3);
  const chars = Array.from(text);
  let line = '';
  let lineY = y;

  for (const char of chars) {
    if (char === '\n') {
      g.fillText(line, x, lineY);
      line = '';
      lineY += lineHeight;
      if (lineY + fontSize > y + maxH) return;
      continue;
    }
    const testLine = line + char;
    const width = g.measureText(testLine).width;
    if (width > maxW && line) {
      g.fillText(line, x, lineY);
      line = char;
      lineY += lineHeight;
      if (lineY + fontSize > y + maxH) return;
    } else {
      line = testLine;
    }
  }
  if (line) {
    g.fillText(line, x, lineY);
  }
}

// --- 图片加载 ---

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

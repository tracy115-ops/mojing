# 06. 对话气泡烧录

## 问题

漫画分镜出图时如果让 AI 直接画对白文字,会出现:
- 中文渲染差(AI 字体训练数据多为英文)
- 位置不可控
- 改字要重新出图(成本高)

**正确做法:** 出图时不带文字 → 后期 Canvas 烧录对白气泡。

## 出图阶段的 prompt 保护

`step-panel-image.ts` 构造 prompt 时强制加:

```
no text, no watermark, no speech bubble, no caption
```

避免 AI 在画面里画乱字。

## Stage 流程

```
panel_image(无文字)
   ↓
page_compose(拼页,Phase 2)
   ↓
dialogue_burn(画气泡)
```

`dialogue_burn` 是最后一步,在最终页面上绘制气泡。

## 实现方案:前端 Canvas

### 数据结构

```typescript
interface DialogueBubble {
  panelId: string;
  speakerId?: string;        // 角色 ID,决定气泡样式(主/次角/旁白)
  speakerName?: string;      // 显示用名字(角色名或"旁白")
  text: string;
  bbox: { x: number; y: number; w: number; h: number };  // 百分比坐标
  shape: 'oval' | 'rect' | 'thought' | 'shout' | 'narration';
  tail?: 'tail-l' | 'tail-r' | 'tail-down' | 'none';     // 气泡尾巴方向
}
```

### 默认布局算法

LLM 在 panel_script 阶段输出 dialogue 时,同时给出建议 bbox:

```json
{
  "description": "...",
  "dialogue": "你今天看起来很累",
  "dialogueBbox": { "x": 10, "y": 5, "w": 50, "h": 15 },
  "dialogueShape": "oval",
  "dialogueTail": "tail-down"
}
```

LLM 的空间判断不精确,但作为默认值可用。用户在 UI 拖动调整。

### Canvas 绘制

```typescript
function drawBubble(
  ctx: CanvasRenderingContext2D,
  bubble: DialogueBubble,
  canvasW: number,
  canvasH: number,
) {
  const x = bubble.bbox.x / 100 * canvasW;
  const y = bubble.bbox.y / 100 * canvasH;
  const w = bubble.bbox.w / 100 * canvasW;
  const h = bubble.bbox.h / 100 * canvasH;

  // 1. 气泡形状
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;

  switch (bubble.shape) {
    case 'oval':
      drawOval(ctx, x, y, w, h);
      break;
    case 'rect':
      drawRoundedRect(ctx, x, y, w, h, 8);
      break;
    case 'thought':
      drawThoughtCloud(ctx, x, y, w, h);
      break;
    case 'shout':
      drawShoutStar(ctx, x, y, w, h);
      break;
    case 'narration':
      drawNarrationBox(ctx, x, y, w, h);
      break;
  }

  // 2. 尾巴(指向说话角色)
  if (bubble.tail && bubble.tail !== 'none') {
    drawTail(ctx, bubble.tail, x, y, w, h);
  }

  // 3. 文字
  ctx.fillStyle = '#000000';
  ctx.font = `${computeFontSize(w, h, bubble.text.length)}px sans-serif`;
  ctx.textBaseline = 'top';
  wrapText(ctx, bubble.text, x + 8, y + 6, w - 16, h - 12);
}
```

### 文字换行

```typescript
function wrapText(ctx, text, x, y, maxW, maxH) {
  const chars = text.split('');
  let line = '';
  let lineY = y;

  for (const char of chars) {
    const testLine = line + char;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxW && line) {
      ctx.fillText(line, x, lineY);
      line = char;
      lineY += ctx.font.match(/\d+/)?.[0] * 1.2 ?? 24;
      if (lineY > y + maxH) break;  // 溢出截断
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, lineY);
}
```

### 字体大小自适应

```typescript
function computeFontSize(w: number, h: number, charCount: number): number {
  // 估算:让文字占满 bbox 的 80%
  const area = w * h;
  const charArea = area / charCount;
  // √charArea 的 0.7 倍约等于字号
  return Math.floor(Math.sqrt(charArea) * 0.7);
}
```

## 气泡样式按角色类型区分

| speakerType | shape | fill | stroke |
|---|---|---|---|
| 主角 | oval | #fff | #000 |
| 配角 | rect | #fff | #000 |
| 旁白 | narration | #fef3c7(浅黄) | #d97706 |
| 内心独白 | thought(云朵) | #f3f4f6(浅灰) | #6b7280 |
| 喊叫 | shout(爆炸星) | #fef2f2(浅红) | #dc2626 |

LLM 在 panel_script 决定 `dialogueShape`,用户可改。

## 实现位置

`step-dialogue-burn.ts`:

```typescript
export async function runDialogueBurn(
  pages: PageSpec[],
  panels: PanelSpec[],
  ctx: { novelProjectId: string },
  onProgress?: (done: number, total: number) => void,
): Promise<{ pages: PageSpec[] }> {
  const result: PageSpec[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pagePanels = page.panelIds
      .map(id => panels.find(p => p.id === id))
      .filter((p): p is PanelSpec => !!p);

    // 把每镜的 dialogue 烧到 page 上
    const burned = await burnDialoguesOnPage(page, pagePanels, ctx);
    result.push(burned);
    onProgress?.(i + 1, pages.length);
  }
  return { pages: result };
}
```

## 与 page_compose 的关系

如果 `page_compose` 没启用(单镜模式),`dialogue_burn` 直接在单镜图上烧。
如果 `page_compose` 启用,先拼页再烧气泡(在最终页面上烧,避免拼页时裁切气泡)。

## Phase 2 编辑器

`ComicPipelinePanel` 的 dialogue_burn stage 详情区,提供可视化编辑:

```
┌──────────────────────────────┐
│  [页面预览 + 气泡拖动]         │
│                                │
│  Panel 1:                     │
│    Text: [你今天看起来很累]    │
│    Shape: [oval ▾]            │
│    Tail: [tail-down ▾]        │
│    Speaker: [alice ▾]         │
│                                │
│  [+ 添加气泡]                 │
└──────────────────────────────┘
```

用户改完 → 调 `runSingleStage(pid, 'dialogue_burn')` 重跑这一步(Canvas 重绘,不消耗 provider 额度)。

## 字体选择

默认用系统字体栈:

```css
font-family: "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
```

Phase 3 增强:让用户上传自定义字体(`.ttf` / `.otf`),用 `FontFace` API 加载。

## 性能

- 单页烧 4 个气泡 → < 50ms
- 20 页 → 1s
- 不需要 Web Worker

## 与 Rust 后端的关系

**不依赖 Rust。** 纯前端 Canvas 完成。

如果未来需要更高质量(抗锯齿、矢量导出 SVG),可在 Phase 3 评估 `src-tauri/src/image_compose.rs` + `image` + `resvg` 方案。

## 总结

| Phase | 功能 |
|---|---|
| Phase 2 MVP | LLM 给默认 bbox,Canvas 烧录,5 种气泡形状 |
| Phase 2+ | UI 拖动编辑气泡位置/形状/文字 |
| Phase 3 | 自定义字体、SVG 矢量导出 |

# 05. 分镜布局策略

## 三种粒度

| 粒度 | 描述 | 实现复杂度 | 视觉效果 |
|---|---|---|---|
| **一镜一图** | 每镜一张独立图,垂直/水平滚动浏览 | 极低(Phase 1) | 简单清晰,适合条漫/速写 |
| **一页多镜 + 网格** | 每页 2-6 镜,固定网格布局 | 中(Phase 2) | 经典漫画阅读感 |
| **一页多镜 + 自由** | 镜大小不规则,出血/叠加 | 高(Phase 3) | 专业漫画家水准 |

## Phase 1:一镜一图

每镜一张图,UI 用网格瀑布流展示。

**Layout 字段:** `PanelSpec.layout = 'single'`

**UI 展示:**

```
┌────────┐ ┌────────┐
│ Panel 1│ │ Panel 2│
│  图    │ │  图    │
└────────┘ └────────┘
┌────────┐ ┌────────┐
│ Panel 3│ │ Panel 4│
└────────┘ └────────┘
```

适用场景:条漫(webtoon)、单图集、概念图。

## Phase 2:一页多镜

### Layout 选项

| Layout | 每页镜数 | 视觉 |
|---|---|---|
| `grid-2` | 2(上下或左右) | 双栏对话场景 |
| `grid-3` | 3(上1下2 或 上2下1) | 节奏感强 |
| `grid-4` | 4(2×2) | 经典四格 |
| `grid-6` | 6(2×3 或 3×2) | 信息密度高 |
| `manga-row` | 横条 2-3 镜并排 | 横幅动作场景 |

### Pipeline 改造

新增 stage:

```typescript
case 'page_compose':
  return !!options.enablePageCompose && spec.panels.length > 1;
```

**`step-page-compose.ts`:**

```typescript
export async function runPageCompose(
  panels: PanelSpec[],
  options: { layout: PanelLayout; padding: number; background: string },
  onProgress?: (done: number, total: number) => void,
): Promise<{ pages: PageSpec[] }> {
  // 1. 按 layout 把 panels 切分成页
  const pages = chunkPanelsByLayout(panels, options.layout);

  // 2. 每页用 Canvas 拼图
  const result = await Promise.all(
    pages.map((page, i) => composePageImage(page, options, i))
  );

  return { pages: result };
}
```

### Canvas 拼图实现

```typescript
async function composePageImage(
  page: PanelSpec[],
  opts: ComposeOptions,
  pageIndex: number,
): Promise<PageSpec> {
  const canvas = document.createElement('canvas');
  const { width, height } = computeCanvasSize(page.length, opts.layout);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d')!;

  // 1. 背景
  ctx.fillStyle = opts.background || '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // 2. 每镜绘制
  for (let i = 0; i < page.length; i++) {
    const slot = computeSlot(i, page.length, opts.layout, width, height);
    const img = await loadImage(page[i].imageUrl!);

    // cover 模式裁剪(保持比例填充 slot)
    drawImageCover(ctx, img, slot);

    // 边框
    ctx.strokeStyle = '#000';
    ctx.lineWidth = opts.borderWidth || 2;
    ctx.strokeRect(slot.x, slot.y, slot.w, slot.h);
  }

  // 3. 导出
  const dataUrl = canvas.toDataURL('image/png');
  return {
    id: `page_${pageIndex + 1}`,
    pageNumber: pageIndex + 1,
    panelIds: page.map(p => p.id),
    imageUrl: await saveAsset(opts.pid, 'page', dataUrl, `page_${pageIndex + 1}`),
  };
}
```

### 槽位计算示例(grid-4)

```
┌─────────┬─────────┐
│         │         │
│  slot 0 │  slot 1 │
│         │         │
├─────────┼─────────┤
│         │         │
│  slot 2 │  slot 3 │
│         │         │
└─────────┴─────────┘
```

```typescript
function computeGrid4Slots(w, h, padding) {
  const cellW = (w - padding * 3) / 2;
  const cellH = (h - padding * 3) / 2;
  return [
    { x: padding,             y: padding,             w: cellW, h: cellH },
    { x: padding * 2 + cellW, y: padding,             w: cellW, h: cellH },
    { x: padding,             y: padding * 2 + cellH, w: cellW, h: cellH },
    { x: padding * 2 + cellW, y: padding * 2 + cellH, w: cellW, h: cellH },
  ];
}
```

## Phase 2 增量:LLM 决定 layout

简单做法:用户在 CreateComicModal 选 layout,所有页统一。

进阶做法:LLM 在 `panel_script` stage 为每组 panels 决定 layout:

```json
{
  "panels": [
    { "description": "...", "layout": "single" },
    { "description": "...", "layout": "grid-2", "group": "g1" },
    { "description": "...", "layout": "grid-2", "group": "g1" },
    { "description": "...", "layout": "single" }
  ]
}
```

`page_compose` 按 `group` 字段把同组的镜拼到一页。LLM 决策的 prompt 加:

```
- 紧密相关的连续动作 → 用 grid-2/grid-3 同页呈现
- 重要转折/特写 → 用 single 单独一页强调
- layout 字段决定单镜或同组多镜
- 同 group 的 panels 必须用相同 layout
```

## Phase 3:自由布局

不规则画框、出血、叠加 — 这需要:

1. LLM 输出每镜的 `bbox: { x, y, w, h }`(百分比坐标)
2. Canvas 按坐标绘制
3. UI 编辑器让用户拖动调整

工作量很大,Phase 3 视用户反馈决定是否做。

## 出图 aspectRatio 与 layout 的协调

| Layout | 单镜 aspect | 整页 aspect(典型) |
|---|---|---|
| single | 3:4 / 16:9 | 等于单镜 |
| grid-2(垂直) | 16:9 | 3:4 |
| grid-2(水平) | 9:16 | 16:9 |
| grid-4 | 3:4 | 3:4(2×2) |
| grid-6 | 3:4 | 16:9(2×3)或 9:16(3×2) |

**协调规则:**
- `ComicMetadata.aspectRatio` 是**整页**比例
- LLM/用户选 `panelLayout` 后,自动计算单镜 aspect 反传给 image provider

实现位置:`step-panel-image.ts` 调用 provider 前:

```typescript
const panelAspect = computePanelAspect(spec.meta.aspectRatio, panel.layout);
```

## 用户可微调(单步重跑)

每个 PanelSpec 有独立 `layout` 字段,用户可在 StageInputEditor 改:
- 改单镜 layout → 重跑 `page_compose`(只重拼不改图)
- 改 prompt → 重跑 `panel_image`(重新出图)+ `page_compose`

## 渲染顺序保证

Canvas 绘制顺序 = panels 数组顺序,LLM 输出时已按故事顺序排好。用户可在 UI 拖动重排(改 `panel.index`),`page_compose` 按 index 排序。

## 性能

- 单页 4 镜 @ 1024×1024 PNG → Canvas 拼图 < 100ms
- 20 页 → 2s,可接受
- 大图(4K)+ 多页 → 考虑 Web Worker(避免阻塞 UI 线程)

## 总结

| Phase | 做什么 | 文件 |
|---|---|---|
| Phase 1 | 一镜一图,UI 网格展示 | 现有 ComicWorkspace |
| Phase 2 | 新增 `page_compose` stage + Canvas 拼图 | `step-page-compose.ts` |
| Phase 3 | 自由 bbox 布局 + UI 编辑器 | 待设计 |

---
name: aiworkstation-css-architecture
description: AI WorkStation CSS 架构与主题规范。用于任何样式开发、CSS 重构、主题切换、Ant Design 控件定制、面板 UI 开发。涉及文本框、输入框、下拉框、按钮、卡片、设置页时必须使用。
---

# AI WorkStation CSS Architecture

## 当前架构

按这四层组织：

1. **`src/styles/themes/variables.css`** — 主题 token（颜色、边框、阴影、间距变量）
2. **`src/styles/themes/dark.ts` / `light.ts`** — Ant Design 主题 Token 配置
3. **Feature CSS** — 各功能模块自己的样式（内联在组件中或单独 CSS 文件）
4. **`src/styles/global.css`** — reset、app shell、全局布局（`ws-*` class）

## 分层规则

### tokens 层 (`variables.css`)
- 只放主题变量
- 不允许出现业务选择器

### Ant Design 主题层 (`dark.ts` / `light.ts`)
- Ant Design 组件的视觉定制
- 通过 ConfigProvider theme prop 注入

### feature 层
- 各功能自己的布局和视觉特化
- 禁止跨 feature 污染

### global 层 (`global.css`)
- `html/body/#root`
- app shell（`ws-shell`, `ws-titlebar`, `ws-body`, `ws-sidebar`, `ws-content`, `ws-statusbar`）
- 真正跨功能的公共规则

## 布局体系

```
ws-shell (flex column, 100vh)
├── ws-titlebar (38px, flex, 拖拽区域)
├── ws-body (flex, flex-1)
│   ├── ws-sidebar (260px, 可折叠)
│   └── ws-content (flex-1, overflow auto)
└── ws-statusbar (28px, flex)
```

## 主题规范

- 深浅主题都走 CSS 变量
- Ant Design 自动跟随 ConfigProvider algorithm
- 禁止在多个文件重复写 dark override

## 修改流程

1. 判断归属层
2. 只改对应层
3. `npm run build` 验证
4. 检查深色/浅色主题都可读

## 禁止事项

- 硬编码颜色值
- 在 global.css 堆 feature 规则
- 全局裸写 `.ant-*` 选择器

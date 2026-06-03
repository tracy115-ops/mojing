---
name: aiworkstation-ui-pro
description: AI WorkStation UI 开发与样式规范。用于确保应用保持统一的视觉风格。包含颜色体系、布局规范、组件样式指导。在进行前端界面开发、修改 CSS、设计新组件或优化现有 UI 时使用。
---

# AI WorkStation UI 开发规范

## 1. 核心视觉原则
- **极简现代**：减少装饰性元素，强调内容和功能
- **空间感**：使用足够的 padding 和 margin
- **一致性**：所有组件必须符合 Design Tokens

## 2. 颜色体系 (Tokens)

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--bg-base` | `#f5f7fa` | `#141414` | 主背景 |
| `--bg-container` | `#ffffff` | `#1f1f1f` | 容器/卡片 |
| `--bg-sidebar` | `#fcfcfc` | `#181818` | 侧边栏 |
| `--accent-primary` | `#1677ff` | `#3b82f6` | 品牌色 |
| `--text-primary` | `rgba(0,0,0,0.88)` | `rgba(255,255,255,0.88)` | 主文字 |
| `--text-secondary` | `rgba(0,0,0,0.65)` | `rgba(255,255,255,0.65)` | 次要文字 |
| `--border-base` | `#d9d9d9` | `rgba(255,255,255,0.12)` | 边框 |

## 3. 布局规范
- **Sidebar**: 260px（可折叠至 48px）
- **TitleBar**: 38px
- **StatusBar**: 28px
- **Border Radius**: 6px (标准), 4px (小), 12px (模态框)

## 4. i18n 规范
- 所有用户可见文字使用 `t('key')`
- Key 格式：`domain.element`（如 `novel.title`, `settings.general.language`）
- 先加 `zh-CN.ts`，再加 `en-US.ts`（类型为 `typeof zhCN`）

## 5. 开发建议
- **CSS 变量优先**：始终使用 CSS 变量，避免硬编码
- **响应式**：面板使用 flex-1 分配剩余空间
- **Icons**：统一使用 Ant Design Icons

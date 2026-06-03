# 主题切换开发规范

## 架构概览

应用主题由 `settingsStore.appearance.theme` 驱动，支持 dark / light / system 三种模式。

```
settingsStore.setTheme('dark' | 'light' | 'system')
    ↓ resolveAppearanceTheme()
    ↓ currentTheme: 'dark' | 'light'
    ↓
App.tsx ConfigProvider
    ├── algorithm: darkAlgorithm / defaultAlgorithm
    ├── theme token: darkTheme / lightTheme
    └── cssVar key: aiws-dark / aiws-light
    ↓
document.documentElement.setAttribute('data-theme', 'dark' | 'light')
    ↓
variables.css
    ├── :root (light tokens)
    └── [data-theme='dark'] (dark tokens)
```

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/stores/settingsStore.ts` | `currentTheme`, `setTheme()`, `resolveAppearanceTheme()` |
| `src/App.tsx` | ConfigProvider 根据 currentTheme 切换 algorithm 和 theme token |
| `src/styles/themes/variables.css` | `:root` 亮色变量 + `[data-theme='dark']` 暗色变量 |
| `src/styles/themes/dark.ts` | Ant Design 暗色主题 Token 配置 |
| `src/styles/themes/light.ts` | Ant Design 亮色主题 Token 配置 |
| `src/styles/themes/index.ts` | 主题导出和工具函数 |
| `src/main.tsx` | 初始主题检测（从 localStorage 读取） |

## CSS 变量体系

### 由 variables.css 静态定义

| 变量 | 用途 | 亮色 | 暗色 |
|------|------|------|------|
| `--bg-base` | 整体背景 | `#f5f7fa` | `#141414` |
| `--bg-container` | 容器/卡片 | `#ffffff` | `#1f1f1f` |
| `--bg-sidebar` | 侧边栏 | `#fcfcfc` | `#181818` |
| `--text-primary` | 主文字 | `rgba(0,0,0,0.88)` | `rgba(255,255,255,0.88)` |
| `--text-secondary` | 次要文字 | `rgba(0,0,0,0.65)` | `rgba(255,255,255,0.65)` |
| `--border-base` | 边框 | `#d9d9d9` | `rgba(255,255,255,0.12)` |
| `--accent-primary` | 强调色 | `#1677ff` | `#3b82f6` |

## 开发规范

### 添加新 UI 元素时

1. **使用 CSS 变量**，禁止硬编码颜色：
   ```css
   /* ✅ */
   .my-component { background: var(--bg-container); color: var(--text-primary); }

   /* ❌ */
   .my-component { background: #ffffff; color: #333333; }
   ```

2. **Ant Design 组件**自动跟随 ConfigProvider 切换

3. **新组件使用 CSS class** 而非内联 style（便于主题切换）

### 判断亮暗色

```typescript
import { useSettingsStore } from '@/stores/settingsStore';
const isDark = useSettingsStore((s) => s.currentTheme) !== 'light';
```

## 检查清单

- [ ] 新 UI 元素使用 CSS 变量，无硬编码颜色
- [ ] 切换主题后 `data-theme`、CSS 变量、Ant Design 三者同步
- [ ] Ant Design 弹层 z-index 通过 ConfigProvider components 配置

# AI WorkStation - 项目开发规范

## 技术栈
- Tauri 2.x + React 19 + TypeScript + Zustand + Ant Design 5
- Rust 后端
- 构建工具: Vite + Cargo
- 样式: Tailwind CSS 4 + CSS Variables + Ant Design Theme

---

## 国际化 (i18n) 开发规范

### 架构概览
自定义轻量 i18n 方案（~3KB），**禁止使用 react-i18next**。

核心文件：
- `src/i18n/index.ts` — 提供 `useTranslation()` hook 和独立 `t()` 函数
- `src/i18n/locales/zh-CN.ts` — 中文翻译（**源文件，key 的权威来源**）
- `src/i18n/locales/en-US.ts` — 英文翻译，类型为 `typeof zhCN`，编译时强制 key 一致

### 使用方式

#### React 组件内
```tsx
import { useTranslation } from '@/i18n';
const { t } = useTranslation();
return <span>{t('common.save')}</span>;
```

#### React 组件外（stores、callbacks）
```tsx
import { t } from '@/i18n';
message.success(t('common.saved'));
```

### 新增 UI 文字时必须遵守的规则

1. **禁止硬编码中英文文字** — 所有用户可见文字使用 `t('key')`
2. **先加 zh-CN，再加 en-US** — en-US 类型为 `typeof zhCN`，编译时强制一致
3. **Key 命名规范**：`domain.element` 格式
   - `common.*` — 通用词
   - `sidebar.*` — 侧边栏
   - `titleBar.*` — 标题栏
   - `settings.*` — 设置页（含 general, appearance, network, notifications, creative）
   - `novel.*` — 小说引擎
   - `comic.*` — 漫画工坊
   - `video.*` — 视频工坊
   - `project.*` — 项目管理
   - `message.*` — 消息提示
4. **支持参数插值**：`t('novel.wordCount', { count: 5000 })`

### 禁止事项
- **禁止** 在 locale 文件中创建重复 key
- **禁止** 使用 `.json` 格式（必须用 `.ts`）
- **禁止** 直接修改 `en-US.ts` 的类型声明（必须始终为 `typeof zhCN`）

---

## 主题切换规范

主题由 `settingsStore.appearance.theme` 驱动（`dark` / `light` / `system`）。

核心链路：
```
settingsStore.setTheme()
    → currentTheme ('dark' | 'light')
    → App.tsx ConfigProvider (darkAlgorithm / defaultAlgorithm)
    → document.documentElement.setAttribute('data-theme', ...)
    → variables.css CSS 变量切换
```

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/stores/settingsStore.ts` | `currentTheme`, `setTheme()` |
| `src/App.tsx` | ConfigProvider 根据 currentTheme 切换 algorithm |
| `src/styles/themes/variables.css` | `:root` 亮色 + `[data-theme='dark']` 暗色变量 |
| `src/styles/themes/dark.ts` | Ant Design 暗色主题 Token |
| `src/styles/themes/light.ts` | Ant Design 亮色主题 Token |
| `src/styles/global.css` | `ws-*` 布局类 |

### 开发规范
- 所有颜色必须使用 CSS 变量，禁止硬编码
- Ant Design 组件自动跟随 ConfigProvider
- 新 UI 元素使用 `var(--bg-*)`, `var(--text-*)`, `var(--border-*)`, `var(--accent-*)`

---

## 项目结构

```
src/
├── App.tsx                    # 应用入口（ConfigProvider + 主题）
├── main.tsx                   # React root + 主题检测
├── components/
│   ├── Layout/MainLayout.tsx  # 主布局（TitleBar + Sidebar + Content + StatusBar）
│   ├── Novel/NovelView.tsx    # 小说引擎视图
│   ├── Comic/ComicView.tsx    # 漫画工坊视图
│   ├── Video/VideoView.tsx    # 视频工坊视图
│   └── Settings/SettingsPanel.tsx # 设置面板
├── stores/
│   └── settingsStore.ts       # 全局设置状态
├── i18n/
│   ├── index.ts               # i18n 框架
│   └── locales/
│       ├── zh-CN.ts           # 中文
│       └── en-US.ts           # 英文
├── styles/
│   ├── global.css             # 全局样式 + 布局
│   ├── style-layers.css       # CSS @layer 声明
│   └── themes/                # 主题配置
├── types/index.ts             # 类型定义
└── utils/
    └── toast.ts               # Toast 通知
```

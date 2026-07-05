# 漫画工坊文档

本目录沉淀「文本→漫画」生成功能的设计与实现文档。

## 文档索引

| 文档 | 内容 |
|------|------|
| [01-overview.md](./01-overview.md) | 功能愿景、三模式输入、Phase 路线图 |
| [02-architecture.md](./02-architecture.md) | 模块分层、与小说/视频工坊的复用边界 |
| [03-pipeline.md](./03-pipeline.md) | 6 步漫画流水线状态机定义 |
| [04-character-consistency.md](./04-character-consistency.md) | 跨分镜角色一致性方案(复用 video 锚定图) |
| [05-panel-layout.md](./05-panel-layout.md) | 单镜 / 多镜网格 / 条漫布局策略 |
| [06-dialogue-burn.md](./06-dialogue-burn.md) | 对话气泡 Canvas 烧录方案 |
| [07-novel-integration.md](./07-novel-integration.md) | 从小说项目导入章节,角色/场景复用 |
| [08-phase1-mvp.md](./08-phase1-mvp.md) | Phase 1 MVP 实现清单(Direct pure,一镜一图) |

## 状态速览

- **Phase 1 MVP**:⏳ 待实施(Direct pure 模式,一镜一图,单步重跑)
- **Phase 2**:📐 设计中(Novel 模式、多镜网格、对话烧录)
- **Phase 3**:💡 可选(PDF/长图导出、风格预设库、跨页一致性)

## 入口

复用现有 ComicView + ComicWorkspace,在内部嵌入 ComicPipelinePanel(对齐 VideoPipelinePanel)。

两种入口:
1. **独立使用**:ComicView → 新建漫画 → 输入主题/角色 → 一键生成
2. **从小说导入**(Phase 2):NovelView 底部 → "生成漫画" → 选章节范围 → 自动提取角色/场景

## 与视频工坊的复用边界

| 模块 | 复用度 | 说明 |
|------|--------|------|
| `step-character-anchor` | 完全复用 | 漫画也需要角色锚定图,逻辑一致 |
| `direct-scene-builder` | 抽象后复用 | comic/video 共享"主题→角色+场景"的 LLM 提取 |
| `providerRouter` + `image-adapters` | 完全复用 | 加 `imageTier: 'comic'` |
| `asset-store` | 完全复用 | 产物落盘逻辑一致 |
| `StageInputEditor` + `runSingleStage` | 完全复用 | 单步重跑架构平行 |
| `step-keyframe` | 参考实现 | 漫画版 `step-panel-image` 借鉴多 reference |
| `ffmpeg.rs` | 不复用 | 漫画是静态图,改用 Canvas / Sharp |

详细复用清单见 [02-architecture.md](./02-architecture.md)。

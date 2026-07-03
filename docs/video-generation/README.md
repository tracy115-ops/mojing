# 视频生成模块文档

本目录沉淀「小说→视频」一键成片功能的所有设计与实现文档。

## 文档索引

| 文档 | 内容 |
|------|------|
| [01-overview.md](./01-overview.md) | 功能愿景、Phase 1-4 路线图 |
| [02-architecture.md](./02-architecture.md) | 系统分层、模块边界、数据流 |
| [03-model-matrix.md](./03-model-matrix.md) | T2I / T2V / I2V / TTS 模型矩阵与档位策略 |
| [04-pipeline-state-machine.md](./04-pipeline-state-machine.md) | 8 步流水线状态机定义与转换规则 |
| [05-provider-abstraction.md](./05-provider-abstraction.md) | Provider 抽象层（复用现有 services/providers） |
| [06-character-consistency.md](./06-character-consistency.md) | 角色一致性方案（FLUX 多参考图、锚定图） |
| [07-ffmpeg-backend.md](./07-ffmpeg-backend.md) | Tauri FFmpeg 合成后端设计 |
| [08-phase1-implementation.md](./08-phase1-implementation.md) | Phase 1 MVP 实现清单（已完成） |
| [09-phase2-roadmap.md](./09-phase2-roadmap.md) | Phase 2 真实感提升路线图（待实施） |
| [10-phase3-ux.md](./10-phase3-ux.md) | Phase 3 UX 打磨路线图（待实施） |
| [11-troubleshooting.md](./11-troubleshooting.md) | 常见问题与排查 |
| [12-dual-channel-unification.md](./12-dual-channel-unification.md) | 14 步完整流程对齐三种模式：Direct/Novel 共享 core（设计中） |
| [13-single-stage-rerun.md](./13-single-stage-rerun.md) | 单步重跑（runSingleStage / runFromStage）+ 可编辑 stage 输入 |
| [14-audio-merge-fix.md](./14-audio-merge-fix.md) | 音视合成 + 成片 0 秒不可播的根因与修复（2026-06-29） |
| [15-doubao-seedance.md](./15-doubao-seedance.md) | Doubao (Seedance 2.0) Video Provider 接入 |

## 状态速览

- **Phase 1 MVP**：✅ 已完成（代码 + typecheck 通过，未跑端到端测试）
- **Phase 2**：⏳ 待实施（角色锚定、I2V、多 Provider 路由）
- **Phase 3**：⏳ 待实施（人工 checkpoint、剪辑台）
- **Phase 4**：⏳ 可选（BGM、转场特效、长视频）

## 入口

两个入口都已支持：

1. **从小说**：NovelView 底部工具栏 → "生成视频" 按钮
2. **独立使用**：VideoView 顶部工具栏 → "从小说生成视频" 按钮（用户在弹窗里选小说项目）

两条路径共用同一套 `VideoPipeline` + `VideoGeneratorModal`。

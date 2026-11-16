# 视频生成模块文档

本目录记录视频创作工作区、小说／剧本改编、分镜制作与成片的设计、实现及验证边界。

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
| [15-doubao-seedance.md](./15-doubao-seedance.md) | Seedance 2.0／2.5 接入、模型约束与验证边界 |
| [16-open-ai-canvas-sync.md](./16-open-ai-canvas-sync.md) | Open AI Canvas 工作流适配、Agnes 质量修正与后续模型扩展 |
| [17-video-studio-redesign.md](./17-video-studio-redesign.md) | 竞品逐页功能与布局审计、11 个创作入口、世界引擎、迁移覆盖及未完成项 |
| [18-media-editing-and-shot-transfer.md](./18-media-editing-and-shot-transfer.md) | 音视频参考、图像编辑、画布连线与分镜素材回流的接口及验证边界 |
| [19-asset-library-and-mp4.md](./19-asset-library-and-mp4.md) | 文件夹、标签、批量整理、回收站、素材包与桌面 MP4 转换 |
| [20-world-camera-sequence.md](./20-world-camera-sequence.md) | 世界多机位序列、连续动画预演、批量构图映射及分镜产物失效 |
| [21-image-mask-editing.md](./21-image-mask-editing.md) | 画笔／擦除、原生 WebUI 蒙版、局部像素合成、候选保留及本地失败恢复 |
| [22-media-upload.md](./22-media-upload.md) | S3 兼容媒体上传、临时参考链接、对象验证、取消恢复及链接续期 |
| [23-world-model-animation.md](./23-world-model-animation.md) | GLB 动作区间、倍速、延迟入场、循环／末帧保持与时间线动作条 |
| [24-world-camera-monitor.md](./24-world-camera-monitor.md) | 双／四画面同步监看、独立机位截图、运镜采用与输出状态恢复 |
| [25-world-frame-export.md](./25-world-frame-export.md) | 固定时间逐帧 MP4、原生编码核对、取消清理与仅重试编码 |
| [26-release-e2e.md](./26-release-e2e.md) | 发布版从剧本到成片、原生导出、画布回流和退出重开的端到端验证 |

## 当前状态

旧 Phase 文档保留最初的阶段设计，不作为当前功能完成清单。
现有系统已具备角色与场景参考、逐镜生产／审核、多模型路由、时间线与 FFmpeg 合成。
本次增加视频创作首页、图像／视频工作台、无限画布、世界引擎、电商制作、素材、任务、创作方法及模型／Eagle 页面。
进一步补充音视频参考、图片编辑、素材管理与 MP4 副本，以及世界多机位预演和构图批量回流分镜。
图像编辑增加画笔蒙版、原生 WebUI 重绘、局部合成和不重复请求模型的本地恢复。
本地音视频可通过 S3 兼容存储上传为模型参考，支持临时链接续期和上传恢复。
世界中的 GLB 动作支持片段起止、倍速、延迟入场、循环或末帧保持，与预演及导出同步。
世界引擎支持双／四画面同步监看、单机位参考图与机位曲线采用。
桌面世界引擎增加逐帧 MP4，支持 1280／1920 长边、固定帧率、取消清理和编码失败后复用帧重试。
真实模型画质、云端服务与高级功能差异以 15–25 号文档为准。

## 入口

主要入口：

1. **视频工坊**：进入新创作空间，按制作目标选择项目、画布、世界或单项工作台。
2. **从小说改编**：小说内生成视频入口，或短剧项目中的小说选择入口，共用原有制作链。
3. **新建视频**：标题栏“+”→ 视频工坊，直接打开新项目表单。

既有项目生产仍使用 `VideoPipeline`／`VideoGeneratorModal`；自由创作、画布和电商复用同一套 Provider 路由与素材服务。

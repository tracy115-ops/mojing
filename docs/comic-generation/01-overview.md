# 01. 漫画工坊 Overview

## 功能愿景

把「文本/小说 → 一致角色的分镜漫画」流程做成一键任务,在 MoJing 里和小说引擎、视频工坊形成完整创作闭环。

```
小说引擎  ─┐
           ├─→  漫画工坊  ─→  分镜图集 / PDF / 长图
直接输入  ─┘
```

## 三种输入模式(对齐视频工坊)

| 模式 | 输入 | 流程 | 适用 |
|---|---|---|---|
| **Direct pure** | 用户直接输入主题 + 角色 prompt | 角色 → 分镜 prompt → 每镜出图 | 速写、单页测试、无项目库 |
| **Direct extract** | 用户粘贴一段文本(小说片段/剧本) | LLM 提取角色+场景 → 分镜 → 出图 | 临时使用、外部素材 |
| **Novel pipeline** | 从小说项目导入某卷/某章 | 复用小说已有角色+章节内容 | 长篇连载、剧情连续性 |

UI 入口对齐 `DirectVideoModal`:三模式 radio 切换,pipeline 按 `sourceMode` 路由。

## 设计原则

1. **能复用就别造**:角色锚定、provider 路由、asset-store、单步重跑 — 全部从视频工坊搬过来
2. **静态优先**:漫画是图片,没有 TTS/I2V/audio_merge 这些时序环节,pipeline 短
3. **可微调**:每镜 prompt / seed / style 都能改后单步重跑(平行复用 stage-handlers 架构)
4. **风格可配**:日漫/美漫/水墨/像素 — 用 prompt 关键词控制,不引入新 provider

## Pipeline 步骤(对比视频的 14 步,漫画 6 步)

| # | Stage | 必须? | 说明 |
|---|---|---|---|
| 1 | `character_anchor` | 否(可选) | 角色锚定立绘,保证多分镜一致性 |
| 2 | `panel_script` | 是 | LLM 把主题/小说内容拆成 N 个分镜(画面描述+对话+构图) |
| 3 | `panel_image` | 是 | 每镜出图(I2I,带角色 reference) |
| 4 | `page_compose`(可选) | 否 | 多镜拼成单页(网格/条漫布局) |
| 5 | `dialogue_burn`(可选) | 否 | 对话气泡烧入画面 |
| 6 | `export`(可选) | 否 | 导出 PDF / 长图 / 单图压缩包 |

**最小流水线**:`panel_script → panel_image`(2 步),其余可选。

## Phase 路线图

### Phase 1 MVP(1-2 天)
- 类型层 + ComicStore 扩展(ComicPipelineState / stage 状态)
- Direct pure 模式:用户输入主题 + 角色 → 一键生成 4-6 镜
- 一镜一图布局(不做 page_compose)
- ComicPipelinePanel 侧栏 + stage 详情(对齐 VideoPipelinePanel)
- 单步重跑能力(直接复用 stage-handlers 模式)

### Phase 2(2-3 天)
- Direct extract 模式:粘贴文本 → LLM 抽取
- Novel pipeline 模式:从小说项目导入,角色/场景自动复用
- 一页多镜布局:网格 / 漫画条 / 自由(用 Canvas 拼)
- 对话气泡 Canvas 烧录

### Phase 3(可选,1-2 天)
- 跨页角色一致性(用第 1 页的立绘做第 N 页 reference)
- 漫画风格预设库(日漫/美漫/水墨 — prompt 模板)
- 导出 PDF / 长图 / ZIP

## 不做的事(明确边界)

- ❌ 不做手绘板 / 笔刷 / 矢量编辑(这是 Procreate / Krita 的领域)
- ❌ 不做漫画字体设计 / 排版引擎
- ❌ 不做视频/动画(已有视频工坊)
- ❌ 不做 LoRA 训练(周期太长,reference image 已够用)

## 与小说引擎的联动(Phase 2 重点)

视频工坊已有 `NovelView → 生成视频` 入口。漫画同理:

```
NovelView 工具栏  →  "生成漫画"  →  选章节范围  →  ComicPipeline 跑
```

关键复用:
- 小说项目的 `characters[]`、`volumes[].chapters[]` 直接读
- 角色 `appearance` / `personality` 字段映射到 `ComicCharacter`
- 章节 `content` 喂给 LLM 做 panel_script

详细映射见 [07-novel-integration.md](./07-novel-integration.md)。

## 关键决策点

下面 5 个决策需要在 Phase 1 启动前对齐,每项都有专文:

| 决策 | 推荐 | 文档 |
|---|---|---|
| 分镜粒度:一镜一图 vs 一页多镜 | MVP 一镜一图,Phase 2 多镜 | [05-panel-layout.md](./05-panel-layout.md) |
| 角色一致性策略:reference vs LoRA | reference image(对齐 video) | [04-character-consistency.md](./04-character-consistency.md) |
| Provider 路由:复用 vs 专用 | 复用 router + imageTier | [02-architecture.md](./02-architecture.md) |
| 对白烧录:前端 Canvas vs 后端 | Canvas(可预览可编辑) | [06-dialogue-burn.md](./06-dialogue-burn.md) |
| 章节选择:整卷 vs 单章 | 单章多选 | [07-novel-integration.md](./07-novel-integration.md) |

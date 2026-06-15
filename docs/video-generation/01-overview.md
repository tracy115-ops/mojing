# 01 — 功能愿景与路线图

## 愿景

**让用户把小说章节一键转成电影级短视频。**

零剪辑、零调参、零写 prompt。用户只需要：
1. 选小说项目
2. 勾选章节
3. 点"开始生成"

10-30 分钟后拿到一段带配音、字幕、转场的成片。

## 核心价值

| 维度 | 现状（手动） | 我们的目标 |
|------|--------------|-----------|
| 时间 | 几小时—几天 | 30 分钟 |
| 门槛 | 需懂 prompt 工程、剪辑、配音 | 零 |
| 一致性 | 角色画面每帧都变 | 同一小说同一角色形象统一 |
| 成本 | 反复试错烧 token | 按 tier 选模型，自动优化 |

## 四阶段路线图

### Phase 1 — MVP（1-2 周）✅ 已完成

- 章节切片 + 分镜 prompt（LLM 批处理）
- Kling T2V 接入（复用现有 adapter）
- 简单 T2V（跳过分镜图，先看效果）
- 字幕硬编码 + FFmpeg 拼接
- **目标**：能跑通一个简陋的视频

### Phase 2 — 真实感提升（2-3 周）⏳ 待实施

- 角色锚定图（FLUX.2 / Seedream 4.0 多参考图）
- 分镜图检查点（人工 review）
- I2V 生成（替代 T2V，画面稳定性 ↑）
- 多 Provider 路由（Kling / Seedance / Veo 按 tier 切换）
- **目标**：第一镜头就能让人想看下去

### Phase 3 — UX 打磨（2 周）⏳ 待实施

- 分镜编辑台（用户改 prompt 后单镜头重生成）
- 配音（Edge TTS / MiniMax）
- 字幕样式（多种预设）
- 失败重试与单个 shot 回滚
- **目标**：用户能微调成自己满意的样子

### Phase 4 — 高级（可选）

- BGM 自动配（基于 mood 匹配音乐库）
- 转场特效（淡入淡出、缩放、转场 sound）
- 多段长视频（>1 分钟，多 chapter 合并）
- 字幕翻译（多语言）
- **目标**：接近专业短视频工具

## 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Provider 抽象 | 复用 `src/services/providers` | 已有完整 BaseLLMProvider/BaseImageProvider/BaseVideoProvider，不重复造轮子 |
| 视频状态管理 | Zustand 单独 store（不入库） | 视频是临时产物，重生成即可 |
| FFmpeg 集成 | `ffmpeg-sidecar` Rust crate | 自动管理二进制，用户无需手动安装 |
| 合成策略 | Phase 1 concat demuxer copy | 假设所有 clip 同 codec，最快 |
| LLM 任务路由 | `taskType: 'translation'` 用于分镜 | 分镜本质是文本改写，temperature 0.6 |

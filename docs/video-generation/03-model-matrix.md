# 03 — 模型矩阵与档位策略

## 设计原则

不是所有镜头都需要最贵的模型。我们按"性价比"分四档，让用户自己选偏好：

| Tier | 定位 | 适用 |
|------|------|------|
| `free` | 免费或近免费 | 测试、草稿、抖音短剧 |
| `value` | 性价比之选 | 默认推荐，日产量大 |
| `quality` | 高质量 | 商业项目、付费短剧 |
| `premium` | 旗舰 | 关键镜头、广告片 |

## T2I（文生图）— Phase 2 用

| Tier | 模型 | 厂商 | 特点 | 一致性 |
|------|------|------|------|--------|
| free | SDXL 1.0 | Stability | 开源、本地可跑 | 弱 |
| free | 小云雀 (Seedream Lite) | 字节 | 中文 prompt 强 | 弱 |
| value | FLUX.1 dev | Black Forest | 质量好、开源 | 中（需 LoRA） |
| value | Seedream 4.0 | 字节 | 中文场景强 | 中 |
| quality | FLUX.2 | Black Forest | **多参考图**（角色一致） | **强** |
| quality | Seedream 4.0 Pro | 字节 | 多参考图 | 强 |
| premium | Midjourney v7 | MJ | 美学天花板 | 中（需 cref） |
| premium | GPT-Image-1 | OpenAI | 文字渲染强 | 中 |

**Phase 2 推荐**：FLUX.2 + 多参考图（实现角色一致性，见 [06-character-consistency.md](./06-character-consistency.md)）

## T2V / I2V（文生视频 / 图生视频）

| Tier | 模型 | 厂商 | 时长 | 音频 | 特点 |
|------|------|------|------|------|------|
| free | 小云雀 T2V | 字节 | 5s | ❌ | 中文场景好、有免费额度 |
| free | Kling Std | 快手 | 5s | ❌ | 国内可用、稳定 |
| value | Kling Pro 1.6 | 快手 | 5/10s | ❌ | 动作流畅 |
| value | Vidu 1.5 | 生数 | 4/8s | ❌ | 中文 prompt 强 |
| value | Seedance 2.0 Pro | 字节 | 5/10s | ✅ | **原生音频**（拟音） |
| quality | Veo 3.1 | Google | 8s | ✅ | 顶级音频、画面 |
| quality | Runway Gen-4.5 | Runway | 10s | ❌ | 运镜专业 |
| premium | Sora 2 | OpenAI | 10s | ✅ | 顶级综合 |
| premium | Veo 3.1 Fast | Google | 8s | ✅ | 速度更快 |

**Phase 1 默认**：Kling Pro（已有 adapter，国内可用）
**Phase 2 推荐**：Seedance 2.0 Pro（原生音频省 TTS 成本）+ Veo 3.1（关键镜头）

## TTS（配音）

| Tier | 模型 | 厂商 | 中文质量 | 情感 |
|------|------|------|----------|------|
| free | Edge TTS | 微软 | 优秀 | 中 |
| free | 阿里云 Lite | 阿里 | 优秀 | 中 |
| value | 火山引擎标准 | 字节 | 优秀 | 强 |
| value | MiniMax speech-01 | MiniMax | 优秀 | 强 |
| quality | 火山引擎 2.0 | 字节 | 顶级 | 强 |
| quality | MiniMax speech-02-hd | MiniMax | 顶级 | 强 |
| premium | ElevenLabs Multilingual v2 | 11Labs | 中 | 顶级 |

**Phase 3 推荐**：默认 Edge TTS（免费 + 优秀），关键作品升级 MiniMax speech-02-hd

## 自动档位选择策略

代码位置：`src/services/video/pipeline.ts` 的 `tierToDefaultModel()`

```ts
function tierToDefaultModel(tier: VideoSpec['videoTier']): string {
  switch (tier) {
    case 'free':     return 'kling-v2';        // Kling 标准版
    case 'value':    return 'kling-v2';
    case 'quality':  return 'kling-v2-pro';
    case 'premium':  return 'kling-v2-pro';    // Phase 2 接 Veo/Sora
    default:         return 'kling-v2';
  }
}
```

**Phase 2 改造方向**：
```ts
case 'quality':  return 'seedance-2-pro';  // 原生音频
case 'premium':  return 'veo-3.1';         // 顶级画面 + 音频
```

## 智能降级（Phase 3）

当一个 tier 的 Provider 失败或不可达时，自动降级：

```
premium → quality → value → free → abort
```

实现位置（待 Phase 3）：`pipeline.ts` 的 `videoWorker()` 捕获异常后重试，写入降级日志。

## 价格估算（参考，2026-06）

按一章小说生成 1 分钟视频（约 12 个 5s 镜头）：

| Tier | T2V 成本 | TTS 成本 | 合成 | 总计 |
|------|---------|---------|------|------|
| free | 0（免费额度） | 0 | 0 | ~0 元 |
| value | 12 × 0.5 = 6 元 | 0 | 0 | ~6 元 |
| quality | 12 × 2 = 24 元 | 1 元 | 0 | ~25 元 |
| premium | 12 × 5 = 60 元 | 5 元 | 0 | ~65 元 |

价格仅供参考，实际看厂商计费策略。

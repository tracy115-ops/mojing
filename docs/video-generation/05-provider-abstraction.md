# 05 — Provider 抽象层（复用现有实现）

## 关键决策：不重新发明

**Phase 1 计划阶段**曾提议新建 ImageProvider / VideoProvider / TTSProvider 接口。

**调研后发现**：`src/services/providers/` 已经有完整抽象，**直接复用，零重复造轮子**。

## 现有抽象

### 基类

文件：`src/services/providers/base.ts`

```ts
abstract class BaseLLMProvider {
  abstract generate(req: LLMGenerateRequest): Promise<LLMGenerateResponse>;
  abstract *stream(req): AsyncIterable<LLMStreamChunk>;
}

abstract class BaseImageProvider {
  abstract generate(req: ImageGenerateRequest): Promise<ImageGenerateResponse>;
}

abstract class BaseVideoProvider {
  abstract generate(req: VideoGenerateRequest): Promise<VideoGenerateResponse>;
  abstract checkStatus(taskId): Promise<{ status; progress; result? }>;
}
```

### 路由器

文件：`src/services/providers/router.ts`

```ts
class ProviderRouter {
  async generate(req: LLMGenerateRequest): Promise<LLMGenerateResponse>;
  async generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResponse>;
  async generateVideo(req: VideoGenerateRequest): Promise<VideoGenerateResponse>;
}
export const providerRouter = new ProviderRouter();
```

路由器职责：
- 从 `providerStore` 读 active endpoint
- 按 `config.primary` / `config.fallback` 路由
- 按 `req.taskType` 选模型（`config.models[taskType]`）

### 已实现的 Video Adapter

文件：`src/services/providers/video-adapters.ts`

| Adapter | Provider ID | 特点 |
|---------|------------|------|
| `KlingVideoProvider` | `kling` | 异步任务 + 轮询，5s 间隔，最长 10 分钟 |
| `RunwayProvider` | `runway` | Gen-4 Turbo，轮询 |
| `ViduProvider` | `vidu` | 中文 prompt 强 |

### 类型系统

文件：`src/types/providers.ts`

```ts
interface VideoGenerateRequest {
  taskType: 'clip' | '...';
  prompt: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fps?: number;
  referenceImages?: string[];   // ← I2V 关键
  audioPrompt?: string;          // ← Phase 2 原生音频
  seed?: number;
}

interface VideoGenerateResponse {
  videoData: string;             // URL 或 base64
  width: number;
  height: number;
  durationSeconds: number;
  model: string;
  provider: VideoProviderId;
  latencyMs: number;
}
```

## Pipeline 如何调用

`src/services/video/pipeline.ts` 的 `generateOneClip()`：

```ts
private async generateOneClip(shot: StoryboardShot, spec: VideoSpec): Promise<GeneratedClip> {
  const [w, h] = parseResolution(spec.resolution);
  const response = await providerRouter.generateVideo({
    taskType: 'clip',
    prompt: shot.videoPrompt,
    model: tierToDefaultModel(spec.videoTier),
    width: w,
    height: h,
    durationSeconds: shot.durationSeconds,
    fps: spec.fps,
  });

  return {
    shotId: shot.id,
    videoUrl: response.videoData,
    durationSeconds: response.durationSeconds || shot.durationSeconds,
    provider: response.provider,
    model: response.model,
    hasAudio: false,  // Phase 2 加原生音频检测
    generatedAt: new Date().toISOString(),
  };
}
```

## 用户配置入口

视频 Provider 在 Settings → Providers 配置：
- `providerStore.endpoints` 存所有 endpoint
- `providerStore.config.video.primary` / `fallback` / `models` 配置路由

`VideoGeneratorModal` 启动前检查：

```ts
const videoEndpoints = useProviderStore((s) => s.endpoints.filter((e) => e.enabled));
const hasVideoProvider = videoEndpoints.length > 0;

// 没有 Provider 时禁用启动按钮 + 显示警告
```

## Phase 2 扩展计划

### 新增 Seedance adapter

```ts
// src/services/providers/video-adapters.ts

export class SeedanceProvider extends BaseVideoProvider {
  readonly providerId = 'seedance';

  async generate(req: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    // 字节豆包视频 API
    // POST /api/v3/content/generation
    // 支持 native audio
  }
}
```

加到 `createVideoProvider()` factory 和 `VideoProviderId` 类型。

### 新增 FLUX.2 adapter

```ts
export class FluxProvider extends BaseImageProvider {
  readonly providerId = 'flux';

  async generate(req: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    // 多参考图：req.referenceImages[]
    // 返回图像 URL + seed（用于复现）
  }
}
```

用于 Phase 2 角色锚定图（见 [06-character-consistency.md](./06-character-consistency.md)）。

### 新增 Edge TTS adapter

```ts
// Phase 3
export class EdgeTTSProvider {
  async synthesize(text: string, voice: string): Promise<ArrayBuffer> {
    // Microsoft Edge Read Aloud API（免费）
  }
}
```

## Provider 不可达的降级

Phase 1 实现：`providerRouter.generateVideo` 在 primary 和 fallback 都失败时抛错，pipeline 把该 shot 标记失败但不中断其他 shot。

Phase 3 改进：在 `videoWorker` 里捕获异常，按 `tier` 降级重试：

```ts
const TIERS = ['premium', 'quality', 'value', 'free'];
async function generateWithFallback(shot, currentTier) {
  const idx = TIERS.indexOf(currentTier);
  for (let i = idx; i < TIERS.length; i++) {
    try {
      return await generateOneClip(shot, TIERS[i]);
    } catch (e) {
      console.warn(`Tier ${TIERS[i]} failed, falling back...`);
    }
  }
  throw new Error('All tiers failed');
}
```

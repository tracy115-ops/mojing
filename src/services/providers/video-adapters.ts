import type {
  VideoGenerateRequest,
  VideoGenerateResponse,
  ApiEndpoint,
} from '@/types/providers';
import { BaseVideoProvider } from './base';
import { fetch as httpFetch } from './fetch-proxy';

// --- Kling Video Adapter ---
//
// Kling 官方文档路径(https://doc.shuyanai.com/doc-9001142):
//   文生视频:POST {baseUrl}/kling/v1/videos/text2video
//   图生视频:POST {baseUrl}/kling/v1/videos/image2video
//   查询任务:GET  {baseUrl}/kling/v1/videos/text2video/{id}
//                 或 /kling/v1/videos/image2video/{id}
//
// 之前误用了 OpenAI-style 的 /v1/videos/generations,在官方 base URL 上返回 404。
// 用户如果走第三方代理站,可能仍需要旧路径 — 在 baseUrl 里若已带 /kling 或路径
// 不规范,我们尽量兼容。但默认按官方走。

export class KlingVideoProvider extends BaseVideoProvider {
  readonly providerId = 'kling';

  /** 本次提交用的路径(text2video 或 image2video),checkStatus 需要同前缀 */
  private lastSubmitPath: 'text2video' | 'image2video' = 'text2video';

  /** 计算 base URL,统一去掉尾部斜杠,自动补 /kling 前缀(若用户没填) */
  private klingBase(): string {
    const raw = this.endpoint.baseUrl.replace(/\/+$/, '');
    // 用户填 `https://api-beijing.klingai.com` → 补成 `.../kling`
    // 用户填 `https://api-beijing.klingai.com/kling` → 保持
    if (/\/kling$/.test(raw)) return raw;
    return `${raw}/kling`;
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const [width, height] = (request.width && request.height)
      ? [request.width, request.height]
      : [1920, 1080];

    const isI2V = !!request.referenceImages?.length;
    this.lastSubmitPath = isI2V ? 'image2video' : 'text2video';

    const body: Record<string, unknown> = {
      model: request.model || 'kling-v2',
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      cfg_scale: 0.5,
      // mode/duration:Kling 仅支持 5s / 10s,std / pro 模式
      mode: request.durationSeconds && request.durationSeconds > 5 ? 'pro' : 'std',
      duration: request.durationSeconds && request.durationSeconds > 5 ? '10' : '5',
      aspect_ratio: `${width}:${height}`,
    };

    if (isI2V) {
      // image2video 用 image 字段
      body.image = request.referenceImages![0];
    }

    const submitUrl = `${this.klingBase()}/v1/videos/${this.lastSubmitPath}`;
    const submitResponse = await httpFetch(submitUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResponse.ok) {
      const text = await submitResponse.text().catch(() => '');
      throw new Error(`Kling API error ${submitResponse.status}: ${text}`);
    }

    const submitData = await submitResponse.json();
    const taskId = submitData.data?.task_id;

    if (!taskId) {
      throw new Error('Kling API: no task_id returned');
    }

    // Poll for completion
    return this.pollUntilComplete(taskId, startTime);
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse }> {
    const statusUrl = `${this.klingBase()}/v1/videos/${this.lastSubmitPath}/${taskId}`;
    const response = await httpFetch(statusUrl, {
      method: 'GET',
      headers: this.getHeaders(),
      signal: this.timeoutSignal(30_000),
    });

    if (!response.ok) {
      throw new Error(`Kling status check error ${response.status}`);
    }

    const data = await response.json();
    const taskStatus = data.data?.task_status;

    if (taskStatus === 'succeed') {
      const video = data.data?.task_result?.videos?.[0];
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: video?.url ?? '',
          width: 1920,
          height: 1080,
          durationSeconds: 5,
          model: 'kling-v2',
          provider: 'kling',
          latencyMs: 0,
        },
      };
    }

    if (taskStatus === 'failed') {
      return { status: 'failed', progress: 0 };
    }

    return {
      status: 'processing',
      progress: taskStatus === 'processing' ? 0.5 : 0,
    };
  }

  private async pollUntilComplete(taskId: string, startTime: number): Promise<VideoGenerateResponse> {
    const maxPolls = 120; // 10 minutes max at 5s interval
    const maxConsecutiveErrors = 3;
    let consecutiveErrors = 0;
    let lastPollError: Error | null = null;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const status = await this.checkStatus(taskId);
        consecutiveErrors = 0;
        if (status.status === 'completed' && status.result) {
          return { ...status.result, latencyMs: Date.now() - startTime };
        }
        if (status.status === 'failed') {
          throw new Error('Kling video generation failed');
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('generation failed')) {
          throw err;
        }
        consecutiveErrors++;
        lastPollError = err instanceof Error ? err : new Error(String(err));
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `Kling polling failed after ${consecutiveErrors} consecutive errors: ${lastPollError.message}`,
          );
        }
      }
    }
    throw new Error('Kling video generation timed out');
  }
}

// --- Runway Adapter ---

export class RunwayProvider extends BaseVideoProvider {
  readonly providerId = 'runway';

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: request.model || 'gen4_turbo',
      promptText: request.prompt,
      duration: request.durationSeconds ?? 5,
      ratio: '16:9',
    };

    if (request.referenceImages?.length) {
      body.promptImage = request.referenceImages[0];
    }

    const response = await httpFetch(`${this.endpoint.baseUrl}/v1/image_to_video`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Runway API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const taskId = data.id;

    // Poll for completion
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusResp = await httpFetch(`${this.endpoint.baseUrl}/v1/tasks/${taskId}`, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      const statusData = await statusResp.json();

      if (statusData.status === 'SUCCEEDED') {
        return {
          videoData: statusData.output?.[0] ?? '',
          width: 1920,
          height: 1080,
          durationSeconds: request.durationSeconds ?? 5,
          model: request.model || 'gen4_turbo',
          provider: 'runway',
          latencyMs: Date.now() - startTime,
        };
      }
      if (statusData.status === 'FAILED') {
        throw new Error('Runway generation failed');
      }
    }

    throw new Error('Runway generation timed out');
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse }> {
    const response = await httpFetch(`${this.endpoint.baseUrl}/v1/tasks/${taskId}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    const data = await response.json();

    if (data.status === 'SUCCEEDED') {
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: data.output?.[0] ?? '',
          width: 1920,
          height: 1080,
          durationSeconds: 5,
          model: 'gen4_turbo',
          provider: 'runway',
          latencyMs: 0,
        },
      };
    }
    if (data.status === 'FAILED') return { status: 'failed', progress: 0 };
    return { status: 'processing', progress: data.progress ?? 0.5 };
  }
}

// --- Vidu Adapter ---

export class ViduProvider extends BaseVideoProvider {
  readonly providerId = 'vidu';

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: request.model || 'vidu-1.5',
      prompt: request.prompt,
      duration: request.durationSeconds ?? 4,
      resolution: '1080p',
      aspect_ratio: '16:9',
    };

    if (request.referenceImages?.length) {
      body.image = request.referenceImages[0];
      body.img_boost = true;
    }

    const response = await httpFetch(`${this.endpoint.baseUrl}/v1/video/generate`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!response.ok) {
      throw new Error(`Vidu API error ${response.status}`);
    }

    const data = await response.json();
    const taskId = data.data?.task_id;

    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const result = await this.checkStatus(taskId);
      if (result.status === 'completed' && result.result) {
        return { ...result.result, latencyMs: Date.now() - startTime };
      }
      if (result.status === 'failed') throw new Error('Vidu generation failed');
    }

    throw new Error('Vidu generation timed out');
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse }> {
    const response = await httpFetch(`${this.endpoint.baseUrl}/v1/video/status/${taskId}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    const data = await response.json();
    const state = data.data?.state;

    if (state === 'success') {
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: data.data?.video_url ?? '',
          width: 1920,
          height: 1080,
          durationSeconds: 4,
          model: 'vidu-1.5',
          provider: 'vidu',
          latencyMs: 0,
        },
      };
    }
    if (state === 'failed') return { status: 'failed', progress: 0 };
    return { status: 'processing', progress: data.data?.progress ?? 0.3 };
  }
}

// --- Agnes Video API (Sapiens AI) ---
// 文档: https://agnes-ai.com/doc/agnes-video-v20
// POST {baseUrl}/v1/videos/generations  (baseUrl 通常为 https://apihub.agnes-ai.com)
// 文生视频: model, prompt 必填
// 图生视频: 增加 image (URL 或 data URI)
// 异步任务:响应里拿 task_id 或 video_id,轮询 GET {baseUrl}/v1/videos/{id}
// 完成态:返回 video_url

export class AgnesVideoProvider extends BaseVideoProvider {
  readonly providerId = 'agnes-video';

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const model = request.model || 'agnes-video-v2.0';

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const submitUrl = /\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/videos/generations`
      : `${baseUrl}/v1/videos/generations`;

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
    };

    if (request.durationSeconds) {
      body.duration = `${request.durationSeconds}s`;
    }

    if (request.referenceImages?.length) {
      body.image = request.referenceImages[0];
    }

    const submitResp = await httpFetch(submitUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      throw new Error(`Agnes Video API error ${submitResp.status}: ${text}`);
    }

    const submitData = await submitResp.json();
    // 文档里 task_id / video_id / id 三种字段都可能返回,优先取 video_id(推荐查询键)
    const taskId =
      submitData.video_id ?? submitData.task_id ?? submitData.id ?? submitData.data?.video_id;
    if (!taskId) {
      throw new Error('Agnes Video: no task_id returned');
    }

    // 轮询
    return this.pollUntilComplete(taskId, startTime);
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse }> {
    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const statusUrl = /\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/videos/${taskId}`
      : `${baseUrl}/v1/videos/${taskId}`;

    const resp = await httpFetch(statusUrl, {
      method: 'GET',
      headers: this.getHeaders(),
      signal: this.timeoutSignal(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Agnes Video status error ${resp.status}`);
    }

    const data = await resp.json();
    // 兼容字段:state / status / task_status
    const state = (data.state ?? data.status ?? data.task_status ?? '').toLowerCase();

    if (state === 'success' || state === 'succeeded' || state === 'completed') {
      const videoUrl = data.video_url ?? data.output?.video_url ?? data.data?.video_url ?? '';
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: videoUrl,
          width: 1920,
          height: 1080,
          durationSeconds: 5,
          model: 'agnes-video-v2.0',
          provider: 'agnes-video',
          latencyMs: 0,
        },
      };
    }

    if (state === 'failed' || state === 'error') {
      return { status: 'failed', progress: 0 };
    }

    return { status: 'processing', progress: typeof data.progress === 'number' ? data.progress : 0.3 };
  }

  private async pollUntilComplete(taskId: string, startTime: number): Promise<VideoGenerateResponse> {
    const maxPolls = 120; // 10 分钟 (5s × 120)
    const maxConsecutiveErrors = 3; // 连续 3 次轮询失败才放弃
    let consecutiveErrors = 0;
    let lastPollError: Error | null = null;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 5000));

      try {
        const status = await this.checkStatus(taskId);
        consecutiveErrors = 0; // 成功一次就清零

        if (status.status === 'completed' && status.result) {
          return { ...status.result, latencyMs: Date.now() - startTime };
        }
        if (status.status === 'failed') {
          throw new Error('Agnes Video generation failed');
        }
      } catch (err) {
        // 如果是 "generation failed" 这种明确的失败状态,直接冒泡
        if (err instanceof Error && err.message.includes('generation failed')) {
          throw err;
        }
        // 否则视为轮询错误(网络抖动 / 临时 5xx),记录后继续
        consecutiveErrors++;
        lastPollError = err instanceof Error ? err : new Error(String(err));
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `Agnes Video polling failed after ${consecutiveErrors} consecutive errors: ${lastPollError.message}`,
          );
        }
      }
    }
    throw new Error('Agnes Video generation timed out');
  }
}

// --- Factory ---

export function createVideoProvider(
  providerId: string,
  endpoint: ApiEndpoint,
): BaseVideoProvider {
  switch (providerId) {
    case 'kling':
      return new KlingVideoProvider(endpoint);
    case 'runway':
      return new RunwayProvider(endpoint);
    case 'vidu':
      return new ViduProvider(endpoint);
    case 'agnes-video':
      return new AgnesVideoProvider(endpoint);
    default:
      // Default to Kling-compatible API
      return new KlingVideoProvider(endpoint);
  }
}

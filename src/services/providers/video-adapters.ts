import type {
  VideoGenerateRequest,
  VideoGenerateResponse,
  ApiEndpoint,
} from '@/types/providers';
import { BaseVideoProvider } from './base';

// --- Kling Video Adapter ---

export class KlingVideoProvider extends BaseVideoProvider {
  readonly providerId = 'kling';

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const [width, height] = (request.width && request.height)
      ? [request.width, request.height]
      : [1920, 1080];

    const body: Record<string, unknown> = {
      model: request.model || 'kling-v2',
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      cfg_scale: 0.5,
      mode: request.durationSeconds && request.durationSeconds > 5 ? 'pro' : 'std',
      duration: request.durationSeconds ? `${request.durationSeconds}s` : '5s',
      aspect_ratio: `${width}:${height}`,
    };

    if (request.referenceImages?.length) {
      body.image = request.referenceImages[0];
    }

    // Kling uses async generation — submit task first
    const submitResponse = await fetch(`${this.endpoint.baseUrl}/v1/videos/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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
    const response = await fetch(
      `${this.endpoint.baseUrl}/v1/videos/generations/${taskId}`,
      {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(30_000),
      },
    );

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
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const status = await this.checkStatus(taskId);
      if (status.status === 'completed' && status.result) {
        return { ...status.result, latencyMs: Date.now() - startTime };
      }
      if (status.status === 'failed') {
        throw new Error('Kling video generation failed');
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

    const response = await fetch(`${this.endpoint.baseUrl}/v1/image_to_video`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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
      const statusResp = await fetch(`${this.endpoint.baseUrl}/v1/tasks/${taskId}`, {
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
    const response = await fetch(`${this.endpoint.baseUrl}/v1/tasks/${taskId}`, {
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

    const response = await fetch(`${this.endpoint.baseUrl}/v1/video/generate`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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
    const response = await fetch(`${this.endpoint.baseUrl}/v1/video/status/${taskId}`, {
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
    default:
      // Default to Kling-compatible API
      return new KlingVideoProvider(endpoint);
  }
}

import type {
  VideoGenerateRequest,
  VideoGenerateResponse,
  VideoProviderId,
  ApiEndpoint,
} from '@/types/providers';
import { BaseVideoProvider } from './base.ts';
import { fetch as httpFetch } from './fetch-proxy.ts';
import { applyUnconsumedGenerationParameters } from './parameter-transport.ts';
import { getVideoGenerationCapabilities } from './provider-capabilities.ts';
import { validateVideoMediaReferences } from './video-media-contract.ts';

function videoControlModeForRequest(request: VideoGenerateRequest): 'text' | 'reference' | 'keyframe' {
  return request.controlMode ?? (request.firstFrame || request.lastFrame ? 'keyframe'
    : request.subjectReferences?.length || request.audioReferences?.length || request.videoReferences?.length ? 'reference'
    : request.referenceImages?.length ? 'keyframe' : 'text');
}

/**
 * 把 data URI 形式的图片字符串剥成纯 base64。
 *  - 输入 `data:image/png;base64,xxxx` → 返回 `xxxx`(纯 base64)
 *  - 输入纯 base64(没有前缀) → 原样返回
 *  - 输入 http(s):// / tauri:// / 文件路径 → 返回 null
 *    (Agnes Python 后端 b64decode 无法处理 URL,调用方必须先转成 base64)
 *
 * 返回 null 时调用方应该抛清晰错误,而不是把 URL 喂给后端触发
 * 含糊的 "Incorrect padding"。
 */
function stripDataUriPrefix(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // 公网 HTTP/HTTPS URL — Agnes 后端可直接拉取
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // 本地 URL 或本地路径形式 — 必须先经 readAsDataUri 转成 data URI
  if (/^(tauri:|blob:|file:|\/|[a-zA-Z]:[\\/])/.test(trimmed)) return null;
  // data URI — 剥前缀
  const m = trimmed.match(/^data:[^;]+;base64,(.*)$/);
  if (m) return m[1].replace(/\s/g, '');
  // 已经是纯 base64 — 校验并去空格
  if (/^[A-Za-z0-9+/\s]+=*$/.test(trimmed)) return trimmed.replace(/\s/g, '');
  return null;
}

/**
 * 把用户想要的视频时长(秒)映射到 Agnes V2.0 支持的标准帧数档位。
 *
 * Agnes V2.0 通过 num_frames + frame_rate 控制时长,只接受固定档位:
 *   num_frames=81,  frame_rate=24 → ~3.4s
 *   num_frames=121, frame_rate=24 → ~5.0s
 *   num_frames=241, frame_rate=24 → ~10.0s
 *   num_frames=441, frame_rate=24 → ~18.4s
 *
 * 不在档位上的时长向下取整到最近的档位;超过 18s 的截到 441;不传默认 5s(121)。
 */
function pickAgnesFramesTier(durationSeconds?: number): { numFrames: number; frameRate: number } {
  const TIERS = [
    { numFrames: 49, frameRate: 24, seconds: 49 / 24 }, // ~2.0s (极速特写/暴击)
    { numFrames: 65, frameRate: 24, seconds: 65 / 24 }, // ~2.7s (动作打斗)
    { numFrames: 81, frameRate: 24, seconds: 81 / 24 }, // ~3.4s (短对白/神态)
    { numFrames: 97, frameRate: 24, seconds: 97 / 24 }, // ~4.0s (标准叙事)
    { numFrames: 121, frameRate: 24, seconds: 121 / 24 }, // ~5.0s (标准镜头)
    { numFrames: 145, frameRate: 24, seconds: 145 / 24 }, // ~6.0s (大场景/长台词)
    { numFrames: 169, frameRate: 24, seconds: 169 / 24 }, // ~7.0s (氛围空镜)
    { numFrames: 241, frameRate: 24, seconds: 241 / 24 }, // ~10.0s (长镜头)
    { numFrames: 441, frameRate: 24, seconds: 441 / 24 }, // ~18.4s (特长镜头)
  ];
  if (!durationSeconds || durationSeconds <= 0) return TIERS[4]; // 默认 5s

  // 匹配最接近的档位
  let closest = TIERS[0];
  let minDiff = Math.abs(TIERS[0].seconds - durationSeconds);
  for (const t of TIERS) {
    const diff = Math.abs(t.seconds - durationSeconds);
    if (diff < minDiff) {
      minDiff = diff;
      closest = t;
    }
  }
  return closest;
}

function pickStandardAspectRatio(width?: number, height?: number, explicit?: string): string {
  const supported = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
  if (explicit && supported.includes(explicit as typeof supported[number])) return explicit;
  if (!width || !height) return '16:9';

  const ratio = width / height;
  return supported.reduce((closest, candidate) => {
    const [w, h] = candidate.split(':').map(Number);
    const [closestW, closestH] = closest.split(':').map(Number);
    return Math.abs(w / h - ratio) < Math.abs(closestW / closestH - ratio) ? candidate : closest;
  }, supported[0]);
}

function dimensionsForAspect(
  aspectRatio: string | undefined,
  shortEdge: number,
): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: shortEdge, height: Math.round(shortEdge * 16 / 9) };
    case '1:1':
      return { width: shortEdge, height: shortEdge };
    case '4:3':
      return { width: Math.round(shortEdge * 4 / 3), height: shortEdge };
    case '3:4':
      return { width: shortEdge, height: Math.round(shortEdge * 4 / 3) };
    case '21:9':
      return { width: Math.round(shortEdge * 21 / 9), height: shortEdge };
    default:
      return { width: Math.round(shortEdge * 16 / 9), height: shortEdge };
  }
}

function numericDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function readVideoDimensions(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const width = numericDimension(record.width);
  const height = numericDimension(record.height);
  return width && height ? { width, height } : undefined;
}

function findVideoDimensions(data: unknown): { width: number; height: number } | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const candidates = [
    record,
    record.metadata,
    record.output,
    record.data,
    typeof record.metadata === 'object' && record.metadata ? (record.metadata as Record<string, unknown>).video : undefined,
    typeof record.output === 'object' && record.output ? (record.output as Record<string, unknown>).video : undefined,
    typeof record.data === 'object' && record.data ? (record.data as Record<string, unknown>).video : undefined,
  ];
  for (const candidate of candidates) {
    const dimensions = readVideoDimensions(candidate);
    if (dimensions) return dimensions;
  }
  return undefined;
}

/** Agnes 2.5 Flash currently exposes only the 720P output tier. */
function pickAgnesV25Size(model: string, width?: number, height?: number): '720P' | '1080P' {
  if (/flash/i.test(model)) return '720P';
  return width && height && width * height >= 1920 * 1080 ? '1080P' : '720P';
}

function agnesV25Dimensions(model: string, ratio: string, size: '720P' | '1080P') {
  // Flash uses its own published map, including the 1280x704 landscape output.
  const flash: Record<string, [number, number]> = {
    '21:9': [1680, 720], '16:9': [1280, 704], '4:3': [960, 720],
    '1:1': [720, 720], '3:4': [720, 960], '9:16': [720, 1280],
  };
  const standard: Record<string, [number, number]> = {
    '21:9': [1470, 630], '16:9': [1280, 720], '4:3': [1112, 834],
    '1:1': [960, 960], '3:4': [834, 1112], '9:16': [720, 1280],
  };
  const hd: Record<string, [number, number]> = {
    '21:9': [2206, 946], '16:9': [1920, 1080], '4:3': [1664, 1248],
    '1:1': [1440, 1440], '3:4': [1248, 1664], '9:16': [1080, 1920],
  };
  const table = /flash/i.test(model) ? flash : size === '1080P' ? hd : standard;
  const [width, height] = table[ratio] ?? table['16:9'];
  return { width, height };
}

/** Resolve only temporal frame controls. Subject references must be handled by a provider's native API. */
function resolveKeyframeImages(
  request: VideoGenerateRequest,
  providerName: string,
): { firstImage?: string; lastImage?: string } {
  if (request.controlMode === 'text') return {};
  if (request.controlMode === 'reference') {
    throw new Error(`${providerName} does not support native subject-reference video generation`);
  }

  const firstImage = request.firstFrame || request.referenceImages?.[0];
  const lastImage = request.lastFrame || request.referenceImages?.[1];
  if (request.controlMode === 'keyframe' && !firstImage) {
    throw new Error(`${providerName} keyframe mode requires firstFrame`);
  }
  return { firstImage, lastImage };
}

function bindSubjectReferencePrompt(request: VideoGenerateRequest, token: (index: number) => string): string {
  const bindings = (request.subjectReferences ?? []).filter((reference) => !!reference.image)
    .map((reference, index) => `${token(index + 1)}: ${reference.label || reference.id}; preserve this subject's identity and wardrobe.`);
  return bindings.length ? `${request.prompt}\n\n[Reference assignments]\n${bindings.join('\n')}` : request.prompt;
}

/** 递归扫描任意 JSON 响应对象，精确提取合法的 HTTP/HTTPS 视频文件 URL */
function findHttpVideoUrlInObject(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findHttpVideoUrlInObject(item);
      if (found) return found;
    }
    return null;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
      if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(val) || /video|media|output|stream/i.test(key) || /video|media|mp4/i.test(val)) {
        return val;
      }
    } else if (typeof val === 'object' && val !== null) {
      const found = findHttpVideoUrlInObject(val);
      if (found) return found;
    }
  }
  return null;
}

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
  private lastModel = 'kling-v2';
  private requestedDurationSeconds = 5;

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
    const model = request.model?.trim() || 'kling-v2';
    this.lastModel = model;
    this.requestedDurationSeconds = request.durationSeconds ?? 5;
    const [width, height] = (request.width && request.height)
      ? [request.width, request.height]
      : [1920, 1080];

    const { firstImage, lastImage: tailImage } = resolveKeyframeImages(request, 'Kling');
    const isI2V = !!firstImage;
    this.lastSubmitPath = isI2V ? 'image2video' : 'text2video';

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      cfg_scale: 0.5,
      // mode/duration:Kling 仅支持 5s / 10s,std / pro 模式
      mode: request.durationSeconds && request.durationSeconds > 5 ? 'pro' : 'std',
      duration: request.durationSeconds && request.durationSeconds > 5 ? '10' : '5',
      aspect_ratio: pickStandardAspectRatio(width, height, request.aspectRatio),
    };

    if (isI2V) {
      // 首尾帧双图控制 (First-Last Frame Continuity)
      body.image = firstImage;
      if (tailImage) {
        body.image_tail = tailImage;
      }
    }
    if (typeof request.seed === 'number' && Number.isInteger(request.seed)) {
      body.seed = request.seed;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'durationSeconds', 'aspectRatio', 'seed'],
    );

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
      // 30s 在代理转发场景下偏紧,tauri-plugin-http 会抛 "Request canceled"
      signal: this.timeoutSignal(90_000),
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
          durationSeconds: this.requestedDurationSeconds,
          model: this.lastModel,
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
  private lastModel = 'gen4_turbo';
  private requestedDurationSeconds = 5;

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const model = request.model?.trim() || 'gen4_turbo';
    this.lastModel = model;
    this.requestedDurationSeconds = request.durationSeconds ?? 5;

    const body: Record<string, unknown> = {
      model,
      promptText: request.prompt,
      duration: request.durationSeconds ?? 5,
      ratio: pickStandardAspectRatio(request.width, request.height, request.aspectRatio),
    };

    const { firstImage, lastImage } = resolveKeyframeImages(request, 'Runway');
    if (firstImage) {
      if (lastImage) {
        body.promptImage = [
          { uri: firstImage, position: 'first' },
          { uri: lastImage, position: 'last' },
        ];
      } else {
        body.promptImage = firstImage;
      }
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'durationSeconds', 'aspectRatio'],
    );

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
          model,
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
          durationSeconds: this.requestedDurationSeconds,
          model: this.lastModel,
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
  private lastModel = 'vidu-1.5';
  private requestedDurationSeconds = 4;

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const model = request.model?.trim() || 'vidu-1.5';
    this.lastModel = model;
    this.requestedDurationSeconds = request.durationSeconds ?? 4;

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      duration: request.durationSeconds ?? 4,
      resolution: '1080p',
      aspect_ratio: pickStandardAspectRatio(request.width, request.height, request.aspectRatio),
    };

    const { firstImage, lastImage } = resolveKeyframeImages(request, 'Vidu');
    if (firstImage) {
      if (lastImage) {
        body.start_image = firstImage;
        body.end_image = lastImage;
      } else {
        body.image = firstImage;
      }
      body.img_boost = true;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'durationSeconds', 'aspectRatio'],
    );

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
          durationSeconds: this.requestedDurationSeconds,
          model: this.lastModel,
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
// POST {baseUrl}/v1/videos        (baseUrl 通常为 https://apihub.agnes-ai.com)
// 文生视频: model, prompt 必填
// 图生视频: 增加 image (URL 或 data URI)
// 异步任务:响应里拿 task_id 或 video_id,轮询 GET {baseUrl}/v1/videos/{id}
// 完成态:返回 video_url

export class AgnesVideoProvider extends BaseVideoProvider {
  readonly providerId = 'agnes-video';

  /** 记住上次提交用的 model,checkStatus 时拼到 query 里(Agnes API 要求非默认模型必填) */
  private lastModel: string = 'agnes-video-2.5-flash';

  /**
   * 记住上次提交拿到的查询键 + 类型。
   * Agnes 创建任务响应同时返回 task_id(`task_xxx` 前缀)和 video_id (`video_xxx` 前缀)
   */
  private requestedDurationSeconds: number | undefined = 5;
  private requestedWidth: number | undefined;
  private requestedHeight: number | undefined;
  private requestedAspectRatio: string | undefined;
  private requestedSize: '720P' | '1080P' | undefined;
  private lastQueryKind: 'video_id' | 'task_id' = 'video_id';
  private lastQueryId: string = '';

  getWireParameterSnapshot(request: VideoGenerateRequest): Record<string, unknown> {
    const model = request.model?.trim() || 'agnes-video-2.5-flash';
    const isV25 = !/2\.0|v2\.0/i.test(model);
    const subjectImages = (request.subjectReferences ?? []).filter((reference) => !!reference.image);
    const referenceImages = (request.referenceImages ?? []).filter(Boolean);
    const controlMode = videoControlModeForRequest(request);

    if (isV25) {
      const seconds = Math.max(4, Math.min(12, Math.round(request.durationSeconds || 5)));
      const firstFrame = request.firstFrame || referenceImages[0];
      const lastFrame = request.lastFrame || referenceImages[1];
      const wire: Record<string, unknown> = {
        model,
        size: pickAgnesV25Size(model, request.width, request.height),
        aspect_ratio: pickStandardAspectRatio(request.width, request.height, request.aspectRatio),
        seconds: String(seconds),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        mode: controlMode,
        ...(controlMode === 'keyframe' && firstFrame ? { first_frame: 'provided' } : {}),
        ...(controlMode === 'keyframe' && lastFrame ? { last_frame: 'provided' } : {}),
        ...(controlMode === 'reference' ? { imagesCount: subjectImages.length || referenceImages.length } : {}),
        ...(request.audioReferences?.length ? { audiosCount: request.audioReferences.length } : {}),
        ...(request.videoReferences?.length ? { videosCount: request.videoReferences.length } : {}),
      };
      applyUnconsumedGenerationParameters(
        wire,
        request,
        ['model', 'durationSeconds', 'width', 'height', 'aspectRatio', 'seed'],
      );
      return wire;
    }

    let width = request.width || 1152;
    let height = request.height || 768;
    if (width > 0 && height > 0) {
      const aspect = width / height;
      if (Math.abs(aspect - 16 / 9) < 0.1) {
        width = 1152;
        height = 768;
      } else if (Math.abs(aspect - 9 / 16) < 0.1) {
        width = 768;
        height = 1152;
      } else if (Math.abs(aspect - 1) < 0.1) {
        width = 896;
        height = 896;
      } else {
        width = Math.round(width / 32) * 32;
        height = Math.round(height / 32) * 32;
      }
    }
    const tier = pickAgnesFramesTier(request.durationSeconds);
    const firstFrame = request.firstFrame || referenceImages[0];
    const lastFrame = request.lastFrame || referenceImages[1];
    const wire: Record<string, unknown> = {
      model,
      width,
      height,
      num_frames: tier.numFrames,
      frame_rate: tier.frameRate,
      ...(request.numInferenceSteps ? { num_inference_steps: request.numInferenceSteps } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      ...(firstFrame ? { mode: lastFrame ? 'keyframes' : (request.mode || 'ti2vid') } : request.mode ? { mode: request.mode } : {}),
      ...(firstFrame ? { imageCount: lastFrame ? 2 : 1 } : {}),
    };
    applyUnconsumedGenerationParameters(
      wire,
      request,
      ['model', 'durationSeconds', 'width', 'height', 'numInferenceSteps', 'seed', 'negativePrompt', 'mode'],
    );
    return wire;
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    let model = request.model?.trim() || 'agnes-video-2.5-flash';
    this.lastModel = model;
    this.requestedDurationSeconds = request.durationSeconds;
    this.requestedWidth = request.width;
    this.requestedHeight = request.height;
    this.requestedAspectRatio = pickStandardAspectRatio(request.width, request.height, request.aspectRatio);

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    // baseUrl 可能是 https://apihub.agnes-ai.com 或 https://apihub.agnes-ai.com/v1
    const submitUrl = /\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/videos`
      : `${baseUrl}/v1/videos`;

    const isV25 = !/2\.0|v2\.0/i.test(model);
    this.requestedSize = isV25
      ? pickAgnesV25Size(model, request.width, request.height)
      : undefined;

    validateVideoMediaReferences({ ...request, controlMode: videoControlModeForRequest(request) }, getVideoGenerationCapabilities('agnes-video', model), request.subjectReferences?.length || request.referenceImages?.length || 0);

    let body: Record<string, unknown>;

    if (isV25) {
      // ===== Agnes Video 2.5 OpenAPI 规范 =====
      const seconds = Math.max(4, Math.min(12, Math.round(request.durationSeconds || 5)));
      const aspect_ratio = pickStandardAspectRatio(request.width, request.height, request.aspectRatio);

      body = {
        model,
        prompt: request.prompt,
        size: pickAgnesV25Size(model, request.width, request.height),
        aspect_ratio,
        seconds: String(seconds),
      };

      if (typeof request.seed === 'number' && Number.isInteger(request.seed)) {
        body.seed = request.seed;
      }

      const cleanedImages = (request.referenceImages ?? []).filter(Boolean);
      const subjectImages = (request.subjectReferences ?? []).map((reference) => reference.image).filter(Boolean);
      const controlMode = videoControlModeForRequest(request);

      if (controlMode === 'keyframe') {
        const firstFrame = request.firstFrame || cleanedImages[0];
        const lastFrame = request.lastFrame || cleanedImages[1];
        if (!firstFrame) {
          throw new Error('Agnes Video 2.5 keyframe mode requires firstFrame');
        }
        if (lastFrame) {
          body.mode = 'keyframe';
          body.first_frame = firstFrame;
          body.last_frame = lastFrame;
        } else {
          body.mode = 'keyframe';
          body.first_frame = firstFrame;
        }
      } else if (controlMode === 'reference') {
        const images = subjectImages.length > 0 ? subjectImages : cleanedImages;
        if (images.length === 0 && !request.audioReferences?.length && !request.videoReferences?.length) {
          throw new Error('Agnes Video 2.5 reference mode requires images, audio or video');
        }
        const maxImages = /flash/i.test(model) ? 5 : 8;
        if (images.length > maxImages) {
          throw new Error(`Agnes Video ${model} accepts at most ${maxImages} reference images; received ${images.length}`);
        }
        body.mode = 'reference';
        if (images.length) body.images = images;
        if (request.audioReferences?.length) body.audios = request.audioReferences.map((reference) => reference.url);
        if (request.videoReferences?.length) body.videos = request.videoReferences.map((reference) => ({ url: reference.url }));
        body.prompt = bindSubjectReferencePrompt(request, (index) => `<Picture ${index}>`);
      } else {
        body.mode = 'text';
      }
    } else {
      // ===== Agnes Video 2.0 规范 =====
      body = {
        model,
        prompt: request.prompt,
      };

      // 1. 分辨率计算 (width / height): 优先适配 16:9 / 9:16 / 1:1 标准规格 (默认 1152x768)
      let w = request.width || 1152;
      let h = request.height || 768;
      if (w > 0 && h > 0) {
        const aspect = w / h;
        if (Math.abs(aspect - 16 / 9) < 0.1) {
          w = 1152;
          h = 768;
        } else if (Math.abs(aspect - 9 / 16) < 0.1) {
          w = 768;
          h = 1152;
        } else if (Math.abs(aspect - 1) < 0.1) {
          w = 896;
          h = 896;
        } else {
          w = Math.round(w / 32) * 32;
          h = Math.round(h / 32) * 32;
        }
      } else {
        w = 1152;
        h = 768;
      }
      body.width = w;
      body.height = h;

      // 2. 帧数 (num_frames) & 帧率 (frame_rate): 遵循 8n + 1 规则且 <= 441
      const tier = pickAgnesFramesTier(request.durationSeconds);
      body.num_frames = tier.numFrames;
      body.frame_rate = tier.frameRate;

      // 3. 推理步数 (num_inference_steps)
      if (request.numInferenceSteps && request.numInferenceSteps > 0) {
        body.num_inference_steps = request.numInferenceSteps;
      }

      // 4. 随机种子 (seed): 增强画面连贯性与可复现性
      if (typeof request.seed === 'number' && Number.isInteger(request.seed)) {
        body.seed = request.seed;
      }

      // 5. 反向提示词 (negative_prompt): 过滤模糊、畸变与杂质
      if (request.negativePrompt) {
        body.negative_prompt = request.negativePrompt;
      }

      // 6. Agnes 2.0 只支持时间关键帧，不支持 2.5 的主体参考模式。
      const { firstImage, lastImage } = resolveKeyframeImages(request, 'Agnes Video 2.0');
      if (firstImage) {
        const cleanedImages = (request.referenceImages ?? [])
          .map((img) => stripDataUriPrefix(img))
          .filter((img): img is string => !!img);
        const firstFrame = stripDataUriPrefix(firstImage || cleanedImages[0]);
        const lastFrame = stripDataUriPrefix(lastImage || cleanedImages[1]);

        if (firstFrame && lastFrame) {
          body.image = firstFrame;
          body.mode = 'keyframes';
          body.extra_body = {
            image: [firstFrame, lastFrame],
            mode: 'keyframes',
          };
        } else if (firstFrame) {
          body.image = firstFrame;
          body.mode = request.mode || 'ti2vid';
        }
      } else if (request.mode) {
        body.mode = request.mode;
      }
    }

    this.requestedDurationSeconds = isV25
      ? Number(body.seconds)
      : Number(body.num_frames) / Number(body.frame_rate);

    applyUnconsumedGenerationParameters(
      body,
      request,
      isV25
        // width/height and durationSeconds are normalized application inputs;
        // Agnes 2.5 has already consumed them as size/seconds above.
        ? ['model', 'durationSeconds', 'width', 'height', 'aspectRatio', 'seed']
        : ['model', 'durationSeconds', 'width', 'height', 'numInferenceSteps', 'seed', 'negativePrompt', 'mode'],
    );

    const submitResp = await httpFetch(submitUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      // Agnes video submit 在代理转发 / 高峰期可能要 2-3 分钟才回响应。
      // 之前 120s 经常触发 "Request canceled"(实测日志:每对 shot 间隔 2 分钟整,
      // 正好是 120s 超时的特征)。调到 5 分钟,给代理足够时间。
      // 上层 router.callWithTimeoutRetry 还会再重试 2 次作为兜底。
      signal: this.timeoutSignal(300_000),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      throw new Error(`Agnes Video API error ${submitResp.status}: ${text}`);
    }

    const submitData = await submitResp.json();
    // 官方文档明确:响应同时返回 task_id 和 video_id,推荐用 video_id 查询。
    // 这里优先用 video_id + 推荐接口;如果某些代理只返回 task_id,降级到兼容接口。
    const videoId = submitData.video_id ?? submitData.data?.video_id;
    const taskId = submitData.task_id ?? submitData.id;

    if (videoId) {
      this.lastQueryId = videoId;
      this.lastQueryKind = 'video_id';
    } else if (taskId) {
      this.lastQueryId = taskId;
      this.lastQueryKind = 'task_id';
    } else {
      throw new Error('Agnes Video: no task_id or video_id returned');
    }

    // 轮询
    return this.pollUntilComplete(startTime);
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse; failReason?: string }> {
    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const model = this.lastModel || 'agnes-video-v2.0';
    const modelNameParam = `model_name=${encodeURIComponent(model)}`;

    // 按 lastQueryKind 选对 endpoint。外部直接调 checkStatus(比如 UI 单独刷新)
    // 时没经过 generate,此时 taskId 参数是上次的 id,我们根据前缀猜类型:
    //   - `video_` 开头 → video_id → 走推荐接口
    //   - `task_` 开头或别的 → task_id → 走兼容接口
    const kind: 'video_id' | 'task_id' = taskId === this.lastQueryId
      ? this.lastQueryKind
      : taskId.startsWith('video_') ? 'video_id' : 'task_id';

    let statusUrl: string;
    if (kind === 'video_id') {
      // 推荐:GET /agnesapi?video_id=<VIDEO_ID>&model_name=<MODEL>
      // 注意:这个路径不带 /v1 前缀,直接挂在根域名下。
      const rootBase = baseUrl.replace(/\/v\d+$/, '');
      statusUrl = `${rootBase}/agnesapi?video_id=${encodeURIComponent(taskId)}&${modelNameParam}`;
    } else {
      // 兼容:GET /v1/videos/<TASK_ID>?model_name=<MODEL>(query 参数对旧接口可选)
      const pathBase = /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
      statusUrl = `${pathBase}/videos/${encodeURIComponent(taskId)}?${modelNameParam}`;
    }

    const resp = await httpFetch(statusUrl, {
      method: 'GET',
      headers: this.getHeaders(),
      // ⚠️ 之前是 30_000(30s),但 tauri-plugin-http 把 AbortSignal.timeout
      // 到期统一抛 "Request canceled"(不像浏览器抛 TimeoutError)。
      // Agnes 代理转发有时慢,30s 不够,改成 90s。
      signal: this.timeoutSignal(90_000),
    });

    if (!resp.ok) {
      // 之前没读 body,导致 400 的真实原因看不到。这里把响应文本拼进错误消息。
      const text = await resp.text().catch(() => '');
      throw new Error(`Agnes Video status error ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    // 兼容字段:state / status / task_status
    const state = (data.status ?? data.state ?? data.task_status ?? '').toLowerCase();

    if (state === 'success' || state === 'succeeded' || state === 'completed') {
      // 严禁误取 `remixed_from_video_id`(此字段为 video_xxx 格式的 ID 字符串，非播放 URL，会导致播放器显示纯文字与合成失败)。
      // 优先从官方及各中转站的标准 HTTP(S) URL 字段中提取播放地址：
      let videoUrl =
        (typeof data.metadata?.url === 'string' && /^https?:\/\//i.test(data.metadata.url) ? data.metadata.url : null) ??
        (typeof data.video_url === 'string' && /^https?:\/\//i.test(data.video_url) ? data.video_url : null) ??
        (typeof data.url === 'string' && /^https?:\/\//i.test(data.url) ? data.url : null) ??
        (typeof data.video === 'string' && /^https?:\/\//i.test(data.video) ? data.video : null) ??
        (typeof data.output?.video_url === 'string' && /^https?:\/\//i.test(data.output.video_url) ? data.output.video_url : null) ??
        (typeof data.output?.url === 'string' && /^https?:\/\//i.test(data.output.url) ? data.output.url : null) ??
        (typeof data.data?.video_url === 'string' && /^https?:\/\//i.test(data.data.video_url) ? data.data.video_url : null) ??
        (typeof data.data?.url === 'string' && /^https?:\/\//i.test(data.data.url) ? data.data.url : null) ??
        (typeof data.file_url === 'string' && /^https?:\/\//i.test(data.file_url) ? data.file_url : null) ??
        (typeof data.download_url === 'string' && /^https?:\/\//i.test(data.download_url) ? data.download_url : null) ??
        findHttpVideoUrlInObject(data) ??
        '';

      if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
        throw new Error(
          `Agnes Video: 任务已成功完成，但未能解析到可用的视频播放 HTTP URL (响应片段: ${JSON.stringify(data).slice(0, 300)})`,
        );
      }

      const returnedDuration = [data.seconds, data.duration, data.duration_seconds, data.metadata?.seconds, data.metadata?.duration]
        .map((value) => typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN)
        .find((value) => Number.isFinite(value) && value > 0);
      const dimensions = findVideoDimensions(data)
        ?? (this.requestedSize
          ? agnesV25Dimensions(model, this.requestedAspectRatio ?? '16:9', this.requestedSize)
          : this.requestedWidth && this.requestedHeight
            ? { width: this.requestedWidth, height: this.requestedHeight }
            : dimensionsForAspect(this.requestedAspectRatio, 720));
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: videoUrl,
          width: dimensions.width,
          height: dimensions.height,
          durationSeconds: returnedDuration ?? this.requestedDurationSeconds ?? 5,
          model: this.lastModel,
          provider: 'agnes-video',
          latencyMs: 0,
        },
      };
    }

    if (state === 'failed' || state === 'error') {
      // 把原始响应里的失败原因带出来 — Agnes 通常用 error.message / fail_reason /
      // data.error 字段。没有就给个原始 JSON 片段,避免吞错。
      const reason =
        (typeof data.error === 'string' && data.error) ||
        data.error?.message ||
        data.fail_reason ||
        data.failure_reason ||
        data.data?.error?.message ||
        JSON.stringify(data).slice(0, 300);
      return { status: 'failed', progress: 0, failReason: reason };
    }

    return { status: 'processing', progress: typeof data.progress === 'number' ? data.progress : 0.3 };
  }

  private async pollUntilComplete(startTime: number): Promise<VideoGenerateResponse> {
    const maxPolls = 120; // 10 分钟 (5s × 120)
    const maxConsecutiveErrors = 3; // 连续 3 次轮询失败才放弃
    let consecutiveErrors = 0;
    let lastPollError: Error | null = null;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 5000));

      try {
        const status = await this.checkStatus(this.lastQueryId);
        consecutiveErrors = 0; // 成功一次就清零

        if (status.status === 'completed' && status.result) {
          return { ...status.result, latencyMs: Date.now() - startTime };
        }
        if (status.status === 'failed') {
          const reason = status.failReason ?? '(provider 没有给出具体原因)';
          throw new Error(`Agnes Video generation failed: ${reason}`);
        }
      } catch (err) {
        // 如果是 "generation failed" 这种明确的失败状态,直接冒泡
        if (err instanceof Error && err.message.includes('Agnes Video generation failed')) {
          throw err;
        }
        // tauri-plugin-http 在 AbortSignal 到期时抛 "Request canceled",
        // 这是单次请求超时,属于网络抖动类,应该重试而不是直接放弃。
        // 把它翻译成可读的错误消息。
        if (err instanceof Error && err.message.includes('Request canceled')) {
          lastPollError = new Error(
            `Agnes Video 轮询单次请求超时(90s,可能是网络或代理转发慢),将重试`,
          );
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            throw new Error(
              `Agnes Video polling failed after ${consecutiveErrors} consecutive timeouts: ${lastPollError.message}`,
            );
          }
          continue;
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

// --- Doubao / Volcano Ark Video Adapter (Seedance 2.0) ---
//
// 官方文档(火山方舟):
//   创建:POST {baseUrl}/api/v3/contents/generations/tasks
//   轮询:GET  {BaseUrl}/api/v3/contents/generations/tasks/{id}
//
// 文生 / 图生 / 多模态共用同一个创建端点,通过 content 数组里的 role 区分:
//   - 文生:1 个 text
//   - 图生(首帧):1 个 text(可选)+ 1 个 image_url(role=first_frame)
//   - 多模态:text + 0-9 个 image_url(role=reference_image)
//
// 响应:`{id: "cgt-..."}`,轮询拿到 `{status, content: {video_url}}`。
// 模型名:`doubao-seedance-2-0-260128`(标准,1080p)、
//        `doubao-seedance-2-0-fast-260128`(极速,720p)。
//
// 视频自身会带音频(人声/音效/配乐)—— 我们项目走自己的 TTS pipeline,
// 这里默认 generate_audio=false,避免后面 audio_merge 又要混合两套音频。

export class DoubaoVideoProvider extends BaseVideoProvider {
  readonly providerId = 'doubao-video';
  private lastModel = 'doubao-seedance-2-0-260128';
  private requestedDurationSeconds = 5;
  private requestedAspectRatio?: string;
  private requestedResolution?: string;

  getWireParameterSnapshot(request: VideoGenerateRequest): Record<string, unknown> {
    const model = request.model?.trim() || 'doubao-seedance-2-0-260128';
    const duration = this.clampDuration(request.durationSeconds, model);
    const ratio = this.pickRatio(request.width, request.height, request.aspectRatio);
    const resolution = this.pickResolution(request, model);
    const wire: Record<string, unknown> = {
      model,
      duration,
      ratio,
      generate_audio: request.generateAudio ?? false,
      watermark: false,
      ...(resolution ? { resolution } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      controlMode: videoControlModeForRequest(request),
      referenceImageCount: request.referenceImages?.length ?? 0,
      subjectReferenceCount: request.subjectReferences?.length ?? 0,
      audioReferenceCount: request.audioReferences?.length ?? 0,
      videoReferenceCount: request.videoReferences?.length ?? 0,
    };
    applyUnconsumedGenerationParameters(
      wire,
      request,
      ['model', 'durationSeconds', 'aspectRatio', 'width', 'height', 'seed', 'generateAudio'],
    );
    return wire;
  }

  /** 把任意图片引用规范化成 Seedance 能接受的字符串:
   *  - http(s) URL / data:image/...;base64,... / asset:// → 原样返回
   *  - 裸 base64 → 补 data:image/png;base64, 前缀(Seedance 要求带前缀)
   *  - 本地 tauri:// / 文件路径 → 抛清晰错误,让上层关闭 I2V 或换 provider */
  private normalizeImageRef(raw: string): string {
    const s = raw.trim();
    if (!s) throw new Error('Doubao Video: empty reference image');
    // 公网 URL / data URI / 火山素材 ID — 直接接受
    if (/^(https?:|data:|asset:)/i.test(s)) return s;
    // 裸 base64(Seedance 文档明确支持 base64,但要求带 data: 前缀)
    if (/^[A-Za-z0-9+/\s]+=*$/.test(s) && s.length > 100) {
      return `data:image/png;base64,${s.replace(/\s/g, '')}`;
    }
    // tauri://... / 盘符路径 / 相对路径 — 火山后端拉不到本地文件
    throw new Error(
      'Doubao Video: 关键帧是本地文件 URL,Seedance 后端无法读取。请改用支持 URL 引用的 provider,或在「设置 → 视频」关闭 I2V。',
    );
  }

  /** 把 (width, height) 映射到 Seedance 支持的 ratio 字符串。
   *  Seedance 接受 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / 21:9 / adaptive。
   *  对不上就 adaptive,让模型按 prompt 自行决定。 */
  private pickRatio(width?: number, height?: number, explicit?: string): string {
    const supported = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'];
    if (explicit && supported.includes(explicit)) return explicit;
    if (!width || !height) return '16:9';
    const ratio = width / height;
    // 容差 5%
    const TOLERANCE = 0.05;
    const TABLE: Array<[number, string]> = [
      [16 / 9, '16:9'],
      [4 / 3, '4:3'],
      [1, '1:1'],
      [3 / 4, '3:4'],
      [9 / 16, '9:16'],
      [21 / 9, '21:9'],
    ];
    for (const [r, label] of TABLE) {
      if (Math.abs(ratio - r) / r < TOLERANCE) return label;
    }
    return 'adaptive';
  }

  /** Native duration depends on the model generation: 2.0 up to 15s, 2.5 up to 30s. */
  private clampDuration(seconds?: number, model = this.lastModel): number {
    if (!seconds || !Number.isFinite(seconds)) return 5;
    const n = Math.round(seconds);
    if (n < 4) return 4;
    const maximum = /seedance-2-5/i.test(model) ? 30 : 15;
    if (n > maximum) return maximum;
    return n;
  }

  private pickResolution(request: VideoGenerateRequest, model: string): string {
    if (/fast|flash/i.test(model)) return '720p';
    const pixels = (request.width ?? 1280) * (request.height ?? 720);
    return pixels >= 1920 * 1080 ? '1080p' : pixels >= 1280 * 720 ? '720p' : '480p';
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const model = request.model?.trim() || 'doubao-seedance-2-0-260128';
    this.lastModel = model;
    this.requestedDurationSeconds = this.clampDuration(request.durationSeconds);
    this.requestedAspectRatio = this.pickRatio(request.width, request.height, request.aspectRatio);

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    // 用户可能填了完整 baseUrl (https://ark.cn-beijing.volces.com) 或带 /api
    // 统一拼成 {baseUrl}/api/v3/contents/generations/tasks
    const submitUrl = /\/api\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/contents/generations/tasks`
      : `${baseUrl}/api/v3/contents/generations/tasks`;

    // content 数组:显式区分时间首帧与主体参考图。
    const content: Array<Record<string, unknown>> = [];
    if (request.prompt) {
      content.push({ type: 'text', text: request.prompt });
    }
    const subjectImages = (request.subjectReferences ?? []).map((reference) => reference.image).filter(Boolean);
    const controlMode = videoControlModeForRequest(request);
    const capabilities = getVideoGenerationCapabilities('doubao-video', model);
    validateVideoMediaReferences({ ...request, controlMode }, capabilities, subjectImages.length || request.referenceImages?.length || 0);
    if (controlMode === 'keyframe') {
      const firstImage = request.firstFrame || request.referenceImages?.[0];
      if (!firstImage) throw new Error('Doubao Video keyframe mode requires firstFrame');
      const imgRef = this.normalizeImageRef(firstImage);
      content.push({
        type: 'image_url',
        image_url: { url: imgRef },
        role: 'first_frame',
      });
      const lastImage = request.lastFrame || request.referenceImages?.[1];
      if (lastImage) {
        content.push({ type: 'image_url', image_url: { url: this.normalizeImageRef(lastImage) }, role: 'last_frame' });
      }
    } else if (controlMode === 'reference') {
      const images = subjectImages.length > 0 ? subjectImages : (request.referenceImages ?? []);
      if (images.length === 0 && !request.audioReferences?.length && !request.videoReferences?.length) throw new Error('Doubao Video reference mode requires images, audio or video');
      if (images.length > capabilities.references.maxImages) throw new Error(`Doubao Video accepts at most ${capabilities.references.maxImages} reference images`);
      if (request.prompt) content[0].text = bindSubjectReferencePrompt(request, (index) => `@图像${index}`);
      for (const image of images) {
        content.push({
          type: 'image_url',
          image_url: { url: this.normalizeImageRef(image) },
          role: 'reference_image',
        });
      }
      for (const reference of request.audioReferences ?? []) content.push({ type: 'audio_url', audio_url: { url: reference.url }, role: 'reference_audio' });
      for (const reference of request.videoReferences ?? []) content.push({ type: 'video_url', video_url: { url: reference.url }, role: 'reference_video' });
    }

    const body: Record<string, unknown> = {
      model,
      content,
      // 时长(秒,4-15)
      duration: this.clampDuration(request.durationSeconds),
      // 比例:按请求宽高推导,推不出就走 adaptive
      ratio: this.pickRatio(request.width, request.height, request.aspectRatio),
      // 默认关声音:本项目走自己的 TTS pipeline,不需要 Seedance 自带的 BGM/音效
      generate_audio: request.generateAudio ?? false,
      // 默认加水印按 false(测试期不希望被强制加水印)
      watermark: false,
    };

    body.resolution = this.pickResolution(request, model);
    this.requestedResolution = String(body.resolution);
    if (typeof request.seed === 'number' && Number.isInteger(request.seed)) body.seed = request.seed;
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'durationSeconds', 'aspectRatio', 'width', 'height', 'seed', 'generateAudio'],
    );

    if (new TextEncoder().encode(JSON.stringify(body)).length > 64 * 1024 * 1024) throw new Error('Seedance request exceeds 64 MB. Use public media URLs for large files.');
    const submitResp = await httpFetch(submitUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      throw new Error(`Doubao Video API error ${submitResp.status}: ${text.slice(0, 500)}`);
    }

    const submitData = await submitResp.json();
    const taskId = submitData.id;
    if (!taskId) {
      throw new Error(`Doubao Video: no task id returned (got ${JSON.stringify(submitData).slice(0, 200)})`);
    }

    return this.pollUntilComplete(taskId, startTime);
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse; failReason?: string }> {
    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const statusUrl = /\/api\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`
      : `${baseUrl}/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`;

    const resp = await httpFetch(statusUrl, {
      method: 'GET',
      headers: this.getHeaders(),
      signal: this.timeoutSignal(90_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Doubao Video status error ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    const state = String(data.status ?? '').toLowerCase();

    if (state === 'succeeded' || state === 'success') {
      const videoUrl = data.content?.video_url ?? data.content?.url ?? '';
      if (!videoUrl) throw new Error('Doubao Video: task succeeded without a video URL');
      const dimensions = findVideoDimensions(data)
        ?? dimensionsForAspect(this.requestedAspectRatio, this.requestedResolution === '1080p' ? 1080 : this.requestedResolution === '480p' ? 480 : 720);
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: videoUrl,
          width: dimensions.width,
          height: dimensions.height,
          durationSeconds: typeof data.duration === 'number' ? data.duration : this.requestedDurationSeconds,
          model: data.model ?? this.lastModel,
          provider: 'doubao-video',
          latencyMs: 0,
        },
      };
    }

    if (state === 'failed' || state === 'error' || state === 'cancelled') {
      const reason =
        data.error?.message ||
        data.error?.code ||
        data.fail_reason ||
        JSON.stringify(data).slice(0, 300);
      return { status: 'failed', progress: 0, failReason: reason };
    }

    // queued / running / processing
    return { status: 'processing', progress: typeof data.progress === 'number' ? data.progress : 0.3 };
  }

  private async pollUntilComplete(taskId: string, startTime: number): Promise<VideoGenerateResponse> {
    const maxPolls = 120; // 10 分钟
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
          throw new Error(`Doubao Video generation failed: ${status.failReason ?? '(no reason)'}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('generation failed')) {
          throw err;
        }
        consecutiveErrors++;
        lastPollError = err instanceof Error ? err : new Error(String(err));
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `Doubao Video polling failed after ${consecutiveErrors} consecutive errors: ${lastPollError.message}`,
          );
        }
      }
    }
    throw new Error('Doubao Video generation timed out (10 min)');
  }
}

// --- Leonardo Motion (图生视频) ---
// 文档: https://docs.leonardo.ai/ (Leonardo Motion)
// POST {baseUrl}/rest/v1/video-generations  (baseUrl 通常为 https://api.leonardo.ai/v1)
// 鉴权: Bearer apiKey
// 异步任务: 返回 id / videoGenerationId,轮询 GET /rest/v1/video-generations/{id}
// 完成态返回视频 URL (临时有效,需及时下载)。
//
// Leonardo Motion 本质是图生视频 (I2V):必须传一张源图片。
// 项目视频流水线 step-video-gen 总是带关键帧,正常路径走 I2V;
// 若调用方没给 referenceImages,抛清晰错误,避免后端报含糊的 400。
//
// 字段名基于训练数据,接入后建议用真实 key 跑一次校对。
// 结果字段做多名兼容 (参考 AgnesVideoProvider)。

export class LeonardoVideoProvider extends BaseVideoProvider {
  readonly providerId = 'leonardo-video';
  private lastModel = 'leonardo-motion';

  /** 记住提交拿到的查询 id,checkStatus 外部单独调用时也能用 */
  private lastQueryId: string = '';
  /** 记住用户请求的时长,完成态回算 (Leonardo 不一定回传 duration) */
  private requestedDurationSeconds: number | undefined;

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    this.requestedDurationSeconds = request.durationSeconds;

    const { firstImage: image } = resolveKeyframeImages(request, 'Leonardo Motion');
    if (!image) {
      throw new Error(
        'Leonardo Motion 需要一张源图片(图生视频),请在视频设置里保留 I2V,或换用支持文生视频的 provider。',
      );
    }

    const model = request.model?.trim() || 'leonardo-motion';
    this.lastModel = model;
    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    // 兼容用户填 https://api.leonardo.ai/v1 或不带版本
    const base = /\/v\d+$/.test(baseUrl) ? baseUrl.replace(/\/v\d+$/, '/v1') : `${baseUrl}/v1`;

    // Leonardo Motion 接受 image 为公网 URL 或 data URI;本地 webview URL 后端拉不到,
    // 这里只做透传 + 基本校验 (data: / https:),其余交给后端报错或上层转 data URI。
    if (!/^(https?:|data:)/i.test(image)) {
      throw new Error(
        'Leonardo Motion: 源图必须是公网 URL 或 data URI,本地文件 URL 后端无法读取。请换用支持 URL 引用的 provider,或先把关键帧转成 data URI。',
      );
    }

    const body: Record<string, unknown> = {
      prompt: request.prompt,
      modelId: model,
      image,
    };
    if (request.negativePrompt) {
      body.negative_prompt = request.negativePrompt;
    }
    if (request.durationSeconds) {
      // Leonardo Motion 通常只支持 4-5s 档位,这里传秒数让它自行取整
      body.duration = request.durationSeconds;
    }

    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'durationSeconds', 'negativePrompt'],
    );

    const submitResp = await httpFetch(`${base}/rest/v1/video-generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(300_000),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      throw new Error(`Leonardo Motion submit error ${submitResp.status}: ${text.slice(0, 500)}`);
    }

    const submitData = await submitResp.json();
    const taskId =
      submitData.id ??
      submitData.videoGenerationId ??
      submitData.video_generation_id ??
      submitData.data?.id;
    if (!taskId) {
      throw new Error(`Leonardo Motion: no task id returned (got ${JSON.stringify(submitData).slice(0, 200)})`);
    }
    this.lastQueryId = taskId;

    return this.pollUntilComplete(taskId, startTime);
  }

  async checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse; failReason?: string }> {
    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const base = /\/v\d+$/.test(baseUrl) ? baseUrl.replace(/\/v\d+$/, '/v1') : `${baseUrl}/v1`;
    const id = taskId || this.lastQueryId;

    const resp = await httpFetch(`${base}/rest/v1/video-generations/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: this.getHeaders(),
      // tauri-plugin-http 在 AbortSignal 到期抛 "Request canceled",代理转发可能慢,给 90s
      signal: this.timeoutSignal(90_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Leonardo Motion status error ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    const state = String(data.status ?? data.state ?? '').toLowerCase();

    if (state === 'complete' || state === 'completed' || state === 'succeeded' || state === 'success') {
      // 结果字段多名兼容
      const videoUrl =
        data.url ??
        data.video_url ??
        data.output?.video_url ??
        data.output?.url ??
        data.data?.video_url ??
        data.video?.url ??
        '';
      const duration =
        typeof data.duration === 'number' ? data.duration :
        typeof data.length === 'number' ? data.length :
        (this.requestedDurationSeconds ?? 5);
      return {
        status: 'completed',
        progress: 1,
        result: {
          videoData: videoUrl,
          width: 1920,
          height: 1080,
          durationSeconds: duration,
          model: this.lastModel,
          provider: 'leonardo-video',
          latencyMs: 0,
        },
      };
    }

    if (state === 'failed' || state === 'error') {
      const reason =
        (typeof data.error === 'string' && data.error) ||
        data.error?.message ||
        data.failure_reason ||
        data.data?.error?.message ||
        JSON.stringify(data).slice(0, 300);
      return { status: 'failed', progress: 0, failReason: reason };
    }

    // pending / processing / running
    return { status: 'processing', progress: typeof data.progress === 'number' ? data.progress : 0.3 };
  }

  private async pollUntilComplete(taskId: string, startTime: number): Promise<VideoGenerateResponse> {
    const maxPolls = 120; // 10 分钟 (5s × 120)
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
          throw new Error(`Leonardo Motion generation failed: ${status.failReason ?? '(provider 未给出原因)'}`);
        }
      } catch (err) {
        // "generation failed" 是明确的失败状态,直接冒泡
        if (err instanceof Error && err.message.includes('Leonardo Motion generation failed')) {
          throw err;
        }
        consecutiveErrors++;
        lastPollError = err instanceof Error ? err : new Error(String(err));
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `Leonardo Motion polling failed after ${consecutiveErrors} consecutive errors: ${lastPollError.message}`,
          );
        }
      }
    }
    throw new Error('Leonardo Motion generation timed out (10 min)');
  }
}

// --- SiliconFlow / 硅基流动 Video Provider (Wan 2.1) ---
// API: POST {baseUrl}/video/submit
// Body: { model, prompt, image?, seed }
// Response: { requestId }
// Status Check: POST {baseUrl}/video/status { requestId }

export class SiliconFlowVideoProvider extends BaseVideoProvider {
  readonly providerId: VideoProviderId = 'siliconflow-video';
  private lastModel = 'Wan-AI/Wan2.2-T2V-A14B';
  private requestedDurationSeconds = 5;

  private baseUrl(): string {
    const b = this.endpoint.baseUrl.replace(/\/+$/, '');
    return /\/v\d+$/.test(b) ? b : `${b}/v1`;
  }

  async generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const startTime = Date.now();
    const { firstImage } = resolveKeyframeImages(request, 'SiliconFlow Video');
    const model = request.model?.trim() || this.lastModel;
    this.lastModel = model;
    this.requestedDurationSeconds = request.durationSeconds ?? 5;

    // 优先尝试用户指定的或 endpoint 里配置的 model,然后再按备选列表重试
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
    };

    if (firstImage) {
      body.image = firstImage;
    }
    if (typeof request.seed === 'number') {
      body.seed = request.seed;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'seed'],
    );

    const submitUrl = `${this.baseUrl()}/video/submit`;
    const submitResponse = await httpFetch(submitUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResponse.ok) {
      const text = await submitResponse.text().catch(() => '');
      throw new Error(`SiliconFlow Video API error ${submitResponse.status}: ${text}`);
    }

    const submitData = await submitResponse.json();
    const requestId = submitData.requestId || submitData.request_id || submitData.task_id || submitData.id;

    if (!requestId) {
      throw new Error('SiliconFlow Video API: no requestId returned');
    }

    return this.pollUntilComplete(requestId, startTime, model);
  }

  async checkStatus(requestId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse; failReason?: string }> {
    const statusUrl = `${this.baseUrl()}/video/status`;
    const response = await httpFetch(statusUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ requestId }),
      signal: this.timeoutSignal(90_000),
    });

    if (!response.ok) {
      throw new Error(`SiliconFlow Video status check error ${response.status}`);
    }

    const data = await response.json();
    const state = (data.status || data.state || '').toLowerCase();

    if (state === 'succeed' || state === 'success' || state === 'completed') {
      const videoUrl = data.results?.videos?.[0]?.url || data.result?.url || data.url || data.video_url;
      if (!videoUrl) {
        throw new Error('SiliconFlow Video: completed but no video url in response');
      }
      return {
        status: 'completed',
        progress: 1.0,
        result: {
          videoData: videoUrl,
          width: 1280,
          height: 720,
          durationSeconds: this.requestedDurationSeconds,
          model: this.lastModel,
          provider: 'siliconflow-video',
          latencyMs: 0,
        },
      };
    }

    if (state === 'failed' || state === 'error') {
      const reason = data.reason || data.message || JSON.stringify(data).slice(0, 300);
      return { status: 'failed', progress: 0, failReason: reason };
    }

    return { status: 'processing', progress: typeof data.progress === 'number' ? data.progress : 0.4 };
  }

  private async pollUntilComplete(requestId: string, startTime: number, model: string): Promise<VideoGenerateResponse> {
    const maxPolls = 120; // 10 分钟
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const status = await this.checkStatus(requestId);
      if (status.status === 'completed' && status.result) {
        return { ...status.result, model, latencyMs: Date.now() - startTime };
      }
      if (status.status === 'failed') {
        throw new Error(`SiliconFlow Video failed: ${status.failReason ?? 'unknown error'}`);
      }
    }
    throw new Error('SiliconFlow Video timed out (10 min)');
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
    case 'doubao-video':
      return new DoubaoVideoProvider(endpoint);
    case 'leonardo-video':
      return new LeonardoVideoProvider(endpoint);
    case 'siliconflow-video':
      return new SiliconFlowVideoProvider(endpoint);
    case '302ai-video':
      throw new Error(`No video adapter is implemented for provider ${providerId}`);
    default:
      // 如果 Provider 是 custom 或者属于其他通用,检查 URL 特征。
      // 若包含 siliconflow 则自动走向 SiliconFlow 驱动,避免抛错成 Kling
      throw new Error(`No video adapter is implemented for provider ${providerId}`);
  }
}

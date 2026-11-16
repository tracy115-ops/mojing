import type {
  LLMGenerateRequest,
  LLMGenerateResponse,
  LLMStreamChunk,
  ImageGenerateRequest,
  ImageGenerateResponse,
  VideoGenerateRequest,
  VideoGenerateResponse,
  TTSRequest,
  TTSResponse,
  ApiEndpoint,
} from '@/types/providers';
import { applyUnconsumedGenerationParameters } from './parameter-transport.ts';

// --- fetch timeout helper ---
//
// AbortSignal.timeout() 在老版 WebView2 上不可用,会同步抛 TypeError,
// 被 fetch 包装成 "Failed to fetch"——这就是 image/video 在 release build
// 上 50ms 内同步失败的根因。这里做 polyfill:能用就用,不能用就降级到
// AbortController + setTimeout。
export function fetchTimeout(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // fall through to manual controller
  }
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  } catch {
    return undefined;
  }
}

// --- Base Provider ---

export abstract class BaseLLMProvider {
  abstract readonly providerId: string;
  protected endpoint: ApiEndpoint;

  constructor(endpoint: ApiEndpoint) {
    this.endpoint = endpoint;
  }

  abstract generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse>;
  abstract stream(request: LLMGenerateRequest): AsyncIterable<LLMStreamChunk>;

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.endpoint.apiKey}`,
      ...this.endpoint.customHeaders,
    };
  }

  protected timeoutSignal(ms: number): AbortSignal | undefined {
    return fetchTimeout(ms);
  }
}

export abstract class BaseImageProvider {
  abstract readonly providerId: string;
  protected endpoint: ApiEndpoint;

  constructor(endpoint: ApiEndpoint) {
    this.endpoint = endpoint;
  }

  abstract generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse>;

  /**
   * Return a sanitized preview of the parameters the adapter will transport.
   * Concrete adapters can override this when their native API renames or
   * derives normalized application fields.
   */
  getWireParameterSnapshot(request: ImageGenerateRequest): Record<string, unknown> {
    const wire: Record<string, unknown> = {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.size !== undefined ? { size: request.size } : {}),
      ...(request.width !== undefined ? { width: request.width } : {}),
      ...(request.height !== undefined ? { height: request.height } : {}),
      ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
      ...(request.style !== undefined ? { style: request.style } : {}),
      ...(request.quality !== undefined ? { quality: request.quality } : {}),
      ...(request.steps !== undefined ? { steps: request.steps } : {}),
      ...(request.guidanceScale !== undefined ? { guidanceScale: request.guidanceScale } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      referenceImageCount: request.referenceImages?.length ?? 0,
    };
    applyUnconsumedGenerationParameters(
      wire,
      request,
      ['model', 'size', 'width', 'height', 'aspectRatio', 'negativePrompt', 'style', 'quality', 'steps', 'guidanceScale', 'seed'],
    );
    return wire;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.endpoint.apiKey}`,
      ...this.endpoint.customHeaders,
    };
  }

  protected timeoutSignal(ms: number): AbortSignal | undefined {
    return fetchTimeout(ms);
  }

  /**
   * 把 provider 返回的字符串归一化成 <img src> 能直接渲染的形式:
   *   - 完整 URL(http://, https://, data:, file:) → 原样返回
   *   - 纯 base64 字符串(没有 data: 前缀)→ 补成 data:image/png;base64,...
   *
   * OpenAI-style /v1/images/generations 接口在 response_format='b64_json' 时
   * 只返回原始 base64 字符串,浏览器无法直接渲染 —— 必须加 data URI 前缀。
   */
  protected normalizeImageSrc(raw: string | undefined | null): string {
    if (!raw) return '';
    const s = raw.trim();
    if (!s) return '';
    if (/^(https?:|data:|file:|blob:)/i.test(s)) return s;
    // 落到这里的几乎都是裸 base64(无 data: 前缀)。
    return `data:image/png;base64,${s}`;
  }
}

export abstract class BaseVideoProvider {
  abstract readonly providerId: string;
  protected endpoint: ApiEndpoint;

  constructor(endpoint: ApiEndpoint) {
    this.endpoint = endpoint;
  }

  abstract generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse>;
  abstract checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse; failReason?: string }>;

  /**
   * Return a sanitized preview of the parameters the adapter will transport.
   * Concrete adapters can override this when their native API renames or
   * derives normalized application fields.
   */
  getWireParameterSnapshot(request: VideoGenerateRequest): Record<string, unknown> {
    const wire: Record<string, unknown> = {
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
      ...(request.fps !== undefined ? { fps: request.fps } : {}),
      ...(request.width !== undefined ? { width: request.width } : {}),
      ...(request.height !== undefined ? { height: request.height } : {}),
      ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.numInferenceSteps !== undefined ? { numInferenceSteps: request.numInferenceSteps } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.controlMode !== undefined ? { controlMode: request.controlMode } : {}),
      referenceImageCount: request.referenceImages?.length ?? 0,
      subjectReferenceCount: request.subjectReferences?.length ?? 0,
    };
    applyUnconsumedGenerationParameters(
      wire,
      request,
      ['model', 'durationSeconds', 'fps', 'width', 'height', 'aspectRatio', 'negativePrompt', 'seed', 'numInferenceSteps', 'mode'],
    );
    return wire;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.endpoint.apiKey}`,
      ...this.endpoint.customHeaders,
    };
  }

  protected timeoutSignal(ms: number): AbortSignal | undefined {
    return fetchTimeout(ms);
  }
}

export abstract class BaseTTSProvider {
  abstract readonly providerId: string;
  protected endpoint: ApiEndpoint;

  constructor(endpoint: ApiEndpoint) {
    this.endpoint = endpoint;
  }

  abstract generate(request: TTSRequest): Promise<TTSResponse>;

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.endpoint.apiKey}`,
      ...this.endpoint.customHeaders,
    };
  }

  protected timeoutSignal(ms: number): AbortSignal | undefined {
    return fetchTimeout(ms);
  }
}

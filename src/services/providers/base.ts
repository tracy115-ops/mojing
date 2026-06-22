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

export abstract class BaseVideoProvider {
  abstract readonly providerId: string;
  protected endpoint: ApiEndpoint;

  constructor(endpoint: ApiEndpoint) {
    this.endpoint = endpoint;
  }

  abstract generate(request: VideoGenerateRequest): Promise<VideoGenerateResponse>;
  abstract checkStatus(taskId: string): Promise<{ status: string; progress: number; result?: VideoGenerateResponse }>;

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

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
}

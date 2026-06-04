import type {
  ImageGenerateRequest,
  ImageGenerateResponse,
  ApiEndpoint,
} from '@/types/providers';
import { BaseImageProvider } from './base';

// --- DALL-E Adapter ---

export class DALLEProvider extends BaseImageProvider {
  readonly providerId = 'dalle';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const model = request.model || 'dall-e-3';

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      n: 1,
      size: `${request.width ?? 1024}x${request.height ?? 1024}`,
      quality: 'standard',
      response_format: 'b64_json',
    };

    if (request.style) {
      body.style = request.style;
    }

    const response = await fetch(`${this.endpoint.baseUrl}/images/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DALL-E API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];

    return {
      imageData: image?.b64_json ?? image?.url ?? '',
      width: request.width ?? 1024,
      height: request.height ?? 1024,
      model,
      provider: 'dalle',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Stable Diffusion / Flux / ComfyUI (WebUI API compatible) ---

export class SDWebUIProvider extends BaseImageProvider {
  readonly providerId = 'sd-webui';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;

    const body: Record<string, unknown> = {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      width,
      height,
      steps: 30,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
    };

    if (request.seed !== undefined) {
      body.seed = request.seed;
    }

    const response = await fetch(`${this.endpoint.baseUrl}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SD API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    return {
      imageData: data.images?.[0] ?? '',
      width,
      height,
      model: request.model || 'stable-diffusion',
      provider: 'stable-diffusion',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Kling Image API ---

export class KlingImageProvider extends BaseImageProvider {
  readonly providerId = 'kling-image';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;

    const body: Record<string, unknown> = {
      model: request.model || 'kling-v1',
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      image_size: `${width}x${height}`,
      n: 1,
    };

    if (request.referenceImages?.length) {
      body.image_reference = request.referenceImages[0];
    }

    const response = await fetch(`${this.endpoint.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Kling Image API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];

    return {
      imageData: image?.url ?? image?.b64_json ?? '',
      width,
      height,
      model: request.model || 'kling-v1',
      provider: 'kling-image',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Factory ---

export function createImageProvider(
  providerId: string,
  endpoint: ApiEndpoint,
): BaseImageProvider {
  switch (providerId) {
    case 'dalle':
      return new DALLEProvider(endpoint);
    case 'stable-diffusion':
    case 'flux':
    case 'comfyui':
      return new SDWebUIProvider(endpoint);
    case 'kling-image':
      return new KlingImageProvider(endpoint);
    default:
      // Assume OpenAI-compatible image API
      return new DALLEProvider(endpoint);
  }
}

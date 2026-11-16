import type {
  ImageGenerateRequest,
  ImageGenerateResponse,
  ApiEndpoint,
} from '@/types/providers';
import { BaseImageProvider } from './base';
import { fetch as httpFetch } from './fetch-proxy';
import { applyUnconsumedGenerationParameters } from './parameter-transport';
import { readAsDataUri, isRemoteUrl } from '@/services/video/asset-store';
import { buildSDWebUIRequest, getAgnesImageOutput, getAgnesImageWireParameterSnapshot } from './image-wire-contract.ts';

function pickIdeogramAspectRatio(width?: number, height?: number, explicit?: string): string {
  const supported = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '2:1', '1:2', '3:1', '1:3'] as const;
  if (explicit && supported.includes(explicit as typeof supported[number])) return explicit;
  if (!width || !height) return '1:1';

  const target = width / height;
  return supported.reduce((closest, candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(':').map(Number);
    const [closestWidth, closestHeight] = closest.split(':').map(Number);
    return Math.abs(candidateWidth / candidateHeight - target)
      < Math.abs(closestWidth / closestHeight - target)
      ? candidate
      : closest;
  }, supported[2]);
}

// --- DALL-E Adapter ---

export class DALLEProvider extends BaseImageProvider {
  readonly providerId = 'dalle';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const model = request.model || 'dall-e-3';
    const size = request.size || inferDalleSize(request.width, request.height, request.aspectRatio);
    const [outputWidth, outputHeight] = parseImageSize(size);

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      n: 1,
      size,
      quality: request.quality ?? 'standard',
      response_format: 'b64_json',
    };

    if (request.style) {
      body.style = request.style;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'size', 'width', 'height', 'quality', 'style'],
    );

    const response = await httpFetch(`${this.endpoint.baseUrl}/images/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DALL-E API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];

    return {
      imageData: this.normalizeImageSrc(image?.b64_json ?? image?.url ?? ''),
      width: outputWidth,
      height: outputHeight,
      model,
      provider: 'dalle',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Stable Diffusion / Flux / ComfyUI (WebUI API compatible) ---

export class SDWebUIProvider extends BaseImageProvider {
  readonly providerId = 'sd-webui';

  getWireParameterSnapshot(request: ImageGenerateRequest): Record<string, unknown> {
    const wire = buildSDWebUIRequest(request, true);
    return { path: wire.path, ...wire.body };
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    const images = request.referenceImages ? await Promise.all(request.referenceImages.map((image) => readAsDataUri(image))) : undefined;
    const { path, body } = buildSDWebUIRequest({ ...request, referenceImages: images });
    const response = await httpFetch(`${this.endpoint.baseUrl}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(300_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SD API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (!data.images?.[0]) throw new Error('SD WebUI returned no image');

    return {
      imageData: this.normalizeImageSrc(data.images[0]),
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
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'width', 'height', 'negativePrompt'],
    );

    const response = await httpFetch(`${this.endpoint.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Kling Image API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];

    return {
      imageData: this.normalizeImageSrc(image?.url ?? image?.b64_json ?? ''),
      width,
      height,
      model: request.model || 'kling-v1',
      provider: 'kling-image',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- 智谱 CogView API ---
// 文档:https://open.bigmodel.cn/dev/api/image-generation
// POST {baseUrl}/images/generations
// 鉴权:Bearer JWT(用户在智谱开放平台拿的 API Key 直接当 Bearer 用)
// 返回:{ data: [{ url }] } (异步任务模式也有,这里走同步)

export class CogViewProvider extends BaseImageProvider {
  readonly providerId = 'cogview';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const model = request.model || 'cogview-3-plus';
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    // CogView 用 size 字段,格式 "宽x高"
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      size: `${width}x${height}`,
    };
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'width', 'height'],
    );

    const response = await httpFetch(`${this.endpoint.baseUrl}/images/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`CogView API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];

    return {
      imageData: this.normalizeImageSrc(image?.url ?? image?.b64_json ?? ''),
      width,
      height,
      model,
      provider: 'cogview',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- 阿里通义万相 Wanx API ---
// 文档:https://help.aliyun.com/zh/dashscope/developer-reference/api-details-9
// 走 DashScope OpenAI 兼容接口
// POST {baseUrl}/services/aigc/text2image/image-synthesis
// 鉴权:Bearer apiKey
// 异步任务:返回 task_id,需轮询

export class WanxProvider extends BaseImageProvider {
  readonly providerId = 'wanx';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const model = request.model || 'wanx-v1';
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    // 通义 size 格式 "1024*1024"
    const size = `${width}*${height}`;

    const body: Record<string, unknown> = {
      model,
      input: { prompt: request.prompt },
      parameters: {
        size,
        n: 1,
        ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      },
    };
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'width', 'height', 'negativePrompt'],
      'parameters',
    );

    const submitResponse = await httpFetch(`${this.endpoint.baseUrl}/services/aigc/text2image/image-synthesis`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResponse.ok) {
      const text = await submitResponse.text().catch(() => '');
      throw new Error(`Wanx submit error ${submitResponse.status}: ${text}`);
    }

    const submitData = await submitResponse.json();
    const taskId = submitData.output?.task_id;
    if (!taskId) throw new Error('Wanx: no task_id returned');

    // 轮询任务状态
    const deadline = startTime + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusResp = await httpFetch(`${this.endpoint.baseUrl}/tasks/${taskId}`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: this.timeoutSignal(30_000),
      });
      if (!statusResp.ok) {
        const text = await statusResp.text().catch(() => '');
        throw new Error(`Wanx status error ${statusResp.status}: ${text}`);
      }
      const statusData = await statusResp.json();
      const status = statusData.output?.task_status;
      if (status === 'SUCCEEDED') {
        const url = statusData.output?.results?.[0]?.url ?? '';
        return {
          imageData: this.normalizeImageSrc(url),
          width,
          height,
          model,
          provider: 'wanx',
          latencyMs: Date.now() - startTime,
        };
      }
      if (status === 'FAILED') {
        throw new Error(`Wanx task failed: ${statusData.output?.message ?? 'unknown'}`);
      }
      // PENDING / RUNNING 继续
    }
    throw new Error('Wanx task timed out (180s)');
  }
}

// --- 字节即梦 Jimeng API (火山方舟兼容) ---
// 走火山方舟 visual service,异步任务模式
// 文档:https://www.volcengine.com/docs/6791/1397048
// 这里走简化的 OpenAI 兼容路径 — 字节即梦 AIGC 图片生成
// POST {baseUrl}/api/v3/contents/generations/tasks (视觉)

export class JimengProvider extends BaseImageProvider {
  readonly providerId = 'jimeng';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    const model = request.model || 'doubao-seedream-3-0-t2i-250415';

    const body: Record<string, unknown> = {
      model,
      content: [
        {
          text: request.prompt,
          type: 'text',
        },
      ],
      parameters: {
        width,
        height,
        ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      },
    };
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'width', 'height', 'negativePrompt'],
      'parameters',
    );

    const submitResp = await httpFetch(`${this.endpoint.baseUrl}/api/v3/contents/generations/tasks`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      throw new Error(`Jimeng submit error ${submitResp.status}: ${text}`);
    }

    const submitData = await submitResp.json();
    const taskId = submitData.id;
    if (!taskId) throw new Error('Jimeng: no task id returned');

    const deadline = startTime + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const resp = await httpFetch(`${this.endpoint.baseUrl}/api/v3/contents/generations/tasks/${taskId}`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: this.timeoutSignal(30_000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Jimeng status error ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      const status = data.status;
      if (status === 'succeeded') {
        const url = data.content?.image_url ?? data.output?.image_url ?? '';
        return {
          imageData: this.normalizeImageSrc(url),
          width,
          height,
          model,
          provider: 'jimeng',
          latencyMs: Date.now() - startTime,
        };
      }
      if (status === 'failed') {
        throw new Error(`Jimeng task failed: ${data.error?.message ?? 'unknown'}`);
      }
    }
    throw new Error('Jimeng task timed out (180s)');
  }
}

// --- Ideogram API ---
// 文档:https://developer.ideogram.ai/api-reference#tag/Image-Generation/operation/generate
// POST {baseUrl}/v1/ideogram/v3/generate (form/multipart 或 json)

export class IdeogramProvider extends BaseImageProvider {
  readonly providerId = 'ideogram';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    const model = request.model || 'V_3';

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      aspect_ratio: pickIdeogramAspectRatio(width, height, request.aspectRatio),
      magic_prompt_option: 'OFF',
      num_images: 1,
    };

    if (request.negativePrompt) {
      body.negative_prompt = request.negativePrompt;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'aspectRatio', 'negativePrompt'],
    );

    const response = await httpFetch(`${this.endpoint.baseUrl}/ideogram/v1/generate`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ideogram API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];

    return {
      imageData: this.normalizeImageSrc(image?.url ?? ''),
      width,
      height,
      model,
      provider: 'ideogram',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Agnes Image API (Sapiens AI, OpenAI-compatible) ---
// 文档: https://agnes-ai.com/doc/agnes-image-21-flash
// POST {baseUrl}/v1/images/generations  (baseUrl 通常为 https://apihub.agnes-ai.com)
// 必填: model, prompt, size
// response_format 必须放在 extra_body 里,否则返回 400
// 返回 data[0].b64_json 或 data[0].url

export class AgnesImageProvider extends BaseImageProvider {
  readonly providerId = 'agnes-image';

  getWireParameterSnapshot(request: ImageGenerateRequest): Record<string, unknown> {
    return getAgnesImageWireParameterSnapshot(request);
  }

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const model = request.model?.trim() || 'agnes-image-2.1-flash';

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    // 用户填 `https://apihub.agnes-ai.com` 或 `https://apihub.agnes-ai.com/v1` 都兼容
    const url = /\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/images/generations`
      : `${baseUrl}/v1/images/generations`;

    const output = getAgnesImageOutput(request);

    const isImg2Img = !!request.referenceImages?.length;

    const extraBody: Record<string, unknown> = {
      response_format: isImg2Img ? 'b64_json' : 'url',
    };

    // 图生图: Agnes 官方要求在 extra_body.image 中传入 Data URI 或公网 URL 数组
    if (isImg2Img) {
      const cleaned: string[] = [];
      for (const r of request.referenceImages!) {
        let candidate = r;
        if (candidate && !candidate.startsWith('data:') && !isRemoteUrl(candidate)) {
          try {
            candidate = await readAsDataUri(candidate);
          } catch {}
        }
        const norm = normalizeForAgnes(candidate);
        if (norm) cleaned.push(norm);
      }
      if (cleaned.length > 0) {
        extraBody.image = cleaned;
      }
    }

    // 按照 Agnes 官方文档规范构造 Body (严禁在顶层放置 response_format)
    const body: Record<string, unknown> = {
      model,
      prompt: appendNegativeConstraints(request.prompt, request.negativePrompt),
      size: output.size,
      ratio: output.ratio,
      extra_body: extraBody,
    };

    if (!isImg2Img) {
      body.return_base64 = true;
    }

    // 注意: Agnes 官方 API 规范不支持 negative_prompt 字段，
    // 在 text image 队列传递 negative_prompt 会导致 HTTP 400 错误 ("negative_prompt is not supported by text image queue")。
    // 负向与解剖结构约束由各上游在 prompt 中以自然语言明确约束。

    if (request.seed !== undefined && request.seed !== null) {
      body.seed = request.seed;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'size', 'width', 'height', 'aspectRatio', 'seed', 'negativePrompt'],
    );

    const response = await httpFetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(180_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Agnes Image API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.data?.[0];
    const rawImage = image?.b64_json
      ? (image.b64_json.startsWith('data:') ? image.b64_json : `data:image/png;base64,${image.b64_json}`)
      : (image?.url ?? '');

    if (!rawImage) {
      throw new Error(`Agnes Image API returned empty image data: ${JSON.stringify(data)}`);
    }

    return {
      imageData: this.normalizeImageSrc(rawImage),
      width: output.width,
      height: output.height,
      model,
      provider: 'agnes-image',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Leonardo.ai Image API ---
// 文档: https://docs.leonardo.ai/
// POST {baseUrl}/rest/v1/generations  (baseUrl 通常为 https://api.leonardo.ai/v1)
// 鉴权: Bearer apiKey
// 异步任务: 返回 generationId,轮询 GET /rest/v1/generations/{id} 至 status=COMPLETE
// 结果字段: generations[0].url (公网 URL,临时有效)
//
// 字段名参考 Wanx 的 submit+poll 骨架;Leonardo 实际响应字段
// (generationId / generations / status) 在官方 SDK 与 REST 之间有大小写差异,
// 这里对结果做多名兼容,接入后建议用真实 key 跑一次校对。

export class LeonardoImageProvider extends BaseImageProvider {
  readonly providerId = 'leonardo';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    // Leonardo 用 modelId (UUID),不是 model 名。用户可在设置里填推荐 UUID。
    const modelId = request.model || 'b24a42c0-7a00-4cc4-9753-ca0962555099';

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    // 兼容用户填 `https://api.leonardo.ai/v1` 或 `.../v1/` 或不带版本。
    // 提交/轮询路径都挂在 /rest/v1 下。
    const base = /\/v\d+$/.test(baseUrl) ? baseUrl.replace(/\/v\d+$/, '/v1') : `${baseUrl}/v1`;

    const body: Record<string, unknown> = {
      prompt: request.prompt,
      modelId,
      width,
      height,
      num_images: 1,
      num_inference_steps: request.steps ?? 30,
      guidance_scale: request.guidanceScale ?? 7,
    };
    if (request.negativePrompt) {
      body.negative_prompt = request.negativePrompt;
    }
    if (request.seed !== undefined) {
      body.seed = request.seed;
    }
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'],
    );

    const submitResp = await httpFetch(`${base}/rest/v1/generations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(60_000),
    });

    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '');
      throw new Error(`Leonardo submit error ${submitResp.status}: ${text.slice(0, 500)}`);
    }

    const submitData = await submitResp.json();
    // 兼容字段名:generationId / sd_generation_job.generation_id
    const generationId =
      submitData.generationId ??
      submitData.sd_generation_job?.generation_id ??
      submitData.id;
    if (!generationId) {
      throw new Error(`Leonardo: no generationId returned (got ${JSON.stringify(submitData).slice(0, 200)})`);
    }

    // 轮询任务状态 —— 完全照搬 Wanx 的 while 循环。
    const deadline = startTime + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusResp = await httpFetch(`${base}/rest/v1/generations/${generationId}`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: this.timeoutSignal(30_000),
      });
      if (!statusResp.ok) {
        const text = await statusResp.text().catch(() => '');
        throw new Error(`Leonardo status error ${statusResp.status}: ${text.slice(0, 500)}`);
      }
      const statusData = await statusResp.json();
      const status = String(statusData.status ?? '').toUpperCase();
      if (status === 'COMPLETE') {
        // 兼容 generations / generated_images 两种结果字段名
        const gen = statusData.generations?.[0] ?? statusData.generated_images?.[0];
        const url = gen?.url ?? '';
        if (!url) {
          throw new Error('Leonardo: generation complete but no image url returned');
        }
        return {
          imageData: this.normalizeImageSrc(url),
          width,
          height,
          model: modelId,
          provider: 'leonardo',
          latencyMs: Date.now() - startTime,
        };
      }
      if (status === 'FAILED') {
        const reason =
          statusData.error?.message ||
          statusData.failure_reason ||
          statusData.error_details ||
          JSON.stringify(statusData).slice(0, 300);
        throw new Error(`Leonardo task failed: ${reason}`);
      }
      // PENDING / RUNNING 继续轮询
    }
    throw new Error('Leonardo task timed out (180s)');
  }
}

function inferDalleSize(width?: number, height?: number, aspectRatio?: string): string {
  if (aspectRatio === '9:16') return '1024x1792';
  if (aspectRatio === '16:9') return '1792x1024';
  if (width && height) {
    const ratio = width / height;
    if (ratio > 1.35) return '1792x1024';
    if (ratio < 0.75) return '1024x1792';
  }
  return '1024x1024';
}

function parseImageSize(size: string): [number, number] {
  const match = size.match(/^(\d+)x(\d+)$/);
  return match ? [Number(match[1]), Number(match[2])] : [1024, 1024];
}

// --- SiliconFlow OpenAI-compatible image API ---

export class SiliconFlowImageProvider extends BaseImageProvider {
  readonly providerId = 'siliconflow-image';

  async generate(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const startTime = Date.now();
    const width = request.width ?? 1024;
    const height = request.height ?? 1024;
    const model = request.model || 'black-forest-labs/FLUX.1-schnell';
    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const url = /\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/images/generations`
      : `${baseUrl}/v1/images/generations`;
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      image_size: `${width}x${height}`,
    };
    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (request.steps !== undefined) body.num_inference_steps = request.steps;
    if (request.guidanceScale !== undefined) body.guidance_scale = request.guidanceScale;
    if (request.seed !== undefined) body.seed = request.seed;
    applyUnconsumedGenerationParameters(
      body,
      request,
      ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'],
    );

    const response = await httpFetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(300_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`SiliconFlow Image API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const image = data.images?.[0] ?? data.data?.[0];
    const imageData = this.normalizeImageSrc(image?.url ?? image?.b64_json ?? image ?? '');
    if (!imageData) throw new Error('SiliconFlow Image API returned empty image data');
    return {
      imageData,
      width,
      height,
      model,
      provider: 'siliconflow-image',
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
    case 'cogview':
      return new CogViewProvider(endpoint);
    case 'wanx':
      return new WanxProvider(endpoint);
    case 'jimeng':
      return new JimengProvider(endpoint);
    case 'ideogram':
      return new IdeogramProvider(endpoint);
    case 'agnes-image':
      return new AgnesImageProvider(endpoint);
    case 'leonardo':
      return new LeonardoImageProvider(endpoint);
    case 'siliconflow-image':
      return new SiliconFlowImageProvider(endpoint);
    case 'custom':
      return new DALLEProvider(endpoint);
    default:
      throw new Error(`No image adapter is implemented for provider ${providerId}`);
  }
}

/**
 * Agnes Image 的引用图归一化。
 *
 * Agnes 文档明确要求 `image` 数组元素是「公网 URL 或 Data URI Base64」,
 * 且 Data URI 必须保留 `data:image/...;base64,` 前缀 —— 剥掉前缀会触发 400 'invalid input image'。
 *
 * - 完整 data URI(`data:image/png;base64,XXX`):原样返回,保留前缀
 * - 公网 https URL:原样返回
 * - 本地 URL(asset.localhost / blob: / file: / 绝对路径 / webview URL):返回 null,由调用方抛错
 *   因为 Agnes 后端拉不到本地 webview URL,必须先在调用方转成 data URI。
 */
function normalizeForAgnes(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  // 完整 data URI —— 保留前缀(Agnes 的硬性要求)
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(trimmed)) {
    return trimmed;
  }

  // 排除本地 webview URL 与 localhost 链接(云端无法访问本地回环)
  if (/^https?:\/\/(asset\.localhost|localhost|127\.0\.0\.1|tauri\.localhost)/i.test(trimmed)) {
    return null;
  }

  // 真正的公网 http(s) URL —— 原样返回
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function appendNegativeConstraints(prompt: string, negativePrompt?: string): string {
  const negative = negativePrompt?.trim();
  if (!negative) return prompt;
  return `${prompt.trim()}\n\n[Negative constraints]\nDo not include: ${negative}\n\n[Reference priority]\nWhen a negative constraint conflicts with a bound subject record or reference image, preserve the bound subject record and reference image.`;
}

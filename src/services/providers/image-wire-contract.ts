import type { ImageGenerateRequest } from '@/types/providers';
import { applyUnconsumedGenerationParameters } from './parameter-transport.ts';
import { fingerprintPayload } from './generation-snapshot.ts';

/** AUTOMATIC1111 WebUI contract: grayscale white selects the pixels to repaint. */
export function buildSDWebUIRequest(request: ImageGenerateRequest, redacted = false) {
  const images = request.referenceImages?.filter(Boolean) ?? [];
  if (images.length > 1 || request.mask && images.length !== 1) throw new Error('SD WebUI image editing requires one source image');
  const body: Record<string, unknown> = {
    ...(request.model ? { override_settings: { sd_model_checkpoint: request.model } } : {}),
    prompt: request.prompt, negative_prompt: request.negativePrompt ?? '', width: request.width ?? 1024, height: request.height ?? 1024,
    steps: request.steps ?? 30, cfg_scale: request.guidanceScale ?? 7, sampler_name: 'DPM++ 2M Karras',
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(images.length ? { init_images: redacted ? { count: 1 } : images, denoising_strength: request.editStrength ?? 0.65, include_init_images: false } : {}),
    ...(request.mask ? { mask: redacted ? { fingerprint: fingerprintPayload(request.mask) } : request.mask, mask_blur: 0, inpainting_mask_invert: 0, inpaint_full_res: false } : {}),
  };
  applyUnconsumedGenerationParameters(body, request, ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale', 'editStrength']);
  return { path: images.length ? '/sdapi/v1/img2img' : '/sdapi/v1/txt2img', body };
}

const AGNES_IMAGE_DIMENSIONS = {
  '1:1': [1024, 1024],
  '3:4': [864, 1152],
  '4:3': [1152, 864],
  '16:9': [1312, 736],
  '9:16': [736, 1312],
  '2:3': [832, 1248],
  '3:2': [1248, 832],
  '21:9': [1568, 672],
} as const;
const AGNES_IMAGE_RATIOS = Object.keys(AGNES_IMAGE_DIMENSIONS) as Array<keyof typeof AGNES_IMAGE_DIMENSIONS>;

/** Map normalized image inputs to the fields Agnes actually accepts. */
export function pickAgnesImageRatio(width: number, height: number, explicit?: string): keyof typeof AGNES_IMAGE_DIMENSIONS {
  if (explicit && Object.prototype.hasOwnProperty.call(AGNES_IMAGE_DIMENSIONS, explicit)) return explicit as keyof typeof AGNES_IMAGE_DIMENSIONS;
  if (!(width > 0 && height > 0)) return '1:1';
  const ratio = width / height;
  return AGNES_IMAGE_RATIOS.reduce((closest, candidate) => {
    const [w, h] = candidate.split(':').map(Number);
    const [cw, ch] = closest.split(':').map(Number);
    return Math.abs(w / h - ratio) < Math.abs(cw / ch - ratio) ? candidate : closest;
  }, '1:1');
}

/** Video production assets default to 2K; explicit tiers always take precedence. */
export function getAgnesImageOutput(request: ImageGenerateRequest) {
  const ratio = pickAgnesImageRatio(request.width ?? 1024, request.height ?? 1024, request.aspectRatio);
  const [baseWidth, baseHeight] = AGNES_IMAGE_DIMENSIONS[ratio];
  const explicitSize = request.size ?? request.parameters?.size;
  if (explicitSize !== undefined && (typeof explicitSize !== 'string' || !/^[1-4]K$/i.test(explicitSize))) {
    throw new Error('Agnes Image size must be 1K, 2K, 3K, or 4K');
  }
  const productionAsset = ['character', 'scene', 'storyboard'].includes(request.taskType);
  const scale = explicitSize
    ? Number(String(explicitSize)[0])
    : Math.min(4, Math.max(productionAsset ? 2 : 1, Math.ceil(Math.max(
        (request.width ?? baseWidth) / baseWidth,
        (request.height ?? baseHeight) / baseHeight,
      ))));
  return { size: `${scale}K`, ratio, width: baseWidth * scale, height: baseHeight * scale };
}

/** Return a redacted snapshot of the exact Agnes wire shape. */
export function getAgnesImageWireParameterSnapshot(
  request: ImageGenerateRequest,
): Record<string, unknown> {
  const model = request.model?.trim() || 'agnes-image-2.1-flash';
  const output = getAgnesImageOutput(request);
  const referenceImageCount = request.referenceImages?.filter(Boolean).length ?? 0;
  const hasReferences = referenceImageCount > 0;
  const wire: Record<string, unknown> = {
    model,
    size: output.size,
    ratio: output.ratio,
    extra_body: {
      response_format: hasReferences ? 'b64_json' : 'url',
      ...(hasReferences ? { image: { count: referenceImageCount } } : {}),
    },
    ...(hasReferences ? {} : { return_base64: true }),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    referenceImageCount,
  };
  applyUnconsumedGenerationParameters(
    wire,
    request,
    ['model', 'size', 'width', 'height', 'aspectRatio', 'seed', 'negativePrompt'],
  );
  return wire;
}

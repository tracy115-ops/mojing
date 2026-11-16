import type {
  EndpointGenerationCapabilities,
  GenerationParameterSpec,
  GenerationParameterTransport,
  GenerationParameterType,
  LLMGenerationCapabilities,
  LLMModelCapabilityOverride,
  LLMProviderId,
  ImageGenerationCapabilities,
  ImageModelCapabilityOverride,
  ImageModelCapability,
  ImageProviderId,
  VideoGenerationCapabilities,
  VideoModelCapabilityOverride,
  VideoModelCapability,
  VideoProviderId,
  VideoControlMode,
  VideoResolutionTier,
  VideoMediaReference,
  VideoMediaReferenceCapability,
} from '../../types/providers.ts';
import { validateVideoMediaReferences } from './video-media-contract.ts';
import { hasImageMaskAdapter } from './image-edit-contract.ts';

type ImageProfile = Omit<ImageGenerationCapabilities, 'model' | 'endpointId'> & {
  defaultModel: string;
  modelRules?: Array<{
    matches: (model: string) => boolean;
    parameters: GenerationParameterSpec[];
    references: ImageGenerationCapabilities['references'];
  }>;
};

type VideoProfile = Omit<VideoGenerationCapabilities, 'model' | 'endpointId'> & {
  defaultModel: string;
  modelRules?: Array<{
    matches: (model: string) => boolean;
    parameters: GenerationParameterSpec[];
    references: VideoGenerationCapabilities['references'];
    resolutionTiers?: VideoResolutionTier[];
  }>;
};

const spec = (
  key: string,
  type: GenerationParameterSpec['type'],
  description: string,
  options: Partial<GenerationParameterSpec> = {},
): GenerationParameterSpec => ({ key, type, description, ...options });

const noImageReferences: ImageGenerationCapabilities['references'] = {
  supported: false,
  maxImages: 0,
  mode: 'none',
  supportsReferenceRoles: false,
};

const singleImageReference: ImageGenerationCapabilities['references'] = {
  supported: true,
  maxImages: 1,
  mode: 'single',
  supportsReferenceRoles: false,
};

const multipleImageReferences = (maxImages: number): ImageGenerationCapabilities['references'] => ({
  supported: true,
  maxImages,
  mode: 'multiple',
  supportsReferenceRoles: false,
});

const noVideoReferences: VideoGenerationCapabilities['references'] = {
  supported: false,
  maxImages: 0,
  mode: 'none',
  supportsFirstFrame: false,
  supportsLastFrame: false,
  supportsSubjectReferences: false,
};

const firstFrameVideoReference: VideoGenerationCapabilities['references'] = {
  supported: true,
  maxImages: 1,
  mode: 'first_frame',
  supportsFirstFrame: true,
  supportsLastFrame: false,
  supportsSubjectReferences: false,
};

const firstLastVideoReference: VideoGenerationCapabilities['references'] = {
  supported: true,
  maxImages: 2,
  mode: 'first_last',
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsSubjectReferences: false,
};

const subjectVideoReference = (maxImages: number, supportsFirstLast = false): VideoGenerationCapabilities['references'] => ({
  supported: true,
  maxImages,
  mode: supportsFirstLast ? 'multiple' : 'subject_references',
  supportsFirstFrame: supportsFirstLast,
  supportsLastFrame: supportsFirstLast,
  supportsSubjectReferences: true,
});

const mediaReference = (maxCount: number, seconds: number, kind: 'audio' | 'video', allowData = false): VideoMediaReferenceCapability => ({
  maxCount, transport: allowData ? 'public_url_or_data' : 'public_url', minSeconds: 2, maxSeconds: seconds, maxTotalSeconds: seconds,
  maxBytes: (kind === 'audio' ? 15 : 200) * 1024 * 1024,
  mimeTypes: kind === 'audio' ? ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave'] : ['video/mp4', 'video/quicktime'],
});
const agnesReferences = (flash: boolean): VideoGenerationCapabilities['references'] => ({
  ...subjectVideoReference(flash ? 5 : 8, true), audio: mediaReference(3, 12, 'audio'),
  ...(flash ? {} : { video: { ...mediaReference(1, 12, 'video'), maxBytes: 50 * 1024 * 1024 } }), maxTotalMedia: 12,
});
const seedanceReferences = (v25 = false, flash = false): VideoGenerationCapabilities['references'] => ({
  ...subjectVideoReference(v25 ? flash ? 10 : 30 : 9, true),
  audio: mediaReference(v25 ? flash ? 5 : 10 : 3, v25 ? 30 : 15, 'audio', true),
  video: mediaReference(v25 ? flash ? 5 : 10 : 3, v25 ? 30 : 15, 'video'), audioRequiresVisual: !v25,
});
const generateAudio = spec('generateAudio', 'boolean', 'Generate native synchronized audio. The project pipeline keeps this disabled.');

const resolutionTier = (
  id: string,
  shortEdge: number,
  label = id.toUpperCase(),
): VideoResolutionTier => ({ id, label, shortEdge });

const video720p: VideoResolutionTier[] = [resolutionTier('720p', 720, '720p')];
const video720p1080p: VideoResolutionTier[] = [
  resolutionTier('720p', 720, '720p'),
  resolutionTier('1080p', 1080, '1080p'),
];

const imageCommon = [
  spec('model', 'string', 'Provider model identifier.'),
  spec('width', 'integer', 'Output width in pixels.', { min: 64 }),
  spec('height', 'integer', 'Output height in pixels.', { min: 64 }),
  spec('negativePrompt', 'string', 'Content or visual traits to avoid.'),
  spec('seed', 'integer', 'Deterministic random seed.', { min: 0 }),
  spec('style', 'string', 'Provider style preset or style hint.'),
  spec('quality', 'string', 'Provider quality tier.'),
  spec('steps', 'integer', 'Inference step count.', { min: 1 }),
  spec('guidanceScale', 'number', 'Prompt adherence scale.', { min: 0 }),
];

const videoCommon = [
  spec('model', 'string', 'Provider model identifier.'),
  spec('durationSeconds', 'number', 'Requested clip duration in seconds.', { min: 1 }),
  spec('fps', 'integer', 'Requested output frame rate.', { min: 1 }),
  spec('width', 'integer', 'Output width in pixels.', { min: 64 }),
  spec('height', 'integer', 'Output height in pixels.', { min: 64 }),
  spec('aspectRatio', 'enum', 'Output aspect ratio.', {
    enumValues: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  }),
  spec('negativePrompt', 'string', 'Content or motion traits to avoid.'),
  spec('seed', 'integer', 'Deterministic random seed.', { min: 0 }),
  spec('numInferenceSteps', 'integer', 'Inference step count.', { min: 1 }),
  spec('mode', 'string', 'Provider-specific generation mode.'),
];

const ideogramAspectRatio = spec('aspectRatio', 'enum', 'Ideogram output aspect ratio.', {
  enumValues: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '2:1', '1:2', '3:1', '1:3'],
});
const dalleSize = spec('size', 'enum', 'DALL-E output size.', {
  enumValues: ['1024x1024', '1792x1024', '1024x1792'],
});
const durationFiveOrTen = spec('durationSeconds', 'number', 'Requested clip duration in seconds.', {
  allowedValues: [5, 10],
});
const durationFourOrEight = spec('durationSeconds', 'number', 'Requested clip duration in seconds.', {
  allowedValues: [4, 8],
});
const durationFourToFifteen = spec('durationSeconds', 'integer', 'Requested clip duration in seconds.', {
  min: 4,
  max: 15,
});
const durationFourToThirty = spec('durationSeconds', 'integer', 'Requested clip duration in seconds.', {
  min: 4,
  max: 30,
});
const durationFourToTwelve = spec('durationSeconds', 'integer', 'Requested clip duration in seconds.', {
  min: 4,
  max: 12,
});
const durationTwoToEighteen = spec('durationSeconds', 'number', 'Requested clip duration in seconds.', {
  min: 2,
  max: 18,
});

const IMAGE_PROFILES: Partial<Record<ImageProviderId, ImageProfile>> = {
  dalle: {
    modality: 'image',
    provider: 'dalle',
    defaultModel: 'dall-e-3',
    parameters: [
      imageCommon[0], dalleSize,
      spec('quality', 'enum', 'DALL-E quality tier.', { enumValues: ['standard', 'hd'] }),
      spec('style', 'enum', 'DALL-E visual style.', { enumValues: ['vivid', 'natural'] }),
    ],
    references: noImageReferences,
  },
  'stable-diffusion': {
    modality: 'image',
    provider: 'stable-diffusion',
    defaultModel: 'stable-diffusion',
    parameters: [...imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'].includes(item.key)), spec('editStrength', 'number', 'Image-to-image denoising strength.', { min: 0, max: 1 })],
    references: { ...singleImageReference, maskSupported: true },
  },
  flux: {
    modality: 'image',
    provider: 'flux',
    defaultModel: 'flux',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'].includes(item.key)),
    references: noImageReferences,
  },
  comfyui: {
    modality: 'image',
    provider: 'comfyui',
    defaultModel: 'comfyui',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'].includes(item.key)),
    references: noImageReferences,
  },
  'kling-image': {
    modality: 'image',
    provider: 'kling-image',
    defaultModel: 'kling-v1',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt'].includes(item.key)),
    references: singleImageReference,
  },
  cogview: {
    modality: 'image',
    provider: 'cogview',
    defaultModel: 'cogview-3-plus',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height'].includes(item.key)),
    references: noImageReferences,
  },
  wanx: {
    modality: 'image',
    provider: 'wanx',
    defaultModel: 'wanx-v1',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt'].includes(item.key)),
    references: noImageReferences,
  },
  jimeng: {
    modality: 'image',
    provider: 'jimeng',
    defaultModel: 'doubao-seedream-3-0-t2i-250415',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt'].includes(item.key)),
    references: noImageReferences,
  },
  ideogram: {
    modality: 'image',
    provider: 'ideogram',
    defaultModel: 'V_3',
    parameters: [
      imageCommon[0], ideogramAspectRatio, imageCommon[3],
    ],
    references: noImageReferences,
  },
  'agnes-image': {
    modality: 'image',
    provider: 'agnes-image',
    defaultModel: 'agnes-image-2.1-flash',
    parameters: [
      imageCommon[0],
      imageCommon[1], imageCommon[2],
      spec('size', 'enum', 'Native image resolution tier; production assets default to 2K.', { enumValues: ['1K', '2K', '3K', '4K'] }),
      spec('aspectRatio', 'enum', 'Agnes output aspect ratio.', { enumValues: ['16:9', '9:16', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'] }),
      spec('negativePrompt', 'string', 'Content or visual traits to avoid; translated into the provider prompt because Agnes has no native negative-prompt field.'),
      imageCommon[4],
    ],
    references: multipleImageReferences(4),
  },
  leonardo: {
    modality: 'image',
    provider: 'leonardo',
    defaultModel: 'b24a42c0-7a00-4cc4-9753-ca0962555099',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'].includes(item.key)),
    references: noImageReferences,
  },
  midjourney: {
    modality: 'image',
    provider: 'midjourney',
    defaultModel: 'default',
    parameters: [imageCommon[0]],
    references: noImageReferences,
  },
  'siliconflow-image': {
    modality: 'image',
    provider: 'siliconflow-image',
    defaultModel: 'black-forest-labs/FLUX.1-schnell',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height', 'negativePrompt', 'seed', 'steps', 'guidanceScale'].includes(item.key)),
    references: noImageReferences,
  },
  custom: {
    modality: 'image',
    provider: 'custom',
    defaultModel: 'default',
    parameters: imageCommon.filter((item) => ['model', 'width', 'height'].includes(item.key)),
    references: noImageReferences,
  },
};

const VIDEO_PROFILES: Partial<Record<VideoProviderId, VideoProfile>> = {
  sora: {
    modality: 'video', provider: 'sora', defaultModel: 'sora-1',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'aspectRatio', 'width', 'height'].includes(item.key)),
    references: noVideoReferences,
    resolutionTiers: video720p1080p,
  },
  runway: {
    modality: 'video', provider: 'runway', defaultModel: 'gen4_turbo',
    parameters: [videoCommon[0], durationFiveOrTen, videoCommon[5]],
    references: firstLastVideoReference,
    resolutionTiers: video720p1080p,
  },
  kling: {
    modality: 'video', provider: 'kling', defaultModel: 'kling-v2',
    parameters: [videoCommon[0], durationFiveOrTen, videoCommon[5], videoCommon[7]],
    references: firstLastVideoReference,
    resolutionTiers: video720p1080p,
  },
  vidu: {
    modality: 'video', provider: 'vidu', defaultModel: 'vidu-1.5',
    parameters: [videoCommon[0], durationFourOrEight, videoCommon[5]],
    references: firstLastVideoReference,
    resolutionTiers: video720p1080p,
  },
  pika: {
    modality: 'video', provider: 'pika', defaultModel: 'pika-1.0',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'aspectRatio'].includes(item.key)),
    references: firstFrameVideoReference,
    resolutionTiers: video720p,
  },
  'agnes-video': {
    modality: 'video', provider: 'agnes-video', defaultModel: 'agnes-video-2.5-flash',
    // Agnes 2.5 accepts normalized duration and dimensions through the
    // adapter, which maps them to its native `seconds` and `size` fields.
    // Keep these inputs in the contract so the router does not silently drop
    // the pipeline's requested shot duration or output resolution.
    parameters: [videoCommon[0], durationFourToTwelve, videoCommon[3], videoCommon[4], videoCommon[5], videoCommon[7]],
    references: agnesReferences(true),
    resolutionTiers: video720p,
    modelRules: [
      {
        // Agnes 2.5 without the Flash suffix exposes the higher tier. Keep
        // this model rule explicit so a bare `agnes-video-2.5` is not treated
        // as the Flash-only 720p variant.
        matches: (model) => /(?:2\.5(?!.*flash)|\bpro\b)/i.test(model),
        parameters: [videoCommon[0], durationFourToTwelve, videoCommon[3], videoCommon[4], videoCommon[5], videoCommon[7]],
        references: agnesReferences(false),
        resolutionTiers: video720p1080p,
      },
      {
        matches: (model) => /2\.0|v2\.0/i.test(model),
        parameters: [
          videoCommon[0], durationTwoToEighteen, videoCommon[3], videoCommon[4], videoCommon[6], videoCommon[7], videoCommon[8], videoCommon[9],
        ],
        references: firstLastVideoReference,
        resolutionTiers: video720p,
      },
    ],
  },
  'doubao-video': {
    modality: 'video', provider: 'doubao-video', defaultModel: 'doubao-seedance-2-0-260128',
    parameters: [videoCommon[0], durationFourToFifteen, videoCommon[5], videoCommon[3], videoCommon[4], videoCommon[7], generateAudio],
    references: seedanceReferences(),
    resolutionTiers: video720p1080p,
    modelRules: [
      {
        matches: (model) => /seedance-2-5.*(?:fast|flash)/i.test(model),
        parameters: [videoCommon[0], durationFourToThirty, videoCommon[5], videoCommon[3], videoCommon[4], videoCommon[7], generateAudio],
        references: seedanceReferences(true, true),
        resolutionTiers: video720p,
      },
      {
        matches: (model) => /seedance-2-5/i.test(model),
        parameters: [videoCommon[0], durationFourToThirty, videoCommon[5], videoCommon[3], videoCommon[4], videoCommon[7], generateAudio],
        references: seedanceReferences(true),
        resolutionTiers: video720p1080p,
      },
      {
        matches: (model) => /fast|flash/i.test(model),
        parameters: [videoCommon[0], durationFourToFifteen, videoCommon[5], videoCommon[3], videoCommon[4], videoCommon[7], generateAudio],
        references: seedanceReferences(),
        resolutionTiers: video720p,
      },
    ],
  },
  'minimax-video': {
    modality: 'video', provider: 'minimax-video', defaultModel: 'MiniMax-Hailuo-02',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'aspectRatio'].includes(item.key)),
    references: firstFrameVideoReference,
    resolutionTiers: video720p,
  },
  cogvideo: {
    modality: 'video', provider: 'cogvideo', defaultModel: 'cogvideox-5b',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'width', 'height', 'seed'].includes(item.key)),
    references: firstFrameVideoReference,
    resolutionTiers: video720p,
  },
  '302ai-video': {
    modality: 'video', provider: '302ai-video', defaultModel: 'default',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'aspectRatio'].includes(item.key)),
    references: firstFrameVideoReference,
    resolutionTiers: video720p,
  },
  'siliconflow-video': {
    modality: 'video', provider: 'siliconflow-video', defaultModel: 'Wan-AI/Wan2.2-T2V-A14B',
    parameters: [videoCommon[0], videoCommon[7]],
    references: noVideoReferences,
    resolutionTiers: video720p,
    modelRules: [
      {
        matches: (model) => /i2v/i.test(model),
        parameters: [videoCommon[0], videoCommon[7]],
        references: firstFrameVideoReference,
        resolutionTiers: video720p,
      },
    ],
  },
  'leonardo-video': {
    modality: 'video', provider: 'leonardo-video', defaultModel: 'leonardo-motion',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'negativePrompt'].includes(item.key)),
    references: firstFrameVideoReference,
    resolutionTiers: video720p,
  },
  custom: {
    modality: 'video', provider: 'custom', defaultModel: 'default',
    parameters: videoCommon.filter((item) => ['model', 'durationSeconds', 'aspectRatio'].includes(item.key)),
    references: noVideoReferences,
    resolutionTiers: video720p,
  },
};

// Keep these lists aligned with the provider factories. A provider may still
// be visible in Settings before its adapter exists, but it must not be
// advertised to the planner as executable.
const IMAGE_ADAPTER_PROVIDERS = new Set<ImageProviderId>([
  'dalle',
  'stable-diffusion',
  'flux',
  'comfyui',
  'kling-image',
  'cogview',
  'wanx',
  'jimeng',
  'ideogram',
  'agnes-image',
  'leonardo',
  'siliconflow-image',
  'custom',
]);

const VIDEO_ADAPTER_PROVIDERS = new Set<VideoProviderId>([
  'runway',
  'kling',
  'vidu',
  'agnes-video',
  'doubao-video',
  'leonardo-video',
  'siliconflow-video',
]);

const genericImageProfile: ImageProfile = {
  modality: 'image',
  provider: 'custom',
  defaultModel: 'default',
  parameters: [imageCommon[0]],
  references: noImageReferences,
};

const genericVideoProfile: VideoProfile = {
  modality: 'video',
  provider: 'custom',
  defaultModel: 'default',
  parameters: [videoCommon[0]],
  references: noVideoReferences,
  resolutionTiers: video720p,
};

const VISION_MODEL_HINT = /(vision|vl|gpt-4o|gpt-4\.1|gpt-4\.5|o1|o3|claude-3|claude-sonnet-4|gemini)/i;

/**
 * LLM visual input is opt-in for custom endpoints. Known vision model names
 * receive a conservative default, while proxies can declare the exact
 * contract in endpoint.generationCapabilities.llm.
 */
export function getLLMGenerationCapabilities(
  provider: LLMProviderId,
  model: string,
  endpointId?: string,
  override?: LLMModelCapabilityOverride,
): LLMGenerationCapabilities {
  const supportsImageInputs = override?.supportsImageInputs
    ?? (provider !== 'deepseek' && VISION_MODEL_HINT.test(model));
  const maxImageInputs = override?.maxImageInputs ?? (supportsImageInputs ? 6 : 0);
  return {
    modality: 'llm',
    provider,
    model,
    endpointId,
    supportsImageInputs,
    maxImageInputs: Math.max(0, Math.floor(maxImageInputs)),
  };
}

function uniqueSpecs(parameters: GenerationParameterSpec[]): GenerationParameterSpec[] {
  return Array.from(new Map(parameters.map((item) => [item.key, item])).values());
}

export function getImageGenerationCapabilities(
  provider: ImageProviderId,
  model?: string,
  endpointId?: string,
  override?: ImageModelCapabilityOverride,
): ImageGenerationCapabilities {
  const profile = IMAGE_PROFILES[provider] ?? genericImageProfile;
  const adapterAvailable = IMAGE_ADAPTER_PROVIDERS.has(provider);
  const resolvedModel = model?.trim() || profile.defaultModel;
  const rule = adapterAvailable ? profile.modelRules?.find((candidate) => candidate.matches(resolvedModel)) : undefined;
  const references = adapterAvailable ? (override?.references ?? rule?.references ?? profile.references) : noImageReferences;
  const parameters = adapterAvailable ? uniqueSpecs(override?.parameters ?? rule?.parameters ?? profile.parameters) : [];
  if (references.maskSupported && hasImageMaskAdapter(provider) && !parameters.some((item) => item.key === 'editStrength')) {
    parameters.push(spec('editStrength', 'number', 'Image-to-image denoising strength.', { min: 0, max: 1 }));
  }
  return {
    modality: 'image',
    provider,
    model: resolvedModel,
    adapterAvailable,
    endpointId,
    parameters,
    references: references.maskSupported && !hasImageMaskAdapter(provider) ? { ...references, maskSupported: false } : references,
  };
}

export function getVideoGenerationCapabilities(
  provider: VideoProviderId,
  model?: string,
  endpointId?: string,
  override?: VideoModelCapabilityOverride,
): VideoGenerationCapabilities {
  const profile = VIDEO_PROFILES[provider] ?? genericVideoProfile;
  const adapterAvailable = VIDEO_ADAPTER_PROVIDERS.has(provider);
  const resolvedModel = model?.trim() || profile.defaultModel;
  const rule = adapterAvailable ? profile.modelRules?.find((candidate) => candidate.matches(resolvedModel)) : undefined;
  return {
    modality: 'video',
    provider,
    model: resolvedModel,
    adapterAvailable,
    endpointId,
    parameters: adapterAvailable ? uniqueSpecs(override?.parameters ?? rule?.parameters ?? profile.parameters) : [],
    references: adapterAvailable ? (override?.references ?? rule?.references ?? profile.references) : noVideoReferences,
    resolutionTiers: adapterAvailable
      ? (override?.resolutionTiers ?? rule?.resolutionTiers ?? profile.resolutionTiers)
      : [],
  };
}

export function getImageModelCapabilities(
  provider: ImageProviderId,
  models: string[],
  endpointId?: string,
  overrides?: EndpointGenerationCapabilities['image'],
): ImageModelCapability[] {
  return models
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => {
      const capabilities = getImageGenerationCapabilities(provider, model, endpointId, overrides?.[model]);
      return {
        model,
        parameters: capabilities.parameters,
        references: capabilities.references,
      };
    });
}

export function getVideoModelCapabilities(
  provider: VideoProviderId,
  models: string[],
  endpointId?: string,
  overrides?: EndpointGenerationCapabilities['video'],
): VideoModelCapability[] {
  return models
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => {
      const capabilities = getVideoGenerationCapabilities(provider, model, endpointId, overrides?.[model]);
      return {
        model,
        parameters: capabilities.parameters,
        references: capabilities.references,
        resolutionTiers: capabilities.resolutionTiers,
      };
    });
}

export interface FilteredGenerationParameters {
  values: Record<string, unknown>;
  acceptedKeys: string[];
  rejectedKeys: string[];
}

/** Parse the optional JSON contract stored on an endpoint. */
export function parseEndpointGenerationCapabilities(
  raw: string | undefined,
): EndpointGenerationCapabilities | undefined {
  const text = raw?.trim();
  if (!text) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Generation capability contract must be valid JSON');
  }
  const root = asRecord(parsed, 'contract');
  const result: EndpointGenerationCapabilities = {};

  for (const key of Object.keys(root)) {
    if (key !== 'llm' && key !== 'image' && key !== 'video') {
      throw new Error(`Unsupported capability section "${key}"; use llm, image, or video`);
    }
  }
  if (root.llm !== undefined) result.llm = parseLLMModelCapabilityOverrides(root.llm);
  if (root.image !== undefined) result.image = parseModelCapabilityOverrides(root.image, 'image');
  if (root.video !== undefined) result.video = parseModelCapabilityOverrides(root.video, 'video');
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseLLMModelCapabilityOverrides(
  value: unknown,
): NonNullable<EndpointGenerationCapabilities['llm']> {
  const models = asRecord(value, 'llm models');
  const result: NonNullable<EndpointGenerationCapabilities['llm']> = {};
  for (const [model, rawOverride] of Object.entries(models)) {
    if (!model.trim()) throw new Error('llm capability model name cannot be empty');
    const override = asRecord(rawOverride, `llm.${model}`);
    for (const key of Object.keys(override)) {
      if (key !== 'supportsImageInputs' && key !== 'maxImageInputs') {
        throw new Error(`Unsupported field "llm.${model}.${key}"`);
      }
    }
    const supportsImageInputs = override.supportsImageInputs === undefined
      ? undefined
      : booleanField(override.supportsImageInputs, `llm.${model}.supportsImageInputs`);
    const maxImageInputs = override.maxImageInputs === undefined
      ? undefined
      : nonNegativeInteger(override.maxImageInputs, `llm.${model}.maxImageInputs`);
    result[model] = {
      ...(supportsImageInputs === undefined ? {} : { supportsImageInputs }),
      ...(maxImageInputs === undefined ? {} : { maxImageInputs }),
    };
  }
  return result;
}

function parseModelCapabilityOverrides(
  value: unknown,
  modality: 'image',
): NonNullable<EndpointGenerationCapabilities['image']>;
function parseModelCapabilityOverrides(
  value: unknown,
  modality: 'video',
): NonNullable<EndpointGenerationCapabilities['video']>;
function parseModelCapabilityOverrides(
  value: unknown,
  modality: 'image' | 'video',
): EndpointGenerationCapabilities['image'] | EndpointGenerationCapabilities['video'] {
  const models = asRecord(value, `${modality} models`);
  const result: Record<string, ImageModelCapabilityOverride | VideoModelCapabilityOverride> = {};

  for (const [model, rawOverride] of Object.entries(models)) {
    if (!model.trim()) throw new Error(`${modality} capability model name cannot be empty`);
    const override = asRecord(rawOverride, `${modality}.${model}`);
    for (const key of Object.keys(override)) {
      if (key !== 'parameters' && key !== 'references' && key !== 'resolutionTiers') {
        throw new Error(`Unsupported field "${modality}.${model}.${key}"`);
      }
      if (modality === 'image' && key === 'resolutionTiers') {
        throw new Error(`Unsupported field "${modality}.${model}.${key}"`);
      }
    }
    const parameters = override.parameters === undefined
      ? undefined
      : parseParameterSpecs(override.parameters, `${modality}.${model}.parameters`);
    const references = override.references === undefined
      ? undefined
      : modality === 'image'
        ? parseImageReferences(override.references, `${modality}.${model}.references`)
        : parseVideoReferences(override.references, `${modality}.${model}.references`);
    const resolutionTiers = modality === 'video' && override.resolutionTiers !== undefined
      ? parseVideoResolutionTiers(override.resolutionTiers, `${modality}.${model}.resolutionTiers`)
      : undefined;
    result[model] = {
      ...(parameters ? { parameters } : {}),
      ...(references ? { references } : {}),
      ...(resolutionTiers ? { resolutionTiers } : {}),
    } as ImageModelCapabilityOverride | VideoModelCapabilityOverride;
  }
  return result as EndpointGenerationCapabilities['image'] & EndpointGenerationCapabilities['video'];
}

function parseParameterSpecs(value: unknown, path: string): GenerationParameterSpec[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((raw, index) => {
    const item = asRecord(raw, `${path}[${index}]`);
    const key = stringField(item.key, `${path}[${index}].key`);
    const typeValue = stringField(item.type, `${path}[${index}].type`);
    const types: GenerationParameterType[] = ['string', 'number', 'integer', 'boolean', 'enum'];
    if (!types.includes(typeValue as GenerationParameterType)) {
      throw new Error(`${path}[${index}].type must be string, number, integer, boolean, or enum`);
    }
    const description = stringField(item.description, `${path}[${index}].description`);
    const parameter: GenerationParameterSpec = {
      key,
      type: typeValue as GenerationParameterType,
      description,
    };
    if (item.enumValues !== undefined) {
      if (!Array.isArray(item.enumValues) || item.enumValues.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${path}[${index}].enumValues must be an array of strings`);
      }
      parameter.enumValues = item.enumValues as string[];
    }
    if (item.allowedValues !== undefined) {
      if (!Array.isArray(item.allowedValues) || item.allowedValues.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
        throw new Error(`${path}[${index}].allowedValues must be an array of finite numbers`);
      }
      parameter.allowedValues = item.allowedValues as number[];
    }
    if (item.min !== undefined) parameter.min = finiteNumber(item.min, `${path}[${index}].min`);
    if (item.max !== undefined) parameter.max = finiteNumber(item.max, `${path}[${index}].max`);
    if (item.required !== undefined) {
      if (typeof item.required !== 'boolean') throw new Error(`${path}[${index}].required must be boolean`);
      parameter.required = item.required;
    }
    if (parameter.type === 'enum' && (!parameter.enumValues || parameter.enumValues.length === 0)) {
      throw new Error(`${path}[${index}].enumValues must contain at least one value for enum parameters`);
    }
    if (item.transport !== undefined) {
      const transport = asRecord(item.transport, `${path}[${index}].transport`);
      for (const key of Object.keys(transport)) {
        if (key !== 'location' && key !== 'key') {
          throw new Error(`Unsupported field "${path}[${index}].transport.${key}"`);
        }
      }
      const location = transport.location === undefined
        ? undefined
        : stringField(transport.location, `${path}[${index}].transport.location`);
      if (location !== undefined && !['body', 'input', 'parameters', 'extraBody'].includes(location)) {
        throw new Error(`${path}[${index}].transport.location must be body, input, parameters, or extraBody`);
      }
      const wireKey = transport.key === undefined
        ? undefined
        : stringField(transport.key, `${path}[${index}].transport.key`);
      parameter.transport = {
        ...(location ? { location: location as GenerationParameterTransport['location'] } : {}),
        ...(wireKey ? { key: wireKey } : {}),
      };
    }
    return parameter;
  });
}

function parseImageReferences(value: unknown, path: string): ImageGenerationCapabilities['references'] {
  const item = asRecord(value, path);
  const supported = booleanField(item.supported, `${path}.supported`);
  const maxImages = nonNegativeInteger(item.maxImages, `${path}.maxImages`);
  const mode = stringField(item.mode, `${path}.mode`);
  if (!['none', 'single', 'multiple'].includes(mode)) {
    throw new Error(`${path}.mode must be none, single, or multiple`);
  }
  const supportsReferenceRoles = item.supportsReferenceRoles === undefined
    ? undefined
    : booleanField(item.supportsReferenceRoles, `${path}.supportsReferenceRoles`);
  const maskSupported = item.maskSupported === undefined ? undefined : booleanField(item.maskSupported, `${path}.maskSupported`);
  if (maskSupported && (!supported || maxImages < 1)) throw new Error(`${path}.maskSupported requires a source image`);
  return {
    supported,
    maxImages,
    mode: mode as ImageGenerationCapabilities['references']['mode'],
    ...(supportsReferenceRoles === undefined ? {} : { supportsReferenceRoles }),
    ...(maskSupported === undefined ? {} : { maskSupported }),
  };
}

function parseVideoReferences(value: unknown, path: string): VideoGenerationCapabilities['references'] {
  const item = asRecord(value, path);
  const supported = booleanField(item.supported, `${path}.supported`);
  const maxImages = nonNegativeInteger(item.maxImages, `${path}.maxImages`);
  const mode = stringField(item.mode, `${path}.mode`);
  if (!['none', 'first_frame', 'first_last', 'subject_references', 'multiple'].includes(mode)) {
    throw new Error(`${path}.mode has an unsupported value`);
  }
  return {
    supported,
    maxImages,
    mode: mode as VideoGenerationCapabilities['references']['mode'],
    supportsFirstFrame: booleanField(item.supportsFirstFrame, `${path}.supportsFirstFrame`),
    supportsLastFrame: booleanField(item.supportsLastFrame, `${path}.supportsLastFrame`),
    supportsSubjectReferences: booleanField(item.supportsSubjectReferences, `${path}.supportsSubjectReferences`),
    ...(item.audio === undefined ? {} : { audio: parseVideoMediaCapability(item.audio, `${path}.audio`) }),
    ...(item.video === undefined ? {} : { video: parseVideoMediaCapability(item.video, `${path}.video`) }),
    ...(item.audioRequiresVisual === undefined ? {} : { audioRequiresVisual: booleanField(item.audioRequiresVisual, `${path}.audioRequiresVisual`) }),
    ...(item.maxTotalMedia === undefined ? {} : { maxTotalMedia: positiveInteger(item.maxTotalMedia, `${path}.maxTotalMedia`) }),
  };
}

function parseVideoMediaCapability(value: unknown, path: string): VideoMediaReferenceCapability {
  const item = asRecord(value, path);
  if (!['public_url', 'public_url_or_data'].includes(String(item.transport))) throw new Error(`${path}.transport has an unsupported value`);
  if (!Array.isArray(item.mimeTypes) || !item.mimeTypes.length || item.mimeTypes.some((mime) => typeof mime !== 'string' || !/^(audio|video)\/[\w.+-]+$/.test(mime))) throw new Error(`${path}.mimeTypes must list audio/video MIME types`);
  const result: VideoMediaReferenceCapability = {
    maxCount: nonNegativeInteger(item.maxCount, `${path}.maxCount`), transport: item.transport as VideoMediaReferenceCapability['transport'],
    minSeconds: positiveInteger(item.minSeconds, `${path}.minSeconds`), maxSeconds: positiveInteger(item.maxSeconds, `${path}.maxSeconds`),
    maxTotalSeconds: positiveInteger(item.maxTotalSeconds, `${path}.maxTotalSeconds`), maxBytes: positiveInteger(item.maxBytes, `${path}.maxBytes`), mimeTypes: item.mimeTypes as string[],
  };
  if (result.maxSeconds < result.minSeconds || result.maxTotalSeconds < result.maxSeconds) throw new Error(`${path} has inconsistent duration limits`);
  return result;
}

function parseVideoResolutionTiers(value: unknown, path: string): VideoResolutionTier[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must contain at least one tier`);
  }
  return value.map((raw, index) => {
    const item = asRecord(raw, `${path}[${index}]`);
    for (const key of Object.keys(item)) {
      if (!['id', 'label', 'shortEdge', 'width', 'height'].includes(key)) {
        throw new Error(`Unsupported field "${path}[${index}].${key}"`);
      }
    }
    const id = stringField(item.id, `${path}[${index}].id`);
    const label = item.label === undefined ? undefined : stringField(item.label, `${path}[${index}].label`);
    const shortEdge = item.shortEdge === undefined
      ? undefined
      : positiveInteger(item.shortEdge, `${path}[${index}].shortEdge`);
    const width = item.width === undefined
      ? undefined
      : positiveInteger(item.width, `${path}[${index}].width`);
    const height = item.height === undefined
      ? undefined
      : positiveInteger(item.height, `${path}[${index}].height`);
    if (shortEdge === undefined && (width === undefined || height === undefined)) {
      throw new Error(`${path}[${index}] must define shortEdge or both width and height`);
    }
    if ((width === undefined) !== (height === undefined)) {
      throw new Error(`${path}[${index}] must define width and height together`);
    }
    return {
      id,
      ...(label ? { label } : {}),
      ...(shortEdge === undefined ? {} : { shortEdge }),
      ...(width === undefined ? {} : { width, height }),
    };
  });
}

function asRecord(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, any>;
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function booleanField(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be boolean`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${path} must be a non-negative integer`);
  return number;
}

function positiveInteger(value: unknown, path: string): number {
  const number = nonNegativeInteger(value, path);
  if (number < 1) throw new Error(`${path} must be a positive integer`);
  return number;
}

/** Validate planner output once, at the boundary before an adapter receives it. */
export function filterGenerationParameters(
  requested: Record<string, unknown> | undefined,
  capabilities: ImageGenerationCapabilities | VideoGenerationCapabilities,
): FilteredGenerationParameters {
  const values: Record<string, unknown> = {};
  const acceptedKeys: string[] = [];
  const rejectedKeys: string[] = [];
  if (!requested) return { values, acceptedKeys, rejectedKeys };

  const allowed = new Map(capabilities.parameters.map((item) => [item.key, item]));
  for (const [key, value] of Object.entries(requested)) {
    const rule = allowed.get(key);
    const modelIsAvailable = key !== 'model'
      || !capabilities.availableModels?.length
      || (typeof value === 'string' && capabilities.availableModels.includes(value));
    if (!rule || !isValidParameterValue(value, rule) || !modelIsAvailable) {
      rejectedKeys.push(key);
      continue;
    }
    values[key] = value;
    acceptedKeys.push(key);
  }
  return { values, acceptedKeys, rejectedKeys };
}

export function validateImageReferences(
  referenceImages: string[] | undefined,
  capabilities: ImageGenerationCapabilities,
): void {
  const count = referenceImages?.filter(Boolean).length ?? 0;
  if (count === 0) return;
  if (!capabilities.references.supported) {
    throw new Error(`Image provider ${capabilities.provider}/${capabilities.model} does not support reference images`);
  }
  if (count > capabilities.references.maxImages) {
    throw new Error(
      `Image provider ${capabilities.provider}/${capabilities.model} accepts at most ${capabilities.references.maxImages} reference image(s), received ${count}`,
    );
  }
}

export interface NormalizedVideoReferences {
  controlMode: VideoControlMode;
  referenceImages?: string[];
  firstFrame?: string;
  lastFrame?: string;
  subjectReferences?: Array<{ id: string; image: string; label?: string }>;
  audioReferences?: VideoMediaReference[];
  videoReferences?: VideoMediaReference[];
}

/** Select the strongest available reference mode without changing provider semantics. */
export function selectVideoControlMode(
  input: {
    requestedMode?: VideoControlMode;
    hasFirstFrame: boolean;
    hasSubjectReferences: boolean;
    /** Manual identity/style references should remain identity references. */
    preferSubjectReferences?: boolean;
  },
  capabilities: VideoGenerationCapabilities,
): VideoControlMode {
  if (input.requestedMode) return input.requestedMode;
  if (input.preferSubjectReferences
    && input.hasSubjectReferences
    && capabilities.references.supportsSubjectReferences) return 'reference';
  if (input.hasFirstFrame && capabilities.references.supportsFirstFrame) return 'keyframe';
  if (input.hasSubjectReferences && capabilities.references.supportsSubjectReferences) return 'reference';
  return 'text';
}

/** Normalize one request so an adapter receives only one reference semantic. */
export function normalizeVideoReferences(
  input: {
    controlMode?: VideoControlMode;
    referenceImages?: string[];
    firstFrame?: string;
    lastFrame?: string;
    subjectReferences?: Array<{ id: string; image: string; label?: string }>;
    audioReferences?: VideoMediaReference[];
    videoReferences?: VideoMediaReference[];
  },
  capabilities: VideoGenerationCapabilities,
): NormalizedVideoReferences {
  const rawImages = input.referenceImages?.filter((image) => !!image) ?? [];
  const subjects = input.subjectReferences?.filter((reference) => !!reference.image) ?? [];
  const hasExplicitFrames = !!input.firstFrame || !!input.lastFrame;
  const controlMode = input.controlMode
    ?? (hasExplicitFrames ? 'keyframe' : subjects.length > 0 || input.audioReferences?.length || input.videoReferences?.length ? 'reference' : rawImages.length > 0 ? 'keyframe' : 'text');
  const media = { audioReferences: input.audioReferences, videoReferences: input.videoReferences };
  validateVideoMediaReferences({ ...media, controlMode }, capabilities, subjects.length || rawImages.length);

  if (controlMode === 'text') {
    validateVideoReferences({
      controlMode,
      referenceImages: rawImages,
      firstFrame: input.firstFrame,
      lastFrame: input.lastFrame,
      subjectReferences: subjects,
    }, capabilities);
    return { controlMode };
  }

  if (controlMode === 'reference') {
    if (input.firstFrame || input.lastFrame) {
      throw new Error('Video reference mode cannot include temporal first/last frame controls');
    }
    if (subjects.length > 0) {
      validateVideoReferences({ controlMode, subjectReferences: subjects, ...media }, capabilities);
      return { controlMode, subjectReferences: subjects, ...media };
    }
    validateVideoReferences({ controlMode, referenceImages: rawImages, ...media }, capabilities);
    return { controlMode, referenceImages: rawImages.length > 0 ? rawImages : undefined, ...media };
  }

  if (subjects.length > 0) {
    throw new Error('Video keyframe mode cannot include subject references');
  }
  const firstFrame = input.firstFrame ?? (!hasExplicitFrames ? rawImages[0] : undefined);
  const lastFrame = input.lastFrame ?? (!hasExplicitFrames ? rawImages[1] : undefined);
  const keyframeImages = [firstFrame, lastFrame].filter((image): image is string => !!image);
  validateVideoReferences({
    controlMode,
    referenceImages: keyframeImages,
    firstFrame,
    lastFrame,
  }, capabilities);
  return {
    controlMode,
    referenceImages: keyframeImages.length > 0 ? keyframeImages : undefined,
    firstFrame,
    lastFrame,
  };
}

export function validateVideoReferences(
  input: {
    referenceImages?: string[];
    controlMode: 'text' | 'keyframe' | 'reference';
    firstFrame?: string;
    lastFrame?: string;
    subjectReferences?: Array<{ image?: string }>;
    audioReferences?: VideoMediaReference[];
    videoReferences?: VideoMediaReference[];
  },
  capabilities: VideoGenerationCapabilities,
): void {
  const subjectReferences = input.subjectReferences?.filter((reference) => !!reference.image) ?? [];
  validateVideoMediaReferences(input, capabilities, subjectReferences.length || input.referenceImages?.filter(Boolean).length || 0);
  const hasAnyReference = !!input.firstFrame
    || !!input.lastFrame
    || subjectReferences.length > 0
    || !!input.referenceImages?.filter(Boolean).length || !!input.audioReferences?.length || !!input.videoReferences?.length;
  if (!hasAnyReference) return;
  if (input.controlMode === 'text') {
    throw new Error(`Video request selected text mode but supplied reference material for ${capabilities.provider}/${capabilities.model}`);
  }
  if (!capabilities.references.supported) {
    throw new Error(`Video provider ${capabilities.provider}/${capabilities.model} does not support reference material`);
  }
  if (input.controlMode === 'keyframe') {
    if (!capabilities.references.supportsFirstFrame || !input.firstFrame) {
      throw new Error(`Video provider ${capabilities.provider}/${capabilities.model} requires a supported first frame for keyframe mode`);
    }
    if (input.lastFrame && !capabilities.references.supportsLastFrame) {
      throw new Error(`Video provider ${capabilities.provider}/${capabilities.model} does not support a last frame`);
    }
    const count = (input.firstFrame ? 1 : 0) + (input.lastFrame ? 1 : 0);
    if (count > capabilities.references.maxImages) {
      throw new Error(`Video provider ${capabilities.provider}/${capabilities.model} accepts at most ${capabilities.references.maxImages} keyframe image(s), received ${count}`);
    }
  }
  if (input.controlMode === 'reference') {
    if ((subjectReferences.length || input.referenceImages?.length) && !capabilities.references.supportsSubjectReferences) {
      throw new Error(`Video provider ${capabilities.provider}/${capabilities.model} does not support subject references`);
    }
    const count = subjectReferences.length || input.referenceImages?.filter(Boolean).length || 0;
    if (count === 0 && !input.audioReferences?.length && !input.videoReferences?.length) {
      throw new Error(`Video reference mode requires at least one subject reference for ${capabilities.provider}/${capabilities.model}`);
    }
    if (count > capabilities.references.maxImages) {
      throw new Error(`Video provider ${capabilities.provider}/${capabilities.model} accepts at most ${capabilities.references.maxImages} reference image(s), received ${count}`);
    }
  }
}

function isValidParameterValue(value: unknown, rule: GenerationParameterSpec): boolean {
  if (value === undefined || value === null) return false;
  if (rule.type === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'enum') return typeof value === 'string' && !!rule.enumValues?.includes(value);
  if (rule.type === 'integer') {
    return typeof value === 'number'
      && Number.isInteger(value)
      && Number.isFinite(value)
      && (rule.allowedValues === undefined || rule.allowedValues.includes(value))
      && (rule.min === undefined || value >= rule.min)
      && (rule.max === undefined || value <= rule.max);
  }
  return typeof value === 'number'
    && Number.isFinite(value)
    && (rule.allowedValues === undefined || rule.allowedValues.includes(value))
    && (rule.min === undefined || value >= rule.min)
    && (rule.max === undefined || value <= rule.max);
}

export function formatCapabilitiesForPrompt(
  capabilities: ImageGenerationCapabilities | VideoGenerationCapabilities | undefined,
): string {
  if (!capabilities) return 'No provider capability metadata is available; emit only prompt text and omit optional parameters.';
  const parameters = capabilities.parameters.map((item) => {
    const constraints = [
      item.enumValues?.length ? `values=${item.enumValues.join('|')}` : '',
      item.allowedValues?.length ? `values=${item.allowedValues.join('|')}` : '',
      item.min !== undefined ? `min=${item.min}` : '',
      item.max !== undefined ? `max=${item.max}` : '',
    ].filter(Boolean).join(', ');
    return `- ${item.key} (${item.type}${constraints ? `, ${constraints}` : ''}): ${item.description}`;
  });
  const referenceText = capabilities.modality === 'image'
    ? `references: ${capabilities.references.supported ? `${capabilities.references.mode}, max ${capabilities.references.maxImages}; referenceRoles=${capabilities.references.supportsReferenceRoles === true}` : 'unsupported'}`
    : `references: ${capabilities.references.supported ? `${capabilities.references.mode}, max ${capabilities.references.maxImages}; firstFrame=${capabilities.references.supportsFirstFrame}; lastFrame=${capabilities.references.supportsLastFrame}; subjectReferences=${capabilities.references.supportsSubjectReferences}` : 'unsupported'}`;
  const resolutionText = capabilities.modality === 'video' && capabilities.resolutionTiers?.length
    ? `resolutionTiers: ${capabilities.resolutionTiers.map((tier) => tier.id).join('|')}`
    : '';
  return [
    `provider=${capabilities.provider}`,
    `model=${capabilities.model}`,
    `execution=${capabilities.adapterAvailable === false ? 'unavailable' : 'available'}`,
    ...(capabilities.endpointId ? [`endpointId=${capabilities.endpointId}`] : []),
    ...(capabilities.availableModels?.length ? [`availableModels=${capabilities.availableModels.join('|')}`] : []),
    ...(capabilities.modelCapabilities?.length
      ? capabilities.modelCapabilities.flatMap((model) => [
          `- ${model.model}:`,
          formatModelReferenceText(capabilities.modality, model.references),
          ...(capabilities.modality === 'video' && 'resolutionTiers' in model && model.resolutionTiers?.length
            ? [`  resolutionTiers: ${model.resolutionTiers.map((tier: VideoResolutionTier) => tier.id).join('|')}`]
            : []),
          ...formatParameterLines(model.parameters, '  '),
        ])
      : [referenceText, ...(resolutionText ? [resolutionText] : []), 'parameters:', ...(parameters.length ? parameters : ['- none'])]),
  ].join('\n');
}

function formatParameterLines(parameters: GenerationParameterSpec[], indent = ''): string[] {
  return [
    `${indent}parameters:`,
    ...(parameters.length
      ? parameters.map((item) => {
          const constraints = [
            item.enumValues?.length ? `values=${item.enumValues.join('|')}` : '',
            item.allowedValues?.length ? `values=${item.allowedValues.join('|')}` : '',
            item.min !== undefined ? `min=${item.min}` : '',
            item.max !== undefined ? `max=${item.max}` : '',
          ].filter(Boolean).join(', ');
          return `${indent}- ${item.key} (${item.type}${constraints ? `, ${constraints}` : ''}): ${item.description}`;
        })
      : [`${indent}- none`]),
  ];
}

function formatModelReferenceText(
  modality: ImageGenerationCapabilities['modality'] | VideoGenerationCapabilities['modality'],
  references: ImageGenerationCapabilities['references'] | VideoGenerationCapabilities['references'],
): string {
  if (modality === 'image') {
    const imageReferences = references as ImageGenerationCapabilities['references'];
    return `references: ${imageReferences.supported ? `${imageReferences.mode}, max ${imageReferences.maxImages}; referenceRoles=${imageReferences.supportsReferenceRoles === true}` : 'unsupported'}`;
  }
  const videoReferences = references as VideoGenerationCapabilities['references'];
  return `references: ${videoReferences.supported ? `${videoReferences.mode}, max ${videoReferences.maxImages}; firstFrame=${videoReferences.supportsFirstFrame}; lastFrame=${videoReferences.supportsLastFrame}; subjectReferences=${videoReferences.supportsSubjectReferences}` : 'unsupported'}`;
}

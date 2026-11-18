// ============================================================================
// API Provider Types — Unified multi-provider adapter layer
// ============================================================================

// --- LLM Provider IDs ---

export type LLMProviderId =
  | 'openai'
  | 'claude'
  | 'deepseek'
  | 'qwen'
  | 'doubao'
  | 'glm'
  | 'custom';

export type ImageProviderId =
  | 'dalle'
  | 'midjourney'
  | 'stable-diffusion'
  | 'flux'
  | 'comfyui'
  | 'kling-image'
  | 'cogview'
  | 'wanx'
  | 'jimeng'
  | 'siliconflow-image'
  | 'ideogram'
  | 'agnes-image'
  | 'leonardo'
  | 'custom';

export type VideoProviderId =
  | 'sora'
  | 'runway'
  | 'kling'
  | 'vidu'
  | 'pika'
  | 'agnes-video'
  | 'doubao-video'
  | 'minimax-video'
  | 'cogvideo'
  | '302ai-video'
  | 'siliconflow-video'
  | 'leonardo-video'
  | 'custom';

export type TTSProviderId =
  | 'openai-tts'        // OpenAI TTS API (tts-1 / tts-1-hd)
  | 'doubao-tts'        // 字节豆包配音 (火山语音)
  | 'siliconflow-tts'   // 硅基流动 CosyVoice
  | 'edge-tts'          // Microsoft Edge TTS (免费)
  | 'custom';

export type MusicProviderId =
  | 'suno-music'        // Suno AI (v3.5 / v4 音乐大模型)
  | 'udio-music'        // Udio 音乐大模型
  | 'siliconflow-music' // 硅基流动语音/配乐
  | 'custom';

export type VideoControlMode = 'text' | 'keyframe' | 'reference';

/** Semantic role of a reference image in a provider request. */
export type GenerationReferenceRole =
  | 'first_frame'
  | 'last_frame'
  | 'subject'
  | 'environment'
  | 'continuity'
  | 'opening'
  | 'custom';

/** Reference material prepared by the pipeline before an adapter serializes it. */
export interface GenerationReferenceInput {
  id: string;
  role: GenerationReferenceRole;
  image: string;
  label?: string;
  subjectId?: string;
  subjectIds?: string[];
}

/** Persistable description of a reference slot. The image payload itself is intentionally omitted. */
export interface GenerationReferenceSnapshot {
  id: string;
  role: GenerationReferenceRole;
  label?: string;
  subjectId?: string;
  subjectIds?: string[];
  providerIndex: number;
  payloadFingerprint: string;
  payloadKind: 'data_uri' | 'url' | 'base64' | 'unknown';
  mediaKind?: 'image' | 'audio' | 'video';
}

/** Structured request contract captured for the execution trace. */
export interface GenerationRequestSnapshot {
  schemaVersion: 1;
  taskType: string;
  model: string;
  controlMode?: VideoControlMode;
  promptFingerprint: string;
  parameterValues: Record<string, unknown>;
  /** Provider adapter's sanitized native/wire-level parameter preview. */
  wireParameterValues?: Record<string, unknown>;
  acceptedParameterKeys: string[];
  rejectedParameterKeys: string[];
  referenceSlots: GenerationReferenceSnapshot[];
}

/** Structured result contract captured after a provider returns. */
export interface GenerationResponseSnapshot {
  schemaVersion: 1;
  outputKind: 'image' | 'video' | 'audio';
  outputFingerprint?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  provider: string;
  model: string;
}

/** One concrete provider attempt, kept separate from the final invocation result. */
export interface GenerationAttemptSnapshot {
  provider: string;
  model: string;
  endpointId?: string;
  startedAt: string;
  finishedAt: string;
  status: 'succeeded' | 'failed';
  error?: string;
}

// --- Generation capability contract ---

/** Stable parameter names shared by the text planner and generation adapters. */
export type GenerationParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'enum';

export type GenerationParameterLocation = 'body' | 'input' | 'parameters' | 'extraBody';

export interface GenerationParameterTransport {
  /** Where an adapter should place a provider-specific parameter. */
  location?: GenerationParameterLocation;
  /** Provider field name. Defaults to the normalized parameter key. */
  key?: string;
}

export interface GenerationParameterSpec {
  /** Normalized request key, for example `aspectRatio` or `guidanceScale`. */
  key: string;
  type: GenerationParameterType;
  description: string;
  enumValues?: string[];
  /** Exact numeric values accepted by a provider/model, when applicable. */
  allowedValues?: number[];
  min?: number;
  max?: number;
  required?: boolean;
  /** Optional wire mapping for endpoint-specific parameters. */
  transport?: GenerationParameterTransport;
}

export interface ImageReferenceCapability {
  supported: boolean;
  maxImages: number;
  mode: 'none' | 'single' | 'multiple';
  /** Whether the adapter/provider preserves one independent semantic role per image slot. */
  supportsReferenceRoles?: boolean;
  /** Separate white-edit/black-keep mask transported by a concrete adapter. */
  maskSupported?: boolean;
}

export interface ImageModelCapability {
  model: string;
  parameters: GenerationParameterSpec[];
  references: ImageReferenceCapability;
}

export interface VideoReferenceCapability {
  supported: boolean;
  maxImages: number;
  mode: 'none' | 'first_frame' | 'first_last' | 'subject_references' | 'multiple';
  supportsFirstFrame: boolean;
  supportsLastFrame: boolean;
  supportsSubjectReferences: boolean;
  audio?: VideoMediaReferenceCapability;
  video?: VideoMediaReferenceCapability;
  audioRequiresVisual?: boolean;
  maxTotalMedia?: number;
}

export interface VideoMediaReferenceCapability {
  maxCount: number;
  transport: 'public_url' | 'public_url_or_data';
  minSeconds: number;
  maxSeconds: number;
  maxTotalSeconds: number;
  maxBytes: number;
  mimeTypes: string[];
}

export interface VideoMediaReference {
  id: string;
  url: string;
  label?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  mimeType?: string;
}

/** A provider/model output tier exposed to the production UI. */
export interface VideoResolutionTier {
  /** Stable normalized id, for example `720p` or `1080p`. */
  id: string;
  /** Optional human-readable label supplied by the endpoint contract. */
  label?: string;
  /** Short edge used to derive dimensions for the selected aspect ratio. */
  shortEdge?: number;
  /** Exact dimensions for providers that expose fixed-size outputs. */
  width?: number;
  height?: number;
}

export interface VideoModelCapability {
  model: string;
  parameters: GenerationParameterSpec[];
  references: VideoReferenceCapability;
  resolutionTiers?: VideoResolutionTier[];
}

/** Optional visual-input contract for an LLM endpoint/model. */
export interface LLMModelCapabilityOverride {
  supportsImageInputs?: boolean;
  maxImageInputs?: number;
}

/** Provider/model facts used by visual review and other multimodal tasks. */
export interface LLMGenerationCapabilities {
  modality: 'llm';
  provider: LLMProviderId;
  model: string;
  endpointId?: string;
  supportsImageInputs: boolean;
  maxImageInputs: number;
}

/** Optional per-model facts supplied by an endpoint configuration. */
export interface ImageModelCapabilityOverride {
  parameters?: GenerationParameterSpec[];
  references?: ImageReferenceCapability;
}

/** Optional per-model facts supplied by an endpoint configuration. */
export interface VideoModelCapabilityOverride {
  parameters?: GenerationParameterSpec[];
  references?: VideoReferenceCapability;
  resolutionTiers?: VideoResolutionTier[];
}

/**
 * Provider defaults describe known APIs. Endpoint overrides are for a proxy
 * or a model whose contract differs from the provider default.
 */
export interface EndpointGenerationCapabilities {
  llm?: Record<string, LLMModelCapabilityOverride>;
  image?: Record<string, ImageModelCapabilityOverride>;
  video?: Record<string, VideoModelCapabilityOverride>;
}

/** Provider/model facts supplied to the storyboard planner and router. */
export interface ImageGenerationCapabilities {
  modality: 'image';
  provider: ImageProviderId;
  model: string;
  /** Whether the application has a concrete adapter for this provider. */
  adapterAvailable?: boolean;
  /** Models exposed by the selected endpoint, when the endpoint declares them. */
  availableModels?: string[];
  /** Per-model contracts when the endpoint exposes more than one model. */
  modelCapabilities?: ImageModelCapability[];
  endpointId?: string;
  parameters: GenerationParameterSpec[];
  references: ImageReferenceCapability;
}

/** Provider/model facts supplied to the storyboard planner and router. */
export interface VideoGenerationCapabilities {
  modality: 'video';
  provider: VideoProviderId;
  model: string;
  /** Whether the application has a concrete adapter for this provider. */
  adapterAvailable?: boolean;
  /** Models exposed by the selected endpoint, when the endpoint declares them. */
  availableModels?: string[];
  /** Per-model contracts when the endpoint exposes more than one model. */
  modelCapabilities?: VideoModelCapability[];
  endpointId?: string;
  parameters: GenerationParameterSpec[];
  references: VideoReferenceCapability;
  resolutionTiers?: VideoResolutionTier[];
}

// --- API Endpoint Config ---

export interface ApiEndpoint {
  id: string;
  name: string;
  provider: LLMProviderId | ImageProviderId | VideoProviderId | TTSProviderId | MusicProviderId;
  /**
   * 类别标记。固定类别 provider(llm/openai 等)可不填,会从 PROVIDER_CATEGORY 推断;
   * 'custom' provider 必须填,否则会在所有类别列表里都出现/都不出现。
   */
  category?: 'llm' | 'image' | 'video' | 'tts';
  baseUrl: string;
  apiKey: string;
  models?: string[];
  /** Optional model-level parameter/reference contract for this endpoint. */
  generationCapabilities?: EndpointGenerationCapabilities;
  organizationId?: string;
  customHeaders?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- LLM Task Types ---

export type LLMTaskType =
  | 'planning'       // 宏观规划 / 大纲
  | 'generation'     // 正文生成
  | 'review'         // 审校质检
  | 'rewrite'        // 定向修写（质量门纠正）
  | 'extraction'     // 结构化提取（摘要/三元组/伏笔）
  | 'analysis'       // 叙事分析（紧张度评分/风格检测）
  | 'translation'    // 跨模块翻译（小说→漫画脚本）
  | 'prompt_optimization' // 提示词动态膨胀与渲染优化
  | 'embedding';     // 文本向量化

export type ImageTaskType =
  | 'character'      // 角色立绘
  | 'scene'          // 场景背景
  | 'panel'          // 漫画分格
  | 'style-transfer' // 风格迁移
  | 'storyboard';    // 分镜草图

export type VideoTaskType =
  | 'clip'           // 短片段（3-5s）
  | 'transition'     // 转场
  | 'full-scene'     // 完整场景（10-30s）
  | 'lip-sync'       // 口型同步
  | 'effects';       // 后期特效

// --- Provider Routing Config ---

export interface LLMModelMapping {
  planning: string;
  generation: string;
  review: string;
  extraction: string;
  translation: string;
  embedding: string;
}

export interface ImageModelMapping {
  character: string;
  scene: string;
  panel: string;
  'style-transfer': string;
  storyboard: string;
}

export interface VideoModelMapping {
  clip: string;
  transition: string;
  'full-scene': string;
  'lip-sync': string;
  effects: string;
}

export interface LLMProviderConfig {
  primary: LLMProviderId;
  fallback?: LLMProviderId;
  endpointId?: string;
  fallbackEndpointId?: string;
  models: Partial<LLMModelMapping>;
  defaultModel: string;
}

export interface ImageProviderConfig {
  primary: ImageProviderId;
  fallback?: ImageProviderId;
  endpointId?: string;
  fallbackEndpointId?: string;
  models: Partial<ImageModelMapping>;
  defaultModel: string;
  defaultWidth: number;
  defaultHeight: number;
}

export interface VideoProviderConfig {
  primary: VideoProviderId;
  fallback?: VideoProviderId;
  endpointId?: string;
  fallbackEndpointId?: string;
  models: Partial<VideoModelMapping>;
  defaultModel: string;
  defaultResolution: string;
  defaultFps: number;
  /** Additional attempts when Agnes Flash reports a temporary full queue. */
  queueRetryCount?: number;
  /** Initial delay before retrying a full Agnes queue, in milliseconds. */
  queueRetryBackoffMs?: number;
}

// --- TTS Provider Config ---

export interface TTSProviderConfig {
  primary: TTSProviderId;
  fallback?: TTSProviderId;
  endpointId?: string;
  fallbackEndpointId?: string;
  defaultModel: string;       // e.g. 'tts-1' / 'tts-1-hd'
  defaultVoice: string;       // e.g. 'alloy' / 'echo' / 'nova'
  defaultFormat: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
  defaultSpeed: number;       // 0.25 - 4.0
}

// --- Unified Provider Configuration ---

export interface ProviderConfig {
  llm: LLMProviderConfig;
  image: ImageProviderConfig;
  video: VideoProviderConfig;
  tts?: TTSProviderConfig;
}

// --- Generation Request/Response ---

export interface LLMGenerateRequest {
  taskType: LLMTaskType;
  endpointId?: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  /** Optional thinking mode for models that support it (currently DeepSeek V4). */
  thinking?: boolean;
  stopSequences?: string[];
  /** Optional visual inputs for models that support image understanding. */
  imageInputs?: string[];
}

export interface LLMGenerateResponse {
  content: string;
  model: string;
  provider: LLMProviderId;
  usage: TokenUsage;
  latencyMs: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ImageGenerateRequest {
  taskType: ImageTaskType;
  /** Stable execution label for tracing one request back to a shot or asset. */
  sourceLabel?: string;
  prompt: string;
  negativePrompt?: string;
  model?: string;
  size?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  style?: string;
  quality?: string;
  steps?: number;
  guidanceScale?: number;
  referenceImages?: string[];
  /** Grayscale PNG Data URI, white edits and black preserves; same dimensions as the sole source. */
  mask?: string;
  editStrength?: number;
  /** Semantic reference slots used for tracing and provider capability checks. */
  referenceSlots?: GenerationReferenceInput[];
  seed?: number;
  /** Planner-selected normalized values. Router validates these against capabilities. */
  parameters?: Record<string, unknown>;
  /** Contract entries used to transport endpoint-specific parameters. */
  parameterSpecs?: GenerationParameterSpec[];
  endpointId?: string;
}

export interface ImageGenerateResponse {
  imageData: string;       // base64 or URL
  width: number;
  height: number;
  model: string;
  provider: ImageProviderId;
  /** Endpoint that actually returned the artifact, including fallback routing. */
  endpointId?: string;
  /** Normalized request that was actually sent, including provider wire values. */
  requestSnapshot?: GenerationRequestSnapshot;
  /** Provider/output facts captured for the returned artifact. */
  responseSnapshot?: GenerationResponseSnapshot;
  latencyMs: number;
}

export interface VideoGenerateRequest {
  taskType: VideoTaskType;
  /** Stable execution label for tracing one request back to a shot or asset. */
  sourceLabel?: string;
  prompt: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  durationSeconds?: number;
  fps?: number;
  referenceImages?: string[];
  /** Semantic reference slots used for tracing and provider capability checks. */
  referenceSlots?: GenerationReferenceInput[];
  /** Provider-independent control semantics. Adapters must not infer reference mode from array positions. */
  controlMode?: VideoControlMode;
  /** Explicit first/last frame semantics for providers that support them. */
  firstFrame?: string;
  lastFrame?: string;
  /** Identity references used by providers with native subject-reference support. */
  subjectReferences?: Array<{
    id: string;
    image: string;
    label?: string;
  }>;
  audioPrompt?: string;
  audioReferences?: VideoMediaReference[];
  videoReferences?: VideoMediaReference[];
  /** Omitted by the project pipeline, which mixes its own TTS and music. */
  generateAudio?: boolean;
  endpointId?: string; // Optional: use a specific endpoint instead of the configured primary
  seed?: number;
  numInferenceSteps?: number;
  mode?: string;
  /** Planner-selected normalized values. Router validates these against capabilities. */
  parameters?: Record<string, unknown>;
  /** Contract entries used to transport endpoint-specific parameters. */
  parameterSpecs?: GenerationParameterSpec[];
}

export interface VideoGenerateResponse {
  videoData: string;       // base64 or URL
  width: number;
  height: number;
  durationSeconds: number;
  model: string;
  provider: VideoProviderId;
  /** Endpoint that actually returned the artifact, including fallback routing. */
  endpointId?: string;
  /** Normalized request that was actually sent, including provider wire values. */
  requestSnapshot?: GenerationRequestSnapshot;
  /** Provider/output facts captured for the returned artifact. */
  responseSnapshot?: GenerationResponseSnapshot;
  latencyMs: number;
}

// --- TTS ---

export interface TTSRequest {
  /** 待合成文本(中/英文均可,主流 TTS 模型都支持) */
  text: string;
  /** 音色 ID,缺省走 config.defaultVoice */
  voice?: string;
  /** 模型 ID,缺省走 config.defaultModel */
  model?: string;
  /** 输出格式 */
  format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
  /** 语速 0.25-4.0 */
  speed?: number;
  /** 可选:固定到某个 endpoint(用于多 endpoint 场景) */
  endpointId?: string;
}

export interface TTSResponse {
  /** 音频数据 base64 (含 data:audio/xxx;base64, 前缀) */
  audioData: string;
  format: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
  /** 估算时长(秒),由 provider 返回或客户端推算 */
  durationSeconds?: number;
  model: string;
  voice: string;
  provider: TTSProviderId;
  latencyMs: number;
}

// --- Provider Health ---

export interface ProviderHealth {
  endpointId: string;
  available: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

// --- Streaming ---

export interface LLMStreamChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
}

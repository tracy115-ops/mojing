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
  | 'ideogram'
  | 'custom';

export type VideoProviderId =
  | 'sora'
  | 'runway'
  | 'kling'
  | 'vidu'
  | 'pika'
  | 'custom';

export type TTSProviderId =
  | 'openai-tts'    // OpenAI TTS API (tts-1 / tts-1-hd)
  | 'doubao-tts'    // 字节豆包 TTS
  | 'edge-tts'      // Microsoft Edge TTS (免费)
  | 'custom';

// --- API Endpoint Config ---

export interface ApiEndpoint {
  id: string;
  name: string;
  provider: LLMProviderId | ImageProviderId | VideoProviderId | TTSProviderId;
  /**
   * 类别标记。固定类别 provider(llm/openai 等)可不填,会从 PROVIDER_CATEGORY 推断;
   * 'custom' provider 必须填,否则会在所有类别列表里都出现/都不出现。
   */
  category?: 'llm' | 'image' | 'video' | 'tts';
  baseUrl: string;
  apiKey: string;
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
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  stopSequences?: string[];
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
  prompt: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  style?: string;
  referenceImages?: string[];
  seed?: number;
}

export interface ImageGenerateResponse {
  imageData: string;       // base64 or URL
  width: number;
  height: number;
  model: string;
  provider: ImageProviderId;
  latencyMs: number;
}

export interface VideoGenerateRequest {
  taskType: VideoTaskType;
  prompt: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fps?: number;
  referenceImages?: string[];
  audioPrompt?: string;
  endpointId?: string; // Optional: use a specific endpoint instead of the configured primary
}

export interface VideoGenerateResponse {
  videoData: string;       // base64 or URL
  width: number;
  height: number;
  durationSeconds: number;
  model: string;
  provider: VideoProviderId;
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

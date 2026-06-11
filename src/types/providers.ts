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
  | 'custom';

export type VideoProviderId =
  | 'sora'
  | 'runway'
  | 'kling'
  | 'vidu'
  | 'pika'
  | 'custom';

// --- API Endpoint Config ---

export interface ApiEndpoint {
  id: string;
  name: string;
  provider: LLMProviderId | ImageProviderId | VideoProviderId;
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

// --- Unified Provider Configuration ---

export interface ProviderConfig {
  llm: LLMProviderConfig;
  image: ImageProviderConfig;
  video: VideoProviderConfig;
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

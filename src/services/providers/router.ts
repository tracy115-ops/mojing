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
  LLMProviderId,
  ImageProviderId,
  ImageTaskType,
  VideoProviderId,
  VideoTaskType,
  TTSProviderId,
  ApiEndpoint,
  GenerationAttemptSnapshot,
  GenerationRequestSnapshot,
  ImageGenerationCapabilities,
  ImageModelCapabilityOverride,
  VideoGenerationCapabilities,
  VideoModelCapabilityOverride,
} from '@/types/providers';
import { BaseLLMProvider } from './base';
import { OpenAICompatibleProvider, ClaudeProvider } from './llm-adapters';
import { createImageProvider } from './image-adapters';
import { normalizeAgnesImageSeed } from './image-wire-contract';
import { validateNativeImageEdit } from './image-edit-contract';
import { createVideoProvider } from './video-adapters';
import { createTTSProvider } from './tts-adapters';
import { isEndpointInCategory, useProviderStore } from '@/stores/providerStore';
import { logger } from '@/services/log';
import { emitInvocation } from './invocation-context';
import {
  buildImageRequestSnapshot,
  buildLLMRequestSnapshot,
  buildResponseSnapshot,
  buildVideoRequestSnapshot,
  fingerprintPayload,
} from './generation-snapshot';
import { isContentPolicyViolation, buildSafetyRewriteChain } from './prompt-safety';
import {
  filterGenerationParameters,
  getLLMGenerationCapabilities,
  getImageGenerationCapabilities,
  getImageModelCapabilities,
  getVideoGenerationCapabilities,
  getVideoModelCapabilities,
  validateImageReferences,
  normalizeVideoReferences,
} from './provider-capabilities';
import {
  alignReferenceSlots,
  materializeReferenceInputBundle,
} from './reference-contract';

function nowIso(): string {
  return new Date().toISOString();
}

function truncatePrompt(prompt: string | undefined, max = 2000): string | undefined {
  if (!prompt) return undefined;
  if (prompt.length <= max) return prompt;
  return `${prompt.slice(0, max)}\n…[truncated ${prompt.length - max} chars]`;
}

/**
 * 在 provider 调用外包一层"内容审核拦截自动重试"。
 *
 * 当 provider 抛 content_policy_violation 时,按 soft → aggressive 顺序
 * 改写 prompt 重试,直到成功或链路用尽。
 *
 * 非内容审核错误(网络、配额、参数等)不重试,原样抛。
 *
 * 返回值带 __originalPrompt 字段,调用方可以据此判断是否发生过改写。
 */
async function callWithSafetyRetry<T>(
  originalPrompt: string,
  attempt: (prompt: string) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(originalPrompt);
  } catch (err) {
    if (!isContentPolicyViolation(err)) throw err;

    const chain = buildSafetyRewriteChain(originalPrompt);
    void logger.warn(
      `[router] content_policy_violation, trying ${chain.length} safety rewrites (prompt length ${originalPrompt.length})`,
      'router',
    );

    let lastErr = err;
    for (let i = 0; i < chain.length; i++) {
      const rewritten = chain[i];
      try {
        const result = await attempt(rewritten);
        void logger.info(
          `[router] safety rewrite #${i + 1}/${chain.length} succeeded`,
          'router',
        );
        return result;
      } catch (e) {
        lastErr = e;
        if (!isContentPolicyViolation(e)) throw e;
        // 仍是 content policy,继续下一档
      }
    }
    // 链路用尽,抛最后的错误(让上层 stage 处理)
    throw lastErr;
  }
}

/** 判断错误是否为「瞬时网络/超时」类(值得重试)。
 *  - tauri-plugin-http 的 abort: "Request canceled"
 *  - fetch 标准 timeout: "timed out" / "timeout"
 *  - Node 网络层: "ETIMEDOUT" / "ECONNRESET" / "ECONNABORTED"
 *  - 5xx 服务端错误:HTTP 502/503/504(代理后端临时不可用) */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // 不可恢复的模型/鉴权/参数错误，立即抛出，绝不浪费时间做重试退避
  if (
    msg.includes('model_not_found') ||
    msg.includes('no available channel for model') ||
    msg.includes('invalid_model') ||
    msg.includes('unknown model') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication')
  ) {
    return false;
  }
  if (msg.includes('request canceled')) return true;
  if (msg.includes('timed out') || msg.includes('timeout')) return true;
  if (msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('econnaborted')) return true;
  // A provider quota that explicitly asks the user to upgrade or add balance
  // will not recover during this run. Retrying it only burns time and can
  // submit duplicate paid jobs on providers that accept the next attempt.
  const exhaustedQuota = /free users|upgrade to|token plan|quota exceeded|insufficient balance|billing required/.test(msg);
  if (!exhaustedQuota && (msg.includes('429') || msg.includes('rate limit') || msg.includes('limit reached') || msg.includes('ipm limit'))) return true;
  // HTTP 5xx(从 "API error 503: ..." 这种消息里识别)
  if (/\b5\d{2}\b/.test(msg) && msg.includes('error')) return true;
  return false;
}

function isVideoQueueFull(err: unknown): boolean {
  return err instanceof Error && /video_queue_full|queue[_ ]full/i.test(err.message);
}

/** 对瞬时网络错误及 429 限流自动重试(最多 retries 次,指数退避)。
 *  非瞬时错误(如 content_policy / 400 参数错误 / 401 鉴权失败)直接抛,不重试。 */
async function callWithTimeoutRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  options: { queueRetries?: number; queueBackoffMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  const queueRetries = Math.max(0, Math.min(20, Math.floor(options.queueRetries ?? retries)));
  const queueBackoffMs = Math.max(1000, Math.min(30 * 60 * 1000, Math.floor(options.queueBackoffMs ?? 30000)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const queueFull = isVideoQueueFull(err);
      const maxRetries = queueFull ? queueRetries : retries;
      if (attempt >= maxRetries || !isTransientNetworkError(err)) throw err;
      const isRateLimit = err instanceof Error && /429|rate limit|limit reached/i.test(err.message);
      // 队列满使用可配置退避；限流/网络抖动沿用较短的原策略。
      const delayMs = queueFull
        ? queueBackoffMs * Math.pow(2, attempt)
        : isRateLimit ? 6000 * Math.pow(2, attempt) : 3000 * Math.pow(3, attempt);
      void logger.warn(
        `[router] ${queueFull ? '视频队列已满' : '瞬时错误/限流'},${delayMs}ms 后重试 (${attempt + 1}/${maxRetries}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        'router',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

interface RouterInvocationFields {
  category: 'llm' | 'image' | 'video' | 'tts';
  provider: string;
  model: string;
  endpointId?: string;
  prompt?: string;
  sourceLabel?: string;
  baseUrl?: string;
  requestSummary?: string[];
  supportedParameters?: string[];
  actualParameters?: string[];
  requestSnapshot?: GenerationRequestSnapshot;
  attempts?: GenerationAttemptSnapshot[];
  executionStatus?: 'succeeded' | 'degraded' | 'failed';
}

function updateInvocationPrompt(fields: RouterInvocationFields, prompt: string): void {
  fields.prompt = prompt;
  if (fields.requestSnapshot) {
    fields.requestSnapshot = {
      ...fields.requestSnapshot,
      promptFingerprint: fingerprintPayload(prompt) ?? 'empty',
    };
  }
}

async function runWithInvocation<T extends { latencyMs?: number; model: string; provider: string; usage?: { promptTokens?: number; completionTokens?: number }; durationSeconds?: number }>(
  fields: RouterInvocationFields,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = nowIso();
  const startTs = Date.now();
  let retries = 0;
  let lastErr: string | undefined;
  // Outer try records the first error so the user sees the real cause; retries
  // inside fallback paths increment via a closure passed in below — but for
  // simplicity we just count attempts in this scope.
  try {
    const result = await fn();
    // If fallback path was used (caught inside), the caller's fn does its own
    // retry — we can't see that from here. We approximate retries=0 if first
    // attempt succeeded.
    const durationMs = result.latencyMs ?? Date.now() - startTs;
    void logger.info(`[router] ${fields.category} ok ${result.provider}/${result.model} ${durationMs}ms`, 'router');
    const invocation = {
      category: fields.category,
      provider: result.provider ?? fields.provider,
      model: result.model ?? fields.model,
      endpointId: fields.endpointId,
      startedAt,
      finishedAt: nowIso(),
      durationMs,
      retries,
      inputTokens: result.usage?.promptTokens,
      outputTokens: result.usage?.completionTokens,
      imageCount: fields.category === 'image' ? 1 : undefined,
      audioSeconds: fields.category === 'tts' ? result.durationSeconds : undefined,
      videoSeconds: fields.category === 'video' ? result.durationSeconds : undefined,
      promptPreview: truncatePrompt(fields.prompt),
      sourceLabel: fields.sourceLabel,
      requestSummary: fields.requestSummary,
      supportedParameters: fields.supportedParameters,
      actualParameters: fields.actualParameters,
      requestSnapshot: fields.requestSnapshot,
      responseSnapshot: fields.category === 'llm'
        ? undefined
        : buildResponseSnapshot(fields.category, result),
      attempts: fields.attempts,
      executionStatus: fields.executionStatus ?? ('succeeded' as const),
      error: lastErr,
    };
    emitInvocation(invocation);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[router] ${fields.category} FAIL ${fields.provider}/${fields.model} endpoint=${fields.endpointId ?? '-'} baseUrl=${fields.baseUrl ?? '-'} : ${msg}`, 'router');
    const invocation = {
      category: fields.category,
      provider: fields.provider,
      model: fields.model,
      endpointId: fields.endpointId,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - startTs,
      retries,
      promptPreview: truncatePrompt(fields.prompt),
      sourceLabel: fields.sourceLabel,
      requestSummary: fields.requestSummary,
      supportedParameters: fields.supportedParameters,
      actualParameters: fields.actualParameters,
      requestSnapshot: fields.requestSnapshot,
      attempts: fields.attempts,
      executionStatus: 'failed' as const,
      error: msg,
    };
    emitInvocation(invocation);
    throw err;
  }
}

// --- LLM Provider Factory ---

function createLLMProvider(
  providerId: LLMProviderId,
  endpoint: import('@/types/providers').ApiEndpoint,
): BaseLLMProvider {
  switch (providerId) {
    case 'claude':
      return new ClaudeProvider(endpoint);
    case 'openai':
      return new OpenAICompatibleProvider(endpoint, 'openai');
    case 'deepseek':
      return new OpenAICompatibleProvider(endpoint, 'deepseek');
    case 'qwen':
      return new OpenAICompatibleProvider(endpoint, 'qwen');
    case 'doubao':
      return new OpenAICompatibleProvider(endpoint, 'doubao');
    case 'glm':
      return new OpenAICompatibleProvider(endpoint, 'glm');
    default:
      return new OpenAICompatibleProvider(endpoint, 'custom');
  }
}

// --- Unified Provider Router ---

function resolveEndpoint(
  endpointId: string | undefined,
  category: 'llm' | 'image' | 'video',
): ApiEndpoint | undefined {
  const store = useProviderStore.getState();
  if (endpointId) {
    const endpoint = store.endpoints.find((candidate) => candidate.id === endpointId);
    if (!endpoint || !endpoint.enabled || !isEndpointInCategory(endpoint, category)) {
      throw new Error(`Configured ${category} endpoint "${endpointId}" is missing, disabled, or belongs to another category`);
    }
    return endpoint;
  }
  return store.getActiveEndpoint(category);
}

function resolveConfiguredModel(
  category: 'image' | 'video',
  taskType: ImageTaskType | VideoTaskType,
  requestedModel: string | undefined,
  endpoint: ApiEndpoint | undefined,
): string {
  const store = useProviderStore.getState();
  const config = store.config[category];
  const taskModel = (config.models as Record<string, string> | undefined)?.[taskType];
  const explicitModel = requestedModel?.trim();

  // A model emitted by the planner or selected by a caller is a decision, not
  // a hint. If the endpoint advertises a model list, never replace that
  // decision with another model behind the caller's back.
  if (explicitModel) {
    if (endpoint?.models?.length && !endpoint.models.includes(explicitModel)) {
      throw new Error(
        `Requested ${category} model "${explicitModel}" is not advertised by endpoint ${endpoint.id}. `
          + `Available models: ${endpoint.models.join(', ')}`,
      );
    }
    return explicitModel;
  }

  if (endpoint?.models?.length) {
    const configuredCandidates = [taskModel, config.defaultModel].filter(
      (value): value is string => !!value?.trim(),
    );
    return configuredCandidates.find((candidate) => endpoint.models?.includes(candidate)) ?? endpoint.models[0];
  }
  if (taskModel?.trim()) return taskModel.trim();
  if (config.defaultModel?.trim()) return config.defaultModel.trim();
  return category === 'image'
    ? getImageGenerationCapabilities(endpoint?.provider as ImageProviderId ?? config.primary as ImageProviderId, undefined, endpoint?.id).model
    : getVideoGenerationCapabilities(endpoint?.provider as VideoProviderId ?? config.primary as VideoProviderId, undefined, endpoint?.id).model;
}

/**
 * Fallback endpoints have their own model list and capability contract. A
 * primary planner decision can be reused only when that endpoint advertises
 * the same model; otherwise use the fallback endpoint's declared first model
 * or its provider contract default.
 */
function resolveFallbackModel(
  category: 'image' | 'video',
  requestedModel: string | undefined,
  endpoint: ApiEndpoint,
): string {
  const explicitModel = requestedModel?.trim();
  if (explicitModel && (!endpoint.models?.length || endpoint.models.includes(explicitModel))) {
    return explicitModel;
  }
  if (endpoint.models?.length) return endpoint.models[0];
  return category === 'image'
    ? getImageGenerationCapabilities(endpoint.provider as ImageProviderId, undefined, endpoint.id).model
    : getVideoGenerationCapabilities(endpoint.provider as VideoProviderId, undefined, endpoint.id).model;
}

function collectImageParameterInputs(request: ImageGenerateRequest): Record<string, unknown> {
  return {
    ...(request.parameters ?? {}),
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
    ...(request.editStrength !== undefined ? { editStrength: request.editStrength } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

function collectVideoParameterInputs(request: VideoGenerateRequest): Record<string, unknown> {
  return {
    ...(request.parameters ?? {}),
    ...(request.generateAudio !== undefined ? { generateAudio: request.generateAudio } : {}),
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
  };
}

function valueAsString(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function valueAsNumber(values: Record<string, unknown>, key: string): number | undefined {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeParameters(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (typeof value === 'string') {
        return `${key}=${value.length > 120 ? `${value.slice(0, 120)}…` : value}`;
      }
      return `${key}=${JSON.stringify(value)}`;
    })
    .join(';') || '-';
}

/** Planner-selected values are decisions, so unsupported ones must fail at
 * the provider boundary instead of disappearing from the actual request. */
function assertPlannerParameterCompatibility(
  parameters: Record<string, unknown> | undefined,
  rejectedKeys: string[],
  category: 'image' | 'video',
  provider: string,
  model: string,
): void {
  const requestedKeys = new Set(Object.keys(parameters ?? {}));
  const rejectedPlannerKeys = rejectedKeys.filter((key) => requestedKeys.has(key));
  if (rejectedPlannerKeys.length > 0) {
    throw new Error(
      `${category} planner parameters are not supported by ${provider}/${model}: `
        + `${rejectedPlannerKeys.join(', ')}. Replan this shot with the advertised capability contract.`,
    );
  }
}

/**
 * The normalized request contains both planner fields and application-level
 * fields such as fps, width, or negativePrompt. Only keys explicitly emitted
 * in `parameters` are planner decisions and should be reported as rejected.
 * Adapters may consume or normalize the application fields independently.
 */
function plannerRejectedKeys(
  rejectedKeys: string[],
  parameters: Record<string, unknown> | undefined,
): string[] {
  const plannerKeys = new Set(Object.keys(parameters ?? {}));
  return rejectedKeys.filter((key) => plannerKeys.has(key));
}

interface NormalizedImageRequest {
  request: ImageGenerateRequest;
  capabilities: ImageGenerationCapabilities;
  acceptedKeys: string[];
  rejectedKeys: string[];
}

function normalizeImageRequest(
  request: ImageGenerateRequest,
  provider: ImageProviderId,
  endpointId: string,
  model: string,
  availableModels?: string[],
  capabilityOverride?: ImageModelCapabilityOverride,
): NormalizedImageRequest {
  const baseCapabilities = getImageGenerationCapabilities(provider, model, endpointId, capabilityOverride);
  assertAdapterAvailable(baseCapabilities);
  const capabilities = availableModels?.length
    ? { ...baseCapabilities, availableModels: [...availableModels] }
    : baseCapabilities;
  const referenceBundle = materializeReferenceInputBundle(
    request.referenceImages,
    request.referenceSlots,
    'custom',
    `${provider}/${model}`,
  );
  validateImageReferences(referenceBundle.images, capabilities);
  const inputs = collectImageParameterInputs(request);
  if (provider === 'agnes-image' && typeof inputs.seed === 'number') inputs.seed = normalizeAgnesImageSeed(inputs.seed);
  const filtered = filterGenerationParameters(inputs, capabilities);
  const values = filtered.values;
  const editStrength = valueAsNumber(values, 'editStrength');
  if (request.mask !== undefined && request.editStrength !== undefined && editStrength === undefined) throw new Error('This endpoint rejected the requested image edit strength');
  validateNativeImageEdit({ ...request, referenceImages: referenceBundle.images, editStrength }, capabilities);
  return {
    capabilities,
    acceptedKeys: filtered.acceptedKeys,
    rejectedKeys: filtered.rejectedKeys,
    request: {
      taskType: request.taskType,
      prompt: request.prompt,
      model: valueAsString(values, 'model'),
      size: valueAsString(values, 'size'),
      negativePrompt: valueAsString(values, 'negativePrompt'),
      width: valueAsNumber(values, 'width'),
      height: valueAsNumber(values, 'height'),
      aspectRatio: valueAsString(values, 'aspectRatio'),
      style: valueAsString(values, 'style'),
      quality: valueAsString(values, 'quality'),
      steps: valueAsNumber(values, 'steps'),
      guidanceScale: valueAsNumber(values, 'guidanceScale'),
      mask: request.mask,
      editStrength,
      seed: valueAsNumber(values, 'seed'),
      referenceImages: referenceBundle.images.length > 0 ? referenceBundle.images : undefined,
      referenceSlots: referenceBundle.slots.length > 0 ? referenceBundle.slots : undefined,
      endpointId,
      parameters: values,
      parameterSpecs: capabilities.parameters,
    },
  };
}

interface NormalizedVideoRequest {
  request: VideoGenerateRequest;
  capabilities: VideoGenerationCapabilities;
  acceptedKeys: string[];
  rejectedKeys: string[];
}

function normalizeVideoRequest(
  request: VideoGenerateRequest,
  provider: VideoProviderId,
  endpointId: string,
  model: string,
  availableModels?: string[],
  capabilityOverride?: VideoModelCapabilityOverride,
): NormalizedVideoRequest {
  const baseCapabilities = getVideoGenerationCapabilities(provider, model, endpointId, capabilityOverride);
  assertAdapterAvailable(baseCapabilities);
  const capabilities = availableModels?.length
    ? { ...baseCapabilities, availableModels: [...availableModels] }
    : baseCapabilities;
  const referenceBundle = materializeReferenceInputBundle(
    request.referenceImages,
    request.referenceSlots,
    'custom',
    `${provider}/${model}`,
  );
  let resolutionNormalizedRequest = normalizeVideoResolution(request, capabilities);
  const durationRule = capabilities.parameters.find((parameter) => parameter.key === 'durationSeconds');
  if (Number.isFinite(request.durationSeconds) && durationRule && !durationRule.allowedValues?.length) {
    const seconds = Math.max(durationRule.min ?? 0, Math.min(durationRule.max ?? Infinity, request.durationSeconds!));
    resolutionNormalizedRequest = {
      ...resolutionNormalizedRequest,
      durationSeconds: durationRule.type === 'integer' ? Math.round(seconds) : seconds,
    };
  }
  const filtered = filterGenerationParameters(collectVideoParameterInputs(resolutionNormalizedRequest), capabilities);
  const values = filtered.values;
  const references = normalizeVideoReferences({
    ...request,
    referenceImages: referenceBundle.images,
  }, capabilities);
  const normalizedReferenceSlots = buildNormalizedVideoReferenceSlots(
    referenceBundle.slots,
    references,
    `${provider}/${model}`,
  );
  return {
    capabilities,
    acceptedKeys: filtered.acceptedKeys,
    rejectedKeys: filtered.rejectedKeys,
    request: {
      taskType: request.taskType,
      prompt: request.prompt,
      model: valueAsString(values, 'model'),
      negativePrompt: valueAsString(values, 'negativePrompt'),
      width: valueAsNumber(values, 'width'),
      height: valueAsNumber(values, 'height'),
      aspectRatio: valueAsString(values, 'aspectRatio'),
      durationSeconds: valueAsNumber(values, 'durationSeconds'),
      fps: valueAsNumber(values, 'fps'),
      seed: valueAsNumber(values, 'seed'),
      numInferenceSteps: valueAsNumber(values, 'numInferenceSteps'),
      mode: valueAsString(values, 'mode'),
      controlMode: references.controlMode,
      referenceImages: references.referenceImages,
      referenceSlots: normalizedReferenceSlots.length > 0 ? normalizedReferenceSlots : undefined,
      firstFrame: references.firstFrame,
      lastFrame: references.lastFrame,
      subjectReferences: references.subjectReferences,
      audioPrompt: request.audioPrompt,
      audioReferences: references.audioReferences,
      videoReferences: references.videoReferences,
      generateAudio: typeof values.generateAudio === 'boolean' ? values.generateAudio : undefined,
      endpointId,
      parameters: values,
      parameterSpecs: capabilities.parameters,
    },
  };
}

function buildNormalizedVideoReferenceSlots(
  sourceSlots: import('@/types/providers').GenerationReferenceInput[],
  references: import('@/services/providers/provider-capabilities').NormalizedVideoReferences,
  context: string,
): import('@/types/providers').GenerationReferenceInput[] {
  if (references.controlMode === 'keyframe') {
    const descriptors = [
      ...(references.firstFrame ? [{
        id: 'first-frame',
        role: 'first_frame' as const,
        image: references.firstFrame,
      }] : []),
      ...(references.lastFrame ? [{
        id: 'last-frame',
        role: 'last_frame' as const,
        image: references.lastFrame,
      }] : []),
    ];
    return alignReferenceSlots(sourceSlots, descriptors, `${context} video`);
  }
  if (references.controlMode === 'reference') {
    const descriptors = (references.subjectReferences ?? []).map((reference) => ({
      id: reference.id,
      role: 'subject' as const,
      image: reference.image,
      label: reference.label,
    }));
    return alignReferenceSlots(sourceSlots, descriptors, `${context} video`);
  }
  return [];
}

/**
 * Normalize the application resolution before provider parameters are
 * filtered. The project may retain a historical 1080p preference while the
 * bound model only exposes 720p; passing that value through lets an adapter
 * accidentally submit an unsupported tier.
 */
function normalizeVideoResolution(
  request: VideoGenerateRequest,
  capabilities: VideoGenerationCapabilities,
): VideoGenerateRequest {
  const tiers = capabilities.resolutionTiers?.filter((tier) => (
    (tier.shortEdge && tier.shortEdge > 0) || (tier.width && tier.height)
  )) ?? [];
  if (!tiers.length || !request.width || !request.height) return request;

  const requestedShortEdge = Math.min(request.width, request.height);
  const sorted = [...tiers].sort((a, b) => (
    resolutionShortEdge(a) - resolutionShortEdge(b)
  ));
  const eligible = sorted.filter((tier) => resolutionShortEdge(tier) <= requestedShortEdge);
  const selected = eligible[eligible.length - 1] ?? sorted[0];
  if (!selected) return request;

  const aspectRatio = request.aspectRatio || inferAspectRatio(request.width, request.height);
  const dimensions = selected.width && selected.height
    ? { width: selected.width, height: selected.height }
    : dimensionsForAspect(aspectRatio, selected.shortEdge ?? 720);
  return {
    ...request,
    width: dimensions.width,
    height: dimensions.height,
  };
}

function resolutionShortEdge(tier: NonNullable<VideoGenerationCapabilities['resolutionTiers']>[number]): number {
  return tier.shortEdge ?? Math.min(tier.width ?? 720, tier.height ?? 720);
}

function dimensionsForAspect(aspectRatio: string, shortEdge: number): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16': return { width: shortEdge, height: Math.round(shortEdge * 16 / 9) };
    case '1:1': return { width: shortEdge, height: shortEdge };
    case '4:3': return { width: Math.round(shortEdge * 4 / 3), height: shortEdge };
    case '3:4': return { width: shortEdge, height: Math.round(shortEdge * 4 / 3) };
    case '21:9': return { width: Math.round(shortEdge * 21 / 9), height: shortEdge };
    default: return { width: Math.round(shortEdge * 16 / 9), height: shortEdge };
  }
}

function inferAspectRatio(width: number, height: number): string {
  const ratio = width / height;
  const candidates = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  return candidates.reduce((closest, candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(':').map(Number);
    const [closestWidth, closestHeight] = closest.split(':').map(Number);
    return Math.abs(candidateWidth / candidateHeight - ratio)
      < Math.abs(closestWidth / closestHeight - ratio)
      ? candidate
      : closest;
  }, '16:9');
}

function assertAdapterAvailable(
  capabilities: ImageGenerationCapabilities | VideoGenerationCapabilities,
): void {
  if (capabilities.adapterAvailable === false) {
    throw new Error(
      `No ${capabilities.modality} adapter is implemented for provider ${capabilities.provider}. `
      + 'Choose a provider with a configured adapter or add the adapter before generating.',
    );
  }
}

class ProviderRouter {
  // LLM

  getLLMCapabilities(
    taskType: import('@/types/providers').LLMTaskType = 'review',
    model?: string,
    endpointId?: string,
  ) {
    const store = useProviderStore.getState();
    const config = store.config.llm;
    const endpoint = endpointId
      ? resolveEndpoint(endpointId, 'llm')
      : store.getActiveEndpoint('llm');
    const provider = (endpoint?.provider ?? config.primary) as LLMProviderId;
    const configuredModel = (config.models as Record<string, string> | undefined)?.[taskType];
    const requestedModel = model?.trim() || configuredModel || config.defaultModel;
    const resolvedModel = endpoint?.models?.length
      ? endpoint.models.includes(requestedModel) ? requestedModel : endpoint.models[0]
      : requestedModel;
    return getLLMGenerationCapabilities(
      provider,
      resolvedModel,
      endpoint?.id,
      endpoint?.generationCapabilities?.llm?.[resolvedModel],
    );
  }

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.llm;
    const endpoint = request.endpointId ? resolveEndpoint(request.endpointId, 'llm') : store.getActiveEndpoint('llm');

    if (!endpoint) {
      // Use default OpenAI public endpoint (user must have configured API key)
      throw new Error('No LLM endpoint configured. Please add an API endpoint in Settings → Providers.');
    }

    let taskModel = (config.models as Record<string, string> | undefined)?.[request.taskType];
    let effectiveModel = config.defaultModel || endpoint.models?.[0] || 'glm-5.2';

    // 针对中转站 / 自定义代理（如 OneAPI / NewAPI / 私有中转）：
    // 若端点配置了支持的模型列表（例如 ["glm-5.2"]），确保发送的模型必须在该端点支持的列表中，
    // 彻底杜绝因残留旧服务商模型名称（如 deepseek-chat）导致中转站抛出 503 "无可用渠道支持模型"！
    if (endpoint.models && endpoint.models.length > 0) {
      if (taskModel && endpoint.models.includes(taskModel)) {
        effectiveModel = taskModel;
      } else if (config.defaultModel && endpoint.models.includes(config.defaultModel)) {
        effectiveModel = config.defaultModel;
      } else {
        effectiveModel = endpoint.models[0];
      }
    } else if (taskModel) {
      effectiveModel = taskModel;
    }

    const requestWithModel = { ...request, model: request.model || effectiveModel };

    // 取出 system + user 拼成可读 prompt(只用于账本展示)
    const req = requestWithModel as LLMGenerateRequest;
    const promptText = [req.systemPrompt && `[system] ${req.systemPrompt}`, req.userPrompt && `[user] ${req.userPrompt}`]
      .filter(Boolean)
      .join('\n') || undefined;

    return runWithInvocation(
      {
        category: 'llm',
        provider: endpoint.provider,
        model: requestWithModel.model ?? effectiveModel,
        endpointId: endpoint.id,
        prompt: promptText,
        baseUrl: endpoint.baseUrl,
        requestSummary: [
          `visualInputs=${requestWithModel.imageInputs?.length ?? 0}`,
          `responseFormat=${requestWithModel.responseFormat ?? 'text'}`,
        ],
        requestSnapshot: buildLLMRequestSnapshot(requestWithModel),
      },
      async () => {
        try {
          const provider = createLLMProvider(endpoint.provider as LLMProviderId, endpoint);
          return await provider.generate(requestWithModel);
        } catch (primaryError) {
          if (request.endpointId || !config.fallback) throw primaryError;

          // Try fallback
          const fallbackEndpoint = store.getFallbackEndpoint('llm');
          if (!fallbackEndpoint) throw primaryError;

          try {
            const fallbackProvider = createLLMProvider(config.fallback, fallbackEndpoint);
            return await fallbackProvider.generate(requestWithModel);
          } catch {
            throw primaryError; // Throw original error
          }
        }
      },
    );
  }

  async *stream(request: LLMGenerateRequest): AsyncIterable<LLMStreamChunk> {
    const store = useProviderStore.getState();
    const config = store.config.llm;
    const endpoint = store.getActiveEndpoint('llm');

    if (!endpoint) {
      throw new Error('No LLM endpoint configured.');
    }

    const effectiveModel = (config.models as Record<string, string> | undefined)?.[request.taskType] ?? config.defaultModel;
    const requestWithModel = { ...request, model: request.model || effectiveModel };

    const provider = createLLMProvider(config.primary, endpoint);
    yield* provider.stream(requestWithModel);
  }

  // Image

  getImageCapabilities(
    taskType: ImageTaskType = 'storyboard',
    model?: string,
    endpointId?: string,
  ): ImageGenerationCapabilities {
    const store = useProviderStore.getState();
    const config = store.config.image;
    const endpoint = resolveEndpoint(endpointId, 'image');
    const provider = (endpoint?.provider ?? config.primary) as ImageProviderId;
    const resolvedModel = resolveConfiguredModel('image', taskType, model, endpoint);
    const capabilities = getImageGenerationCapabilities(
      provider,
      resolvedModel,
      endpoint?.id,
      endpoint?.generationCapabilities?.image?.[resolvedModel],
    );
    return endpoint?.models?.length
      ? {
          ...capabilities,
          availableModels: [...endpoint.models],
          modelCapabilities: getImageModelCapabilities(
            provider,
            endpoint.models,
            endpoint.id,
            endpoint.generationCapabilities?.image,
          ),
        }
      : capabilities;
  }

  getVideoCapabilities(
    taskType: VideoTaskType = 'clip',
    model?: string,
    endpointId?: string,
  ): VideoGenerationCapabilities {
    const store = useProviderStore.getState();
    const config = store.config.video;
    const endpoint = resolveEndpoint(endpointId, 'video');
    const provider = (endpoint?.provider ?? config.primary) as VideoProviderId;
    const resolvedModel = resolveConfiguredModel('video', taskType, model, endpoint);
    const capabilities = getVideoGenerationCapabilities(
      provider,
      resolvedModel,
      endpoint?.id,
      endpoint?.generationCapabilities?.video?.[resolvedModel],
    );
    return endpoint?.models?.length
      ? {
          ...capabilities,
          availableModels: [...endpoint.models],
          modelCapabilities: getVideoModelCapabilities(
            provider,
            endpoint.models,
            endpoint.id,
            endpoint.generationCapabilities?.video,
          ),
        }
      : capabilities;
  }

  async generateImage(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.image;
    const explicitEndpoint = request.endpointId
      ? store.endpoints.find((endpoint) => endpoint.id === request.endpointId
        && endpoint.enabled
        && isEndpointInCategory(endpoint, 'image'))
      : undefined;

    if (request.endpointId && !explicitEndpoint) {
      throw new Error(`Configured image endpoint "${request.endpointId}" is missing or disabled`);
    }

    const endpoint = explicitEndpoint ?? store.getActiveEndpoint('image');

    if (!endpoint) {
      throw new Error('No image endpoint configured. Please add one in Settings → Providers.');
    }

    const endpointProvider = endpoint.provider as ImageProviderId;
    const plannedModel = valueAsString(request.parameters ?? {}, 'model');
    const effectiveModel = resolveConfiguredModel(
      'image',
      request.taskType,
      request.model || plannedModel,
      endpoint,
    );
    const requestWithModel: ImageGenerateRequest = { ...request, model: effectiveModel, endpointId: endpoint.id };
    const normalized = normalizeImageRequest(
      requestWithModel,
      endpointProvider,
      endpoint.id,
      effectiveModel,
      endpoint.models,
      endpoint.generationCapabilities?.image?.[effectiveModel],
    );
    const rejectedPlannerKeys = plannerRejectedKeys(normalized.rejectedKeys, requestWithModel.parameters);
    assertPlannerParameterCompatibility(
      requestWithModel.parameters,
      normalized.rejectedKeys,
      'image',
      normalized.capabilities.provider,
      normalized.capabilities.model,
    );
    if (rejectedPlannerKeys.length > 0) {
      void logger.warn(
        `[router] image planner parameters rejected for ${normalized.capabilities.provider}/${normalized.capabilities.model}: ${rejectedPlannerKeys.join(',')}`,
        'router',
      );
    }
    const imageWireParameterValues = createImageProvider(endpointProvider, endpoint)
      .getWireParameterSnapshot(normalized.request);

    const invocationFields: RouterInvocationFields = {
        category: 'image',
        provider: endpointProvider,
        model: effectiveModel,
        endpointId: endpoint.id,
        sourceLabel: requestWithModel.sourceLabel,
        prompt: requestWithModel.prompt,
        baseUrl: endpoint.baseUrl,
        requestSummary: [
          `capabilities=${normalized.capabilities.parameters.map((item) => item.key).join(',') || '-'}`,
          `parameters=${normalized.acceptedKeys.join(',') || '-'}`,
          `rejectedPlanner=${rejectedPlannerKeys.join(',') || '-'}`,
          `values=${summarizeParameters(normalized.request.parameters ?? {})}`,
          `references=${requestWithModel.referenceImages?.length ?? 0}`,
          `size=${normalized.request.width ?? '-'}x${normalized.request.height ?? '-'}`,
          `seed=${normalized.request.seed ?? '-'}`,
        ],
        supportedParameters: normalized.capabilities.parameters.map((item) => item.key),
        actualParameters: normalized.acceptedKeys,
        requestSnapshot: buildImageRequestSnapshot(
          normalized.request,
          normalized.acceptedKeys,
          rejectedPlannerKeys,
          imageWireParameterValues,
        ),
      };

    const result = await runWithInvocation(
      invocationFields,
      async () => {
        // 内容审核拦截时自动改写 prompt 重试(soft → aggressive),
        // 每次重试内部都会走完整的 primary → fallback 链路。
        return callWithSafetyRetry(normalized.request.prompt, async (prompt) => {
          updateInvocationPrompt(invocationFields, prompt);
          const reqWithRewritten: ImageGenerateRequest = { ...normalized.request, prompt };
          // 图像生成也可能因代理转发/网络抖动触发 "Request canceled",
          // 关键帧/角色立绘/场景图任一步全失败都会让整条流水线断掉。
          // 这里加 timeout-retry,和 video 路径保持一致的容错策略。
          return callWithTimeoutRetry(async () => {
            try {
              const provider = createImageProvider(endpointProvider, endpoint);
              return await provider.generate(reqWithRewritten);
            } catch (primaryError) {
              if (explicitEndpoint || !config.fallback) throw primaryError;
              const fallbackEndpoint = store.getFallbackEndpoint('image');
              if (!fallbackEndpoint) throw primaryError;

              try {
                const fallbackProviderId = config.fallback as ImageProviderId;
                const fallbackModel = resolveFallbackModel(
                  'image',
                  request.model || plannedModel,
                  fallbackEndpoint,
                );
                const fallbackRequest: ImageGenerateRequest = {
                  ...request,
                  model: fallbackModel,
                  endpointId: fallbackEndpoint.id,
                };
                const fallbackNormalized = normalizeImageRequest(
                  fallbackRequest,
                  fallbackProviderId,
                  fallbackEndpoint.id,
                  fallbackModel,
                  fallbackEndpoint.models,
                  fallbackEndpoint.generationCapabilities?.image?.[fallbackModel],
                );
                const fallbackRejectedPlannerKeys = plannerRejectedKeys(fallbackNormalized.rejectedKeys, fallbackRequest.parameters);
                assertPlannerParameterCompatibility(
                  fallbackRequest.parameters,
                  fallbackNormalized.rejectedKeys,
                  'image',
                  fallbackNormalized.capabilities.provider,
                  fallbackNormalized.capabilities.model,
                );
                if (fallbackRejectedPlannerKeys.length > 0) {
                  void logger.warn(
                    `[router] fallback image planner parameters rejected for ${fallbackProviderId}/${fallbackModel}: ${fallbackRejectedPlannerKeys.join(',')}`,
                    'router',
                  );
                }
                const fallbackImageWireParameterValues = createImageProvider(fallbackProviderId, fallbackEndpoint)
                  .getWireParameterSnapshot(fallbackNormalized.request);
                invocationFields.provider = fallbackProviderId;
                invocationFields.model = fallbackModel;
                invocationFields.endpointId = fallbackEndpoint.id;
                invocationFields.baseUrl = fallbackEndpoint.baseUrl;
                invocationFields.requestSummary = [
                  `capabilities=${fallbackNormalized.capabilities.parameters.map((item) => item.key).join(',') || '-'}`,
                  `parameters=${fallbackNormalized.acceptedKeys.join(',') || '-'}`,
                  `rejectedPlanner=${fallbackRejectedPlannerKeys.join(',') || '-'}`,
                  `values=${summarizeParameters(fallbackNormalized.request.parameters ?? {})}`,
                  `references=${fallbackNormalized.request.referenceImages?.length ?? 0}`,
                  `size=${fallbackNormalized.request.width ?? '-'}x${fallbackNormalized.request.height ?? '-'}`,
                  `seed=${fallbackNormalized.request.seed ?? '-'}`,
                ];
                invocationFields.supportedParameters = fallbackNormalized.capabilities.parameters.map((item) => item.key);
                invocationFields.actualParameters = fallbackNormalized.acceptedKeys;
                invocationFields.requestSnapshot = buildImageRequestSnapshot(
                  fallbackNormalized.request,
                  fallbackNormalized.acceptedKeys,
                  fallbackRejectedPlannerKeys,
                  fallbackImageWireParameterValues,
                );
                const fallbackReqWithPrompt: ImageGenerateRequest = {
                  ...fallbackNormalized.request,
                  prompt,
                };
                updateInvocationPrompt(invocationFields, prompt);
                return await createImageProvider(fallbackProviderId, fallbackEndpoint).generate(fallbackReqWithPrompt);
              } catch (fallbackError) {
                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
                throw new Error(`Primary image provider failed: ${primaryMessage}; fallback failed: ${fallbackMessage}`);
              }
            }
          });
        });
      },
    );
    return {
      ...result,
      endpointId: invocationFields.endpointId,
      requestSnapshot: invocationFields.requestSnapshot,
      responseSnapshot: buildResponseSnapshot('image', result),
    };
  }

  // Video

  async generateVideo(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.video;

    // Caller can pin a specific endpoint (used by DirectVideoModal's provider/model picker)
    const explicitEndpoint = request.endpointId
      ? store.endpoints.find((e) => e.id === request.endpointId
        && e.enabled
        && isEndpointInCategory(e, 'video'))
      : undefined;

    if (request.endpointId && !explicitEndpoint) {
      throw new Error(`Configured video endpoint "${request.endpointId}" is missing or disabled`);
    }

    const endpoint = explicitEndpoint ?? store.getActiveEndpoint('video');

    if (!endpoint) {
      throw new Error('No video endpoint configured. Please add one in Settings → Providers.');
    }

    const endpointProvider = endpoint.provider as VideoProviderId;
    const plannedModel = valueAsString(request.parameters ?? {}, 'model');
    const effectiveModel = resolveConfiguredModel(
      'video',
      request.taskType,
      request.model || plannedModel,
      endpoint,
    );
    const requestWithModel: VideoGenerateRequest = { ...request, model: effectiveModel, endpointId: endpoint.id };
    const normalized = normalizeVideoRequest(
      requestWithModel,
      endpointProvider,
      endpoint.id,
      effectiveModel,
      endpoint.models,
      endpoint.generationCapabilities?.video?.[effectiveModel],
    );
    const rejectedPlannerKeys = plannerRejectedKeys(normalized.rejectedKeys, requestWithModel.parameters);
    assertPlannerParameterCompatibility(
      requestWithModel.parameters,
      normalized.rejectedKeys,
      'video',
      normalized.capabilities.provider,
      normalized.capabilities.model,
    );
    if (rejectedPlannerKeys.length > 0) {
      void logger.warn(
        `[router] video planner parameters rejected for ${normalized.capabilities.provider}/${normalized.capabilities.model}: ${rejectedPlannerKeys.join(',')}`,
        'router',
      );
    }
    const videoWireParameterValues = createVideoProvider(endpointProvider, endpoint)
      .getWireParameterSnapshot(normalized.request);

    const invocationFields: RouterInvocationFields = {
        category: 'video',
        provider: endpointProvider,
        model: effectiveModel,
        endpointId: endpoint.id,
        sourceLabel: requestWithModel.sourceLabel,
        prompt: requestWithModel.prompt,
        baseUrl: endpoint.baseUrl,
        requestSummary: [
          `capabilities=${normalized.capabilities.parameters.map((item) => item.key).join(',') || '-'}`,
          `parameters=${normalized.acceptedKeys.join(',') || '-'}`,
          `rejectedPlanner=${rejectedPlannerKeys.join(',') || '-'}`,
          `values=${summarizeParameters(normalized.request.parameters ?? {})}`,
          `mode=${normalized.request.controlMode ?? 'text'}`,
          `references=${normalized.request.referenceImages?.length ?? 0}`,
          `subjects=${normalized.request.subjectReferences?.length ?? 0}`,
          `firstFrame=${normalized.request.firstFrame ? 'yes' : 'no'}`,
          `lastFrame=${normalized.request.lastFrame ? 'yes' : 'no'}`,
          `size=${normalized.request.width ?? '-'}x${normalized.request.height ?? '-'}`,
          `fps=${normalized.request.fps ?? '-'}`,
          `seed=${normalized.request.seed ?? '-'}`,
        ],
        supportedParameters: normalized.capabilities.parameters.map((item) => item.key),
        actualParameters: normalized.acceptedKeys,
        requestSnapshot: buildVideoRequestSnapshot(
          normalized.request,
          normalized.acceptedKeys,
          rejectedPlannerKeys,
          videoWireParameterValues,
        ),
      };

    const result = await runWithInvocation(
      invocationFields,
      async () => {
        return callWithSafetyRetry(normalized.request.prompt, async (prompt) => {
          updateInvocationPrompt(invocationFields, prompt);
          const reqWithRewritten: VideoGenerateRequest = { ...normalized.request, prompt };
          // 视频生成是长任务(submit + 长轮询),代理转发或网络抖动可能触发
          // tauri-plugin-http 的 "Request canceled"(单次请求超时)。
          // 这种瞬时错误值得重试,否则整个 video_generation stage 会失败、
          // 已经跑好的 6 个 shot 全废。
          return callWithTimeoutRetry(async () => {
            try {
              const provider = createVideoProvider(endpointProvider, endpoint);
              return await provider.generate(reqWithRewritten);
            } catch (primaryError) {
              if (explicitEndpoint || !config.fallback) throw primaryError;
              const fallbackEndpoint = store.getFallbackEndpoint('video');
              if (!fallbackEndpoint) throw primaryError;

              try {
                const fallbackProviderId = config.fallback as VideoProviderId;
                const fallbackModel = resolveFallbackModel(
                  'video',
                  request.model || plannedModel,
                  fallbackEndpoint,
                );
                const fallbackRequest: VideoGenerateRequest = {
                  ...request,
                  model: fallbackModel,
                  endpointId: fallbackEndpoint.id,
                };
                const fallbackNormalized = normalizeVideoRequest(
                  fallbackRequest,
                  fallbackProviderId,
                  fallbackEndpoint.id,
                  fallbackModel,
                  fallbackEndpoint.models,
                  fallbackEndpoint.generationCapabilities?.video?.[fallbackModel],
                );
                const fallbackRejectedPlannerKeys = plannerRejectedKeys(fallbackNormalized.rejectedKeys, fallbackRequest.parameters);
                assertPlannerParameterCompatibility(
                  fallbackRequest.parameters,
                  fallbackNormalized.rejectedKeys,
                  'video',
                  fallbackNormalized.capabilities.provider,
                  fallbackNormalized.capabilities.model,
                );
                if (fallbackRejectedPlannerKeys.length > 0) {
                  void logger.warn(
                    `[router] fallback video planner parameters rejected for ${fallbackProviderId}/${fallbackModel}: ${fallbackRejectedPlannerKeys.join(',')}`,
                    'router',
                  );
                }
                const fallbackVideoWireParameterValues = createVideoProvider(fallbackProviderId, fallbackEndpoint)
                  .getWireParameterSnapshot(fallbackNormalized.request);
                invocationFields.provider = fallbackProviderId;
                invocationFields.model = fallbackModel;
                invocationFields.endpointId = fallbackEndpoint.id;
                invocationFields.baseUrl = fallbackEndpoint.baseUrl;
                invocationFields.requestSummary = [
                  `capabilities=${fallbackNormalized.capabilities.parameters.map((item) => item.key).join(',') || '-'}`,
                  `parameters=${fallbackNormalized.acceptedKeys.join(',') || '-'}`,
                  `rejectedPlanner=${fallbackRejectedPlannerKeys.join(',') || '-'}`,
                  `values=${summarizeParameters(fallbackNormalized.request.parameters ?? {})}`,
                  `mode=${fallbackNormalized.request.controlMode ?? 'text'}`,
                  `references=${fallbackNormalized.request.referenceImages?.length ?? 0}`,
                  `subjects=${fallbackNormalized.request.subjectReferences?.length ?? 0}`,
                  `firstFrame=${fallbackNormalized.request.firstFrame ? 'yes' : 'no'}`,
                  `lastFrame=${fallbackNormalized.request.lastFrame ? 'yes' : 'no'}`,
                  `size=${fallbackNormalized.request.width ?? '-'}x${fallbackNormalized.request.height ?? '-'}`,
                  `fps=${fallbackNormalized.request.fps ?? '-'}`,
                  `seed=${fallbackNormalized.request.seed ?? '-'}`,
                ];
                invocationFields.supportedParameters = fallbackNormalized.capabilities.parameters.map((item) => item.key);
                invocationFields.actualParameters = fallbackNormalized.acceptedKeys;
                invocationFields.requestSnapshot = buildVideoRequestSnapshot(
                  fallbackNormalized.request,
                  fallbackNormalized.acceptedKeys,
                  fallbackRejectedPlannerKeys,
                  fallbackVideoWireParameterValues,
                );
                const fallbackReqWithPrompt: VideoGenerateRequest = {
                  ...fallbackNormalized.request,
                  prompt,
                };
                updateInvocationPrompt(invocationFields, prompt);
                return await createVideoProvider(fallbackProviderId, fallbackEndpoint).generate(fallbackReqWithPrompt);
              } catch (fallbackError) {
                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
                throw new Error(`Primary video provider failed: ${primaryMessage}; fallback failed: ${fallbackMessage}`);
              }
            }
          }, 3, {
            queueRetries: endpointProvider === 'agnes-video'
              ? config.queueRetryCount ?? 6
              : 3,
            queueBackoffMs: endpointProvider === 'agnes-video'
              ? config.queueRetryBackoffMs ?? 30000
              : 30000,
          });
        });
      },
    );
    return {
      ...result,
      endpointId: invocationFields.endpointId,
      requestSnapshot: invocationFields.requestSnapshot,
      responseSnapshot: buildResponseSnapshot('video', result),
    };
  }

  // TTS

  /** 返回当前激活的 TTS provider id(供上游 step-voice 按类型选真实音色 ID) */
  getActiveTTSProviderId(): TTSProviderId | null {
    const store = useProviderStore.getState();
    const endpoint = store.getActiveEndpoint('tts');
    if (!endpoint) return null;
    // endpoint.provider 是所有 provider id 的联合,这里运行时无 cast 风险
    // (caller 在 TTS 上下文里调,endpoint 必然是 TTS 类)
    return endpoint.provider as TTSProviderId;
  }

  async generateTTS(request: TTSRequest): Promise<TTSResponse> {
    const store = useProviderStore.getState();
    const config = store.config.tts;

    if (!config) {
      throw new Error('No TTS provider configured. Please add one in Settings → Providers.');
    }

    // Caller can pin a specific endpoint
    const explicitEndpoint = request.endpointId
      ? store.endpoints.find((e) => e.id === request.endpointId
        && e.enabled
        && isEndpointInCategory(e, 'tts'))
      : undefined;

    const endpoint = explicitEndpoint ?? store.getActiveEndpoint('tts');

    if (!endpoint) {
      throw new Error('No TTS endpoint configured. Please add one in Settings → Providers.');
    }

    const endpointProvider = endpoint.provider as TTSProviderId;
    const isOfficialOpenAI = endpoint.baseUrl.includes('api.openai.com');
    // 优先拿 Endpoint 配置里填写的模型(如用户在 Mojing/302.AI 填的特定模型名);若为第三方代理中转站,避开盲目发 tts-1
    let resolvedModel = request.model
      || (endpoint.models && endpoint.models.length > 0 ? endpoint.models[0] : undefined);

    if (!resolvedModel || resolvedModel === 'FunAudioLLM/SenseVoiceSmall' || resolvedModel === 'FunAudioLLM/CosyVoice-300M') {
      resolvedModel = (config.defaultModel && config.defaultModel !== 'FunAudioLLM/SenseVoiceSmall' && config.defaultModel !== 'FunAudioLLM/CosyVoice-300M')
        ? config.defaultModel
        : (isOfficialOpenAI ? 'tts-1' : 'FunAudioLLM/CosyVoice2-0.5B');
    }

    const requestWithDefaults: TTSRequest = {
      ...request,
      model: resolvedModel,
      voice: request.voice || config.defaultVoice,
      format: request.format || config.defaultFormat,
      speed: request.speed ?? config.defaultSpeed,
    };

    return runWithInvocation(
      {
        category: 'tts',
        provider: endpointProvider,
        model: requestWithDefaults.model ?? config.defaultModel,
        endpointId: endpoint.id,
        prompt: requestWithDefaults.text,
        baseUrl: endpoint.baseUrl,
      },
      async () => {
        try {
          const provider = createTTSProvider(endpointProvider, endpoint);
          return await provider.generate(requestWithDefaults);
        } catch (primaryError) {
          if (!explicitEndpoint && config.fallback) {
            const fallbackEndpoint = store.getFallbackEndpoint('tts');
            if (fallbackEndpoint) {
              try {
                const fallbackProvider = createTTSProvider(config.fallback, fallbackEndpoint);
                return await fallbackProvider.generate(requestWithDefaults);
              } catch (fallbackErr) {
                console.warn('[tts] fallback provider failed:', fallbackErr);
              }
            }
          }

          // 零门槛免费兜底：若主端点与备用端点均失败（如中转站 400 无额度），自动倒扣调用免费微软 Edge TTS
          console.warn('[tts] Primary & Fallback TTS endpoints failed, falling back to free EdgeTTS Provider:', primaryError);
          const now = new Date().toISOString();
          const edgeEndpoint: ApiEndpoint = {
            id: 'edge-tts-auto-fallback',
            name: '微软 Edge TTS (免费兜底)',
            provider: 'edge-tts' as TTSProviderId,
            baseUrl: 'https://speech.platform.bing.com',
            apiKey: 'free',
            enabled: true,
            createdAt: now,
            updatedAt: now,
          };
          const edgeProvider = createTTSProvider('edge-tts', edgeEndpoint);
          return await edgeProvider.generate(requestWithDefaults);
        }
      },
    );
  }
}

// Singleton
export const providerRouter = new ProviderRouter();

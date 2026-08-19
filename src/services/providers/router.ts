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
  VideoProviderId,
  TTSProviderId,
  ApiEndpoint,
} from '@/types/providers';
import { BaseLLMProvider, BaseImageProvider, BaseVideoProvider, BaseTTSProvider } from './base';
import { OpenAICompatibleProvider, ClaudeProvider } from './llm-adapters';
import { createImageProvider } from './image-adapters';
import { createVideoProvider } from './video-adapters';
import { createTTSProvider } from './tts-adapters';
import { useProviderStore } from '@/stores/providerStore';
import { logger } from '@/services/log';
import { emitInvocation } from './invocation-context';
import { isContentPolicyViolation, buildSafetyRewriteChain } from './prompt-safety';

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
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('limit reached') || msg.includes('ipm limit')) return true;
  // HTTP 5xx(从 "API error 503: ..." 这种消息里识别)
  if (/\b5\d{2}\b/.test(msg) && msg.includes('error')) return true;
  return false;
}

/** 对瞬时网络错误及 429 限流自动重试(最多 retries 次,指数退避)。
 *  非瞬时错误(如 content_policy / 400 参数错误 / 401 鉴权失败)直接抛,不重试。 */
async function callWithTimeoutRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientNetworkError(err)) throw err;
      const isRateLimit = err instanceof Error && /429|rate limit|limit reached/i.test(err.message);
      // 限流退避:6s, 12s, 24s;普通网络抖动:3s, 9s, 27s
      const delayMs = isRateLimit ? 6000 * Math.pow(2, attempt) : 3000 * Math.pow(3, attempt);
      void logger.warn(
        `[router] 瞬时错误/限流,${delayMs}ms 后重试 (${attempt + 1}/${retries}): ${
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

class ProviderRouter {
  // LLM

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.llm;
    const endpoint = store.getActiveEndpoint('llm');

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
        provider: config.primary,
        model: requestWithModel.model ?? effectiveModel,
        endpointId: endpoint.id,
        prompt: promptText,
        baseUrl: endpoint.baseUrl,
      },
      async () => {
        try {
          const provider = createLLMProvider(config.primary, endpoint);
          return await provider.generate(requestWithModel);
        } catch (primaryError) {
          if (!config.fallback) throw primaryError;

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

  async generateImage(request: ImageGenerateRequest): Promise<ImageGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.image;
    const endpoint = store.getActiveEndpoint('image');

    if (!endpoint) {
      throw new Error('No image endpoint configured. Please add one in Settings → Providers.');
    }

    let taskModel = (config.models as Record<string, string> | undefined)?.[request.taskType];
    let effectiveModel = config.defaultModel || endpoint.models?.[0] || 'agnes-image-2.1-flash';

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

    return runWithInvocation(
      {
        category: 'image',
        provider: config.primary,
        model: requestWithModel.model ?? effectiveModel,
        endpointId: endpoint.id,
        prompt: requestWithModel.prompt,
        baseUrl: endpoint.baseUrl,
      },
      async () => {
        // 内容审核拦截时自动改写 prompt 重试(soft → aggressive),
        // 每次重试内部都会走完整的 primary → fallback 链路。
        return callWithSafetyRetry(requestWithModel.prompt, async (prompt) => {
          const reqWithRewritten = { ...requestWithModel, prompt };
          // 图像生成也可能因代理转发/网络抖动触发 "Request canceled",
          // 关键帧/角色立绘/场景图任一步全失败都会让整条流水线断掉。
          // 这里加 timeout-retry,和 video 路径保持一致的容错策略。
          return callWithTimeoutRetry(async () => {
            try {
              const provider = createImageProvider(config.primary, endpoint);
              return await provider.generate(reqWithRewritten);
            } catch (primaryError) {
              if (!config.fallback) throw primaryError;
              const fallbackEndpoint = store.getFallbackEndpoint('image');
              if (!fallbackEndpoint) throw primaryError;

              try {
                const fallbackProvider = createImageProvider(config.fallback, fallbackEndpoint);
                return await fallbackProvider.generate(reqWithRewritten);
              } catch {
                throw primaryError;
              }
            }
          });
        });
      },
    );
  }

  // Video

  async generateVideo(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.video;

    // Caller can pin a specific endpoint (used by DirectVideoModal's provider/model picker)
    const explicitEndpoint = request.endpointId
      ? store.endpoints.find((e) => e.id === request.endpointId && e.enabled)
      : undefined;

    const endpoint = explicitEndpoint ?? store.getActiveEndpoint('video');

    if (!endpoint) {
      throw new Error('No video endpoint configured. Please add one in Settings → Providers.');
    }

    const endpointProvider = endpoint.provider as VideoProviderId;
    let taskModel = (config.models as Record<string, string> | undefined)?.[request.taskType];
    let effectiveModel = config.defaultModel || endpoint.models?.[0] || 'agnes-video-2.5';

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

    return runWithInvocation(
      {
        category: 'video',
        provider: endpointProvider,
        model: requestWithModel.model ?? effectiveModel,
        endpointId: endpoint.id,
        prompt: requestWithModel.prompt,
        baseUrl: endpoint.baseUrl,
      },
      async () => {
        return callWithSafetyRetry(requestWithModel.prompt, async (prompt) => {
          const reqWithRewritten = { ...requestWithModel, prompt };
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
                const fallbackProvider = createVideoProvider(config.fallback, fallbackEndpoint);
                return await fallbackProvider.generate(reqWithRewritten);
              } catch {
                throw primaryError;
              }
            }
          });
        });
      },
    );
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
      ? store.endpoints.find((e) => e.id === request.endpointId && e.enabled)
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

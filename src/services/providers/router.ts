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
} from '@/types/providers';
import { BaseLLMProvider, BaseImageProvider, BaseVideoProvider, BaseTTSProvider } from './base';
import { OpenAICompatibleProvider, ClaudeProvider } from './llm-adapters';
import { createImageProvider } from './image-adapters';
import { createVideoProvider } from './video-adapters';
import { createTTSProvider } from './tts-adapters';
import { useProviderStore } from '@/stores/providerStore';
import { logger } from '@/services/log';
import { emitInvocation } from './invocation-context';

function nowIso(): string {
  return new Date().toISOString();
}

function truncatePrompt(prompt: string | undefined, max = 2000): string | undefined {
  if (!prompt) return undefined;
  if (prompt.length <= max) return prompt;
  return `${prompt.slice(0, max)}\n…[truncated ${prompt.length - max} chars]`;
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

    const effectiveModel = (config.models as Record<string, string> | undefined)?.[request.taskType] ?? config.defaultModel;
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

    const effectiveModel = (config.models as Record<string, string> | undefined)?.[request.taskType] ?? config.defaultModel;
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
        try {
          const provider = createImageProvider(config.primary, endpoint);
          return await provider.generate(requestWithModel);
        } catch (primaryError) {
          if (!config.fallback) throw primaryError;
          const fallbackEndpoint = store.getFallbackEndpoint('image');
          if (!fallbackEndpoint) throw primaryError;

          try {
            const fallbackProvider = createImageProvider(config.fallback, fallbackEndpoint);
            return await fallbackProvider.generate(requestWithModel);
          } catch {
            throw primaryError;
          }
        }
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
    const effectiveModel = (config.models as Record<string, string> | undefined)?.[request.taskType] ?? config.defaultModel;
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
        try {
          const provider = createVideoProvider(endpointProvider, endpoint);
          return await provider.generate(requestWithModel);
        } catch (primaryError) {
          if (explicitEndpoint || !config.fallback) throw primaryError;
          const fallbackEndpoint = store.getFallbackEndpoint('video');
          if (!fallbackEndpoint) throw primaryError;

          try {
            const fallbackProvider = createVideoProvider(config.fallback, fallbackEndpoint);
            return await fallbackProvider.generate(requestWithModel);
          } catch {
            throw primaryError;
          }
        }
      },
    );
  }

  // TTS

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
    const requestWithDefaults: TTSRequest = {
      ...request,
      model: request.model || config.defaultModel,
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
          if (explicitEndpoint || !config.fallback) throw primaryError;
          const fallbackEndpoint = store.getFallbackEndpoint('tts');
          if (!fallbackEndpoint) throw primaryError;

          try {
            const fallbackProvider = createTTSProvider(config.fallback, fallbackEndpoint);
            return await fallbackProvider.generate(requestWithDefaults);
          } catch {
            throw primaryError;
          }
        }
      },
    );
  }
}

// Singleton
export const providerRouter = new ProviderRouter();

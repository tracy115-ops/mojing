import type {
  LLMGenerateRequest,
  LLMGenerateResponse,
  LLMStreamChunk,
  ImageGenerateRequest,
  ImageGenerateResponse,
  VideoGenerateRequest,
  VideoGenerateResponse,
  LLMProviderId,
  ImageProviderId,
  VideoProviderId,
} from '@/types/providers';
import { BaseLLMProvider, BaseImageProvider, BaseVideoProvider } from './base';
import { OpenAICompatibleProvider, ClaudeProvider } from './llm-adapters';
import { createImageProvider } from './image-adapters';
import { createVideoProvider } from './video-adapters';
import { useProviderStore } from '@/stores/providerStore';

// --- LLM Provider Factory ---

function createLLMProvider(
  providerId: LLMProviderId,
  endpoint: Parameters<BaseLLMProvider['generate']>[0] extends never ? never : { endpoint: import('@/types/providers').ApiEndpoint },
): BaseLLMProvider {
  const ep = endpoint as unknown as import('@/types/providers').ApiEndpoint;
  switch (providerId) {
    case 'claude':
      return new ClaudeProvider(ep);
    case 'openai':
      return new OpenAICompatibleProvider(ep, 'openai');
    case 'deepseek':
      return new OpenAICompatibleProvider(ep, 'deepseek');
    case 'qwen':
      return new OpenAICompatibleProvider(ep, 'qwen');
    case 'doubao':
      return new OpenAICompatibleProvider(ep, 'doubao');
    case 'glm':
      return new OpenAICompatibleProvider(ep, 'glm');
    default:
      return new OpenAICompatibleProvider(ep, 'custom');
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

    const effectiveModel = (config.models as Record<string, string>)[request.taskType] ?? config.defaultModel;
    const requestWithModel = { ...request, model: request.model || effectiveModel };

    try {
      const provider = createLLMProvider(config.primary, { endpoint } as never);
      return await provider.generate(requestWithModel);
    } catch (primaryError) {
      if (!config.fallback) throw primaryError;

      // Try fallback
      const fallbackEndpoint = store.getFallbackEndpoint('llm');
      if (!fallbackEndpoint) throw primaryError;

      try {
        const fallbackProvider = createLLMProvider(config.fallback, { endpoint: fallbackEndpoint } as never);
        return await fallbackProvider.generate(requestWithModel);
      } catch {
        throw primaryError; // Throw original error
      }
    }
  }

  async *stream(request: LLMGenerateRequest): AsyncIterable<LLMStreamChunk> {
    const store = useProviderStore.getState();
    const config = store.config.llm;
    const endpoint = store.getActiveEndpoint('llm');

    if (!endpoint) {
      throw new Error('No LLM endpoint configured.');
    }

    const effectiveModel = (config.models as Record<string, string>)[request.taskType] ?? config.defaultModel;
    const requestWithModel = { ...request, model: request.model || effectiveModel };

    const provider = createLLMProvider(config.primary, { endpoint } as never);
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

    const effectiveModel = (config.models as Record<string, string>)[request.taskType] ?? config.defaultModel;
    const requestWithModel = { ...request, model: request.model || effectiveModel };

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
  }

  // Video

  async generateVideo(request: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    const store = useProviderStore.getState();
    const config = store.config.video;
    const endpoint = store.getActiveEndpoint('video');

    if (!endpoint) {
      throw new Error('No video endpoint configured. Please add one in Settings → Providers.');
    }

    const effectiveModel = (config.models as Record<string, string>)[request.taskType] ?? config.defaultModel;
    const requestWithModel = { ...request, model: request.model || effectiveModel };

    try {
      const provider = createVideoProvider(config.primary, endpoint);
      return await provider.generate(requestWithModel);
    } catch (primaryError) {
      if (!config.fallback) throw primaryError;
      const fallbackEndpoint = store.getFallbackEndpoint('video');
      if (!fallbackEndpoint) throw primaryError;

      try {
        const fallbackProvider = createVideoProvider(config.fallback, fallbackEndpoint);
        return await fallbackProvider.generate(requestWithModel);
      } catch {
        throw primaryError;
      }
    }
  }
}

// Singleton
export const providerRouter = new ProviderRouter();

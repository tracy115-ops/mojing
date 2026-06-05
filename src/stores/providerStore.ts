import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ApiEndpoint,
  ProviderConfig,
  LLMProviderId,
  ImageProviderId,
  VideoProviderId,
  ProviderHealth,
} from '@/types/providers';

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  llm: {
    primary: 'openai',
    models: {
      planning: 'gpt-4o',
      generation: 'gpt-4o',
      review: 'gpt-4o-mini',
      extraction: 'gpt-4o-mini',
      translation: 'gpt-4o',
      embedding: 'text-embedding-3-small',
    },
    defaultModel: 'gpt-4o',
  },
  image: {
    primary: 'dalle',
    models: {
      character: 'dall-e-3',
      scene: 'dall-e-3',
      panel: 'dall-e-3',
      'style-transfer': 'dall-e-3',
      storyboard: 'dall-e-3',
    },
    defaultModel: 'dall-e-3',
    defaultWidth: 1024,
    defaultHeight: 1024,
  },
  video: {
    primary: 'kling',
    models: {
      clip: 'kling-v2',
      transition: 'kling-v2',
      'full-scene': 'kling-v2',
      'lip-sync': 'kling-v2',
      effects: 'kling-v2',
    },
    defaultModel: 'kling-v2',
    defaultResolution: '1920x1080',
    defaultFps: 24,
  },
};

interface ProviderState {
  config: ProviderConfig;
  endpoints: ApiEndpoint[];
  healthStatus: Record<string, ProviderHealth>;

  addEndpoint: (endpoint: Omit<ApiEndpoint, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateEndpoint: (id: string, updates: Partial<ApiEndpoint>) => void;
  removeEndpoint: (id: string) => void;
  getEndpoint: (id: string) => ApiEndpoint | undefined;

  setLLMProvider: (provider: LLMProviderId, model?: string, endpointId?: string) => void;
  setImageProvider: (provider: ImageProviderId, model?: string, endpointId?: string) => void;
  setVideoProvider: (provider: VideoProviderId, model?: string, endpointId?: string) => void;
  setLLMModel: (taskType: string, model: string) => void;
  setImageModel: (taskType: string, model: string) => void;
  setVideoModel: (taskType: string, model: string) => void;
  setLLMFallback: (provider: LLMProviderId, endpointId?: string) => void;
  setImageFallback: (provider: ImageProviderId, endpointId?: string) => void;
  setVideoFallback: (provider: VideoProviderId, endpointId?: string) => void;

  checkHealth: (endpointId: string) => Promise<ProviderHealth>;

  getActiveEndpoint: (category: 'llm' | 'image' | 'video') => ApiEndpoint | undefined;
  getFallbackEndpoint: (category: 'llm' | 'image' | 'video') => ApiEndpoint | undefined;

  reset: () => void;
}

const generateId = () => `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_PROVIDER_CONFIG,
      endpoints: [],
      healthStatus: {},

      addEndpoint: (endpoint) => {
        const now = new Date().toISOString();
        const newEndpoint: ApiEndpoint = {
          ...endpoint,
          id: generateId(),
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ endpoints: [...s.endpoints, newEndpoint] }));
      },

      updateEndpoint: (id, updates) => {
        set((s) => ({
          endpoints: s.endpoints.map((ep) =>
            ep.id === id ? { ...ep, ...updates, updatedAt: new Date().toISOString() } : ep,
          ),
        }));
      },

      removeEndpoint: (id) => {
        set((s) => ({ endpoints: s.endpoints.filter((ep) => ep.id !== id) }));
      },

      getEndpoint: (id) => get().endpoints.find((ep) => ep.id === id),

      setLLMProvider: (provider, model, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            llm: {
              ...s.config.llm,
              primary: provider,
              defaultModel: model ?? s.config.llm.defaultModel,
              endpointId,
            },
          },
        }));
      },

      setImageProvider: (provider, model, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            image: {
              ...s.config.image,
              primary: provider,
              defaultModel: model ?? s.config.image.defaultModel,
              endpointId,
            },
          },
        }));
      },

      setVideoProvider: (provider, model, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            video: {
              ...s.config.video,
              primary: provider,
              defaultModel: model ?? s.config.video.defaultModel,
              endpointId,
            },
          },
        }));
      },

      setLLMModel: (taskType, model) => {
        set((s) => ({
          config: {
            ...s.config,
            llm: {
              ...s.config.llm,
              models: { ...s.config.llm.models, [taskType]: model },
            },
          },
        }));
      },

      setImageModel: (taskType, model) => {
        set((s) => ({
          config: {
            ...s.config,
            image: {
              ...s.config.image,
              models: { ...s.config.image.models, [taskType]: model },
            },
          },
        }));
      },

      setVideoModel: (taskType, model) => {
        set((s) => ({
          config: {
            ...s.config,
            video: {
              ...s.config.video,
              models: { ...s.config.video.models, [taskType]: model },
            },
          },
        }));
      },

      setLLMFallback: (provider, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            llm: { ...s.config.llm, fallback: provider, fallbackEndpointId: endpointId },
          },
        }));
      },

      setImageFallback: (provider, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            image: { ...s.config.image, fallback: provider, fallbackEndpointId: endpointId },
          },
        }));
      },

      setVideoFallback: (provider, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            video: { ...s.config.video, fallback: provider, fallbackEndpointId: endpointId },
          },
        }));
      },

      checkHealth: async (endpointId) => {
        const endpoint = get().getEndpoint(endpointId);
        const health: ProviderHealth = {
          endpointId,
          available: false,
          checkedAt: new Date().toISOString(),
        };

        if (!endpoint) {
          health.error = 'Endpoint not found';
          set((s) => ({ healthStatus: { ...s.healthStatus, [endpointId]: health } }));
          return health;
        }

        const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');

        // Compute /models and /chat/completions URLs
        const modelsUrl = (() => {
          if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/models`;
          return `${baseUrl}/models`;
        })();
        const chatUrl = (() => {
          if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/chat/completions`;
          return `${baseUrl}/chat/completions`;
        })();

        try {
          const startTime = Date.now();

          // First try GET /models (most OpenAI-compatible APIs support this)
          let ok = false;
          let errorMsg = '';

          try {
            const response = await fetch(modelsUrl, {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${endpoint.apiKey}`,
                ...endpoint.customHeaders,
              },
              signal: AbortSignal.timeout(8000),
            });
            if (response.ok) {
              ok = true;
            } else {
              errorMsg = `GET /models → HTTP ${response.status}`;
            }
          } catch {
            errorMsg = 'GET /models failed';
          }

          // Fallback: try a minimal chat completion request
          if (!ok) {
            try {
              const response = await fetch(chatUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${endpoint.apiKey}`,
                  ...endpoint.customHeaders,
                },
                body: JSON.stringify({
                  model: 'test',
                  messages: [{ role: 'user', content: 'hi' }],
                  max_tokens: 1,
                }),
                signal: AbortSignal.timeout(10000),
              });
              // Even if model not found (404/422), a valid response means the API is reachable
              ok = response.status !== 0;
              if (!ok) {
                errorMsg = `POST /chat/completions → HTTP ${response.status}`;
              }
              // If we get 401/403, the API is reachable but auth failed
              if (response.status === 401 || response.status === 403) {
                ok = true; // API is reachable, just auth issue
              }
            } catch (err) {
              errorMsg = err instanceof Error ? err.message : 'Connection failed';
            }
          }

          health.latencyMs = Date.now() - startTime;
          health.available = ok;
          if (!ok) {
            health.error = errorMsg;
          }
        } catch (err) {
          health.error = err instanceof Error ? err.message : 'Connection failed';
        }

        set((s) => ({ healthStatus: { ...s.healthStatus, [endpointId]: health } }));
        return health;
      },

      getActiveEndpoint: (category) => {
        const { config, endpoints } = get();
        const endpointId = config[category].endpointId;
        if (endpointId) {
          const found = endpoints.find((ep) => ep.id === endpointId);
          if (found) return found;
        }
        // Fallback: if no specific endpoint bound, use the first LLM-compatible endpoint
        if (endpoints.length === 0) return undefined;
        // For LLM, prefer endpoints with LLM providers
        const llmProviders = ['openai', 'claude', 'deepseek', 'qwen', 'doubao', 'glm', 'custom'];
        if (category === 'llm') {
          return endpoints.find((ep) => llmProviders.includes(ep.provider)) ?? endpoints[0];
        }
        // For image/video, just return first endpoint
        return endpoints[0];
      },

      getFallbackEndpoint: (category) => {
        const { config, endpoints } = get();
        const fallbackId = config[category].fallbackEndpointId;
        if (fallbackId) {
          const found = endpoints.find((ep) => ep.id === fallbackId);
          if (found) return found;
        }
        return undefined;
      },

      reset: () => {
        set({ config: DEFAULT_PROVIDER_CONFIG, endpoints: [], healthStatus: {} });
      },
    }),
    {
      name: 'mojing-providers',
      partialize: (state) => ({
        config: state.config,
        endpoints: state.endpoints,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<ProviderState> | undefined;
        return {
          ...current,
          config: saved?.config ?? current.config,
          endpoints: saved?.endpoints ?? current.endpoints,
          healthStatus: {},
        };
      },
    },
  ),
);

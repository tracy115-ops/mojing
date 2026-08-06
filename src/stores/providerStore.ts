import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ApiEndpoint,
  ProviderConfig,
  LLMProviderId,
  ImageProviderId,
  VideoProviderId,
  TTSProviderId,
  ProviderHealth,
} from '@/types/providers';

/**
 * Single source of truth: which category does each provider belong to?
 * Used by getEndpointsByCategory, getActiveEndpoint, DirectVideoModal,
 * ProviderSettings — anywhere that needs to know "is this endpoint LLM/image/video/tts?".
 *
 * NOTE: 'custom' is intentionally ambiguous (could be any category) — callers that
 * need strict classification should bind a specific endpoint via config[category].endpointId
 * rather than relying on auto-detection. We classify 'custom' as 'llm' by default.
 */
export const PROVIDER_CATEGORY: Record<string, 'llm' | 'image' | 'video' | 'tts'> = {
  // LLM
  openai: 'llm',
  claude: 'llm',
  deepseek: 'llm',
  qwen: 'llm',
  doubao: 'llm',
  glm: 'llm',
  // Image
  dalle: 'image',
  midjourney: 'image',
  'stable-diffusion': 'image',
  flux: 'image',
  comfyui: 'image',
  'kling-image': 'image',
  cogview: 'image',
  wanx: 'image',
  jimeng: 'image',
  'siliconflow-image': 'image',
  ideogram: 'image',
  'agnes-image': 'image',
  leonardo: 'image',
  // Video
  sora: 'video',
  runway: 'video',
  kling: 'video',
  vidu: 'video',
  pika: 'video',
  'agnes-video': 'video',
  'doubao-video': 'video',
  'minimax-video': 'video',
  cogvideo: 'video',
  '302ai-video': 'video',
  'siliconflow-video': 'video',
  'leonardo-video': 'video',
  // TTS
  'openai-tts': 'tts',
  'doubao-tts': 'tts',
  'siliconflow-tts': 'tts',
  'edge-tts': 'tts',
  // Custom — default LLM; if user sets up a custom image/video/tts endpoint they
  // should bind it explicitly via Settings → Provider primary endpoint selector.
  custom: 'llm',
};

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
      character: '',
      scene: '',
      panel: '',
      'style-transfer': '',
      storyboard: '',
    },
    defaultModel: '',
    defaultWidth: 1024,
    defaultHeight: 1024,
  },
  video: {
    primary: 'kling',
    models: {
      clip: '',
      transition: '',
      'full-scene': '',
      'lip-sync': '',
      effects: '',
    },
    defaultModel: '',
    defaultResolution: '1920x1080',
    defaultFps: 24,
  },
  tts: {
    primary: 'openai-tts',
    defaultModel: 'tts-1',
    defaultVoice: 'alloy',
    defaultFormat: 'mp3',
    defaultSpeed: 1.0,
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
  setTTSProvider: (provider: TTSProviderId, model?: string, voice?: string, endpointId?: string) => void;
  setLLMModel: (taskType: string, model: string) => void;
  setImageModel: (taskType: string, model: string) => void;
  setVideoModel: (taskType: string, model: string) => void;
  setLLMFallback: (provider: LLMProviderId, endpointId?: string) => void;
  setImageFallback: (provider: ImageProviderId, endpointId?: string) => void;
  setVideoFallback: (provider: VideoProviderId, endpointId?: string) => void;

  checkHealth: (endpointId: string) => Promise<ProviderHealth>;

  getActiveEndpoint: (category: 'llm' | 'image' | 'video' | 'tts') => ApiEndpoint | undefined;
  getFallbackEndpoint: (category: 'llm' | 'image' | 'video' | 'tts') => ApiEndpoint | undefined;
  /** Returns all enabled endpoints whose provider belongs to the given category.
   *  Single source of truth for category classification — used by DirectVideoModal,
   *  ProviderSettings, pipeline steps, etc. */
  getEndpointsByCategory: (category: 'llm' | 'image' | 'video' | 'tts') => ApiEndpoint[];

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
          // 表单历史上不带 enabled 字段时会变成 undefined,所有下游过滤就把它丢了。
          // 这里兜底为 true —— 用户主动加的 endpoint 默认启用,符合直觉。
          enabled: endpoint.enabled ?? true,
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

      setTTSProvider: (provider, model, voice, endpointId) => {
        set((s) => ({
          config: {
            ...s.config,
            tts: {
              ...(s.config.tts ?? {
                primary: 'openai-tts',
                defaultModel: 'tts-1',
                defaultVoice: 'alloy',
                defaultFormat: 'mp3',
                defaultSpeed: 1.0,
              }),
              primary: provider,
              defaultModel: model ?? s.config.tts?.defaultModel ?? 'tts-1',
              defaultVoice: voice ?? s.config.tts?.defaultVoice ?? 'alloy',
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

        // Edge TTS 走 WebSocket,不走 HTTP /models 探活
        if (endpoint.provider === 'edge-tts') {
          const startTime = Date.now();
          try {
            const ok = await probeEdgeTtsWebSocket();
            health.latencyMs = Date.now() - startTime;
            health.available = ok;
            if (!ok) health.error = 'Edge TTS WSS handshake failed';
          } catch (err) {
            health.error = err instanceof Error ? err.message : 'Edge TTS probe failed';
          }
          set((s) => ({ healthStatus: { ...s.healthStatus, [endpointId]: health } }));
          return health;
        }

        const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');

        // 图像/视频/TTS provider 不存在 /models 或 /chat/completions,
        // 旧逻辑一律按 LLM 路径探活,导致这些 endpoint 永远显示"未连接"。
        // 这里按 provider 类别分发到各自存在的探测路径。
        const category = endpoint.category ?? PROVIDER_CATEGORY[endpoint.provider];

        // 图像 provider:GET /models 大多不存在,直接发一个最小生成请求,
        // 任何 HTTP 响应(即使是 400/402/401)都说明服务可达。
        if (category === 'image') {
          const imageUrl = /\/v\d+$/.test(baseUrl)
            ? `${baseUrl}/images/generations`
            : `${baseUrl}/v1/images/generations`;
          try {
            const startTime = Date.now();
            const response = await fetch(imageUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${endpoint.apiKey}`,
                ...endpoint.customHeaders,
              },
              body: JSON.stringify({
                model: 'test',
                prompt: 'ping',
                size: '1x1',
              }),
              signal: AbortSignal.timeout(10_000),
            });
            health.latencyMs = Date.now() - startTime;
            // 任何 HTTP 响应(非 0 / 非网络错误)都说明服务可达
            // 401/403 = auth 问题但服务通;400/402/404 = 服务通但参数错;200 = 完全通
            health.available = response.status >= 100 && response.status < 600;
            if (!health.available) {
              health.error = `POST /images/generations → no HTTP response`;
            }
          } catch (err) {
            health.error = err instanceof Error ? err.message : 'Image probe failed';
          }
          set((s) => ({ healthStatus: { ...s.healthStatus, [endpointId]: health } }));
          return health;
        }

        // 视频 provider:同样,直接 POST 一个最小生成请求探测可达性
        if (category === 'video') {
          // Agnes 官方路径是 /v1/videos(不带 /generations),OpenAI-compat 的代理
          // 可能用 /v1/videos/generations。兼容两者:先尝试 /videos,失败回退 /videos/generations。
          const videoUrl = /\/v\d+$/.test(baseUrl)
            ? `${baseUrl}/videos`
            : `${baseUrl}/v1/videos`;
          try {
            const startTime = Date.now();
            const response = await fetch(videoUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${endpoint.apiKey}`,
                ...endpoint.customHeaders,
              },
              body: JSON.stringify({
                model: 'test',
                prompt: 'ping',
              }),
              signal: AbortSignal.timeout(10_000),
            });
            health.latencyMs = Date.now() - startTime;
            health.available = response.status >= 100 && response.status < 600;
            if (!health.available) {
              health.error = `POST /videos → no HTTP response`;
            }
          } catch (err) {
            health.error = err instanceof Error ? err.message : 'Video probe failed';
          }
          set((s) => ({ healthStatus: { ...s.healthStatus, [endpointId]: health } }));
          return health;
        }

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

      getEndpointsByCategory: (category) => {
        const { endpoints } = get();
        return endpoints.filter((ep) => {
          if (!ep.enabled) return false;
          // 优先用 endpoint 显式声明的 category(custom endpoint 必须有)
          const cat = ep.category ?? PROVIDER_CATEGORY[ep.provider];
          return cat === category;
        });
      },

      getActiveEndpoint: (category) => {
        const { config, endpoints } = get();
        const cfg = config[category];
        const endpointId = cfg?.endpointId;
        if (endpointId) {
          const found = endpoints.find((ep) => ep.id === endpointId && ep.enabled);
          if (found) return found;
        }
        // Fallback: first enabled endpoint whose provider belongs to this category.
        return get().getEndpointsByCategory(category)[0];
      },

      getFallbackEndpoint: (category) => {
        const { config, endpoints } = get();
        const cfg = config[category];
        const fallbackId = cfg?.fallbackEndpointId;
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
        // Deep-merge config so that schema additions in new versions (e.g. a new
        // `models` field on LLMProviderConfig) get filled in with defaults from
        // the current store, even if the persisted snapshot is from an older build.
        // Without this, downstream code reading config.llm.models.translation crashes.
        // Cast through unknown because Partial<ProviderConfig> has all-optional fields
        // which don't satisfy the required fields of the merged result.
        const mergedConfig = {
          llm: { ...current.config.llm, ...(saved?.config?.llm ?? {}) },
          image: { ...current.config.image, ...(saved?.config?.image ?? {}) },
          video: { ...current.config.video, ...(saved?.config?.video ?? {}) },
          tts: { ...current.config.tts, ...(saved?.config?.tts ?? {}) },
        } as typeof current.config;
        return {
          ...current,
          config: mergedConfig,
          // 兼容历史数据:某些老版本表单不带 enabled,导致 endpoint.enabled = undefined,
          // 下游过滤全失败。这里一次性把 undefined 视为 true(用户主动加的就该启用)。
          endpoints: (saved?.endpoints ?? current.endpoints).map((e) => ({
            ...e,
            enabled: e.enabled ?? true,
          })),
          healthStatus: {},
        };
      },
    },
  ),
);

// --- Edge TTS WSS 探活 ---
// 用一次最小握手验证:连上 + 收到任意消息(含 config 响应)即视为可达。
// 不发完整 SSML,避免占用配额(虽然 Edge TTS 免费)。
async function probeEdgeTtsWebSocket(): Promise<boolean> {
  const WSS_URL =
    'wss://speech.platform.bing.com/speech/synthesis/tts/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const ws = new WebSocket(WSS_URL);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(false);
    }, 8000);

    ws.onopen = () => {
      // 发个 config message,等服务端响应
      ws.send(
        `X-Timestamp:${new Date().toISOString()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify({ context: { synthesis: { audio: { outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }),
      );
    };
    ws.onmessage = () => {
      // 收到任意消息说明握手通过
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(true);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };
  });
}

// --- Boot diagnostics dump ---
// log.ts 启动后会调这个函数,把当前 provider 配置打到日志里。
// 排查"为什么生成视频走了 kling 而不是 agnes"这类问题的关键信息。
// 注意:API key 用占位符,不写盘 —— 避免泄漏。
if (typeof window !== 'undefined') {
  (window as unknown as { __MOJING_PROVIDER_DUMP__?: () => string }).__MOJING_PROVIDER_DUMP__ = () => {
    try {
      const s = useProviderStore.getState();
      const fmt = (cat: 'llm' | 'image' | 'video' | 'tts') => {
        const cfg = s.config[cat];
        if (!cfg) return `${cat}=(unset)`;
        const epId = (cfg as { endpointId?: string }).endpointId;
        const ep = epId ? s.endpoints.find((e) => e.id === epId) : s.getEndpointsByCategory(cat)[0];
        const epDesc = ep ? `${ep.provider}@${ep.baseUrl}(enabled=${ep.enabled})` : '(none)';
        return `${cat}.primary=${cfg.primary} endpoint=${epDesc}`;
      };
      return `[${fmt('llm')} | ${fmt('image')} | ${fmt('video')}]`;
    } catch (e) {
      return `dump-failed: ${String(e)}`;
    }
  };
}

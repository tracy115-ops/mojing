import React, { useState, useCallback } from 'react';
import {
  Card,
  Tabs,
  Select,
  Input,
  Button,
  Space,
  Table,
  Modal,
  Form,
  Tag,
  Tooltip,
  message,
  Typography,
  Divider,
  Alert,
  AutoComplete,
  Switch,
  Collapse,
  Row,
  Col,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  SoundOutlined,
  StarFilled,
  StarOutlined,
  AppstoreOutlined,
  ControlOutlined,
  FileTextOutlined,
  PictureOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore, PROVIDER_CATEGORY } from '@/stores/providerStore';
import type {
  LLMProviderId,
  ImageProviderId,
  VideoProviderId,
  TTSProviderId,
  ApiEndpoint,
} from '@/types/providers';

const LLM_PROVIDER_OPTIONS: { value: LLMProviderId; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek (深度求索 - 推荐)' },
  { value: 'openai', label: 'OpenAI (GPT-4o / O3)' },
  { value: 'qwen', label: 'Qwen (通义千问 / 阿里)' },
  { value: 'doubao', label: 'Doubao (豆包 / 字节)' },
  { value: 'glm', label: 'GLM (智谱清言)' },
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'custom', label: 'Custom (自定义 OpenAI 兼容 API / 中转站)' },
];

const IMAGE_PROVIDER_OPTIONS: { value: ImageProviderId; label: string }[] = [
  { value: 'siliconflow-image', label: '硅基流动 (Kolors / FLUX - 推荐)' },
  { value: 'jimeng', label: '即梦 Seedream (火山方舟 / 字节)' },
  { value: 'wanx', label: '通义万相 (Wanx / 阿里)' },
  { value: 'dalle', label: 'DALL-E (OpenAI)' },
  { value: 'kling-image', label: 'Kling (可灵图生图)' },
  { value: 'cogview', label: 'CogView (智谱 GLM)' },
  { value: 'ideogram', label: 'Ideogram' },
  { value: 'agnes-image', label: 'Agnes Image (免费)' },
  { value: 'leonardo', label: 'Leonardo.ai' },
  { value: 'stable-diffusion', label: 'Stable Diffusion (本地)' },
  { value: 'flux', label: 'Flux (本地)' },
  { value: 'comfyui', label: 'ComfyUI (本地)' },
  { value: 'custom', label: 'Custom (自定义生图 API / 中转站)' },
];

const VIDEO_PROVIDER_OPTIONS: { value: VideoProviderId; label: string }[] = [
  { value: 'kling', label: 'Kling (快手可灵视频 - 推荐)' },
  { value: 'doubao-video', label: '即梦 Seedance (火山引擎 / 豆包)' },
  { value: 'siliconflow-video', label: '硅基流动 (Wan 2.1)' },
  { value: 'minimax-video', label: '海螺 MiniMax (Video-01)' },
  { value: 'vidu', label: 'Vidu (生数科技)' },
  { value: 'cogvideo', label: '智谱 CogVideoX' },
  { value: '302ai-video', label: '302.AI Video' },
  { value: 'sora', label: 'Sora (OpenAI)' },
  { value: 'runway', label: 'Runway (Gen-3 / Gen-4)' },
  { value: 'pika', label: 'Pika' },
  { value: 'agnes-video', label: 'Agnes Video (免费)' },
  { value: 'leonardo-video', label: 'Leonardo Motion' },
  { value: 'custom', label: 'Custom (自定义视频 API / 中转站)' },
];

const TTS_PROVIDER_OPTIONS: { value: TTSProviderId; label: string }[] = [
  { value: 'edge-tts', label: 'Edge TTS (微软免费配音 - 零配置免 Key 推荐)' },
  { value: 'siliconflow-tts', label: '硅基流动 CosyVoice (SiliconFlow)' },
  { value: 'doubao-tts', label: '字节豆包配音 (火山语音 / Doubao TTS)' },
  { value: 'openai-tts', label: 'OpenAI TTS (tts-1 / tts-1-hd)' },
  { value: 'custom', label: 'Custom (自定义配音 API / 中转站)' },
];

const LLM_TASK_MODELS = [
  { key: 'planning', label: '剧本分镜规划 (Planning)' },
  { key: 'generation', label: '正文生成扩展 (Generation)' },
  { key: 'review', label: '视觉规格审查 (Review)' },
  { key: 'extraction', label: '实体台词提取 (Extraction)' },
  { key: 'translation', label: '提示词精准翻译 (Translation)' },
];

const IMAGE_TASK_MODELS = [
  { key: 'character', label: '角色立绘三视图 (Character)' },
  { key: 'scene', label: '场景背景生成 (Scene)' },
  { key: 'panel', label: '漫画分镜画面 (Panel)' },
  { key: 'storyboard', label: '电影分镜关键帧 (Storyboard)' },
];

const VIDEO_TASK_MODELS = [
  { key: 'clip', label: '分镜视频生成 (Clip)' },
  { key: 'transition', label: '转场过渡衔接 (Transition)' },
  { key: 'full-scene', label: '全景镜头生成 (Full Scene)' },
  { key: 'lip-sync', label: '角色说话口型 (Lip Sync)' },
];

// Per-provider suggested models
const PROVIDER_MODEL_SUGGESTIONS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'],
  claude: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  siliconflow: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
  qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  doubao: ['doubao-1.5-pro-32k', 'doubao-1.5-lite-32k'],
  glm: ['glm-5.2', 'glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  // Image
  dalle: ['dall-e-3', 'dall-e-2'],
  'kling-image': ['kling-v2', 'kling-v1-5', 'kling-v1'],
  cogview: ['cogview-3-plus', 'cogview-3-flash'],
  wanx: ['wanx-2.1-t2i-turbo', 'wanx-2.1-t2i-plus', 'wanx-v1'],
  jimeng: ['doubao-seedream-3-0-t2i-250415', 'doubao-seedream-3-0-i2i-250415'],
  'siliconflow-image': ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev', 'Kwai-Kolors/Kolors'],
  ideogram: ['V_3', 'V_2'],
  'agnes-image': ['agnes-image-2.1-flash', 'agnes-image-2.0-flash'],
  leonardo: ['b24a42c0-7a00-4cc4-9753-ca0962555099'],
  // Video
  kling: ['kling-v2', 'kling-v2-pro', 'kling-v1-6'],
  runway: ['gen4_turbo', 'gen3-alpha'],
  vidu: ['vidu-1.5', 'vidu-1.0'],
  pika: ['pika-1.5', 'pika-1.0'],
  'agnes-video': ['agnes-video-v2.0', 'agnes-video-2.5'],
  'doubao-video': ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128'],
  'minimax-video': ['video-01', 'video-01-live'],
  cogvideo: ['cogvideox_5b', 'cogvideox_flash'],
  '302ai-video': ['kling-302', 'sora-302', 'runway-302'],
  'siliconflow-video': ['Wan-AI/Wan2.1-T2V-1.4B', 'Wan-AI/Wan2.1-I2V-14B-720P', 'Wan-AI/Wan2.1-T2V-14B'],
  'leonardo-video': ['leonardo-motion'],
  // TTS
  'edge-tts': ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural'],
  'siliconflow-tts': ['FunAudioLLM/CosyVoice2-0.5B', 'FunAudioLLM/CosyVoice-300M-Instruct'],
  'doubao-tts': ['doubao-tts-v1', 'doubao-voice-standard'],
  'openai-tts': ['tts-1', 'tts-1-hd'],
};

const PROVIDER_DEFAULT_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  custom: 'https://api.example.com/v1',
  dalle: 'https://api.openai.com/v1',
  'stable-diffusion': 'http://127.0.0.1:7860',
  flux: 'http://127.0.0.1:7860',
  comfyui: 'http://127.0.0.1:8188',
  'kling-image': 'https://api-beijing.klingai.com',
  cogview: 'https://open.bigmodel.cn/api/paas/v4',
  wanx: 'https://dashscope.aliyuncs.com/api/v1',
  jimeng: 'https://ark.cn-beijing.volces.com',
  'siliconflow-image': 'https://api.siliconflow.cn/v1',
  ideogram: 'https://api.ideogram.ai/v1',
  'agnes-image': 'https://apihub.agnes-ai.com',
  leonardo: 'https://api.leonardo.ai/v1',
  sora: 'https://api.openai.com/v1',
  runway: 'https://api.runwayml.com',
  kling: 'https://api-beijing.klingai.com',
  vidu: 'https://api.vidu.studio',
  pika: 'https://api.pika.art',
  'agnes-video': 'https://apihub.agnes-ai.com',
  'doubao-video': 'https://ark.cn-beijing.volces.com',
  'minimax-video': 'https://api.minimax.chat/v1',
  cogvideo: 'https://open.bigmodel.cn/api/paas/v4',
  '302ai-video': 'https://api.302.ai/v1',
  'siliconflow-video': 'https://api.siliconflow.cn/v1',
  'leonardo-video': 'https://api.leonardo.ai/v1',
  'openai-tts': 'https://api.openai.com/v1',
  'doubao-tts': 'https://ark.cn-beijing.volces.com/api/v3',
  'siliconflow-tts': 'https://api.siliconflow.cn/v1',
  'edge-tts': 'https://speech.platform.bing.com',
};

function getProviderDefaultUrl(provider: string): string {
  return PROVIDER_DEFAULT_URLS[provider] ?? 'https://api.example.com/v1';
}

const ProviderSettings: React.FC = () => {
  const { t } = useTranslation();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addCategory, setAddCategory] = useState<'llm' | 'image' | 'video' | 'tts'>('llm');
  const [editingEndpoint, setEditingEndpoint] = useState<ApiEndpoint | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const watchProvider = Form.useWatch('provider', form);

  const config = useProviderStore((s) => s.config);
  const endpoints = useProviderStore((s) => s.endpoints);
  const healthStatus = useProviderStore((s) => s.healthStatus);
  const addEndpoint = useProviderStore((s) => s.addEndpoint);
  const removeEndpoint = useProviderStore((s) => s.removeEndpoint);
  const updateEndpoint = useProviderStore((s) => s.updateEndpoint);
  const setLLMProvider = useProviderStore((s) => s.setLLMProvider);
  const setImageProvider = useProviderStore((s) => s.setImageProvider);
  const setVideoProvider = useProviderStore((s) => s.setVideoProvider);
  const setTTSProvider = useProviderStore((s) => s.setTTSProvider);
  const setLLMModel = useProviderStore((s) => s.setLLMModel);
  const setImageModel = useProviderStore((s) => s.setImageModel);
  const setVideoModel = useProviderStore((s) => s.setVideoModel);
  const checkHealth = useProviderStore((s) => s.checkHealth);

  const [discoveringOllama, setDiscoveringOllama] = useState(false);
  const [discoveringLMStudio, setDiscoveringLMStudio] = useState(false);
  const [discoveringComfyUI, setDiscoveringComfyUI] = useState(false);

  const getEndpointsByCategory = useCallback((category: 'llm' | 'image' | 'video' | 'tts') => {
    return endpoints.filter((e) => (e.category ?? PROVIDER_CATEGORY[e.provider]) === category);
  }, [endpoints]);

  // 一键探测并添加本地 Ollama
  const handleAutoDiscoverOllama = async () => {
    setDiscoveringOllama(true);
    try {
      const { fetch: httpFetch } = await import('@/services/providers/fetch-proxy');
      const resp = await httpFetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      const modelNames = (data?.models?.map((m) => m.name) || []).filter(Boolean);
      const finalModels = modelNames.length > 0 ? modelNames : ['qwen2.5:7b', 'deepseek-r1:8b'];

      const existing = endpoints.find((e) => e.baseUrl?.includes('11434'));
      if (existing) {
        updateEndpoint(existing.id, {
          models: finalModels,
          enabled: true,
        });
        handleSetPrimary(existing);
        message.success(`已连接本地 Ollama，成功同步 ${finalModels.length} 个本地模型！`);
      } else {
        const newId = addEndpoint({
          name: '本地 Ollama (11434)',
          provider: 'custom',
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKey: 'ollama',
          models: finalModels,
          enabled: true,
          category: 'llm',
        });
        setLLMProvider('custom', finalModels[0], newId);
        message.success(`成功添加并切换为本地 Ollama，已检测到 ${finalModels.length} 个模型！`);
      }
    } catch {
      message.warning('未检测到本地正在运行的 Ollama 服务。请确认已在本地启动 ollama（如运行 `ollama serve`）。');
    } finally {
      setDiscoveringOllama(false);
    }
  };

  // 一键探测并添加本地 LM Studio
  const handleAutoDiscoverLMStudio = async () => {
    setDiscoveringLMStudio(true);
    try {
      const { fetch: httpFetch } = await import('@/services/providers/fetch-proxy');
      const resp = await httpFetch('http://127.0.0.1:1234/v1/models', { method: 'GET' });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { data?: Array<{ id: string }> };
      const modelNames = (data?.data?.map((m) => m.id) || []).filter(Boolean);
      const finalModels = modelNames.length > 0 ? modelNames : ['local-model'];

      const existing = endpoints.find((e) => e.baseUrl?.includes('1234'));
      if (existing) {
        updateEndpoint(existing.id, {
          models: finalModels,
          enabled: true,
        });
        handleSetPrimary(existing);
        message.success(`已连接本地 LM Studio，成功同步 ${finalModels.length} 个本地模型！`);
      } else {
        const newId = addEndpoint({
          name: '本地 LM Studio (1234)',
          provider: 'custom',
          baseUrl: 'http://127.0.0.1:1234/v1',
          apiKey: 'lm-studio',
          models: finalModels,
          enabled: true,
          category: 'llm',
        });
        setLLMProvider('custom', finalModels[0], newId);
        message.success(`成功添加并切换为本地 LM Studio，检测到模型：${finalModels.join(', ')}！`);
      }
    } catch {
      message.warning('未检测到本地正在运行的 LM Studio 服务。请在 LM Studio 中开启 Local Server (端口 1234)。');
    } finally {
      setDiscoveringLMStudio(false);
    }
  };

  // 一键探测并添加本地 ComfyUI
  const handleAutoDiscoverComfyUI = async () => {
    setDiscoveringComfyUI(true);
    try {
      const { fetch: httpFetch } = await import('@/services/providers/fetch-proxy');
      const resp = await httpFetch('http://127.0.0.1:8188/system_stats', { method: 'GET' });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const existing = endpoints.find((e) => e.baseUrl?.includes('8188'));
      if (existing) {
        message.success('本地 ComfyUI (8188) 服务在线！');
      } else {
        addEndpoint({
          name: '本地 ComfyUI 工作流 (8188)',
          provider: 'comfyui',
          baseUrl: 'http://127.0.0.1:8188',
          apiKey: 'comfyui',
          models: ['FLUX.1-schnell', 'SDXL-Turbo', 'Wan2.1-I2V'],
          enabled: true,
          category: 'image',
        });
        message.success('已成功录入本地 ComfyUI (8188) 端点！');
      }
    } catch {
      message.warning('未检测到本地正在运行的 ComfyUI 服务。请确认 ComfyUI 已在 127.0.0.1:8188 启动。');
    } finally {
      setDiscoveringComfyUI(false);
    }
  };

  // 判断是否为当前类别的主选端点
  const isPrimaryEndpoint = useCallback((endpoint: ApiEndpoint) => {
    const cat = endpoint.category ?? PROVIDER_CATEGORY[endpoint.provider] ?? 'llm';
    const cfg = config[cat];
    if (cfg?.endpointId) {
      return cfg.endpointId === endpoint.id;
    }
    const catEndpoints = endpoints.filter((e) => (e.category ?? PROVIDER_CATEGORY[e.provider]) === cat && e.enabled);
    return catEndpoints[0]?.id === endpoint.id;
  }, [config, endpoints]);

  // 一键设为主选端点
  const handleSetPrimary = useCallback((endpoint: ApiEndpoint) => {
    const cat = endpoint.category ?? PROVIDER_CATEGORY[endpoint.provider] ?? 'llm';
    const defaultModel = endpoint.models?.[0];

    if (cat === 'llm') {
      setLLMProvider(endpoint.provider as LLMProviderId, defaultModel, endpoint.id);
    } else if (cat === 'image') {
      setImageProvider(endpoint.provider as ImageProviderId, defaultModel, endpoint.id);
    } else if (cat === 'video') {
      setVideoProvider(endpoint.provider as VideoProviderId, defaultModel, endpoint.id);
    } else if (cat === 'tts') {
      setTTSProvider(endpoint.provider as TTSProviderId, defaultModel, undefined, endpoint.id);
    }
    message.success(`已将【${endpoint.name}】设为当前${cat.toUpperCase()}主力引擎！`);
  }, [setLLMProvider, setImageProvider, setVideoProvider, setTTSProvider]);

  const handleAddEndpoint = useCallback((category: 'llm' | 'image' | 'video' | 'tts') => {
    setAddCategory(category);
    setEditingEndpoint(null);
    const defaultProvider =
      category === 'llm' ? 'deepseek'
      : category === 'image' ? 'siliconflow-image'
      : category === 'video' ? 'kling'
      : 'edge-tts';
    const defaultUrl = getProviderDefaultUrl(defaultProvider);
    const defaultModels = PROVIDER_MODEL_SUGGESTIONS[defaultProvider] ?? [];

    form.setFieldsValue({
      provider: defaultProvider,
      name: `${defaultProvider.toUpperCase()} 接口`,
      baseUrl: defaultUrl,
      apiKey: defaultProvider === 'edge-tts' ? 'free' : '',
      modelsStr: defaultModels.join(', '),
      enabled: true,
      useAsPrimary: true,
    });
    setAddModalOpen(true);
  }, [form]);

  const handleEditEndpoint = useCallback((endpoint: ApiEndpoint) => {
    setAddCategory(endpoint.category ?? PROVIDER_CATEGORY[endpoint.provider] ?? 'llm');
    setEditingEndpoint(endpoint);
    form.setFieldsValue({
      name: endpoint.name,
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelsStr: endpoint.models ? endpoint.models.join(', ') : '',
    });
    setAddModalOpen(true);
  }, [form]);

  const handleSaveEndpoint = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const provider = values.provider;
      const isEdge = provider === 'edge-tts';
      const baseUrl = values.baseUrl || (isEdge ? 'https://speech.platform.bing.com' : '');
      const apiKey = values.apiKey || (isEdge ? 'free' : '');

      let models = values.modelsStr
        ? values.modelsStr.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      
      // 智能默认填充模型，不卡用户
      if (models.length === 0 && !isEdge) {
        models = PROVIDER_MODEL_SUGGESTIONS[provider] || ['default'];
      }

      if (editingEndpoint) {
        updateEndpoint(editingEndpoint.id, {
          name: values.name,
          provider,
          baseUrl,
          apiKey,
          models,
          category: addCategory,
        });
        if (addCategory === 'llm' && config.llm.endpointId === editingEndpoint.id) {
          setLLMProvider(provider as LLMProviderId, models[0], editingEndpoint.id);
        } else if (addCategory === 'image' && config.image.endpointId === editingEndpoint.id) {
          setImageProvider(provider as ImageProviderId, models[0], editingEndpoint.id);
        } else if (addCategory === 'video' && config.video.endpointId === editingEndpoint.id) {
          setVideoProvider(provider as VideoProviderId, models[0], editingEndpoint.id);
        }
      } else {
        const newId = addEndpoint({
          name: values.name,
          provider,
          baseUrl,
          apiKey,
          models,
          enabled: true,
          category: addCategory,
        });

        if (values.useAsPrimary !== false) {
          if (isEdge) {
            setTTSProvider('edge-tts', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural', newId);
          } else if (addCategory === 'llm') {
            setLLMProvider(provider as LLMProviderId, models[0], newId);
          } else if (addCategory === 'image') {
            setImageProvider(provider as ImageProviderId, models[0], newId);
          } else if (addCategory === 'video') {
            setVideoProvider(provider as VideoProviderId, models[0], newId);
          } else {
            setTTSProvider(provider as TTSProviderId, models[0], undefined, newId);
          }
        }
      }
      setAddModalOpen(false);
      setEditingEndpoint(null);
      form.resetFields();
      message.success('配置已保存并生效！');
    } catch {
      // Form validation error
    }
  }, [form, addEndpoint, updateEndpoint, editingEndpoint, addCategory, setLLMProvider, setImageProvider, setVideoProvider, setTTSProvider]);

  const handleTestConnection = useCallback(async (endpointId: string) => {
    setTestingId(endpointId);
    try {
      const health = await checkHealth(endpointId);
      if (health.available) {
        message.success(`连接成功！延迟: ${health.latencyMs ?? 0}ms`);
      } else {
        message.error(`连接失败: ${health.error || '无法访问服务'}`);
      }
    } catch {
      message.error('连接失败，请检查网络或 URL');
    } finally {
      setTestingId(null);
    }
  }, [checkHealth]);

  // 表格列定义
  const getEndpointColumns = (category: 'llm' | 'image' | 'video' | 'tts') => [
    {
      title: '主选状态',
      key: 'primaryStatus',
      width: 130,
      render: (_: unknown, record: ApiEndpoint) => {
        const isPrimary = isPrimaryEndpoint(record);
        return isPrimary ? (
          <Tag color="gold" icon={<StarFilled style={{ color: '#faad14' }} />}>
            当前主力
          </Tag>
        ) : (
          <Button
            size="small"
            type="link"
            icon={<StarOutlined />}
            onClick={() => handleSetPrimary(record)}
            style={{ padding: 0 }}
          >
            设为主力
          </Button>
        );
      },
    },
    {
      title: '端点名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (name: string, record: ApiEndpoint) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong style={{ fontSize: 13 }}>{name}</Typography.Text>
          <Tag style={{ fontSize: 11 }}>{record.provider}</Tag>
        </Space>
      ),
    },
    {
      title: '支持/默认模型',
      dataIndex: 'models',
      key: 'models',
      render: (models: string[] | undefined, record: ApiEndpoint) => {
        const displayModels = models && models.length > 0
          ? models
          : (PROVIDER_MODEL_SUGGESTIONS[record.provider] ?? ['默认模型']);
        return (
          <Space wrap size={[4, 4]}>
            {displayModels.map((m, idx) => (
              <Tag key={idx} color={idx === 0 ? 'blue' : 'default'} style={{ fontSize: 11 }}>
                {m}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '启用',
      key: 'enabled',
      width: 80,
      render: (_: unknown, record: ApiEndpoint) => (
        <Switch
          size="small"
          checked={record.enabled ?? true}
          onChange={(checked) => updateEndpoint(record.id, { enabled: checked })}
        />
      ),
    },
    {
      title: '连通性',
      key: 'status',
      width: 100,
      render: (_: unknown, record: ApiEndpoint) => {
        const health = healthStatus[record.id];
        if (testingId === record.id) return <LoadingOutlined spin />;
        if (!health) return <Tag>未检测</Tag>;
        return health.available ? (
          <Tag icon={<CheckCircleOutlined />} color="success">正常</Tag>
        ) : (
          <Tooltip title={health.error}>
            <Tag icon={<CloseCircleOutlined />} color="error">异常</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: unknown, record: ApiEndpoint) => (
        <Space size="small">
          <Button size="small" onClick={() => handleTestConnection(record.id)} loading={testingId === record.id}>
            测试
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditEndpoint(record)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeEndpoint(record.id)} />
        </Space>
      ),
    },
  ];

  // 顶部 4 大主力引擎快捷卡片
  const renderActiveOverview = () => {
    const getSummary = (category: 'llm' | 'image' | 'video' | 'tts') => {
      const cfg = config[category];
      const categoryEndpoints = getEndpointsByCategory(category);
      const activeEp = categoryEndpoints.find((e) => isPrimaryEndpoint(e));
      const model = activeEp?.models?.[0] || cfg?.defaultModel || '系统推荐';
      const voice = (activeEp?.models?.[0]) || '默认';
      return {
        provider: activeEp?.name || cfg?.primary || '未配置',
        model,
        voice,
        activeId: activeEp?.id,
        endpoints: categoryEndpoints,
      };
    };

    const llmSummary = getSummary('llm');
    const imageSummary = getSummary('image');
    const videoSummary = getSummary('video');
    const ttsSummary = getSummary('tts');

    return (
      <Card size="small" style={{ marginBottom: 16, background: 'var(--bg-secondary, #fafafa)', borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Space>
            <AppstoreOutlined style={{ color: '#1677ff', fontSize: 16 }} />
            <Typography.Text strong style={{ fontSize: 14 }}>
              当前生效主力引擎（多端点时直接在卡片切换）
            </Typography.Text>
          </Space>
        </div>

        <Row gutter={[12, 12]}>
          {/* LLM */}
          <Col xs={24} sm={12} md={6}>
            <Card size="small" style={{ borderRadius: 6, border: '1px solid #e8e8e8' }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                <FileTextOutlined style={{ marginRight: 4 }} />剧本/分镜/审查 (LLM)
              </div>
              {llmSummary.endpoints.length > 1 ? (
                <Select
                  size="small"
                  style={{ width: '100%', marginBottom: 4 }}
                  value={llmSummary.activeId}
                  onChange={(id) => {
                    const ep = llmSummary.endpoints.find((e) => e.id === id);
                    if (ep) handleSetPrimary(ep);
                  }}
                  options={llmSummary.endpoints.map((e) => ({ value: e.id, label: e.name }))}
                />
              ) : (
                <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                  {llmSummary.provider}
                </Typography.Text>
              )}
              <Tag color="blue" style={{ fontSize: 11, margin: 0 }}>模型: {llmSummary.model}</Tag>
            </Card>
          </Col>

          {/* Image */}
          <Col xs={24} sm={12} md={6}>
            <Card size="small" style={{ borderRadius: 6, border: '1px solid #e8e8e8' }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                <PictureOutlined style={{ marginRight: 4 }} />角色/场景/关键帧 (Image)
              </div>
              {imageSummary.endpoints.length > 1 ? (
                <Select
                  size="small"
                  style={{ width: '100%', marginBottom: 4 }}
                  value={imageSummary.activeId}
                  onChange={(id) => {
                    const ep = imageSummary.endpoints.find((e) => e.id === id);
                    if (ep) handleSetPrimary(ep);
                  }}
                  options={imageSummary.endpoints.map((e) => ({ value: e.id, label: e.name }))}
                />
              ) : (
                <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                  {imageSummary.provider}
                </Typography.Text>
              )}
              <Tag color="cyan" style={{ fontSize: 11, margin: 0 }}>模型: {imageSummary.model}</Tag>
            </Card>
          </Col>

          {/* Video */}
          <Col xs={24} sm={12} md={6}>
            <Card size="small" style={{ borderRadius: 6, border: '1px solid #e8e8e8' }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                <VideoCameraOutlined style={{ marginRight: 4 }} />视频生成 (Video)
              </div>
              {videoSummary.endpoints.length > 1 ? (
                <Select
                  size="small"
                  style={{ width: '100%', marginBottom: 4 }}
                  value={videoSummary.activeId}
                  onChange={(id) => {
                    const ep = videoSummary.endpoints.find((e) => e.id === id);
                    if (ep) handleSetPrimary(ep);
                  }}
                  options={videoSummary.endpoints.map((e) => ({ value: e.id, label: e.name }))}
                />
              ) : (
                <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                  {videoSummary.provider}
                </Typography.Text>
              )}
              <Tag color="purple" style={{ fontSize: 11, margin: 0 }}>模型: {videoSummary.model}</Tag>
            </Card>
          </Col>

          {/* TTS */}
          <Col xs={24} sm={12} md={6}>
            <Card size="small" style={{ borderRadius: 6, border: '1px solid #e8e8e8' }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                <SoundOutlined style={{ marginRight: 4 }} />AI 角色配音 (TTS)
              </div>
              {ttsSummary.endpoints.length > 1 ? (
                <Select
                  size="small"
                  style={{ width: '100%', marginBottom: 4 }}
                  value={ttsSummary.activeId}
                  onChange={(id) => {
                    const ep = ttsSummary.endpoints.find((e) => e.id === id);
                    if (ep) handleSetPrimary(ep);
                  }}
                  options={ttsSummary.endpoints.map((e) => ({ value: e.id, label: e.name }))}
                />
              ) : (
                <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                  {ttsSummary.provider}
                </Typography.Text>
              )}
              <Tag color="green" style={{ fontSize: 11, margin: 0 }}>音色: {ttsSummary.voice}</Tag>
            </Card>
          </Col>
        </Row>
      </Card>
    );
  };

  return (
    <div style={{ padding: '0 8px' }}>
      {/* 顶部主力引擎状态概览 */}
      {renderActiveOverview()}

      {/* 核心端点管理与模型直观展示 */}
      <Tabs
        defaultActiveKey="llm"
        items={[
          {
            key: 'llm',
            label: (
              <Space size={4}>
                <FileTextOutlined />
                <span>文本大模型 (LLM)</span>
              </Space>
            ),
            children: (
              <div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={handleAutoDiscoverOllama}
                    loading={discoveringOllama}
                    style={{ borderColor: '#f97316', color: '#f97316' }}
                  >
                    一键探测并添加本地 Ollama (127.0.0.1:11434)
                  </Button>
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={handleAutoDiscoverLMStudio}
                    loading={discoveringLMStudio}
                    style={{ borderColor: '#8b5cf6', color: '#8b5cf6' }}
                  >
                    一键探测并添加本地 LM Studio (127.0.0.1:1234)
                  </Button>
                </div>
                <Table
                  dataSource={getEndpointsByCategory('llm')}
                  columns={getEndpointColumns('llm')}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: '暂无配置 LLM 端点，请点击下方添加' }}
                  style={{ marginBottom: 12 }}
                />
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('llm')}>
                  添加 LLM 接口端点 (如 DeepSeek / OpenAI / 硅基流动)
                </Button>
              </div>
            ),
          },
          {
            key: 'image',
            label: (
              <Space size={4}>
                <PictureOutlined />
                <span>画面生图 (Image)</span>
              </Space>
            ),
            children: (
              <div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    onClick={handleAutoDiscoverComfyUI}
                    loading={discoveringComfyUI}
                    style={{ borderColor: '#06b6d4', color: '#06b6d4' }}
                  >
                    一键探测并添加本地 ComfyUI (127.0.0.1:8188)
                  </Button>
                </div>
                <Table
                  dataSource={getEndpointsByCategory('image')}
                  columns={getEndpointColumns('image')}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: '暂无生图端点，请点击下方添加' }}
                  style={{ marginBottom: 12 }}
                />
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('image')}>
                  添加生图接口端点 (如 硅基流动 FLUX / 即梦 Seedream / DALL-E)
                </Button>
              </div>
            ),
          },
          {
            key: 'video',
            label: (
              <Space size={4}>
                <VideoCameraOutlined />
                <span>视频生成 (Video)</span>
              </Space>
            ),
            children: (
              <div>
                <Table
                  dataSource={getEndpointsByCategory('video')}
                  columns={getEndpointColumns('video')}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: '暂无视频端点，请点击下方添加' }}
                  style={{ marginBottom: 12 }}
                />
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('video')}>
                  添加视频生成接口端点 (如 可灵 Kling / 即梦 Seedance / 硅基流动 Wan2.1 / Agnes)
                </Button>
              </div>
            ),
          },
          {
            key: 'tts',
            label: (
              <Space size={4}>
                <SoundOutlined />
                <span>配音合成 (TTS)</span>
              </Space>
            ),
            children: (
              <div>
                <Table
                  dataSource={getEndpointsByCategory('tts')}
                  columns={getEndpointColumns('tts')}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: '暂无配音端点，推荐一键开启免费 Edge TTS' }}
                  style={{ marginBottom: 12 }}
                />
                <Space style={{ width: '100%' }} direction="vertical">
                  <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('tts')}>
                    添加自定义配音端点 (如 硅基流动 CosyVoice / 豆包语音)
                  </Button>
                  <Button
                    type="primary"
                    ghost
                    icon={<ThunderboltOutlined />}
                    block
                    onClick={() => {
                      const newId = addEndpoint({
                        name: '微软 Edge TTS (免费高清无 Key)',
                        provider: 'edge-tts',
                        baseUrl: 'https://speech.platform.bing.com',
                        apiKey: 'free',
                        enabled: true,
                        category: 'tts',
                        models: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural'],
                      });
                      setTTSProvider('edge-tts', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural', newId);
                      message.success('已一键接入并启用了免费微软 Edge TTS 引擎！');
                    }}
                  >
                    一键配置并开启免费微软 Edge TTS (免 API Key 高清配音)
                  </Button>
                </Space>
              </div>
            ),
          },
        ]}
      />

      <Divider style={{ margin: '20px 0 12px 0' }} />

      {/* 高级微调：各任务细分模型（按需展开，平时不干扰） */}
      <Collapse
        ghost
        items={[
          {
            key: 'advanced_tasks',
            label: (
              <Space>
                <ControlOutlined style={{ color: '#1677ff' }} />
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  高级微调：针对不同工序指定特定模型（选填，留空则自动继承主力模型）
                </Typography.Text>
              </Space>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Card
                  size="small"
                  title="文本工序细分模型"
                  extra={
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: 0 }}
                      onClick={() => {
                        for (const task of LLM_TASK_MODELS) {
                          setLLMModel(task.key, '');
                        }
                        message.success('已清空所有文本工序自定义设置，全部继承主力模型！');
                      }}
                    >
                      一键清空（全部继承主力）
                    </Button>
                  }
                >
                  {LLM_TASK_MODELS.map((task) => {
                    const activeEp = endpoints.find((e) => e.id === config.llm.endpointId);
                    const modelOpts = (
                      activeEp?.models && activeEp.models.length > 0
                        ? activeEp.models
                        : (PROVIDER_MODEL_SUGGESTIONS[config.llm.primary] ?? [])
                    ).map((m) => ({ value: m, label: m }));

                    return (
                      <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ width: 180, fontSize: 12 }}>{task.label}</span>
                        <AutoComplete
                          style={{ flex: 1 }}
                          value={(config.llm.models as Record<string, string>)[task.key] || undefined}
                          onChange={(v) => setLLMModel(task.key, v)}
                          placeholder={`留空默认使用: ${config.llm.defaultModel || '主力模型'}`}
                          size="small"
                          allowClear
                          options={modelOpts}
                        />
                      </div>
                    );
                  })}
                </Card>

                <Card size="small" title="生图工序细分模型">
                  {IMAGE_TASK_MODELS.map((task) => (
                    <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 180, fontSize: 12 }}>{task.label}</span>
                      <AutoComplete
                        style={{ flex: 1 }}
                        value={(config.image.models as Record<string, string>)[task.key] || undefined}
                        onChange={(v) => setImageModel(task.key, v)}
                        placeholder={`留空默认使用: ${config.image.defaultModel || '主力生图模型'}`}
                        size="small"
                        allowClear
                        options={(PROVIDER_MODEL_SUGGESTIONS[config.image.primary] ?? []).map((m) => ({ value: m, label: m }))}
                      />
                    </div>
                  ))}
                </Card>

                <Card size="small" title="视频工序细分模型">
                  {VIDEO_TASK_MODELS.map((task) => (
                    <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 180, fontSize: 12 }}>{task.label}</span>
                      <AutoComplete
                        style={{ flex: 1 }}
                        value={(config.video.models as Record<string, string>)[task.key] || undefined}
                        onChange={(v) => setVideoModel(task.key, v)}
                        placeholder={`留空默认使用: ${config.video.defaultModel || '主力视频模型'}`}
                        size="small"
                        allowClear
                        options={(PROVIDER_MODEL_SUGGESTIONS[config.video.primary] ?? []).map((m) => ({ value: m, label: m }))}
                      />
                    </div>
                  ))}
                </Card>
              </div>
            ),
          },
        ]}
      />

      {/* 添加 / 编辑端点弹窗 */}
      <Modal
        title={editingEndpoint ? '编辑接口端点' : '添加接口端点'}
        open={addModalOpen}
        onOk={handleSaveEndpoint}
        onCancel={() => { setAddModalOpen(false); setEditingEndpoint(null); form.resetFields(); }}
        okText="保存并启用"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="provider" label="服务商类型" rules={[{ required: true }]}>
            <Select
              disabled={!!editingEndpoint}
              options={
                (addCategory === 'llm' ? LLM_PROVIDER_OPTIONS
                : addCategory === 'image' ? IMAGE_PROVIDER_OPTIONS
                : addCategory === 'video' ? VIDEO_PROVIDER_OPTIONS
                : TTS_PROVIDER_OPTIONS) as { value: string; label: string }[]
              }
              onChange={(value) => {
                form.setFieldsValue({
                  baseUrl: getProviderDefaultUrl(value),
                  name: `${value.toUpperCase()} 接口`,
                  modelsStr: (PROVIDER_MODEL_SUGGESTIONS[value] ?? []).join(', '),
                });
              }}
            />
          </Form.Item>

          <Form.Item name="name" label="端点备注名称" rules={[{ required: true, message: '请填写端点名称' }]}>
            <Input placeholder="例如: 个人 DeepSeek / 官方 OpenAI" />
          </Form.Item>

          <Form.Item
            name="baseUrl"
            label="API 接口地址 (Base URL)"
            rules={[{ required: watchProvider !== 'edge-tts', message: '请填写 Base URL' }]}
          >
            <Input placeholder={watchProvider === 'edge-tts' ? '微软 Edge TTS 自动连接，无需配置' : 'https://api.openai.com/v1'} />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key / 访问令牌"
            rules={[{ required: watchProvider !== 'edge-tts', message: '请填写 API Key' }]}
          >
            <Input.Password placeholder={watchProvider === 'edge-tts' ? '微软 Edge TTS 完全免费，无需 API Key' : 'sk-...'} />
          </Form.Item>

          {watchProvider !== 'edge-tts' && (
            <Form.Item
              name="modelsStr"
              label="指定使用模型 (多个用逗号隔开，首个为默认)"
              tooltip="可直接输入具体模型名称，例如 deepseek-chat, gpt-4o 等"
            >
              <Input placeholder="可留空，系统将自动使用该服务商推荐默认模型" />
            </Form.Item>
          )}

          {watchProvider === 'edge-tts' && (
            <Alert type="info" showIcon message="微软 Edge TTS 支持高质量男女多音色，零门槛开箱即用" style={{ marginTop: 4 }} />
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default ProviderSettings;

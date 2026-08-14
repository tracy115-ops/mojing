import React, { useState, useCallback, useMemo } from 'react';
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
  Steps,
  Alert,
  AutoComplete,
  Checkbox,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
  ApiOutlined as EndpointIcon,
  SettingOutlined,
  ThunderboltOutlined as TaskIcon,
  LockOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore, PROVIDER_CATEGORY } from '@/stores/providerStore';
import type {
  LLMProviderId,
  ImageProviderId,
  VideoProviderId,
  TTSProviderId,
  ApiEndpoint,
  ProviderConfig,
} from '@/types/providers';

const LLM_PROVIDER_OPTIONS: { value: LLMProviderId; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen (通义千问)' },
  { value: 'doubao', label: 'Doubao (豆包)' },
  { value: 'glm', label: 'GLM (智谱)' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
];

const IMAGE_PROVIDER_OPTIONS: { value: ImageProviderId; label: string }[] = [
  { value: 'jimeng', label: '即梦 Seedream (火山方舟 / 字节)' },
  { value: 'wanx', label: '通义万相 (Wanx / 阿里)' },
  { value: 'siliconflow-image', label: '硅基流动 (Kolors / FLUX)' },
  { value: 'dalle', label: 'DALL-E (OpenAI)' },
  { value: 'cogview', label: 'CogView (智谱 GLM)' },
  { value: 'kling-image', label: 'Kling (可灵图生图)' },
  { value: 'ideogram', label: 'Ideogram' },
  { value: 'agnes-image', label: 'Agnes Image (免费)' },
  { value: 'leonardo', label: 'Leonardo.ai' },
  { value: 'stable-diffusion', label: 'Stable Diffusion (本地)' },
  { value: 'flux', label: 'Flux (本地)' },
  { value: 'comfyui', label: 'ComfyUI (本地)' },
  { value: 'custom', label: 'Custom (自定义 OpenAI 兼容 API)' },
];

const VIDEO_PROVIDER_OPTIONS: { value: VideoProviderId; label: string }[] = [
  { value: 'doubao-video', label: '即梦 Seedance (火山引擎 / 豆包)' },
  { value: 'minimax-video', label: '海螺 MiniMax (Video-01)' },
  { value: 'vidu', label: 'Vidu (生数科技)' },
  { value: 'cogvideo', label: '智谱 CogVideoX' },
  { value: '302ai-video', label: '302.AI Video' },
  { value: 'siliconflow-video', label: '硅基流动 (Wan 2.1)' },
  { value: 'kling', label: 'Kling (可灵视频)' },
  { value: 'sora', label: 'Sora' },
  { value: 'runway', label: 'Runway (Gen-3 / Gen-4)' },
  { value: 'pika', label: 'Pika' },
  { value: 'agnes-video', label: 'Agnes Video (免费)' },
  { value: 'leonardo-video', label: 'Leonardo Motion' },
  { value: 'custom', label: 'Custom (自定义视频 API)' },
];

const TTS_PROVIDER_OPTIONS: { value: TTSProviderId; label: string }[] = [
  { value: 'doubao-tts', label: '字节豆包配音 (火山语音 / Doubao TTS)' },
  { value: 'siliconflow-tts', label: '硅基流动 CosyVoice (SiliconFlow)' },
  { value: 'openai-tts', label: 'OpenAI TTS (tts-1 / tts-1-hd)' },
  { value: 'edge-tts', label: 'Edge TTS (微软免费配音)' },
  { value: 'custom', label: 'Custom (自定义配音 API)' },
];


const LLM_TASK_MODELS = [
  { key: 'planning', labelKey: 'provider.task.planning' },
  { key: 'generation', labelKey: 'provider.task.generation' },
  { key: 'review', labelKey: 'provider.task.review' },
  { key: 'extraction', labelKey: 'provider.task.extraction' },
  { key: 'translation', labelKey: 'provider.task.translation' },
];

const IMAGE_TASK_MODELS = [
  { key: 'character', labelKey: 'provider.task.character' },
  { key: 'scene', labelKey: 'provider.task.scene' },
  { key: 'panel', labelKey: 'provider.task.panel' },
  { key: 'style-transfer', labelKey: 'provider.task.style-transfer' },
  { key: 'storyboard', labelKey: 'provider.task.storyboard' },
];

const VIDEO_TASK_MODELS = [
  { key: 'clip', labelKey: 'provider.task.clip' },
  { key: 'transition', labelKey: 'provider.task.transition' },
  { key: 'full-scene', labelKey: 'provider.task.full-scene' },
  { key: 'lip-sync', labelKey: 'provider.task.lip-sync' },
  { key: 'effects', labelKey: 'provider.task.effects' },
];

// Per-provider suggested models — shown as autocomplete dropdown options.
// User can still type any model name not in this list (the input is free-form).
const PROVIDER_MODEL_SUGGESTIONS: Record<string, string[]> = {
  // LLM
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'],
  claude: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-7'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  siliconflow: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
  qwen: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  doubao: ['doubao-1.5-pro', 'doubao-1.5-lite'],
  glm: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  // Image
  dalle: ['dall-e-3', 'dall-e-2'],
  'kling-image': ['kling-v1', 'kling-v1-5', 'kling-v2'],
  cogview: ['cogview-3-plus', 'cogview-3-flash'],
  wanx: ['wanx-v1', 'wanx-2.1-t2i-turbo', 'wanx-2.1-t2i-plus'],
  jimeng: ['doubao-seedream-3-0-t2i-250415', 'doubao-seedream-3-0-i2i-250415'],
  'siliconflow-image': ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev', 'Kwai-Kolors/Kolors', 'stabilityai/stable-diffusion-3-5-large'],
  ideogram: ['V_3', 'V_2'],
  'agnes-image': ['agnes-image-2.1-flash', 'agnes-image-2.0-flash'],
  leonardo: ['b24a42c0-7a00-4cc4-9753-ca0962555099', '2067ae52-fafc-4a4c-9bbf-75c2b2cbb4c2'],
  // Video
  kling: ['kling-v2', 'kling-v2-pro', 'kling-v2-master', 'kling-v1-6'],
  runway: ['gen4_turbo', 'gen3-alpha'],
  vidu: ['vidu-1.5', 'vidu-1.0', 'vidu-q2'],
  pika: ['pika-1.5', 'pika-1.0'],
  'agnes-video': ['agnes-video-v2.0'],
  'doubao-video': ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128'],
  'minimax-video': ['video-01', 'video-01-live'],
  cogvideo: ['cogvideox_5b', 'cogvideox_flash'],
  '302ai-video': ['sora-302', 'kling-302', 'runway-302', 'minimax-302'],
  'siliconflow-video': ['Wan-AI/Wan2.1-T2V-1.4B', 'Wan-AI/Wan2.1-I2V-14B-720P', 'Wan-AI/Wan2.1-T2V-14B', 'Wan-AI/Wan2.2-I2V-A14B'],
  'leonardo-video': ['leonardo-motion'],
  // TTS
  'openai-tts': ['tts-1', 'tts-1-hd', 'cosyvoice-v1', 'doubao-tts-v1', 'gpt-4o-audio-preview'],
  'doubao-tts': ['doubao-tts-v1', 'doubao-voice-standard'],
  'siliconflow-tts': ['FunAudioLLM/CosyVoice2-0.5B', 'FunAudioLLM/CosyVoice-300M-Instruct', 'fishaudio/fish-speech-1.5'],
  'edge-tts': ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'],
  // Music
  'suno-music': ['suno-v3.5', 'suno-v4'],
  'udio-music': ['udio-v1.5'],
  'siliconflow-music': ['suno-v3.5', 'suno-v4'],
};

/** Return the suggestion list for the *primary* provider of a given category.
 *  This drives the autocomplete dropdown — user can still type anything else. */
function getModelSuggestions(
  config: ProviderConfig,
  category: 'llm' | 'image' | 'video' | 'tts',
): string[] {
  const primary = config[category]?.primary;
  if (!primary) return [];
  return PROVIDER_MODEL_SUGGESTIONS[primary] ?? [];
}

type StepKey = 'endpoints' | 'models' | 'tasks';

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
  const [currentStep, setCurrentStep] = useState<StepKey>('endpoints');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addCategory, setAddCategory] = useState<'llm' | 'image' | 'video' | 'tts'>('llm');
  const [editingEndpoint, setEditingEndpoint] = useState<ApiEndpoint | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const watchProvider = Form.useWatch('provider', form);

  // Individual selectors to prevent unnecessary re-renders
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
  const setLLMFallback = useProviderStore((s) => s.setLLMFallback);
  const setImageFallback = useProviderStore((s) => s.setImageFallback);
  const setVideoFallback = useProviderStore((s) => s.setVideoFallback);
  const setLLMModel = useProviderStore((s) => s.setLLMModel);
  const setImageModel = useProviderStore((s) => s.setImageModel);
  const setVideoModel = useProviderStore((s) => s.setVideoModel);
  const checkHealth = useProviderStore((s) => s.checkHealth);

  const hasEndpoints = endpoints.length > 0;

  const getEndpointsByCategory = useCallback((category: 'llm' | 'image' | 'video' | 'tts') => {
    // Single source of truth: PROVIDER_CATEGORY from providerStore.
    // Note: includes disabled endpoints — Settings tables show all so the user can toggle.
    return endpoints.filter((e) => (e.category ?? PROVIDER_CATEGORY[e.provider]) === category);
  }, [endpoints]);

  // Step availability
  const stepStatus = useMemo(() => ({
    endpoints: true,
    models: hasEndpoints,
    tasks: hasEndpoints,
  }), [hasEndpoints]);

  const canGoToStep = (step: StepKey) => stepStatus[step];

  // --- Step 1: Endpoints ---

  const handleAddEndpoint = useCallback((category: 'llm' | 'image' | 'video' | 'tts') => {
    setAddCategory(category);
    setEditingEndpoint(null);
    const defaultProvider =
      category === 'llm' ? 'openai'
      : category === 'image' ? 'dalle'
      : category === 'video' ? 'kling'
      : 'openai-tts';
    const defaultUrl = getProviderDefaultUrl(defaultProvider);
    form.setFieldsValue({
      provider: defaultProvider,
      baseUrl: defaultUrl,
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
      const models = values.modelsStr
        ? values.modelsStr.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      if (values.provider !== 'edge-tts' && !models?.length) {
        form.setFields([{ name: 'modelsStr', errors: ['请填写要使用的具体模型名称'] }]);
        return;
      }

      const provider = values.provider;
      const isEdge = provider === 'edge-tts';
      const baseUrl = values.baseUrl || (isEdge ? 'https://speech.platform.bing.com' : '');
      const apiKey = values.apiKey || (isEdge ? 'free' : '');

      if (editingEndpoint) {
        updateEndpoint(editingEndpoint.id, {
          name: values.name,
          provider,
          baseUrl,
          apiKey,
          models,
          category: addCategory,
        });
      } else {
        // Form 没有 enabled 字段(setFieldsValue 不进 form state),显式补 true。
        // 否则 store 里 endpoint.enabled = undefined,DirectVideoModal 等下游
        // 按 e.enabled 过滤时全部被排除,表现成"已配置但模式按钮还是灰"。
        // 同时带上当前 tab 的 category,让 custom endpoint 能在正确类别下被列出。
        const newId = addEndpoint({
          name: values.name,
          provider,
          baseUrl,
          apiKey,
          models,
          enabled: true,
          category: addCategory,
        });
        if (values.useAsPrimary !== false && provider === 'edge-tts') {
          setTTSProvider('edge-tts', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural', newId);
        } else if (values.useAsPrimary !== false && addCategory === 'llm') {
          setLLMProvider(provider as LLMProviderId, models?.[0], newId);
        } else if (values.useAsPrimary !== false && addCategory === 'image') {
          setImageProvider(provider as ImageProviderId, models?.[0], newId);
        } else if (values.useAsPrimary !== false && addCategory === 'video') {
          setVideoProvider(provider as VideoProviderId, models?.[0], newId);
        } else if (values.useAsPrimary !== false) {
          setTTSProvider(provider as TTSProviderId, models?.[0], undefined, newId);
        }
      }
      setAddModalOpen(false);
      setEditingEndpoint(null);
      form.resetFields();
      message.success(t('common.saved'));
    } catch {
      // Validation failed
    }
  }, [form, addEndpoint, updateEndpoint, editingEndpoint, addCategory, setLLMProvider, setImageProvider, setVideoProvider, setTTSProvider, t]);

  const handleTestConnection = useCallback(async (endpointId: string) => {
    setTestingId(endpointId);
    try {
      const health = await checkHealth(endpointId);
      if (health.available) {
        message.success(t('message.connectionSuccess'));
      } else {
        message.error(`${t('message.connectionFailed')}: ${health.error}`);
      }
    } catch {
      message.error(t('message.connectionFailed'));
    } finally {
      setTestingId(null);
    }
  }, [checkHealth, t]);

  const endpointColumns = useMemo(() => [
    {
      title: t('provider.endpointName'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: t('provider.provider.primary'),
      dataIndex: 'provider',
      key: 'provider',
      width: 130,
      render: (provider: string) => <Tag>{t(`provider.provider.${provider}` as const)}</Tag>,
    },
    {
      title: t('provider.endpointUrl'),
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      ellipsis: true,
      render: (url: string) => (
        <Typography.Text copyable={{ text: url }} style={{ fontSize: 12 }}>{url}</Typography.Text>
      ),
    },
    {
      title: t('common.status' as const),
      key: 'status',
      width: 90,
      render: (_: unknown, record: ApiEndpoint) => {
        const health = healthStatus[record.id];
        if (testingId === record.id) return <LoadingOutlined spin />;
        if (!health) return <Tag>—</Tag>;
        return health.available
          ? <Tag icon={<CheckCircleOutlined />} color="success">{t('provider.connected')}</Tag>
          : <Tooltip title={health.error}><Tag icon={<CloseCircleOutlined />} color="error">{t('provider.disconnected')}</Tag></Tooltip>;
      },
    },
    {
      title: t('common.test' as const),
      key: 'actions',
      width: 180,
      render: (_: unknown, record: ApiEndpoint) => (
        <Space>
          <Button size="small" onClick={() => handleTestConnection(record.id)} loading={testingId === record.id}>
            {t('provider.testConnection')}
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditEndpoint(record)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeEndpoint(record.id)} />
        </Space>
      ),
    },
  ], [t, healthStatus, testingId, handleTestConnection, handleEditEndpoint, removeEndpoint]);

  const renderStepEndpoints = () => (
    <div>
      {!hasEndpoints && (
        <Alert
          type="info"
          showIcon
          message={t('provider.noEndpoints')}
          style={{ marginBottom: 16 }}
        />
      )}
      <Tabs
        items={[
          {
            key: 'llm',
            label: t('provider.llm'),
            children: (
              <div>
                <Table
                  dataSource={getEndpointsByCategory('llm')}
                  columns={endpointColumns}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: t('common.noData' as const) }}
                  style={{ marginBottom: 12 }}
                />
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('llm')}>
                  {t('provider.addEndpoint')} — {t('provider.llm')}
                </Button>
              </div>
            ),
          },
          {
            key: 'image',
            label: t('provider.image'),
            children: (
              <div>
                <Table
                  dataSource={getEndpointsByCategory('image')}
                  columns={endpointColumns}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: t('common.noData' as const) }}
                  style={{ marginBottom: 12 }}
                />
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('image')}>
                  {t('provider.addEndpoint')} — {t('provider.image')}
                </Button>
              </div>
            ),
          },
          {
            key: 'video',
            label: t('provider.video'),
            children: (
              <div>
                <Table
                  dataSource={getEndpointsByCategory('video')}
                  columns={endpointColumns}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: t('common.noData' as const) }}
                  style={{ marginBottom: 12 }}
                />
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('video')}>
                  {t('provider.addEndpoint')} — {t('provider.video')}
                </Button>
              </div>
            ),
          },
          {
            key: 'tts',
            label: t('provider.tts'),
            children: (
              <div>
                <Table
                  dataSource={getEndpointsByCategory('tts')}
                  columns={endpointColumns}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: t('common.noData' as const) }}
                  style={{ marginBottom: 12 }}
                />
                <Space style={{ width: '100%' }} direction="vertical">
                  <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('tts')}>
                    {t('provider.addEndpoint')} — {t('provider.tts')}
                  </Button>
                  <Button
                    type="primary"
                    ghost
                    icon={<SoundOutlined />}
                    block
                    onClick={() => {
                      const newId = addEndpoint({
                        name: '微软 Edge TTS (免费高清无 Key)',
                        provider: 'edge-tts',
                        baseUrl: 'https://speech.platform.bing.com',
                        apiKey: 'free',
                        enabled: true,
                        category: 'tts',
                      });
                      setTTSProvider('edge-tts', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural', newId);
                      message.success('已一键接入并启用了免费微软 Edge TTS 引擎！');
                    }}
                  >
                    ⚡ 一键配置并开启免费微软 Edge TTS (无 Key 告别 400 报错)
                  </Button>
                </Space>
              </div>
            ),
          },
        ]}
      />
    </div>
  );

  // --- Step 2: Model selection ---

  const renderModelSelector = (
    category: 'llm' | 'image' | 'video' | 'tts',
    options: { value: string; label: string }[],
  ) => {
    const catConfig = config[category];
    if (!catConfig) {
      return <Alert type="warning" message={`Category ${category} not configured`} />;
    }
    const setProvider =
      category === 'llm' ? setLLMProvider
      : category === 'image' ? setImageProvider
      : category === 'video' ? setVideoProvider
      : setTTSProvider;
    // TTS 暂不支持 fallback selector(setTTSFallback 不存在)
    const setFallbackFn =
      category === 'llm' ? setLLMFallback
      : category === 'image' ? setImageFallback
      : category === 'video' ? setVideoFallback
      : (() => {});
    const categoryEndpoints = getEndpointsByCategory(category);
    const showFallback = category !== 'tts';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.primary')}</div>
            <Select
              style={{ width: '100%' }}
              value={catConfig.primary}
              onChange={(v) => {
                if (category === 'tts') {
                  setTTSProvider(v as TTSProviderId, catConfig.defaultModel, (catConfig as any).defaultVoice, catConfig.endpointId);
                } else {
                  setProvider(v as never, undefined, catConfig.endpointId);
                }
              }}
              options={options}
            />
          </div>
          {showFallback && (
            <div style={{ flex: 1 }}>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.fallback')}</div>
              <Select
                style={{ width: '100%' }}
                value={(catConfig as { fallback?: string }).fallback}
                onChange={(v) => setFallbackFn(v as never, (catConfig as { fallbackEndpointId?: string }).fallbackEndpointId)}
                options={[{ value: '', label: '— None —' }, ...options]}
                allowClear
              />
            </div>
          )}
        </div>

        {categoryEndpoints.length > 0 && (
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.endpoint')}</div>
            <Select
              style={{ width: '100%' }}
              value={catConfig.endpointId}
              onChange={(v) => {
                if (category === 'tts') {
                  setTTSProvider(catConfig.primary as TTSProviderId, catConfig.defaultModel, (catConfig as any).defaultVoice, v);
                } else {
                  setProvider(catConfig.primary as never, undefined, v);
                }
              }}
              options={categoryEndpoints.map((e) => ({ value: e.id, label: `${e.name} (${e.baseUrl})` }))}
              placeholder={t('provider.endpoint')}
              allowClear
            />
          </div>
        )}

        {/* TTS 额外字段:voice / speed 等(从 TTSProviderConfig 读) */}
        {category === 'tts' && (
          <Alert
            type="info"
            showIcon
            message={t('provider.tts.voiceTip')}
            description={t('provider.tts.voiceDesc')}
          />
        )}
      </div>
    );
  };

  const renderStepModels = () => {
    if (!hasEndpoints) {
      return (
        <Alert
          type="warning"
          showIcon
          icon={<LockOutlined />}
          message={t('provider.stepLocked')}
          description={t('provider.noEndpoints')}
        />
      );
    }

    return (
      <Tabs
        items={[
          {
            key: 'llm',
            label: t('provider.llm'),
            children: <Card size="small">{renderModelSelector('llm', LLM_PROVIDER_OPTIONS)}</Card>,
          },
          {
            key: 'image',
            label: t('provider.image'),
            children: <Card size="small">{renderModelSelector('image', IMAGE_PROVIDER_OPTIONS)}</Card>,
          },
          {
            key: 'video',
            label: t('provider.video'),
            children: <Card size="small">{renderModelSelector('video', VIDEO_PROVIDER_OPTIONS)}</Card>,
          },
          {
            key: 'tts',
            label: t('provider.tts'),
            children: <Card size="small">{renderModelSelector('tts', TTS_PROVIDER_OPTIONS)}</Card>,
          },
          {
            key: 'music',
            label: '🎵 AI 音乐生成',
            children: (
              <Card size="small">
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    选择默认 AI 音乐引擎端点
                  </Typography.Text>
                  <AutoComplete
                    style={{ width: '100%' }}
                    placeholder="选填 Suno AI / 硅基流动 / 自定义中转站音乐模型 (如 suno-v3.5)"
                    options={[
                      { value: 'suno-v3.5', label: 'suno-v3.5 (Suno 高清原声推荐)' },
                      { value: 'suno-v4', label: 'suno-v4 (Suno 最新高品规引擎)' },
                      { value: 'udio-v1.5', label: 'udio-v1.5 (Udio 交响与流行配乐)' },
                      { value: 'FunAudioLLM/SenseVoiceSmall', label: 'FunAudioLLM/SenseVoiceSmall (硅基流动免费)' },
                    ]}
                  />
                </div>
              </Card>
            ),
          },
        ]}
      />
    );
  };

  // --- Step 3: Task models ---

  /** Render one row of "<label> <AutoComplete model input> [reset]".
   *  Works for LLM / image / video task models alike. */
  const renderTaskModelRow = (
    taskKey: string,
    labelKey: string,
    currentValue: string,
    placeholder: string,
    suggestions: string[],
    onCommit: (model: string) => void,
  ) => {
    return (
      <div key={taskKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 120, fontSize: 13, flexShrink: 0 }}>{t(labelKey)}</span>
        <AutoComplete
          style={{ flex: 1 }}
          value={currentValue || undefined}
          onChange={(v) => onCommit(v)}
          placeholder={placeholder || t('provider.task.modelPlaceholder')}
          size="small"
          allowClear
          filterOption={(input, option) =>
            (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
          }
          options={suggestions.map((m) => ({ value: m, label: m }))}
          popupMatchSelectWidth={false}
        />
        {currentValue && (
          <Button
            size="small"
            type="link"
            onClick={() => onCommit('')}
            style={{ flexShrink: 0, padding: '0 4px' }}
          >
            {t('common.reset')}
          </Button>
        )}
      </div>
    );
  };

  const renderStepTasks = () => {
    if (!hasEndpoints) {
      return (
        <Alert
          type="warning"
          showIcon
          icon={<LockOutlined />}
          message={t('provider.stepLocked')}
          description={t('provider.noEndpoints')}
        />
      );
    }

    const llmSuggestions = getModelSuggestions(config, 'llm');
    const imageSuggestions = getModelSuggestions(config, 'image');
    const videoSuggestions = getModelSuggestions(config, 'video');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Card size="small" title={t('provider.llm')}>
          <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
            {t('provider.step.tasks.desc')}
          </div>
          {LLM_TASK_MODELS.map((task) => {
            const currentValue = (config.llm.models as Record<string, string>)[task.key] ?? '';
            return renderTaskModelRow(
              task.key,
              task.labelKey,
              currentValue,
              config.llm.defaultModel,
              llmSuggestions,
              (v) => setLLMModel(task.key, v),
            );
          })}
        </Card>

        <Card size="small" title={t('provider.image')}>
          <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
            {t('provider.step.tasks.imageDesc')}
          </div>
          {IMAGE_TASK_MODELS.map((task) => {
            const currentValue = (config.image.models as Record<string, string>)[task.key] ?? '';
            return renderTaskModelRow(
              task.key,
              task.labelKey,
              currentValue,
              config.image.defaultModel,
              imageSuggestions,
              (v) => setImageModel(task.key, v),
            );
          })}
        </Card>

        <Card size="small" title={t('provider.video')}>
          <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
            {t('provider.step.tasks.videoDesc')}
          </div>
          {VIDEO_TASK_MODELS.map((task) => {
            const currentValue = (config.video.models as Record<string, string>)[task.key] ?? '';
            return renderTaskModelRow(
              task.key,
              task.labelKey,
              currentValue,
              config.video.defaultModel,
              videoSuggestions,
              (v) => setVideoModel(task.key, v),
            );
          })}
        </Card>

        <Card size="small" title={`${t('provider.tts')} — 默认模型与音色设置`}>
          <div style={{ marginBottom: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
            设置 TTS 配音调用的默认 Voice Model 及预设音色（如 CosyVoice / 豆包音色）
          </div>
          {renderTaskModelRow(
            'tts_default_model',
            'TTS 默认模型',
            config.tts?.defaultModel || '',
            'FunAudioLLM/CosyVoice-300M',
            getModelSuggestions(config, 'tts'),
            (v) => setTTSProvider(config.tts?.primary ?? 'openai-tts', v, config.tts?.defaultVoice, config.tts?.endpointId),
          )}
          {renderTaskModelRow(
            'tts_default_voice',
            'TTS 默认音色',
            config.tts?.defaultVoice || '',
            'alloy / xiaoxiao / yunxi',
            ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'],
            (v) => setTTSProvider(config.tts?.primary ?? 'openai-tts', config.tts?.defaultModel, v, config.tts?.endpointId),
          )}
        </Card>
      </div>
    );
  };

  // --- Steps config ---

  const stepsItems = [
    {
      key: 'endpoints',
      title: t('provider.step.endpoints'),
      description: t('provider.step.endpoints.desc'),
      icon: <EndpointIcon />,
    },
    {
      key: 'models',
      title: t('provider.step.models'),
      description: hasEndpoints ? t('provider.step.models.desc') : <LockOutlined style={{ fontSize: 12 }} />,
      icon: <SettingOutlined />,
    },
    {
      key: 'tasks',
      title: t('provider.step.tasks'),
      description: hasEndpoints ? t('provider.step.tasks.desc') : <LockOutlined style={{ fontSize: 12 }} />,
      icon: <TaskIcon />,
    },
  ];

  const stepIndex = ['endpoints', 'models', 'tasks'].indexOf(currentStep);

  return (
    <div style={{ padding: '0 8px' }}>
      <Alert
        type="info"
        showIcon
        message={t('provider.quickSetup.title')}
        description={t('provider.quickSetup.description')}
        style={{ marginBottom: 16 }}
      />
      {renderStepEndpoints()}

      {/* Add/Edit Endpoint Modal */}
      <Modal
        title={editingEndpoint ? t('provider.editEndpoint') : t('provider.addEndpoint')}
        open={addModalOpen}
        onOk={handleSaveEndpoint}
        onCancel={() => { setAddModalOpen(false); setEditingEndpoint(null); form.resetFields(); }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('provider.endpointName')} rules={[{ required: true, message: t('common.required') }]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label={t('provider.primary')} rules={[{ required: true }]}>
            <Select
              disabled={!!editingEndpoint}
              options={
                (addCategory === 'llm' ? LLM_PROVIDER_OPTIONS
                : addCategory === 'image' ? IMAGE_PROVIDER_OPTIONS
                : addCategory === 'video' ? VIDEO_PROVIDER_OPTIONS
                : TTS_PROVIDER_OPTIONS) as { value: string; label: string }[]
              }
              onChange={(value) => {
                form.setFieldsValue({ baseUrl: getProviderDefaultUrl(value) });
              }}
            />
          </Form.Item>
          <Form.Item name="baseUrl" label={t('provider.endpointUrl')} dependencies={['provider']} rules={[{ required: watchProvider !== 'edge-tts', message: t('common.required') }]} extra={watchProvider === 'edge-tts' ? t('provider.edgeTtsUrlAuto') : undefined}>
            <Input placeholder={watchProvider === 'edge-tts' ? t('provider.edgeTtsUrlAuto') : ''} />
          </Form.Item>
          <Form.Item name="apiKey" label={t('provider.apiKey')} dependencies={['provider']} rules={[{ required: watchProvider !== 'edge-tts', message: t('common.required') }]}>
            <Input.Password placeholder={watchProvider === 'edge-tts' ? t('provider.edgeTtsNoKey') : t('provider.apiKeyPlaceholder')} />
          </Form.Item>
          <Form.Item name="modelsStr" label="模型名称 (可选 / 多个用逗号隔开)" tooltip="自定义中转站或服务的模型名，例如: FunAudioLLM/CosyVoice-300M, cosyvoice-v1">
            <Input placeholder="例如: FunAudioLLM/CosyVoice-300M, cosyvoice-v1" />
          </Form.Item>
          {!editingEndpoint && (
            <Form.Item name="useAsPrimary" valuePropName="checked">
              <Checkbox>{t('provider.quickSetup.useAsPrimary')}</Checkbox>
            </Form.Item>
          )}
          {watchProvider === 'edge-tts' && (
            <Alert type="info" showIcon message={t('provider.edgeTtsHint')} style={{ marginTop: 4 }} />
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default ProviderSettings;

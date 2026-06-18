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
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
  ApiOutlined as EndpointIcon,
  SettingOutlined,
  ThunderboltOutlined as TaskIcon,
  LockOutlined,
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
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen (通义千问)' },
  { value: 'doubao', label: 'Doubao (豆包)' },
  { value: 'glm', label: 'GLM (智谱)' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
];

const IMAGE_PROVIDER_OPTIONS: { value: ImageProviderId; label: string }[] = [
  { value: 'dalle', label: 'DALL-E (OpenAI)' },
  { value: 'cogview', label: 'CogView (智谱 GLM)' },
  { value: 'wanx', label: 'Wanx (通义万相 / 阿里)' },
  { value: 'jimeng', label: 'Jimeng (即梦 / 字节)' },
  { value: 'kling-image', label: 'Kling (可灵)' },
  { value: 'ideogram', label: 'Ideogram' },
  { value: 'stable-diffusion', label: 'Stable Diffusion (本地)' },
  { value: 'flux', label: 'Flux (本地)' },
  { value: 'comfyui', label: 'ComfyUI (本地)' },
  { value: 'custom', label: 'Custom' },
];

const VIDEO_PROVIDER_OPTIONS: { value: VideoProviderId; label: string }[] = [
  { value: 'sora', label: 'Sora' },
  { value: 'runway', label: 'Runway' },
  { value: 'kling', label: 'Kling (可灵)' },
  { value: 'vidu', label: 'Vidu' },
  { value: 'pika', label: 'Pika' },
  { value: 'custom', label: 'Custom' },
];

const TTS_PROVIDER_OPTIONS: { value: TTSProviderId; label: string }[] = [
  { value: 'openai-tts', label: 'OpenAI TTS (tts-1 / tts-1-hd)' },
  { value: 'doubao-tts', label: 'Doubao TTS (豆包)' },
  { value: 'edge-tts', label: 'Edge TTS (免费,微软)' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
];

const COMMON_LLM_MODELS = [
  // OpenAI
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  { value: 'o1', label: 'o1' },
  { value: 'o3-mini', label: 'o3 Mini' },
  // Claude
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  // DeepSeek
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  // Qwen
  { value: 'qwen-max', label: 'Qwen Max' },
  { value: 'qwen-plus', label: 'Qwen Plus' },
  { value: 'qwen-turbo', label: 'Qwen Turbo' },
  // Doubao
  { value: 'doubao-1.5-pro', label: 'Doubao 1.5 Pro' },
  { value: 'doubao-1.5-lite', label: 'Doubao 1.5 Lite' },
  // GLM
  { value: 'glm-4-plus', label: 'GLM-4 Plus' },
  { value: 'glm-4-flash', label: 'GLM-4 Flash' },
  { value: 'glm-4-air', label: 'GLM-4 Air' },
];

const LLM_TASK_MODELS = [
  { key: 'planning', labelKey: 'provider.task.planning' },
  { key: 'generation', labelKey: 'provider.task.generation' },
  { key: 'review', labelKey: 'provider.task.review' },
  { key: 'extraction', labelKey: 'provider.task.extraction' },
  { key: 'translation', labelKey: 'provider.task.translation' },
];

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
  ideogram: 'https://api.ideogram.ai/v1',
  sora: 'https://api.openai.com/v1',
  runway: 'https://api.runwayml.com',
  kling: 'https://api-beijing.klingai.com',
  vidu: 'https://api.vidu.studio',
  pika: 'https://api.pika.art',
  'openai-tts': 'https://api.openai.com/v1',
  'doubao-tts': 'https://ark.cn-beijing.volces.com/api/v3',
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
  const [testingId, setTestingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const watchProvider = Form.useWatch('provider', form);

  // Individual selectors to prevent unnecessary re-renders
  const config = useProviderStore((s) => s.config);
  const endpoints = useProviderStore((s) => s.endpoints);
  const healthStatus = useProviderStore((s) => s.healthStatus);
  const addEndpoint = useProviderStore((s) => s.addEndpoint);
  const removeEndpoint = useProviderStore((s) => s.removeEndpoint);
  const setLLMProvider = useProviderStore((s) => s.setLLMProvider);
  const setImageProvider = useProviderStore((s) => s.setImageProvider);
  const setVideoProvider = useProviderStore((s) => s.setVideoProvider);
  const setTTSProvider = useProviderStore((s) => s.setTTSProvider);
  const setLLMFallback = useProviderStore((s) => s.setLLMFallback);
  const setImageFallback = useProviderStore((s) => s.setImageFallback);
  const setVideoFallback = useProviderStore((s) => s.setVideoFallback);
  const setLLMModel = useProviderStore((s) => s.setLLMModel);
  const checkHealth = useProviderStore((s) => s.checkHealth);

  const hasEndpoints = endpoints.length > 0;

  const getEndpointsByCategory = useCallback((category: 'llm' | 'image' | 'video' | 'tts') => {
    // Single source of truth: PROVIDER_CATEGORY from providerStore.
    // Note: includes disabled endpoints — Settings tables show all so the user can toggle.
    return endpoints.filter((e) => PROVIDER_CATEGORY[e.provider] === category);
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
    });
    setAddModalOpen(true);
  }, [form]);

  const handleSaveEndpoint = useCallback(async () => {
    try {
      const values = await form.validateFields();
      // Form 没有 enabled 字段(setFieldsValue 不进 form state),显式补 true。
      // 否则 store 里 endpoint.enabled = undefined,DirectVideoModal 等下游
      // 按 e.enabled 过滤时全部被排除,表现成"已配置但模式按钮还是灰"。
      // 同时带上当前 tab 的 category,让 custom endpoint 能在正确类别下被列出。
      addEndpoint({ ...values, enabled: true, category: addCategory });
      setAddModalOpen(false);
      form.resetFields();
      message.success(t('common.saved'));
    } catch {
      // Validation failed
    }
  }, [form, addEndpoint, addCategory, t]);

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
      width: 140,
      render: (_: unknown, record: ApiEndpoint) => (
        <Space>
          <Button size="small" onClick={() => handleTestConnection(record.id)} loading={testingId === record.id}>
            {t('provider.testConnection')}
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeEndpoint(record.id)} />
        </Space>
      ),
    },
  ], [t, healthStatus, testingId, handleTestConnection, removeEndpoint]);

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
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => handleAddEndpoint('tts')}>
                  {t('provider.addEndpoint')} — {t('provider.tts')}
                </Button>
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
              onChange={(v) => setProvider(v as never, undefined, catConfig.endpointId)}
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
              onChange={(v) => setProvider(catConfig.primary as never, undefined, v)}
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
        ]}
      />
    );
  };

  // --- Step 3: Task models ---

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

    return (
      <Card size="small">
        <div style={{ marginBottom: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          {t('provider.step.tasks.desc')}
        </div>
        {LLM_TASK_MODELS.map((task) => {
          const currentValue = (config.llm.models as Record<string, string>)[task.key] ?? '';
          return (
            <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ width: 120, fontSize: 13, flexShrink: 0 }}>{t(task.labelKey)}</span>
              <Select
                style={{ flex: 1 }}
                value={currentValue || undefined}
                onChange={(v) => setLLMModel(task.key, v)}
                placeholder={config.llm.defaultModel}
                size="small"
                showSearch
                allowClear
                options={COMMON_LLM_MODELS}
                popupMatchSelectWidth={false}
              />
              {currentValue && currentValue !== config.llm.defaultModel && (
                <Button
                  size="small"
                  type="link"
                  onClick={() => setLLMModel(task.key, '')}
                  style={{ flexShrink: 0, padding: '0 4px' }}
                >
                  {t('common.reset')}
                </Button>
              )}
            </div>
          );
        })}
      </Card>
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
      <Steps
        current={stepIndex}
        size="small"
        style={{ marginBottom: 24 }}
        items={stepsItems.map((item) => ({
          title: item.title,
          description: item.description,
          icon: item.icon,
          status: canGoToStep(item.key as StepKey)
            ? undefined
            : 'wait' as const,
        }))}
        onChange={(idx) => {
          const step = (['endpoints', 'models', 'tasks'] as StepKey[])[idx];
          if (canGoToStep(step)) setCurrentStep(step);
        }}
      />

      {currentStep === 'endpoints' && renderStepEndpoints()}
      {currentStep === 'models' && renderStepModels()}
      {currentStep === 'tasks' && renderStepTasks()}

      {/* Navigation buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
        <Button
          disabled={currentStep === 'endpoints'}
          onClick={() => {
            const steps: StepKey[] = ['endpoints', 'models', 'tasks'];
            const idx = steps.indexOf(currentStep);
            if (idx > 0) setCurrentStep(steps[idx - 1]);
          }}
        >
          {t('common.previous')}
        </Button>
        <Button
          type="primary"
          disabled={currentStep === 'tasks'}
          onClick={() => {
            const steps: StepKey[] = ['endpoints', 'models', 'tasks'];
            const idx = steps.indexOf(currentStep);
            const next = steps[idx + 1];
            if (next && canGoToStep(next)) setCurrentStep(next);
          }}
        >
          {t('common.next')}
        </Button>
      </div>

      {/* Add Endpoint Modal */}
      <Modal
        title={t('provider.addEndpoint')}
        open={addModalOpen}
        onOk={handleSaveEndpoint}
        onCancel={() => { setAddModalOpen(false); form.resetFields(); }}
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
          <Form.Item name="baseUrl" label={t('provider.endpointUrl')} rules={[{ required: watchProvider !== 'edge-tts', message: t('common.required') }]} extra={watchProvider === 'edge-tts' ? t('provider.edgeTtsUrlAuto') : undefined}>
            <Input placeholder={watchProvider === 'edge-tts' ? t('provider.edgeTtsUrlAuto') : ''} />
          </Form.Item>
          <Form.Item name="apiKey" label={t('provider.apiKey')} rules={[{ required: watchProvider !== 'edge-tts', message: t('common.required') }]}>
            <Input.Password placeholder={watchProvider === 'edge-tts' ? t('provider.edgeTtsNoKey') : t('provider.apiKeyPlaceholder')} />
          </Form.Item>
          {watchProvider === 'edge-tts' && (
            <Alert type="info" showIcon message={t('provider.edgeTtsHint')} style={{ marginTop: 4 }} />
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default ProviderSettings;

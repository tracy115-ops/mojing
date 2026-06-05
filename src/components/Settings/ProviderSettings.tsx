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
import { useProviderStore } from '@/stores/providerStore';
import type {
  LLMProviderId,
  ImageProviderId,
  VideoProviderId,
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
  { value: 'dalle', label: 'DALL-E' },
  { value: 'stable-diffusion', label: 'Stable Diffusion' },
  { value: 'flux', label: 'Flux' },
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'kling-image', label: 'Kling (可灵)' },
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
  'kling-image': 'https://api.klingai.com',
  sora: 'https://api.openai.com/v1',
  runway: 'https://api.runwayml.com',
  kling: 'https://api.klingai.com',
  vidu: 'https://api.vidu.studio',
  pika: 'https://api.pika.art',
};

function getProviderDefaultUrl(provider: string): string {
  return PROVIDER_DEFAULT_URLS[provider] ?? 'https://api.example.com/v1';
}

const ProviderSettings: React.FC = () => {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState<StepKey>('endpoints');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addCategory, setAddCategory] = useState<'llm' | 'image' | 'video'>('llm');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  // Individual selectors to prevent unnecessary re-renders
  const config = useProviderStore((s) => s.config);
  const endpoints = useProviderStore((s) => s.endpoints);
  const healthStatus = useProviderStore((s) => s.healthStatus);
  const addEndpoint = useProviderStore((s) => s.addEndpoint);
  const removeEndpoint = useProviderStore((s) => s.removeEndpoint);
  const setLLMProvider = useProviderStore((s) => s.setLLMProvider);
  const setImageProvider = useProviderStore((s) => s.setImageProvider);
  const setVideoProvider = useProviderStore((s) => s.setVideoProvider);
  const setLLMFallback = useProviderStore((s) => s.setLLMFallback);
  const setImageFallback = useProviderStore((s) => s.setImageFallback);
  const setVideoFallback = useProviderStore((s) => s.setVideoFallback);
  const setLLMModel = useProviderStore((s) => s.setLLMModel);
  const checkHealth = useProviderStore((s) => s.checkHealth);

  const hasEndpoints = endpoints.length > 0;

  const getEndpointsByCategory = useCallback((category: 'llm' | 'image' | 'video') => {
    return endpoints.filter((e) => {
      if (category === 'llm') return !['dalle', 'stable-diffusion', 'flux', 'comfyui', 'kling-image', 'sora', 'runway', 'kling', 'vidu', 'pika'].includes(e.provider);
      if (category === 'image') return ['dalle', 'stable-diffusion', 'flux', 'comfyui', 'kling-image', 'custom'].includes(e.provider);
      return ['sora', 'runway', 'kling', 'vidu', 'pika', 'custom'].includes(e.provider);
    });
  }, [endpoints]);

  // Step availability
  const stepStatus = useMemo(() => ({
    endpoints: true,
    models: hasEndpoints,
    tasks: hasEndpoints,
  }), [hasEndpoints]);

  const canGoToStep = (step: StepKey) => stepStatus[step];

  // --- Step 1: Endpoints ---

  const handleAddEndpoint = useCallback((category: 'llm' | 'image' | 'video') => {
    setAddCategory(category);
    const defaultProvider = category === 'llm' ? 'openai' : category === 'image' ? 'dalle' : 'kling';
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
      addEndpoint(values);
      setAddModalOpen(false);
      form.resetFields();
      message.success(t('common.saved'));
    } catch {
      // Validation failed
    }
  }, [form, addEndpoint, t]);

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
        ]}
      />
    </div>
  );

  // --- Step 2: Model selection ---

  const renderModelSelector = (
    category: 'llm' | 'image' | 'video',
    options: { value: string; label: string }[],
  ) => {
    const catConfig = config[category];
    const setProvider = category === 'llm' ? setLLMProvider : category === 'image' ? setImageProvider : setVideoProvider;
    const setFallbackFn = category === 'llm' ? setLLMFallback : category === 'image' ? setImageFallback : setVideoFallback;
    const categoryEndpoints = getEndpointsByCategory(category);

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
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.fallback')}</div>
            <Select
              style={{ width: '100%' }}
              value={catConfig.fallback}
              onChange={(v) => setFallbackFn(v as never, catConfig.fallbackEndpointId)}
              options={[{ value: '', label: '— None —' }, ...options]}
              allowClear
            />
          </div>
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
                : VIDEO_PROVIDER_OPTIONS) as { value: string; label: string }[]
              }
              onChange={(value) => {
                form.setFieldsValue({ baseUrl: getProviderDefaultUrl(value) });
              }}
            />
          </Form.Item>
          <Form.Item name="baseUrl" label={t('provider.endpointUrl')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="apiKey" label={t('provider.apiKey')} rules={[{ required: true }]}>
            <Input.Password placeholder={t('provider.apiKeyPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ProviderSettings;

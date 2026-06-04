import React, { useState } from 'react';
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
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
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

const LLM_TASK_MODELS = [
  { key: 'planning', labelKey: 'provider.task.planning' },
  { key: 'generation', labelKey: 'provider.task.generation' },
  { key: 'review', labelKey: 'provider.task.review' },
  { key: 'extraction', labelKey: 'provider.task.extraction' },
  { key: 'translation', labelKey: 'provider.task.translation' },
];

const ProviderSettings: React.FC = () => {
  const { t } = useTranslation();
  const store = useProviderStore();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addCategory, setAddCategory] = useState<'llm' | 'image' | 'video'>('llm');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  const healthStatus = useProviderStore((s) => s.healthStatus);

  const handleAddEndpoint = (category: 'llm' | 'image' | 'video') => {
    setAddCategory(category);
    const defaults: Record<string, string> = {
      llm: 'https://api.openai.com/v1',
      image: 'https://api.openai.com/v1',
      video: 'https://api.klingai.com',
    };
    form.setFieldsValue({
      provider: category === 'llm' ? 'openai' : category === 'image' ? 'dalle' : 'kling',
      baseUrl: defaults[category],
      enabled: true,
    });
    setAddModalOpen(true);
  };

  const handleSaveEndpoint = async () => {
    try {
      const values = await form.validateFields();
      store.addEndpoint(values);
      setAddModalOpen(false);
      form.resetFields();
      message.success(t('common.saved'));
    } catch {
      // Validation failed
    }
  };

  const handleTestConnection = async (endpointId: string) => {
    setTestingId(endpointId);
    try {
      const health = await store.checkHealth(endpointId);
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
  };

  const endpointColumns = [
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
      width: 140,
      render: (provider: string) => <Tag>{t(`provider.provider.${provider}` as const)}</Tag>,
    },
    {
      title: t('provider.endpointUrl'),
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      ellipsis: true,
      render: (url: string) => (
        <Typography.Text copyable={{ text: url }} style={{ fontSize: 12 }}>
          {url}
        </Typography.Text>
      ),
    },
    {
      title: t('common.status' as const),
      key: 'status',
      width: 100,
      render: (_: unknown, record: ApiEndpoint) => {
        const health = healthStatus.get(record.id);
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
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => store.removeEndpoint(record.id)} />
        </Space>
      ),
    },
  ];

  const endpoints = store.endpoints;

  const renderProviderSelector = (
    category: 'llm' | 'image' | 'video',
    options: { value: string; label: string }[],
  ) => {
    const config = store.config[category];
    const setProvider = category === 'llm' ? store.setLLMProvider : category === 'image' ? store.setImageProvider : store.setVideoProvider;
    const setFallback = category === 'llm' ? store.setLLMFallback : category === 'image' ? store.setImageFallback : store.setVideoFallback;
    const categoryEndpoints = endpoints.filter((e) => {
      if (category === 'llm') return !['dalle', 'stable-diffusion', 'flux', 'comfyui', 'kling-image', 'sora', 'runway', 'kling', 'vidu', 'pika'].includes(e.provider);
      if (category === 'image') return ['dalle', 'stable-diffusion', 'flux', 'comfyui', 'kling-image', 'custom'].includes(e.provider);
      return ['sora', 'runway', 'kling', 'vidu', 'pika', 'custom'].includes(e.provider);
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.primary')}</div>
            <Select
              style={{ width: '100%' }}
              value={config.primary}
              onChange={(v) => setProvider(v as never, undefined, config.endpointId)}
              options={options}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.fallback')}</div>
            <Select
              style={{ width: '100%' }}
              value={config.fallback}
              onChange={(v) => setFallback(v as never, config.fallbackEndpointId)}
              options={[{ value: '', label: '— None —' }, ...options]}
              allowClear
            />
          </div>
        </div>

        {/* Endpoint selector */}
        {categoryEndpoints.length > 0 && (
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('provider.endpoint')}</div>
            <Select
              style={{ width: '100%' }}
              value={config.endpointId}
              onChange={(v) => setProvider(config.primary as never, undefined, v)}
              options={categoryEndpoints.map((e) => ({ value: e.id, label: `${e.name} (${e.baseUrl})` }))}
              placeholder="Select endpoint"
              allowClear
            />
          </div>
        )}

        {/* Task-specific model overrides */}
        {category === 'llm' && (
          <>
            <Divider style={{ margin: '4px 0' }}>{t('provider.taskModel')}</Divider>
            {LLM_TASK_MODELS.map((task) => (
              <div key={task.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 120, fontSize: 13 }}>{t(task.labelKey)}</span>
                <Input
                  style={{ flex: 1 }}
                  value={(store.config.llm.models as Record<string, string>)[task.key] ?? ''}
                  onChange={(e) => store.setLLMModel(task.key, e.target.value)}
                  placeholder={store.config.llm.defaultModel}
                  size="small"
                />
              </div>
            ))}
          </>
        )}

        <Button icon={<PlusOutlined />} onClick={() => handleAddEndpoint(category)}>
          {t('provider.addEndpoint')}
        </Button>
      </div>
    );
  };

  return (
    <div style={{ padding: '0 8px' }}>
      <Tabs
        items={[
          {
            key: 'llm',
            label: (
              <span><ThunderboltOutlined /> {t('provider.llm')}</span>
            ),
            children: (
              <Card size="small" style={{ marginBottom: 16 }}>
                {renderProviderSelector('llm', LLM_PROVIDER_OPTIONS)}
              </Card>
            ),
          },
          {
            key: 'image',
            label: (
              <span><ApiOutlined /> {t('provider.image')}</span>
            ),
            children: (
              <Card size="small" style={{ marginBottom: 16 }}>
                {renderProviderSelector('image', IMAGE_PROVIDER_OPTIONS)}
              </Card>
            ),
          },
          {
            key: 'video',
            label: (
              <span><ApiOutlined /> {t('provider.video')}</span>
            ),
            children: (
              <Card size="small" style={{ marginBottom: 16 }}>
                {renderProviderSelector('video', VIDEO_PROVIDER_OPTIONS)}
              </Card>
            ),
          },
          {
            key: 'endpoints',
            label: t('provider.endpoint'),
            children: (
              <Table
                dataSource={endpoints}
                columns={endpointColumns}
                rowKey="id"
                size="small"
                pagination={false}
                locale={{ emptyText: t('common.noData' as const) }}
              />
            ),
          },
        ]}
      />

      <Modal
        title={t('provider.addEndpoint')}
        open={addModalOpen}
        onOk={handleSaveEndpoint}
        onCancel={() => { setAddModalOpen(false); form.resetFields(); }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('provider.endpointName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label={t('provider.primary')} rules={[{ required: true }]}>
            <Select
              options={
                (addCategory === 'llm' ? LLM_PROVIDER_OPTIONS
                : addCategory === 'image' ? IMAGE_PROVIDER_OPTIONS
                : VIDEO_PROVIDER_OPTIONS) as { value: string; label: string }[]
              }
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

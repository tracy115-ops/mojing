import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Switch, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useProviderStore } from '@/stores/providerStore';
import { useTranslation } from '@/i18n';

export default function MusicEndpointSettings() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [form] = Form.useForm();
  const configure = () => {
    const endpoints = useProviderStore.getState().endpoints.filter(endpoint => endpoint.provider === 'suno-music');
    const endpoint = endpoints.find(endpoint => endpoint.enabled) ?? endpoints[0];
    setEditingId(endpoint?.id);
    form.setFieldsValue({ name: endpoint?.name || 'Suno', baseUrl: endpoint?.baseUrl || '', apiKey: endpoint?.apiKey || '', enabled: endpoint?.enabled ?? true });
    setOpen(true);
  };
  const save = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const endpoint = { ...values, name: values.name.trim(), baseUrl: values.baseUrl.trim().replace(/\/+$/, ''), apiKey: values.apiKey.trim(), provider: 'suno-music' as const };
    const store = useProviderStore.getState();
    if (editingId) store.updateEndpoint(editingId, endpoint);
    else store.addEndpoint(endpoint);
    setOpen(false);
    message.success(t('music.endpointSaved'));
  };
  return <>
    <Button icon={<SettingOutlined />} data-testid="music-endpoint-open" onClick={configure}>{t('music.endpoint')}</Button>
    <Modal title={t('music.endpoint')} open={open} onCancel={() => setOpen(false)} onOk={() => void save()} okText={t('common.save')} destroyOnClose className="music-endpoint-modal">
      <Alert type="info" showIcon message={t('music.endpointContract')} style={{ marginBottom: 16 }} />
      <Form form={form} layout="vertical" initialValues={{ apiKey: '', enabled: true }}>
        <Form.Item name="name" label={t('music.endpointName')} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
        <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { validator: async (_, value) => {
          try { const url = new URL(value.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
          catch { throw new Error(t('music.invalidEndpoint')); }
        } }]}><Input placeholder="https://your-provider.example/v1" /></Form.Item>
        <Form.Item name="apiKey" label="API Key"><Input.Password autoComplete="off" /></Form.Item>
        <Form.Item name="enabled" label={t('music.endpointEnabled')} valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  </>;
}

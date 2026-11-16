import { useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Typography, message } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { directCanvas, directWorld } from '@/services/video-studio/director';
import type { StudioCanvas, WorldDocument } from '@/types/video-studio';

export default function StudioDirector({ document, kind, disabled, onApply }: {
  document: StudioCanvas | WorldDocument; kind: 'canvas' | 'world'; disabled?: boolean;
  onApply: (proposal: StudioCanvas | WorldDocument) => void;
}) {
  const { t } = useTranslation();
  const providers = useProviderStore();
  const [open, setOpen] = useState(false), [brief, setBrief] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [endpointId, setEndpointId] = useState<string>(), [model, setModel] = useState<string>();
  const [proposal, setProposal] = useState<{ document: StudioCanvas | WorldDocument; baseRevision: string }>();
  const endpoint = providers.getEndpointsByCategory('llm').find((item) => item.id === endpointId) ?? providers.getActiveEndpoint('llm');
  const plan = async () => {
    if (!endpoint) return;
    setLoading(true); setError(''); setProposal(undefined);
    try {
      const state = useVideoStudioStore.getState();
      const result = kind === 'world' ? await directWorld(document as WorldDocument, brief, state.assets, endpoint.id, model)
        : await directCanvas(document as StudioCanvas, brief, state.assets, state.worlds, endpoint.id, model);
      setProposal({ document: result, baseRevision: document.updatedAt });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  const apply = () => {
    if (!proposal) return;
    if (proposal.baseRevision !== document.updatedAt) { message.warning(t('studio.director.stale')); return; }
    onApply(proposal.document); setOpen(false); setProposal(undefined);
  };
  return <><Button icon={<RobotOutlined />} disabled={disabled} onClick={() => setOpen(true)}>{t('studio.director.title')}</Button><Modal open={open} title={t('studio.director.title')} onCancel={() => { if (!loading) setOpen(false); }} footer={null} width={860} maskClosable={!loading} closable={!loading} destroyOnClose><Space direction="vertical" style={{ width: '100%' }}>
    <Typography.Paragraph type="secondary">{t('studio.director.hint')}</Typography.Paragraph>
    <Space wrap><Select aria-label={t('studio.creator.endpoint')} style={{ minWidth: 200 }} value={endpoint?.id} onChange={(id) => { setEndpointId(id); setModel(undefined); }} options={providers.getEndpointsByCategory('llm').map((item) => ({ value: item.id, label: item.name }))} /><Select aria-label={t('studio.creator.models')} style={{ minWidth: 180 }} value={model ?? endpoint?.models?.[0]} onChange={setModel} options={endpoint?.models?.map((value) => ({ value, label: value })) ?? []} /></Space>
    {!endpoint && <Alert type="info" message={t('studio.creator.noEndpoint')} />}
    <Input.TextArea aria-label={t('studio.director.brief')} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder={t(kind === 'world' ? 'studio.director.worldBrief' : 'studio.director.canvasBrief')} rows={4} disabled={loading} />
    <Button type="primary" loading={loading} disabled={!endpoint || !brief.trim()} onClick={() => void plan()}>{t('studio.director.plan')}</Button>
    {error && <Alert type="error" showIcon message={t('studio.failed')} description={error} />}
    {proposal && <><Typography.Title level={5}>{t('studio.director.proposal')}</Typography.Title><pre className="video-studio-text-preview">{JSON.stringify(proposal.document, null, 2)}</pre><Button type="primary" onClick={apply}>{t('studio.director.apply')}</Button></>}
  </Space></Modal></>;
}

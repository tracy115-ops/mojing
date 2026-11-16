import { useState } from 'react';
import { Button, Input, Modal, Select, Space, Typography, message } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { probeStudioMedia, publicStudioAsset } from '@/services/video-studio/media';
import { studioId, studioNow } from '@/services/video-studio/document';
import type { StudioAsset } from '@/types/video-studio';

export default function StudioLinkImport({ kind, onImport }: { kind?: 'image' | 'audio' | 'video'; onImport?: (asset: StudioAsset) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [url, setUrl] = useState(''), [name, setName] = useState(''), [type, setType] = useState(kind ?? 'video'), [busy, setBusy] = useState(false);
  const importLink = async () => {
    setBusy(true);
    try {
      const base = publicStudioAsset(url, kind ?? type, name);
      const asset: StudioAsset = { ...base, id: studioId(), category: 'reference', createdAt: studioNow(), ...await probeStudioMedia(base.url!, base.kind) };
      useVideoStudioStore.getState().addAsset(asset); onImport?.(asset); setOpen(false); setUrl(''); setName('');
    } catch (error) { message.error(String(error)); } finally { setBusy(false); }
  };
  return <><Button size="small" icon={<LinkOutlined />} onClick={() => setOpen(true)}>{t('studio.media.importLink')}</Button><Modal className="studio-link-import" open={open} title={t('studio.media.importLink')} onCancel={() => !busy && setOpen(false)} onOk={() => void importLink()} confirmLoading={busy} okButtonProps={{ disabled: !url.trim() }} destroyOnClose><Space direction="vertical" className="studio-media-form">
    <Typography.Text type="secondary">{t('studio.media.publicHint')}</Typography.Text>
    {!kind && <Select aria-label={t('studio.media.kind')} value={type} onChange={setType} options={(['video', 'audio', 'image'] as const).map((value) => ({ value, label: t(`studio.kind.${value}`) }))} />}
    <Input aria-label={t('studio.media.url')} placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} />
    <Input aria-label={t('studio.rename')} placeholder={t('studio.rename')} value={name} onChange={(event) => setName(event.target.value)} />
  </Space></Modal></>;
}

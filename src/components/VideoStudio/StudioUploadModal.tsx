import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Select, Space, Spin, Tag, Typography, Upload, message } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useStudioUploadStore } from '@/stores/studioUploadStore';
import { importStudioFile } from '@/services/video-studio/generation';
import { cancelStudioMediaUpload, retryStudioMediaUpload, startStudioMediaUpload } from '@/services/video-studio/media-upload';
import { modelReadableMediaUrl, sniffUploadMedia } from '@/services/video-studio/upload-contract';
import type { StudioAsset } from '@/types/video-studio';
import StudioUploadSettings from './StudioUploadSettings';
import StudioVideoTranscode from './StudioVideoTranscode';

export default function StudioUploadModal({ assetId, kind, onClose, onUploaded }: { assetId?: string; kind: 'image' | 'audio' | 'video'; onClose: () => void; onUploaded?: (asset: StudioAsset) => void }) {
  const { t } = useTranslation(), store = useVideoStudioStore(), settings = useStudioUploadStore();
  const [selectedId, setSelectedId] = useState(assetId), [waiting, setWaiting] = useState<string>();
  const asset = store.assets.find(item => item.id === selectedId), task = [...store.uploadTasks].reverse().find(item => item.assetId === selectedId);
  const busy = task?.status === 'uploading', configured = !!settings.config.endpoint && !!settings.config.bucket && !!settings.credentials.secretAccessKey;
  useEffect(() => {
    if (waiting && task?.id === waiting && task.status === 'completed' && asset) { setWaiting(undefined); onUploaded?.(asset); message.success(t('studio.upload.done')); onClose(); }
  }, [waiting, task?.status, asset]);
  const begin = (newCopy = false) => {
    try { if (task && !newCopy) { retryStudioMediaUpload(task.id); setWaiting(task.id); } else if (asset) setWaiting(startStudioMediaUpload(asset.id)); }
    catch (error) { message.error(t(`studio.upload.error.${error instanceof Error ? error.message : 'network'}`)); }
  };
  const importFile = async (file: File) => {
    try {
      const header = new Uint8Array(await file.slice(0,32).arrayBuffer());
      const webm = kind === 'video' && [26,69,223,163].every((value,index) => header[index] === value);
      const mimeType = webm ? 'video/webm' : sniffUploadMedia(header, kind).mimeType;
      const saved = await importStudioFile(new File([file], file.name, { type: mimeType }));
      setSelectedId(saved.id);
    } catch { message.error(t('studio.upload.error.format')); }
  };
  return <Modal open width={760} className="studio-upload-modal" title={t('studio.upload.title')} onCancel={onClose} footer={null} destroyOnClose><Space direction="vertical" className="studio-upload-form">
    <Alert type="info" message={t('studio.upload.hint')} />
    <Select aria-label={t('studio.upload.source')} disabled={busy} value={selectedId} onChange={setSelectedId} placeholder={t('studio.upload.source')} options={store.assets.filter(item => item.kind === kind).map(item => ({ value: item.id, label: item.name }))} />
    {!assetId && <Upload accept={kind === 'image' ? 'image/png,image/jpeg,image/webp' : kind === 'audio' ? 'audio/mpeg,audio/wav' : 'video/mp4,video/quicktime,video/webm'} showUploadList={false} disabled={busy} beforeUpload={file => { void importFile(file); return false; }}><Button disabled={busy}>{t('studio.asset.upload')}</Button></Upload>}
    {asset?.kind === 'video' && <Space wrap><Typography.Text type="secondary">{t('studio.upload.transcodeHint')}</Typography.Text><StudioVideoTranscode asset={asset} onSaved={item => setSelectedId(item.id)} /></Space>}
    <details open={!configured}><summary>{t('studio.upload.settings')}</summary><StudioUploadSettings /></details>
    {configured && <Typography.Text type="secondary">{t('studio.upload.destination')}: {settings.config.bucket} · {settings.config.region}</Typography.Text>}
    {asset?.cloudUpload && <Tag color={modelReadableMediaUrl(asset, '') ? 'success' : 'warning'}>{t(modelReadableMediaUrl(asset, '') ? 'studio.upload.available' : 'studio.upload.expired')} · {new Date(asset.cloudUpload.expiresAt).toLocaleString()}</Tag>}
    {task && <div data-testid="studio-upload-state"><Tag>{t(`studio.upload.status.${task.status}`)}</Tag>{busy && <><Spin size="small" /><span>{t(`studio.upload.stage.${task.stage}`)}</span></>}{task.error && <Alert type="error" message={t(`studio.upload.error.${task.error}`)} />}</div>}
    <Space wrap><Button type="primary" icon={<CloudUploadOutlined />} disabled={!asset || !configured || busy} loading={busy} data-testid="studio-start-upload" onClick={() => begin()}>{t(task?.status === 'completed' ? 'studio.upload.renew' : task ? 'studio.upload.retry' : 'studio.upload.start')}</Button>{task && !busy && <Button disabled={!asset || !configured} data-testid="studio-new-upload" onClick={() => begin(true)}>{t('studio.upload.newCopy')}</Button>}{busy && <Button onClick={() => cancelStudioMediaUpload(task.id)}>{t('studio.cancel')}</Button>}<Button onClick={onClose}>{t('studio.close')}</Button></Space>
  </Space></Modal>;
}

export function StudioReferenceUpload({ kind, onUploaded }: { kind: 'audio' | 'video'; onUploaded: (asset: StudioAsset) => void }) {
  const { t } = useTranslation(), [open,setOpen] = useState(false);
  return <><Button size="small" icon={<CloudUploadOutlined />} onClick={() => setOpen(true)}>{t('studio.upload.localReference')}</Button>{open && <StudioUploadModal kind={kind} onUploaded={onUploaded} onClose={() => setOpen(false)} />}</>;
}

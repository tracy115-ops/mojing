import { useState } from 'react';
import { Alert, Button, Modal, Select, Space, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { downloadClip, exportVideo, probeFFmpeg, writeDataUri } from '@/services/video/ffmpeg-bridge';
import { getAssetDirectory, isRemoteUrl, resolveLocalPath, toWebviewUrl } from '@/services/video/asset-store';
import { probeStudioMedia } from '@/services/video-studio/media';
import { studioId, studioNow } from '@/services/video-studio/document';
import type { StudioAsset } from '@/types/video-studio';

export default function StudioVideoTranscode({ asset, onSaved }: { asset: StudioAsset; onSaved?: (asset: StudioAsset) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [height, setHeight] = useState(0);
  const desktop = '__TAURI_INTERNALS__' in window;
  const transcode = async () => {
    if (!asset.url || !desktop) return;
    setBusy(true);
    try {
      if (!(await probeFFmpeg()).available) throw new Error(t('studio.transcode.ffmpegRequired'));
      const directory = await getAssetDirectory('studio-library', 'clip'), id = studioId();
      let source = resolveLocalPath(asset.url);
      if (source.startsWith('data:')) source = (await writeDataUri({ dataUri: source, outputPath: `${directory}/${id}-source.video` })).savedPath;
      else if (isRemoteUrl(source)) source = (await downloadClip(source, directory, `${id}-source.video`)).savedPath;
      const result = await exportVideo({ sourcePath: source, outputPath: `${directory}/${id}.mp4`, targetHeight: height, compatibleMp4: true });
      const metadata = await probeStudioMedia(toWebviewUrl(result.outputPath), 'video');
      if (!metadata.width || !metadata.height) throw new Error(t('studio.transcode.decodeFailed'));
      const saved: StudioAsset = { id, name: `${asset.name.replace(/\.[^.]+$/, '')} · MP4`, kind: 'video', category: asset.category, folderId: asset.folderId, tags: asset.tags, url: result.outputPath, storage: 'disk', mimeType: 'video/mp4', createdAt: studioNow(), ...metadata, sizeBytes: result.sizeBytes, durationSeconds: result.durationSeconds ?? metadata.durationSeconds };
      useVideoStudioStore.getState().addAsset(saved); onSaved?.(saved);
      message.success(t('studio.transcode.done')); setOpen(false);
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); } finally { setBusy(false); }
  };
  return <><Button size="small" onClick={() => setOpen(true)}>{t('studio.transcode.title')}</Button><Modal className="studio-transcode-modal" title={t('studio.transcode.title')} open={open} onCancel={() => !busy && setOpen(false)} onOk={() => void transcode()} confirmLoading={busy} okButtonProps={{ disabled: !desktop || !asset.url }} destroyOnClose><Space direction="vertical" className="studio-media-form"><Alert type="info" message={t('studio.transcode.hint')} />{!desktop && <Alert type="warning" message={t('studio.transcode.desktop')} />}<Select aria-label={t('studio.transcode.size')} value={height} onChange={setHeight} options={[{ value: 0, label: t('studio.transcode.original') }, { value: 720, label: t('studio.transcode.cap720') }, { value: 1080, label: t('studio.transcode.cap1080') }]} /></Space></Modal></>;
}

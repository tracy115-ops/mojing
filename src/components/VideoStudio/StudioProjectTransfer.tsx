import { useState } from 'react';
import { Alert, Button, Modal, Select, Space, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { readAsDataUri, saveAsset } from '@/services/video/asset-store';
import { studioId, studioNow } from '@/services/video-studio/document';
import type { StudioAsset } from '@/types/video-studio';
import type { GeneratedClip, ImportedVideoReceipt, ShotVersion } from '@/types/video';
import { inspectStudioVideo } from '@/services/video-studio/inspect-video';
import { fingerprintImportedVideo, fingerprintImportedVideoContext, fingerprintShotInputs } from '@/services/video/core/shot-generation-receipt';
import { evaluateVideoClipQuality } from '@/services/video/core/video-quality-gate';
import { evaluateVideoClipVisually } from '@/services/video/core/visual-quality-review';

export default function StudioProjectTransfer({ asset }: { asset: StudioAsset }) {
  const { t } = useTranslation(), projects = useVideoStore((state) => state.projects);
  const [open, setOpen] = useState(false), [projectId, setProjectId] = useState<string>(), [shotId, setShotId] = useState<string>(), [purpose, setPurpose] = useState('reference'), [busy, setBusy] = useState(false);
  if (!['image', 'video'].includes(asset.kind) || !asset.url) return null;
  const transfer = async () => {
    if (!projectId || !shotId) return;
    setBusy(true);
    try {
      const uri = await readAsDataUri(asset.url!);
      if (!uri.startsWith('data:')) throw new Error(t('studio.transfer.downloadRequired'));
      const project = useVideoStore.getState().projects[projectId];
      const shot = project?.sceneSpec?.shots.find((item) => item.id === shotId);
      if (!shot) throw new Error(t('studio.canvas.missingInput'));
      const shotInputFingerprint = fingerprintShotInputs(shot, 'video');
      const inspected = purpose === 'adopt' ? await inspectStudioVideo(uri) : undefined;
      const url = await saveAsset(projectId, asset.kind === 'video' ? 'clip' : 'keyframe', uri);
      const store = useVideoStore.getState();
      if (!store.projects[projectId]?.sceneSpec?.shots.some((shot) => shot.id === shotId)) throw new Error(t('studio.canvas.missingInput'));
      if (purpose === 'reference' && asset.kind === 'image') store.updateSceneSpecShot(projectId, shotId, { manualReferenceImage: url });
      else if (purpose === 'adopt' && inspected) {
        const importedVideo: ImportedVideoReceipt = { kind: 'imported_video', sourceAssetId: asset.id, sourceUrl: url, sha256: inspected.sha256, width: inspected.width, height: inspected.height, durationSeconds: inspected.durationSeconds, inspectedAt: studioNow(), shotInputFingerprint, visualContextFingerprint: fingerprintImportedVideoContext(project.sceneSpec), audio: 'preserve' };
        const id = studioId(), createdAt = studioNow();
        const clip: GeneratedClip = { shotId, shotVersionId: id, videoUrl: url, provider: 'custom', model: 'imported-video', durationSeconds: inspected.durationSeconds, hasAudio: true, generatedAt: createdAt, importedVideo, inputFingerprint: fingerprintImportedVideo(importedVideo), thumbnailUrl: inspected.frames[0], lastFrameImage: inspected.frames[2] };
        clip.qualityReview = evaluateVideoClipQuality(shot, clip, { assetAvailable: true, requireI2V: false, expectedAspectRatio: project.spec.aspectRatio });
        if (project.options?.enableVisualQualityGate !== false) clip.visualReview = await evaluateVideoClipVisually(shot, clip, { projectId, characters: project.sceneSpec?.characters, scenes: project.sceneSpec?.scenes, outputFrames: inspected.frames });
        const version: ShotVersion = { id, type: 'video', url, createdAt, sourceStudioAssetId: asset.id, importedVideo, inputFingerprint: clip.inputFingerprint, provider: 'custom', model: 'imported-video', durationSeconds: clip.durationSeconds, thumbnailUrl: clip.thumbnailUrl, lastFrameImage: clip.lastFrameImage, hasAudio: true, qualityReview: clip.qualityReview, visualReview: clip.visualReview, reviewStatus: 'unreviewed' };
        if (!store.adoptImportedVideo(projectId, shotId, version)) throw new Error(t('studio.transfer.stale'));
      } else {
        const job = useVideoStudioStore.getState().jobs.find((job) => job.id === asset.jobId);
        store.addShotVersion(projectId, shotId, { id: studioId(), type: asset.kind as 'image' | 'video', url, createdAt: studioNow(), sourceStudioAssetId: asset.id, prompt: job?.input.prompt, model: asset.model, durationSeconds: asset.durationSeconds, requestSnapshot: asset.requestSnapshot, responseSnapshot: asset.responseSnapshot, reviewStatus: 'unreviewed' }, { select: false });
      }
      message.success(t('studio.transfer.done')); setOpen(false);
    } catch (error) { message.error(String(error)); } finally { setBusy(false); }
  };
  return <><Button size="small" onClick={() => { setPurpose(asset.kind === 'image' ? 'reference' : 'candidate'); setOpen(true); }}>{t('studio.transfer.title')}</Button><Modal className="studio-project-transfer" title={t('studio.transfer.title')} open={open} onCancel={() => !busy && setOpen(false)} onOk={() => void transfer()} confirmLoading={busy} okButtonProps={{ disabled: !projectId || !shotId }} destroyOnClose><Space direction="vertical" className="studio-media-form">
    <Alert type="info" message={t('studio.transfer.hint')} />
    {purpose === 'adopt' && <Alert type="warning" message={t('studio.transfer.adoptHint')} />}
    <Select aria-label={t('studio.world.project')} placeholder={t('studio.world.project')} value={projectId} onChange={(id) => { setProjectId(id); setShotId(undefined); }} options={Object.values(projects).filter((project) => project.sceneSpec?.shots.length).map((project) => ({ value: project.novelProjectId, label: project.title || project.novelProjectId }))} />
    <Select aria-label={t('studio.world.selectShot')} placeholder={t('studio.world.selectShot')} value={shotId} onChange={setShotId} options={(projectId ? projects[projectId]?.sceneSpec?.shots ?? [] : []).map((shot) => ({ value: shot.id, label: `#${shot.index + 1} ${(shot.sourceText || shot.videoPrompt).slice(0, 50)}` }))} />
    <Select aria-label={t('studio.transfer.purpose')} value={purpose} onChange={setPurpose} options={[...(asset.kind === 'image' ? [{ value: 'reference', label: t('studio.transfer.reference') }] : [{ value: 'adopt', label: t('studio.transfer.adopt') }]), { value: 'candidate', label: t('studio.transfer.candidate') }]} />
  </Space></Modal></>;
}

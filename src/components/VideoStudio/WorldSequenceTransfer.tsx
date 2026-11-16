import { useEffect, useState } from 'react';
import { Alert, Modal, Select, Spin, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { studioId, studioNow } from '@/services/video-studio/document';
import { retainStudioMedia } from '@/services/video-studio/generation';
import { worldSequenceSpans } from '@/services/video-studio/world-sequence';
import type { StudioAsset, WorldDocument } from '@/types/video-studio';
import type { SceneSpec } from '@/types/video';

export default function WorldSequenceTransfer({ world, capture, onClose }: {
  world: WorldDocument; capture: (time: number) => string; onClose: () => void;
}) {
  const { t } = useTranslation(), projects = useVideoStore((state) => state.projects);
  const [snapshot] = useState(() => structuredClone(world));
  const [previews, setPreviews] = useState<string[]>([]), [error, setError] = useState(''), [preparing, setPreparing] = useState(true), [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<string>(), [expected, setExpected] = useState<SceneSpec>(), [targets, setTargets] = useState<string[]>([]);
  const spans = worldSequenceSpans(snapshot);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const frames: string[] = [];
        for (const span of worldSequenceSpans(snapshot)) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (cancelled) return;
          frames.push(capture((span.start + span.end) / 2));
        }
        if (!cancelled) setPreviews(frames);
      } catch (reason) { if (!cancelled) setError(String(reason)); }
      finally { if (!cancelled) setPreparing(false); }
    })();
    return () => { cancelled = true; };
    // Capture uses the opening world snapshot; changing it requires reopening the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  const selectProject = (id: string) => {
    const spec = projects[id]?.sceneSpec;
    setProjectId(id); setExpected(spec && structuredClone(spec));
    setTargets(spans.map((_, index) => spec?.shots[index]?.id ?? ''));
  };
  const valid = !!projectId && !!expected && !error && previews.length === spans.length && targets.length === spans.length && targets.every((id) => expected.shots.some((shot) => shot.id === id)) && new Set(targets).size === spans.length;
  const apply = async () => {
    if (!valid || !projectId || !expected) return;
    setBusy(true);
    try {
      const currentWorld = () => useVideoStudioStore.getState().worlds.find((item) => item.id === snapshot.id);
      if (JSON.stringify(currentWorld()) !== JSON.stringify(snapshot)) throw new Error(t('studio.world.sequence.stale'));
      const assets: StudioAsset[] = [];
      for (const [index, span] of spans.entries()) assets.push({ id: studioId(), name: `${snapshot.name} · ${span.shot.name} · ${((span.start + span.end) / 2).toFixed(2)}s`, kind: 'image', category: 'reference', createdAt: studioNow(), worldId: snapshot.id, url: await retainStudioMedia(previews[index], 'image') });
      if (JSON.stringify(currentWorld()) !== JSON.stringify(snapshot) || !useVideoStore.getState().applyWorldSequenceReferences(projectId, expected, snapshot.id, assets.map((asset, index) => ({ shotId: targets[index], url: asset.url! })))) throw new Error(t('studio.world.sequence.stale'));
      useVideoStudioStore.setState((state) => ({ assets: [...state.assets, ...assets] }));
      message.success(t('studio.world.sequence.done', { count: assets.length })); onClose();
    } catch (reason) { message.error(String(reason)); }
    finally { setBusy(false); }
  };
  return <Modal className="world-sequence-transfer" title={t('studio.world.sequence.transfer')} open width={760} onCancel={() => !busy && onClose()} onOk={() => void apply()} okText={t('studio.world.sequence.apply')} confirmLoading={busy} okButtonProps={{ disabled: !valid || preparing }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <div className="world-sequence-transfer-content">
      <Alert showIcon type="warning" message={t('studio.world.sequence.transferHint')} />
      <Select aria-label={t('studio.world.project')} placeholder={t('studio.world.project')} value={projectId} disabled={busy} onChange={selectProject} options={Object.entries(projects).filter(([, project]) => project.sceneSpec?.shots.length).map(([id, project]) => ({ value: id, label: project.title || id, disabled: Object.values(project.stages).some((stage) => stage.status === 'running') }))} />
      {error && <Alert type="error" message={error} />}
      {preparing && <Spin tip={t('studio.world.sequence.capturing')}><div style={{ minHeight: 90 }} /></Spin>}
      <div className="world-sequence-transfer-list">{spans.map((span, index) => <div className="world-sequence-transfer-row" key={span.shot.id}>
        {previews[index] ? <img src={previews[index]} alt={span.shot.name} /> : <div />}
        <div><strong>{index + 1}. {span.shot.name}</strong><span>{Number(span.start.toFixed(2))}–{Number(span.end.toFixed(2))}s</span><Select aria-label={`${t('studio.world.sequence.target')} ${index + 1}`} placeholder={t('studio.world.sequence.target')} value={targets[index] || undefined} disabled={!expected || busy} onChange={(value) => setTargets((items) => spans.map((_, i) => i === index ? value : items[i] ?? ''))} options={(expected?.shots ?? []).map((shot) => ({ value: shot.id, label: `#${shot.index + 1} ${(shot.sourceText || shot.videoPrompt || '').slice(0, 55)}`, disabled: targets.some((id, i) => i !== index && id === shot.id) }))} /></div>
      </div>)}</div>
      <span className="video-studio-muted">{t('studio.world.sequence.noTargets')}</span>
    </div>
  </Modal>;
}

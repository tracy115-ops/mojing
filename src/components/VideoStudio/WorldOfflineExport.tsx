import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Progress, Select, Space, Spin, Typography, message } from 'antd';
import { VideoCameraOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { studioNow } from '@/services/video-studio/document';
import { probeFFmpeg } from '@/services/video/ffmpeg-bridge';
import { beginWorldRender, cancelWorldRender, finishWorldRender, writeWorldRenderFrame } from '@/services/video-studio/world-offline-bridge';
import { worldFramePlan } from '@/services/video-studio/world-offline-plan';
import type { WorldDocument } from '@/types/video-studio';
import type { WorldRenderMode, WorldViewport } from '@/services/video-studio/world-renderer';
import './WorldOfflineExport.css';

type Stage = 'idle' | 'preparing' | 'rendering' | 'encoding' | 'failed-render' | 'failed-encode' | 'completed' | 'cancelled';
export default function WorldOfflineExport({ world, mode, disabled, viewport, onOpenChange }: {
  world: WorldDocument; mode: WorldRenderMode; disabled: boolean; viewport: () => WorldViewport | null; onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(), desktop = '__TAURI_INTERNALS__' in window;
  const [snapshot, setSnapshot] = useState<{ world: WorldDocument; mode: WorldRenderMode }>();
  const [longEdge, setLongEdge] = useState(1280), [fps, setFps] = useState(24), [stage, setStage] = useState<Stage>('idle');
  const [completed, setCompleted] = useState(0), [error, setError] = useState(''), [cancelling, setCancelling] = useState(false);
  const job = useRef<string | undefined>(undefined), controller = useRef<AbortController | null>(null), alive = useRef(true);
  const plan = useMemo(() => worldFramePlan(snapshot?.world ?? world, longEdge, fps), [snapshot, world, longEdge, fps]);
  const running = stage === 'preparing' || stage === 'rendering' || stage === 'encoding';
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); if (job.current) void cancelWorldRender(job.current).catch(() => undefined); }; }, []);
  const discard = async () => { if (job.current) { await cancelWorldRender(job.current); job.current = undefined; } };
  const encode = async (id: string) => {
    const result = await finishWorldRender(id);
    // A completed native commit wins a late cancel, and its durable result is retained.
    useVideoStudioStore.getState().addAsset({ id: `offline-${id}`, name: `${snapshot!.world.name} · ${t('studio.world.offline.title')} · ${fps}fps`, kind: 'video', category: 'reference', createdAt: studioNow(), url: result.outputPath, storage: 'disk', mimeType: 'video/mp4', worldId: snapshot!.world.id, width: result.width, height: result.height, durationSeconds: result.durationSeconds, sizeBytes: result.sizeBytes });
    job.current = undefined;
    if (alive.current) { setStage('completed'); message.success(t('studio.world.offline.done')); }
  };
  const start = async (encodeOnly = false) => {
    if (!snapshot || !desktop) return;
    const abort = new AbortController(); controller.current = abort;
    let framesReady = encodeOnly;
    setError(''); setCancelling(false); setStage(encodeOnly ? 'encoding' : 'preparing');
    try {
      if (!encodeOnly) {
        setCompleted(0);
        if (!(await probeFFmpeg()).available) throw new Error(t('studio.transcode.ffmpegRequired'));
        abort.signal.throwIfAborted();
        await discard();
        job.current = await beginWorldRender(plan); abort.signal.throwIfAborted();
        const engine = viewport(); if (!engine) throw new Error(t('studio.world.noWebGL'));
        if (alive.current) setStage('rendering');
        await engine.renderFrames(plan, { world: snapshot.world, mode: snapshot.mode, write: (index, png) => writeWorldRenderFrame(job.current!, index, png), signal: abort.signal, onProgress: value => { if (alive.current) setCompleted(value); } });
        framesReady = true; if (alive.current) setStage('encoding');
      }
      abort.signal.throwIfAborted(); await encode(job.current!);
    } catch (reason) {
      if (abort.signal.aborted || !framesReady) { try { await discard(); } catch (cleanupError) { if (alive.current) setError(String(cleanupError)); } }
      if (alive.current) {
        if (abort.signal.aborted) setStage('cancelled');
        else { setStage(framesReady ? 'failed-encode' : 'failed-render'); setError(String(reason)); }
      }
    } finally { if (alive.current) setCancelling(false); controller.current = null; }
  };
  const cancel = async () => {
    setCancelling(true); controller.current?.abort();
    try { if (job.current) await cancelWorldRender(job.current); }
    catch (reason) { if (alive.current) setError(String(reason)); }
  };
  const close = async () => {
    if (running) return;
    try { await discard(); setSnapshot(undefined); onOpenChange(false); }
    catch (reason) { setError(String(reason)); }
  };
  return <><Button icon={<VideoCameraOutlined />} disabled={disabled} data-testid="world-offline-open" onClick={() => { setSnapshot({ world: structuredClone(world), mode }); setFps([15, 24, 25, 30].includes(world.fps) ? world.fps : 24); setStage('idle'); setCompleted(0); setError(''); onOpenChange(true); }}>{t('studio.world.offline.title')}</Button>
    <Modal open={!!snapshot} title={t('studio.world.offline.title')} className="world-offline-modal" width={600} footer={null} onCancel={() => void close()} closable={!running} maskClosable={!running} destroyOnClose>
      <Space direction="vertical" className="world-offline-form">
        <Alert type="info" message={t('studio.world.offline.hint')} />
        {!desktop && <Alert type="warning" message={t('studio.world.offline.desktop')} />}
        <div className="world-offline-settings"><label>{t('studio.world.offline.size')}<Select aria-label={t('studio.world.offline.size')} value={longEdge} disabled={stage !== 'idle'} onChange={setLongEdge} options={[{ value: 1280, label: t('studio.world.offline.hd') }, { value: 1920, label: t('studio.world.offline.fullHd') }]} /></label><label>{t('studio.world.offline.fps')}<Select aria-label={t('studio.world.offline.fps')} value={fps} disabled={stage !== 'idle'} onChange={setFps} options={[15, 24, 25, 30].map(value => ({ value, label: `${value} fps` }))} /></label></div>
        <Typography.Text data-testid="world-offline-plan">{plan.width} × {plan.height} · {plan.frameCount} {t('studio.world.offline.frames')} · {(plan.frameCount / plan.fps).toFixed(3)}s · {t(`studio.world.${snapshot?.mode ?? mode}`)}</Typography.Text>
        <Typography.Text type="secondary">{t('studio.world.offline.output')}</Typography.Text>
        {stage !== 'idle' && <><Progress percent={Math.floor(completed / plan.frameCount * 100)} status={stage.startsWith('failed') ? 'exception' : completed === plan.frameCount ? 'success' : 'normal'} /><div className="world-offline-status" data-testid="world-offline-status">{running && <Spin size="small" />}<span>{t(`studio.world.offline.${stage}`)} · {completed} / {plan.frameCount} {t('studio.world.offline.frames')}</span></div></>}
        {error && <Alert type="error" showIcon message={t('studio.failed')} description={error} />}
        {stage === 'failed-encode' && <Alert type="info" message={t('studio.world.offline.retryHint')} />}
        <Space wrap>{stage === 'idle' && <Button type="primary" disabled={!desktop} data-testid="world-offline-start" onClick={() => void start()}>{t('studio.world.offline.start')}</Button>}{stage === 'failed-render' && <Button data-testid="world-offline-retry" onClick={() => void start()}>{t('studio.world.offline.renderAgain')}</Button>}{stage === 'failed-encode' && <Button data-testid="world-offline-retry" onClick={() => void start(true)}>{t('studio.world.offline.retryEncode')}</Button>}{running ? <Button loading={cancelling} disabled={cancelling} data-testid="world-offline-cancel" onClick={() => void cancel()}>{t('studio.cancel')}</Button> : <Button onClick={() => void close()}>{t('studio.close')}</Button>}</Space>
      </Space>
    </Modal></>;
}

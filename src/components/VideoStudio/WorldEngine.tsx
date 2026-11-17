import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Slider, Space, Switch, Tag, Tooltip, Upload, message } from 'antd';
import { CameraOutlined, DeleteOutlined, DownloadOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined, RedoOutlined, UndoOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useVideoStore } from '@/stores/videoStore';
import { createStudioCanvas, createWorldObject, addWorldPath, parseStudioBundle, studioId, studioNow, upsertCameraKeyframe, upsertWorldKeyframe, worldCameraAt, worldFromTemplate, worldTransformAt } from '@/services/video-studio/document';
import { exportWorldBundle } from '@/services/video-studio/bundle';
import { ACTOR_JOINTS, CAMERA_MOVES, POSE_PRESETS, actorPoseAt, actorPosePreset, cameraWithMove, worldWithDrawnPath } from '@/services/video-studio/world-animation';
import { retimeWorldCamera, withWorldCameraAt, worldCameraContextAt, worldCameraPoseAt, worldPlaybackDuration, worldSequenceSpans } from '@/services/video-studio/world-sequence';
import { downloadStudioFile, fileAsDataUri, importStudioFile, retainStudioMedia } from '@/services/video-studio/generation';
import { WorldViewport, type WorldRenderMode, type WorldViewMode } from '@/services/video-studio/world-renderer';
import { WORLD_TEMPLATES, WORLD_PROP_IDS, createWorldProp, type WorldTemplate, type WorldPropId } from '@/services/video-studio/world-sets';
import { worldMonitorSelection, worldWithMonitorCamera, type WorldMonitorCount } from '@/services/video-studio/world-monitor';
import type { ActorJoint, ActorPose, StudioAsset, Vec3, WorldCamera, WorldDocument, WorldObject, WorldTransform } from '@/types/video-studio';
import StudioDirector from './StudioDirector';
import WorldCameraSequence from './WorldCameraSequence';
import WorldSequenceTransfer from './WorldSequenceTransfer';
import WorldModelAnimation, { WorldModelAnimationTrack } from './WorldModelAnimation';
import WorldCameraMonitor from './WorldCameraMonitor';
import WorldOfflineExport from './WorldOfflineExport';
import './WorldEngine.css';

function VectorField({ label, value, onChange, rotation, scale, disabled }: { label: string; value: Vec3; onChange: (value: Vec3) => void; rotation?: boolean; scale?: boolean; disabled?: boolean }) {
  return <label className="world-engine-vector"><span>{label}</span><div>{(['X', 'Y', 'Z'] as const).map((axis, index) => <InputNumber key={axis} aria-label={`${label} ${axis}`} size="small" prefix={axis} value={Math.round(value[index] * (rotation ? 180 / Math.PI : 1) * 100) / 100} min={scale ? 0.05 : rotation ? -360 : -100} max={scale ? 100 : rotation ? 360 : 100} step={rotation ? 5 : 0.1} disabled={disabled} onChange={(number) => { if (number === null) return; const next = [...value] as Vec3; next[index] = number * (rotation ? Math.PI / 180 : 1); onChange(next); }} />)}</div></label>;
}

export default function WorldEngine() {
  const { t } = useTranslation();
  const store = useVideoStudioStore();
  const projects = useVideoStore((state) => state.projects);
  const world = store.worlds.find((item) => item.id === store.activeWorldId) ?? store.worlds[0];
  const [selected, setSelected] = useState<string>('camera'), [time, setTime] = useState(0), [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<WorldRenderMode>('solid'), [view, setView] = useState<WorldViewMode>('orbit'), [tool, setTool] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [monitorCount, setMonitorCount] = useState<WorldMonitorCount>(4), [monitorSelection, setMonitorSelection] = useState<string[]>();
  const monitorSources = useMemo(() => world ? worldMonitorSelection(world, monitorSelection, monitorCount) : [], [world, monitorSelection, monitorCount]);
  const [template, setTemplate] = useState<WorldTemplate>('town'), [renderError, setRenderError] = useState(''), [exporting, setExporting] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false), [projectId, setProjectId] = useState<string>(), [shotId, setShotId] = useState<string>();
  const [sequenceOpen, setSequenceOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [undo, setUndo] = useState<WorldDocument[]>([]), [redo, setRedo] = useState<WorldDocument[]>([]);
  const [joint, setJoint] = useState<ActorJoint>('rightShoulder'), [drawingPath, setDrawingPath] = useState(false);
  const [modelClips, setModelClips] = useState<Record<string, Array<{ name: string; duration: number }>>>({});
  const host = useRef<HTMLDivElement>(null), viewport = useRef<WorldViewport | null>(null), timeRef = useRef(time);
  timeRef.current = time;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const commitRef = useRef<(doc: WorldDocument) => void>(() => undefined);
  const commit = (doc: WorldDocument) => { if (world) setUndo((items) => [...items.slice(-39), world]); setRedo([]); store.saveWorld({ ...doc, updatedAt: studioNow() }); setTime((value) => Math.min(value, worldPlaybackDuration(doc))); };
  commitRef.current = commit;
  const object = world?.objects.find((item) => item.id === selected);
  const busy = exporting || playing || sequenceOpen || offlineOpen;
  const playbackDuration = world ? worldPlaybackDuration(world) : 0;
  const cameraContext = world ? worldCameraContextAt(world, time) : undefined;
  useEffect(() => { setTime((value) => Math.min(value, playbackDuration)); }, [playbackDuration]);
  useEffect(() => { setSelected('camera'); setTime(0); setPlaying(false); setUndo([]); setRedo([]); setModelClips({}); setMonitorSelection(undefined); }, [world?.id]);
  useEffect(() => {
    if (!host.current || !world) return;
    let engine: WorldViewport;
    try { engine = new WorldViewport(host.current); viewport.current = engine; setRenderError(''); }
    catch (error) { setRenderError(String(error)); return; }
    engine.callbacks.onSelect = (id) => setSelected(id ?? 'environment');
    engine.callbacks.onModelError = (error) => message.error(error);
    engine.callbacks.onModelLoaded = (id, clips) => setModelClips((previous) => ({ ...previous, [id]: clips }));
    engine.callbacks.onPath = (points) => {
      setDrawingPath(false);
      const latest = useVideoStudioStore.getState().worlds.find((item) => item.id === world.id);
      if (latest) {
        const context = worldCameraContextAt(latest, timeRef.current);
        if (selectedRef.current === 'camera' && context.shot) {
          const moved = worldWithDrawnPath({ ...latest, camera: context.camera, duration: context.shot.duration }, 'camera', points);
          commitRef.current(withWorldCameraAt(latest, timeRef.current, moved.camera)); setTime(context.start);
        } else { commitRef.current(worldWithDrawnPath(latest, selectedRef.current, points)); setTime(0); }
      }
    };
    engine.callbacks.onTransform = (id, transform) => {
      const latest = useVideoStudioStore.getState().worlds.find((item) => item.id === world.id);
      const sceneTime = Math.min(timeRef.current, latest?.duration ?? 0);
      if (latest) commitRef.current({ ...latest, objects: latest.objects.map((item) => item.id === id ? item.keyframes.length || sceneTime > 0 ? upsertWorldKeyframe(item, sceneTime, transform, actorPoseAt(item, sceneTime)) : { ...item, transform } : item) });
    };
    return () => { engine.dispose(); if (viewport.current === engine) viewport.current = null; };
  }, [world?.id]);
  useEffect(() => { if (world && viewport.current && !viewport.current.recording) { viewport.current.sync(world, store.assets, busy ? undefined : selected, mode, view, tool, monitorSources); viewport.current.animate(timeRef.current); } }, [world, store.assets, selected, mode, view, tool, busy, monitorSources]);
  useEffect(() => { if (viewport.current && !viewport.current.recording) viewport.current.animate(time); }, [time]);
  useEffect(() => { viewport.current?.setPathDrawing(drawingPath && !busy && view === 'orbit'); }, [drawingPath, busy, world?.id, view]);
  useEffect(() => {
    if (!playing || !world) return;
    let animation = 0; const started = performance.now(), initialTime = timeRef.current;
    const tick = () => { const value = initialTime + (performance.now() - started) / 1000; if (value >= playbackDuration) { setTime(playbackDuration); setPlaying(false); } else { setTime(value); animation = requestAnimationFrame(tick); } };
    animation = requestAnimationFrame(tick); return () => cancelAnimationFrame(animation);
  }, [playing, playbackDuration]);

  const newWorld = () => store.saveWorld(worldFromTemplate(`${t(`studio.world.template.${template}`)} ${store.worlds.length + 1}`, template, t('studio.world.actor'), { backdrop: t('studio.world.backdrop'), table: t('studio.world.table'), building: t('studio.world.building') }, id => t(`studio.world.prop.${id}`)));
  const addProp = (id: WorldPropId) => {
    if (!world) return;
    const next = createWorldProp(id, t(`studio.world.prop.${id}`)); commit({ ...world, objects: [...world.objects, next] }); setSelected(next.id);
  };
  const addObject = (kind: WorldObject['kind'], assetId?: string) => {
    if (!world) return;
    const next = createWorldObject(kind, `${t(`studio.world.${kind}`)} ${world.objects.filter((item) => item.kind === kind).length + 1}`); next.assetId = assetId; commit({ ...world, objects: [...world.objects, next] }); setSelected(next.id);
  };
  const updateObject = (patch: Partial<WorldObject>) => { if (world && object) commit({ ...world, objects: world.objects.map((item) => item.id === object.id ? { ...item, ...patch } : item) }); };
  const updateTransform = (patch: Partial<WorldTransform>) => {
    if (!world || !object) return;
    const sceneTime = Math.min(time, world.duration), transform = { ...worldTransformAt(object, sceneTime), ...patch };
    updateObject(object.keyframes.length || sceneTime > 0 ? upsertWorldKeyframe(object, sceneTime, transform, actorPoseAt(object, sceneTime)) : { transform });
  };
  const pose = object?.kind === 'actor' ? actorPoseAt(object, time) : undefined;
  const updatePose = (value: ActorPose) => {
    if (!object || !world) return;
    const sceneTime = Math.min(time, world.duration);
    updateObject(object.keyframes.length || sceneTime > 0 ? upsertWorldKeyframe(object, sceneTime, worldTransformAt(object, sceneTime), value) : { pose: value });
  };
  const camera = world ? worldCameraPoseAt(world, time) : undefined;
  const changeCamera = (value: WorldCamera) => { if (world) commit(withWorldCameraAt(world, time, value)); };
  const updateCamera = (patch: Partial<Pick<WorldCamera, 'position' | 'target'>>) => {
    if (!world || !cameraContext) return;
    const current = cameraContext.camera, localTime = cameraContext.time;
    const value = { ...worldCameraAt(current, localTime), ...patch };
    changeCamera(current.keyframes.length || localTime > 0 ? upsertCameraKeyframe(current, localTime, value) : { ...current, ...value });
  };
  const recordKeyframe = () => {
    if (!world) return;
    if (object) updateObject(upsertWorldKeyframe(object, Math.min(time, world.duration), worldTransformAt(object, time), actorPoseAt(object, time)));
    else if (selected === 'camera' && cameraContext) changeCamera(upsertCameraKeyframe(cameraContext.camera, cameraContext.time, worldCameraAt(cameraContext.camera, cameraContext.time)));
  };
  const capture = async (cameraSourceId = 'program', cameraName?: string): Promise<StudioAsset> => {
    if (!world || !viewport.current) throw new Error(t('studio.world.noWebGL'));
    const data = viewport.current.capture(time, mode, cameraSourceId);
    const asset: StudioAsset = { id: studioId(), name: `${world.name} · ${cameraName ? cameraName + ' · ' : ''}${mode} · ${time.toFixed(2)}s`, kind: 'image', category: 'reference', createdAt: studioNow(), url: await retainStudioMedia(data, 'image'), worldId: world.id };
    store.addAsset(asset); return asset;
  };
  const captureTo = async (destination: 'library' | 'canvas' | 'shot') => {
    try {
      const asset = await capture();
      if (destination === 'canvas') {
        const canvas = store.canvases.find((item) => item.id === store.activeCanvasId) ?? createStudioCanvas(t('studio.canvas.new'));
        store.saveCanvas({ ...canvas, nodes: [...canvas.nodes, { id: studioId(), kind: 'image', name: asset.name, assetId: asset.id, worldId: world?.id, prompt: '', x: 100 + canvas.nodes.length % 3 * 300, y: 100 + Math.floor(canvas.nodes.length / 3) * 300 }], updatedAt: studioNow() }); store.setPage('canvas');
      } else if (destination === 'shot' && projectId && shotId) {
        useVideoStore.getState().updateSceneSpecShot(projectId, shotId, { previsReferenceImage: asset.url, previsWorldId: world?.id, manualReferenceImage: undefined, transition: 'cut' }); setApplyOpen(false); message.success(t('studio.world.applied'));
      } else message.success(t('studio.world.savedFrame'));
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  const record = async () => {
    if (!viewport.current || !world) return;
    if (typeof MediaRecorder === 'undefined') { message.warning(t('studio.world.noRecorder')); return; }
    setPlaying(false); setExporting(true);
    try {
      const blob = await viewport.current.record(setTime);
      if (blob.size < 100) throw new Error(t('studio.world.noRecorder'));
      const asset: StudioAsset = { id: studioId(), name: `${world.name} · ${mode}`, kind: 'video', category: 'reference', createdAt: studioNow(), url: await retainStudioMedia(await fileAsDataUri(blob), 'video'), durationSeconds: playbackDuration, worldId: world.id }; store.addAsset(asset); downloadStudioFile(blob, `${world.name}.webm`);
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); } finally { setExporting(false); }
  };
  const transform = object ? worldTransformAt(object, time) : undefined;
  const importDocument = async (file: File) => {
    try {
      const bundle = parseStudioBundle(JSON.parse(await file.text()), 'world');
      if (!bundle.world) return;
      useVideoStudioStore.setState((state) => ({ assets: [...state.assets, ...bundle.assets], worlds: [...state.worlds, ...bundle.worlds], activeWorldId: bundle.world!.id }));
      message.success(t('studio.imported'));
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  const exportDocument = async () => {
    if (!world) return;
    try { downloadStudioFile(JSON.stringify(await exportWorldBundle(world, store.assets), null, 2), `${world.name}.world.json`); }
    catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  return <div className="world-engine-workspace" data-testid="studio-world">
    <div className="world-engine-toolbar"><Select aria-label={t('studio.page.world')} value={world?.id} disabled={busy} onChange={(id) => useVideoStudioStore.setState({ activeWorldId: id })} options={store.worlds.map((item) => ({ value: item.id, label: item.name }))} /><Select aria-label={t('studio.world.template')} value={template} onChange={setTemplate} options={WORLD_TEMPLATES.map((value) => ({ value, label: t(`studio.world.template.${value}`) }))} /><Button icon={<PlusOutlined />} onClick={newWorld} disabled={busy}>{t('studio.world.new')}</Button><Button icon={<UndoOutlined />} disabled={!undo.length || busy} aria-label={t('studio.canvas.undo')} onClick={() => { if (world) { setRedo([...redo, world]); store.saveWorld(undo[undo.length - 1]); setUndo(undo.slice(0, -1)); } }} /><Button icon={<RedoOutlined />} disabled={!redo.length || busy} aria-label={t('studio.canvas.redo')} onClick={() => { if (world) { setUndo([...undo, world]); store.saveWorld(redo[redo.length - 1]); setRedo(redo.slice(0, -1)); } }} /><Upload accept=".json" showUploadList={false} beforeUpload={(file) => { void importDocument(file); return false; }}><Button disabled={busy}>{t('studio.import')}</Button></Upload>{world && <StudioDirector kind="world" document={world} disabled={busy} onApply={(proposal) => { commit(proposal as WorldDocument); setTime(0); }} />}<Button disabled={!world || busy} onClick={() => void exportDocument()}>{t('studio.export')}</Button><Popconfirm title={t('studio.deleteConfirm')} onConfirm={() => { if (world && store.canvases.some((canvas) => canvas.nodes.some((node) => node.kind === 'world' && node.worldId === world.id))) { message.warning(t('studio.asset.inUse')); return; } if (world) store.removeWorld(world.id); }}><Button danger disabled={!world || busy} icon={<DeleteOutlined />} aria-label={t('studio.delete')} /></Popconfirm></div>
    <p className="world-engine-set-hint">{t('studio.world.setHint')}</p>
    {!world ? <div className="world-engine-empty"><Empty description={t('studio.subtitle.world')} /><Button type="primary" onClick={newWorld}>{t('studio.world.new')}</Button></div> : <>
      <div className={`world-engine-body${view === 'monitor' && !exporting ? ' is-monitor' : ''}`}>
        <aside className="world-engine-scene-list"><Input key={`${world.id}:${world.name}`} aria-label={t('studio.rename')} defaultValue={world.name} disabled={busy} onBlur={(event) => { if (event.target.value !== world.name) commit({ ...world, name: event.target.value }); }} /><Space wrap>{(['actor', 'box', 'sphere', 'cylinder', 'tree', 'building'] as const).map((kind) => <Button key={kind} size="small" disabled={busy} onClick={() => addObject(kind)}>{t(`studio.world.${kind}`)}</Button>)}</Space><Upload accept=".glb" showUploadList={false} beforeUpload={(file) => { void importStudioFile(file).then((asset) => addObject('model', asset.id)).catch((error) => message.error(String(error))); return false; }}><Button size="small" disabled={busy}>{t('studio.kind.model')} +</Button></Upload><Select<WorldPropId> showSearch optionFilterProp="label" aria-label={t('studio.world.propLibrary')} placeholder={t('studio.world.propLibrary')} value={undefined} disabled={busy} onChange={addProp} options={WORLD_PROP_IDS.map(id => ({ value: id, label: t(`studio.world.prop.${id}`) }))} /><div className="world-engine-object-tree"><button type="button" className={selected === 'camera' ? 'is-active' : ''} onClick={() => setSelected('camera')}><CameraOutlined />{t('studio.world.camera')}</button><button type="button" className={selected === 'environment' ? 'is-active' : ''} onClick={() => setSelected('environment')}>{t('studio.world.environment')}</button>{world.objects.map((item) => <button type="button" key={item.id} data-testid="world-object-item" className={selected === item.id ? 'is-active' : ''} onClick={() => setSelected(item.id)}><span className="world-engine-object-color" style={{ backgroundColor: item.color }} />{item.name}</button>)}</div></aside>
        <section className="world-engine-stage"><div className="world-engine-view-toolbar"><Button size="small" disabled={busy || view !== 'orbit'} onClick={() => viewport.current?.frameScene()}>{t('studio.world.frameScene')}</Button><Segmented size="small" value={view} onChange={(value) => setView(value as typeof view)} disabled={exporting} options={['orbit', 'shot', 'monitor'].map((value) => ({ value, label: t(`studio.world.${value}`) }))} />{view === 'monitor' && <Segmented size="small" aria-label={t('studio.world.monitor.layout')} value={monitorCount} disabled={exporting} onChange={value => setMonitorCount(value as WorldMonitorCount)} options={[{ value: 2, label: t('studio.world.monitor.two') }, { value: 4, label: t('studio.world.monitor.four') }]} />}<Segmented size="small" value={mode} onChange={(value) => setMode(value as WorldRenderMode)} disabled={exporting} options={['solid', 'clay', 'depth'].map((value) => ({ value, label: t(`studio.world.${value}`) }))} /><Segmented size="small" value={tool} onChange={(value) => setTool(value as typeof tool)} disabled={busy} options={[{ value: 'translate', label: t('studio.world.move') }, { value: 'rotate', label: t('studio.world.rotate') }, { value: 'scale', label: t('studio.world.resize') }]} /></div><div className={`world-engine-viewport${view === 'monitor' && !exporting ? ' is-monitor' : ''}`} data-testid="world-viewport"><div className="world-engine-viewport-surface" ref={host} />{view === 'monitor' && !exporting && <WorldCameraMonitor world={world} time={time} sources={monitorSources} disabled={busy || !!renderError} onSelect={(index, sourceId) => { const next = [...monitorSources]; next[index] = sourceId; setMonitorSelection(next); }} onApply={sourceId => { commit(worldWithMonitorCamera(world, sourceId, time)); setSelected('camera'); }} onCapture={(sourceId, name) => { void capture(sourceId, name).then(() => message.success(t('studio.world.monitor.saved'))).catch(error => message.error(String(error))); }} />}</div>{view === 'monitor' && <div className="world-camera-monitor-hint">{t('studio.world.monitor.hint')}</div>}{drawingPath && <Alert type="info" message={t('studio.world.drawHint')} />}{renderError && <Alert type="error" showIcon message={t('studio.world.noWebGL')} description={renderError} />}<div className="world-engine-output-actions"><Button type={drawingPath ? 'primary' : 'default'} disabled={busy || view !== 'orbit' || selected === 'environment'} onClick={() => setDrawingPath(!drawingPath)}>{t(drawingPath ? 'studio.world.drawingPath' : 'studio.world.drawPath')}</Button><Button icon={<CameraOutlined />} disabled={busy || !!renderError} onClick={() => void captureTo('library')}>{t('studio.world.capture')}</Button><Button disabled={busy || !!renderError} onClick={() => void captureTo('canvas')}>{t('studio.world.toCanvas')}</Button><Button disabled={busy || !!renderError || !Object.values(projects).some((project) => project.sceneSpec?.shots.length)} onClick={() => setApplyOpen(true)}>{t('studio.world.toShot')}</Button><Button icon={<DownloadOutlined />} loading={exporting} disabled={playing || sequenceOpen || !!renderError} onClick={() => void record()}>{t(exporting ? 'studio.world.recording' : 'studio.world.record')}</Button><WorldOfflineExport world={world} mode={mode} viewport={() => viewport.current} disabled={busy || !!renderError} onOpenChange={setOfflineOpen} /></div></section>
        <aside className="world-engine-inspector">
          {object && transform ? <><Input key={`${object.id}:${object.name}`} aria-label={t('studio.rename')} defaultValue={object.name} disabled={busy} onBlur={(event) => updateObject({ name: event.target.value })} /><VectorField label={t('studio.world.position')} value={transform.position} onChange={(position) => updateTransform({ position })} disabled={busy} /><VectorField label={t('studio.world.rotation')} value={transform.rotation} onChange={(rotation) => updateTransform({ rotation })} rotation disabled={busy} /><VectorField label={t('studio.world.scale')} value={transform.scale} onChange={(scale) => updateTransform({ scale })} scale disabled={busy} /><label className="world-engine-field">{t('studio.world.color')}<Input type="color" value={object.color} disabled={busy} onChange={(event) => updateObject({ color: event.target.value })} /></label><label className="world-engine-field">{t('studio.world.visible')}<Switch size="small" checked={object.visible} disabled={busy} onChange={(visible) => updateObject({ visible })} /></label>{object.kind === 'model' && !!modelClips[object.id]?.length && <WorldModelAnimation object={object} clips={modelClips[object.id]} disabled={busy} onChange={updateObject} />}{object.kind === 'actor' && <><span>{t('studio.world.markers')}</span><VectorField label={t('studio.world.markerA')} value={world.markerA} onChange={(markerA) => commit({ ...world, markerA })} disabled={busy} /><VectorField label={t('studio.world.markerB')} value={world.markerB} onChange={(markerB) => commit({ ...world, markerB })} disabled={busy} /><Button disabled={busy} onClick={() => updateObject(addWorldPath(object, world.markerA, world.markerB, world.duration, 'walk'))}>{t('studio.world.walk')}</Button><Button disabled={busy} onClick={() => updateObject(addWorldPath(object, world.markerB, world.markerA, world.duration, 'run'))}>{t('studio.world.run')}</Button><Select<typeof POSE_PRESETS[number]> aria-label={t('studio.world.pose')} placeholder={t('studio.world.pose')} disabled={busy} value={undefined} options={POSE_PRESETS.map((value) => ({ value, label: t(`studio.world.pose.${value}`) }))} onChange={(value) => updatePose(actorPosePreset(value))} /><Select aria-label={t('studio.world.joint')} value={joint} disabled={busy} onChange={setJoint} options={ACTOR_JOINTS.map((value) => ({ value, label: t(`studio.world.joint.${value}`) }))} />{pose && <VectorField label={t('studio.world.jointRotation')} value={pose.joints[joint] ?? [0, 0, 0]} rotation disabled={busy} onChange={(rotation) => updatePose({ ...pose, joints: { ...pose.joints, [joint]: rotation } })} />}<Space><Button size="small" disabled={busy} onClick={() => updateObject({ motion: 'wave' })}>{t('studio.world.wave')}</Button><Button size="small" disabled={busy} onClick={() => updateObject({ motion: 'idle', keyframes: [] })}>{t('studio.world.idle')}</Button></Space><span className="video-studio-muted">{t('studio.world.pathHint')}</span></>}<Space><Button size="small" disabled={busy} onClick={() => { const copy = { ...structuredClone(object), id: studioId(), name: `${object.name} +` }; commit({ ...world, objects: [...world.objects, copy] }); setSelected(copy.id); }}>{t('studio.duplicate')}</Button><Button size="small" danger icon={<DeleteOutlined />} disabled={busy} onClick={() => { commit({ ...world, objects: world.objects.filter((item) => item.id !== object.id) }); setSelected('camera'); }}>{t('studio.delete')}</Button></Space></> : selected === 'camera' ? <>
            <strong>{cameraContext!.shot?.name ?? t('studio.world.camera')}</strong>
            <VectorField label={t('studio.world.position')} value={camera!.position} disabled={busy} onChange={(position) => updateCamera({ position })} />
            <VectorField label={t('studio.world.target')} value={camera!.target} disabled={busy} onChange={(target) => updateCamera({ target })} />
            <label className="world-engine-field">{t('studio.world.focal')}<InputNumber aria-label={t('studio.world.focal')} min={12} max={200} value={cameraContext!.camera.focalLength} disabled={busy} onChange={(focalLength) => focalLength && changeCamera({ ...cameraContext!.camera, focalLength })} /></label>
            <Select value={world.aspectRatio} disabled={busy} onChange={(aspectRatio) => commit({ ...world, aspectRatio })} options={['16:9', '9:16', '1:1', '4:3', '21:9'].map((value) => ({ value, label: value }))} />
            <Button disabled={busy} onClick={() => { const aligned = viewport.current?.alignCamera(); if (aligned) updateCamera(aligned); }}>{t('studio.world.alignCamera')}</Button>
            <Select<typeof CAMERA_MOVES[number]> aria-label={t('studio.world.cameraMove')} placeholder={t('studio.world.cameraMove')} value={undefined} disabled={busy} options={CAMERA_MOVES.map((value) => ({ value, label: t(`studio.world.cameraMove.${value}`) }))} onChange={(move) => { changeCamera(cameraWithMove(cameraContext!.camera, move, cameraContext!.shot?.duration ?? world.duration)); setTime(cameraContext!.start); }} />
            <Button disabled={busy || (world.cameraBookmarks?.length ?? 0) >= 50} onClick={() => commit({ ...world, cameraBookmarks: [...(world.cameraBookmarks ?? []), { id: studioId(), name: `${t('studio.world.camera')} ${(world.cameraBookmarks?.length ?? 0) + 1}`, camera: retimeWorldCamera(cameraContext!.camera, cameraContext!.shot?.duration ?? world.duration, world.duration) }] })}>{t('studio.world.saveCamera')}</Button>
            {!!world.cameraBookmarks?.length && <Select<string> aria-label={t('studio.world.savedCameras')} placeholder={t('studio.world.savedCameras')} value={undefined} disabled={busy} options={world.cameraBookmarks.map((item) => ({ value: item.id, label: item.name }))} onChange={(id) => { const saved = world.cameraBookmarks?.find((item) => item.id === id); if (saved) { changeCamera(retimeWorldCamera(saved.camera, world.duration, cameraContext!.shot?.duration ?? world.duration)); setTime(cameraContext!.start); } }} />}
          </> : <><strong>{t('studio.world.environment')}</strong><Select value={world.environment} disabled={busy} onChange={(environment) => commit({ ...world, environment })} options={['day', 'sunset', 'night', 'fog'].map((value) => ({ value, label: t(`studio.world.${value}`) }))} /><label className="world-engine-field">{t('studio.world.light')}<Slider min={0} max={6} step={0.1} value={world.lightIntensity} disabled={busy} onChange={(lightIntensity) => commit({ ...world, lightIntensity })} /></label><label className="world-engine-field">{t('studio.world.ground')}<Input type="color" value={world.groundColor} disabled={busy} onChange={(event) => commit({ ...world, groundColor: event.target.value })} /></label></>}
        </aside>
      </div>
      <WorldCameraSequence key={world.id} world={world} time={time} disabled={busy} canTransfer={!renderError && Object.values(projects).some((project) => project.sceneSpec?.shots.length)} onChange={commit} onSeek={(value) => { setPlaying(false); setTime(value); setView('shot'); setSelected('camera'); }} onTransfer={() => { if (world.cameraSequence && !world.cameraSequence.enabled) commit({ ...world, cameraSequence: { ...world.cameraSequence, enabled: true } }); setPlaying(false); setSequenceOpen(true); }} />
      <section className="world-engine-timeline" data-testid="world-timeline">
        <div className="world-engine-timeline-toolbar">
          <Button icon={playing ? <PauseOutlined /> : <PlayCircleOutlined />} disabled={exporting || sequenceOpen} onClick={() => { if (time >= playbackDuration) setTime(0); setPlaying(!playing); }}>{t(playing ? 'studio.world.pause' : 'studio.world.play')}</Button>
          <Button disabled={exporting || sequenceOpen} onClick={() => { setPlaying(false); setTime(0); }}>{t('studio.world.reset')}</Button>
          <Tag data-testid="world-playhead">{time.toFixed(2)} / {Number(playbackDuration.toFixed(2))}s</Tag>
          {cameraContext!.shot && <Tag>{cameraContext!.shot.name}</Tag>}
          <label>{t('studio.world.sequence.sceneDuration')}<InputNumber aria-label={t('studio.world.sequence.sceneDuration')} size="small" value={world.duration} min={1} max={60} disabled={busy} onChange={(duration) => {
            if (!duration) return;
            const factor = duration / world.duration;
            commit({ ...world, duration, objects: world.objects.map((item) => ({ ...item, keyframes: item.keyframes.map((frame) => ({ ...frame, time: frame.time * factor })) })), camera: retimeWorldCamera(world.camera, world.duration, duration), cameraBookmarks: world.cameraBookmarks?.map((bookmark) => ({ ...bookmark, camera: retimeWorldCamera(bookmark.camera, world.duration, duration) })) });
          }} /></label>
          <Button disabled={busy || selected === 'environment'} onClick={recordKeyframe}>{t('studio.world.keyframe')}</Button>
          <Tooltip title={t('studio.world.deleteKeyframe')}><Button icon={<DeleteOutlined />} disabled={busy || selected === 'environment'} onClick={() => object ? updateObject({ keyframes: object.keyframes.filter((frame) => Math.abs(frame.time - Math.min(time, world.duration)) > 0.03) }) : changeCamera({ ...cameraContext!.camera, keyframes: cameraContext!.camera.keyframes.filter((frame) => Math.abs(frame.time - cameraContext!.time) > 0.03) })} /></Tooltip>
        </div>
        <Slider aria-label={t('studio.world.timeline')} value={time} min={0} max={playbackDuration} step={1 / world.fps} disabled={exporting || sequenceOpen} onChange={(value) => { setPlaying(false); setTime(value); }} />
        <div className="world-engine-tracks">{[{ id: 'camera', name: t('studio.world.camera'), frames: world.cameraSequence?.enabled ? worldSequenceSpans(world).flatMap((span) => [{ time: span.start }, ...span.shot.camera.keyframes.filter((frame) => frame.time > 0 && frame.time < span.shot.duration).map((frame) => ({ time: span.start + frame.time }))]) : world.camera.keyframes }, ...world.objects.map((item) => ({ id: item.id, name: item.name, frames: item.keyframes }))].map((track) => <div className="world-engine-track" key={track.id}><button type="button" onClick={() => setSelected(track.id)}>{track.name}</button><div>{track.frames.filter((frame) => frame.time <= playbackDuration).map((frame) => <button key={frame.time} type="button" disabled={exporting || sequenceOpen} aria-label={`${track.name} ${frame.time.toFixed(2)}s`} title={`${frame.time.toFixed(2)}s`} style={{ left: `${frame.time / playbackDuration * 100}%` }} onClick={() => { setSelected(track.id); setTime(frame.time); setPlaying(false); }} />)}</div></div>)}{world.objects.filter(item => item.kind === 'model' && item.animationClip !== undefined && modelClips[item.id]?.[item.animationClip]).map(item => <WorldModelAnimationTrack key={item.id} object={item} clip={modelClips[item.id][item.animationClip!]} duration={playbackDuration} disabled={exporting || sequenceOpen} onSeek={value => { setSelected(item.id); setTime(value); setPlaying(false); }} />)}</div>
      </section>
      {sequenceOpen && <WorldSequenceTransfer world={world} capture={(value) => { if (!viewport.current) throw new Error(t('studio.world.noWebGL')); return viewport.current.capture(value, mode); }} onClose={() => setSequenceOpen(false)} />}
    </>}
    <Modal open={applyOpen} title={t('studio.world.toShot')} onCancel={() => setApplyOpen(false)} onOk={() => void captureTo('shot')} okButtonProps={{ disabled: !projectId || !shotId }}><Space direction="vertical" style={{ width: '100%' }}><Alert type="info" showIcon message={t('studio.world.applyHint')} /><Select style={{ width: '100%' }} placeholder={t('studio.world.project')} value={projectId} onChange={(id) => { setProjectId(id); setShotId(undefined); }} options={Object.values(projects).filter((project) => project.sceneSpec?.shots.length).map((project) => ({ value: project.novelProjectId, label: project.title || project.novelProjectId }))} /><Select style={{ width: '100%' }} placeholder={t('studio.world.selectShot')} value={shotId} onChange={setShotId} options={(projectId ? projects[projectId]?.sceneSpec?.shots ?? [] : []).map((shot) => ({ value: shot.id, label: `#${shot.index + 1} ${(shot.sourceText || shot.videoPrompt).slice(0, 60)}` }))} /></Space></Modal>
  </div>;
}

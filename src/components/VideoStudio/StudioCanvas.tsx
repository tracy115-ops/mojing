import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Dropdown, Empty, Input, Popconfirm, Select, Space, Tag, Tooltip, Upload, message } from 'antd';
import { AimOutlined, DeleteOutlined, LinkOutlined, MinusOutlined, PlusOutlined, RedoOutlined, UndoOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { providerRouter } from '@/services/providers';
import { canConnectCanvas, createStudioCanvas, createWorld, parseStudioBundle, studioId, studioNow } from '@/services/video-studio/document';
import { exportCanvasBundle } from '@/services/video-studio/bundle';
import { downloadStudioFile, importStudioFile, submitStudioJob, waitForStudioJob } from '@/services/video-studio/generation';
import { duplicateCanvasNodes, groupCanvasNodes, layoutCanvasNodes, orderedCanvasNodes, ungroupCanvasNodes, type CanvasLayoutAction } from '@/services/video-studio/canvas-graph';
import { getVideoParameter, normalizeNumberForParameter } from '@/services/video/core/video-capability-utils';
import type { StudioAsset, StudioCanvas as CanvasDocument, StudioGenerationInput, StudioNode } from '@/types/video-studio';
import { initialStudioInput } from '@/services/video-studio/input';
import StudioMedia from './StudioMedia';
import StudioDirector from './StudioDirector';
import StudioNodeSettings from './StudioNodeSettings';
import StudioImageEditor from './StudioImageEditor';
import StudioProjectTransfer from './StudioProjectTransfer';
import './StudioCanvas.css';

export default function StudioCanvas() {
  const { t } = useTranslation();
  const store = useVideoStudioStore();
  const canvas = store.canvases.find((item) => item.id === store.activeCanvasId) ?? store.canvases[0];
  const [selected, setSelected] = useState<string>(), [connecting, setConnecting] = useState<string>();
  const [selection, setSelection] = useState<string[]>([]), [batchRunning, setBatchRunning] = useState(false);
  const batchController = useRef<AbortController | null>(null);
  const [undo, setUndo] = useState<CanvasDocument[]>([]), [redo, setRedo] = useState<CanvasDocument[]>([]);
  const [dragPositions, setDragPositions] = useState<Array<{ id: string; x: number; y: number }>>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number }>();
  const [nodeSizes, setNodeSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [resizing, setResizing] = useState<{ id: string; width: number; height: number }>();
  const [pan, setPan] = useState<{ x: number; y: number }>();
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'nodes' | 'pan' | 'marquee' | 'resize'; id?: string; startX: number; startY: number; x: number; y: number; nodes?: Array<{ id: string; x: number; y: number }>; selection?: string[] } | undefined>(undefined);
  const pointerPosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StudioAsset>();
  useEffect(() => { setUndo([]); setRedo([]); setSelected(undefined); setSelection([]); setConnecting(undefined); setNodeSizes({}); drag.current = undefined; setDragPositions([]); setMarquee(undefined); }, [canvas?.id]);
  useEffect(() => () => batchController.current?.abort(), []);
  const commit = (next: CanvasDocument) => {
    if (canvas) setUndo((history) => [...history.slice(-39), canvas]);
    setRedo([]); store.saveCanvas({ ...next, updatedAt: studioNow() });
  };
  const newCanvas = () => store.saveCanvas(createStudioCanvas(`${t('studio.canvas.new')} ${store.canvases.length + 1}`));
  const viewport = { ...(canvas?.viewport ?? { x: 80, y: 80, zoom: 1 }), ...pan };
  const active = canvas?.nodes.find((node) => node.id === selected);
  const activeGroup = canvas?.groups?.find((group) => group.nodeIds.includes(selected ?? ''));
  const positionOf = (node: StudioNode) => dragPositions.find((position) => position.id === node.id) ?? node;
  const selectNode = (id: string, additive: boolean): string[] => {
    const members = canvas?.groups?.find((group) => group.nodeIds.includes(id))?.nodeIds ?? [id];
    const next = additive ? members.every((member) => selection.includes(member)) ? selection.filter((member) => !members.includes(member)) : [...new Set([...selection, ...members])]
      : members.every((member) => selection.includes(member)) ? selection : members;
    setSelection(next); setSelected(next.includes(id) ? id : next[0]); return next;
  };
  const startNodeDrag = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0 || !canvas) return;
    event.stopPropagation();
    const ids = selectNode(id, event.shiftKey || event.ctrlKey || event.metaKey);
    if (!ids.includes(id) || canvas.nodes.some((node) => ids.includes(node.id) && node.layoutLocked)) return;
    drag.current = { mode: 'nodes', startX: event.clientX, startY: event.clientY, x: 0, y: 0, nodes: canvas.nodes.filter((node) => ids.includes(node.id)).map(({ id, x, y }) => ({ id, x, y })) };
  };
  const startResize = (event: ReactPointerEvent, node: StudioNode) => {
    if (event.button !== 0 || node.layoutLocked) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { mode: 'resize', id: node.id, startX: event.clientX, startY: event.clientY, x: nodeSizes[node.id]?.width ?? node.width ?? 260, y: nodeSizes[node.id]?.height ?? node.height ?? 300 };
  };
  const nodeSignature = canvas?.nodes.map((node) => node.id).join(',');
  useEffect(() => {
    const observer = new ResizeObserver((entries) => setNodeSizes((previous) => {
      const next = { ...previous }; let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement, id = element.dataset.nodeId!;
        if (next[id]?.width !== element.offsetWidth || next[id]?.height !== element.offsetHeight) { next[id] = { width: element.offsetWidth, height: element.offsetHeight }; changed = true; }
      }
      return changed ? next : previous;
    }));
    surface.current?.querySelectorAll('[data-node-id]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [canvas?.id, nodeSignature]);
  const updateNode = (id: string, patch: Partial<StudioNode>) => {
    if (canvas) commit({ ...canvas, nodes: canvas.nodes.map((node) => node.id === id ? { ...node, ...patch, id } : node) });
  };
  const addNode = (kind: StudioNode['kind']) => {
    const target = canvas ?? createStudioCanvas(t('studio.canvas.new'));
    const node: StudioNode = { id: studioId(), name: t(`studio.kind.${kind}`), kind, prompt: '', x: (80 - viewport.x) / viewport.zoom + target.nodes.length % 3 * 290, y: (80 - viewport.y) / viewport.zoom + Math.floor(target.nodes.length / 3) * 300 };
    commit({ ...target, nodes: [...target.nodes, node] }); setSelected(node.id); setSelection([node.id]);
  };
  const removeNode = () => {
    if (!canvas || !selected) return;
    const ids = new Set(selection.length ? selection : [selected]);
    commit({ ...ungroupCanvasNodes(canvas, [...ids]), nodes: canvas.nodes.filter((node) => !ids.has(node.id)), edges: canvas.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)) }); setSelected(undefined); setSelection([]);
  };
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      const delta = { x: event.clientX - current.startX, y: event.clientY - current.startY };
      const result = current.mode === 'pan' ? { x: current.x + delta.x, y: current.y + delta.y } : { x: delta.x / viewport.zoom, y: delta.y / viewport.zoom };
      pointerPosition.current = result;
      if (current.mode === 'resize') setResizing({ id: current.id!, width: Math.min(1600, Math.max(220, current.x + result.x)), height: Math.min(1600, Math.max(300, current.y + result.y)) });
      else if (current.mode === 'nodes') setDragPositions(current.nodes!.map((node) => ({ ...node, x: node.x + result.x, y: node.y + result.y })));
      else if (current.mode === 'pan') setPan(result);
      else setMarquee({ x: Math.min(current.x, current.x + delta.x), y: Math.min(current.y, current.y + delta.y), width: Math.abs(delta.x), height: Math.abs(delta.y) });
    };
    const onUp = () => {
      const current = drag.current, position = pointerPosition.current;
      drag.current = undefined; pointerPosition.current = undefined; setDragPositions([]); setPan(undefined); setMarquee(undefined); setResizing(undefined);
      if (!current || !position || !canvas) return;
      const latest = useVideoStudioStore.getState().canvases.find((item) => item.id === canvas.id) ?? canvas;
      if (current.mode === 'marquee') {
        const x = (current.x - latest.viewport.x) / viewport.zoom, y = (current.y - latest.viewport.y) / viewport.zoom;
        const left = Math.min(x, x + position.x), top = Math.min(y, y + position.y), right = Math.max(x, x + position.x), bottom = Math.max(y, y + position.y);
        const hits = latest.nodes.filter((node) => node.x < right && node.x + (nodeSizes[node.id]?.width ?? node.width ?? 260) > left && node.y < bottom && node.y + (nodeSizes[node.id]?.height ?? node.height ?? 300) > top).map((node) => node.id);
        const groups = (latest.groups ?? []).filter((group) => group.nodeIds.some((id) => hits.includes(id))).flatMap((group) => group.nodeIds);
        const ids = [...new Set([...(current.selection ?? []), ...hits, ...groups])]; setSelection(ids); setSelected(ids[0]);
      } else if (current.mode === 'resize') {
        commit({ ...latest, nodes: latest.nodes.map((node) => node.id === current.id ? { ...node, width: Math.min(1600, Math.max(220, current.x + position.x)), height: Math.min(1600, Math.max(300, current.y + position.y)) } : node) });
      } else if (current.mode === 'nodes') {
        commit({ ...latest, nodes: latest.nodes.map((node) => { const initial = current.nodes!.find((item) => item.id === node.id); return initial ? { ...node, x: initial.x + position.x, y: initial.y + position.y } : node; }) });
      } else commit({ ...latest, viewport: { ...latest.viewport, ...position } });
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [canvas, viewport.zoom, nodeSizes]);
  const connect = (to: string) => {
    if (!canvas || !connecting) { selectNode(to, false); return; }
    if (!canConnectCanvas(canvas, connecting, to)) { message.warning(t('studio.canvas.invalidEdge')); return; }
    commit({ ...canvas, edges: [...canvas.edges, { id: studioId(), from: connecting, to }] }); setConnecting(undefined);
  };
  const zoom = (factor: number) => { if (canvas) store.saveCanvas({ ...canvas, viewport: { ...viewport, zoom: Math.min(3, Math.max(0.15, viewport.zoom * factor)) } }); };
  const fit = () => {
    if (!canvas?.nodes.length || !surface.current) return;
    const minX = Math.min(...canvas.nodes.map((node) => node.x)), minY = Math.min(...canvas.nodes.map((node) => node.y));
    const width = Math.max(...canvas.nodes.map((node) => node.x + (nodeSizes[node.id]?.width ?? node.width ?? 260))) - minX, height = Math.max(...canvas.nodes.map((node) => node.y + (nodeSizes[node.id]?.height ?? node.height ?? 300))) - minY;
    const scale = Math.min(1.3, (surface.current.clientWidth - 80) / width, (surface.current.clientHeight - 80) / height);
    store.saveCanvas({ ...canvas, viewport: { x: 40 - minX * scale, y: 40 - minY * scale, zoom: Math.max(0.15, scale) } });
  };
  const generateNode = (node: StudioNode): string => {
      if (!canvas || !['image', 'video', 'text'].includes(node.kind)) throw new Error(t('studio.canvas.notGeneratable'));
      const latest = useVideoStudioStore.getState();
      const doc = latest.canvases.find((item) => item.id === canvas.id);
      if (!doc) throw new Error(t('studio.canvas.notGeneratable'));
      const incoming = doc.edges.filter((edge) => edge.to === node.id).map((edge) => doc.nodes.find((item) => item.id === edge.from)).filter((value): value is StudioNode => !!value);
      const assets = incoming.map((item) => latest.assets.find((asset) => asset.id === item.assetId));
      if (incoming.some((item) => ['image', 'world', 'audio', 'video'].includes(item.kind) && !latest.assets.find((asset) => asset.id === item.assetId))) throw new Error(t('studio.canvas.missingInput'));
      if (incoming.some((item) => item.kind === 'model' || ['audio', 'video'].includes(item.kind) && node.kind !== 'video')) throw new Error(t('studio.media.unsupported'));
      const images = assets.filter((asset): asset is StudioAsset => asset?.kind === 'image');
      const text = incoming.filter((item) => item.kind === 'text').map((item) => latest.assets.find((asset) => asset.id === item.assetId)?.text || item.prompt).filter(Boolean);
      const input: StudioGenerationInput = { ...initialStudioInput(), ...node.generation, kind: node.kind as StudioGenerationInput['kind'], prompt: [...text, node.prompt].filter(Boolean).join('\n\n'), referenceAssetIds: [...new Set([...(node.generation?.referenceAssetIds ?? []), ...images.map((asset) => asset.id)])], audioReferenceAssetIds: [...new Set([...(node.generation?.audioReferenceAssetIds ?? []), ...assets.filter((asset) => asset?.kind === 'audio').map((asset) => asset!.id)])], videoReferenceAssetIds: [...new Set([...(node.generation?.videoReferenceAssetIds ?? []), ...assets.filter((asset) => asset?.kind === 'video').map((asset) => asset!.id)])] };
      input.controlMode ??= 'text';
      if (node.kind === 'video' && images.length) {
        const caps = providerRouter.getVideoCapabilities('clip', input.model, input.endpointId);
        if (node.generation?.controlMode === 'text') throw new Error(t('studio.creator.noReferenceSupport'));
        if (caps.references.supportsSubjectReferences && node.generation?.controlMode !== 'keyframe') input.controlMode = 'reference';
        else if (caps.references.supportsFirstFrame) {
          if (images.length > (caps.references.supportsLastFrame ? 2 : 1)) throw new Error(t('studio.canvas.invalidEdge'));
          input.controlMode = 'keyframe'; input.firstFrameAssetId = images[0].id; input.lastFrameAssetId = images[1]?.id; input.referenceAssetIds = [];
        } else throw new Error(t('studio.creator.noEndpoint'));
      }
      if (node.kind === 'video') {
        const caps = providerRouter.getVideoCapabilities('clip', input.model, input.endpointId);
        if (input.audioReferenceAssetIds?.length || input.videoReferenceAssetIds?.length) {
          if (node.generation?.controlMode && node.generation.controlMode !== 'reference') throw new Error(t('studio.media.modeRequired'));
          input.controlMode = 'reference';
        }
        input.durationSeconds = normalizeNumberForParameter(input.durationSeconds, getVideoParameter(caps, 'durationSeconds'), 5);
        if (caps.resolutionTiers?.length && !caps.resolutionTiers.some((tier) => tier.id === input.resolution)) input.resolution = caps.resolutionTiers[0].id;
      }
      return submitStudioJob(input, { canvasId: canvas.id, nodeId: node.id });
  };
  const submitNode = (node: StudioNode) => { try { generateNode(node); message.success(t('studio.creator.queued')); } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); } };
  const runSelection = async () => {
    if (!canvas) return;
    const controller = new AbortController(); batchController.current = controller; setBatchRunning(true);
    try {
      const ids = orderedCanvasNodes(canvas, selection).filter((id) => canvas.nodes.some((node) => node.id === id && ['image', 'video', 'text'].includes(node.kind) && (!node.assetId || node.prompt.trim() || canvas.edges.some((edge) => edge.to === id))));
      for (const id of ids) {
        if (controller.signal.aborted) break;
        const node = useVideoStudioStore.getState().canvases.find((item) => item.id === canvas.id)?.nodes.find((item) => item.id === id);
        if (!node) throw new Error(t('studio.canvas.missingInput'));
        await waitForStudioJob(generateNode(node), controller.signal);
      }
    } catch (error) { if (!controller.signal.aborted) message.error(`${t('studio.failed')}: ${String(error)}`); }
    finally { setBatchRunning(false); batchController.current = null; }
  };
  const duplicateSelection = () => {
    if (!canvas) return;
    const result = duplicateCanvasNodes(canvas, selection); commit(result.canvas); setSelection(result.ids); setSelected(result.ids[0]);
  };
  const openWorld = (node: StudioNode) => {
    const world = store.worlds.find((item) => item.id === node.worldId) ?? createWorld(node.name);
    store.saveWorld(world); updateNode(node.id, { worldId: world.id }); store.setPage('world');
  };
  const importDocument = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const bundle = parseStudioBundle(data, 'canvas');
      if (!bundle.canvas) return;
      useVideoStudioStore.setState((state) => ({ assets: [...state.assets, ...bundle.assets], worlds: [...state.worlds, ...bundle.worlds], canvases: [...state.canvases, bundle.canvas!], activeCanvasId: bundle.canvas!.id }));
      message.success(t('studio.imported'));
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  const exportDocument = async () => {
    if (!canvas) return;
    try { downloadStudioFile(JSON.stringify(await exportCanvasBundle(canvas, store.assets, store.worlds), null, 2), `${canvas.name}.canvas.json`); }
    catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  const importMedia = async (files: FileList | null) => {
    if (!files) return;
    setCreating(true);
    try {
      for (const file of Array.from(files)) {
        const asset = await importStudioFile(file);
        const latest = useVideoStudioStore.getState().canvases.find((item) => item.id === canvas?.id) ?? createStudioCanvas(t('studio.canvas.new'));
        store.saveCanvas({ ...latest, nodes: [...latest.nodes, { id: studioId(), kind: asset.kind, name: asset.name, assetId: asset.id, prompt: asset.text ?? '', x: 100 + latest.nodes.length % 3 * 300, y: 100 + Math.floor(latest.nodes.length / 3) * 300 }], updatedAt: studioNow() });
      }
    } catch (error) { message.error(String(error)); } finally { setCreating(false); }
  };
  return <div className="studio-canvas-workspace" data-testid="studio-canvas">
    <div className="studio-canvas-toolbar">
      <Select aria-label={t('studio.page.canvas')} value={canvas?.id} onChange={(id) => useVideoStudioStore.setState({ activeCanvasId: id })} options={store.canvases.map((item) => ({ value: item.id, label: item.name }))} />
      <Button onClick={newCanvas} icon={<PlusOutlined />}>{t('studio.new')}</Button><Button disabled={!canvas?.nodes.length} onClick={() => { setSelection(canvas!.nodes.map((node) => node.id)); setSelected(canvas!.nodes[0]?.id); }}>{t('studio.canvas.selectAll')}</Button><Button disabled={!selection.length || batchRunning} onClick={duplicateSelection}>{t('studio.duplicate')}</Button><Button type="primary" loading={batchRunning} disabled={!selection.length} onClick={() => void runSelection()}>{t('studio.canvas.runSelection', { count: selection.length })}</Button>{batchRunning && <Button onClick={() => batchController.current?.abort()}>{t('studio.canvas.stopBatch')}</Button>}
      <Button disabled={selection.length < 2} onClick={() => canvas && commit(groupCanvasNodes(canvas, selection, `${t('studio.canvas.group')} ${(canvas.groups?.length ?? 0) + 1}`))}>{t('studio.canvas.group')}</Button><Button disabled={!canvas?.groups?.some((group) => group.nodeIds.some((id) => selection.includes(id)))} onClick={() => canvas && commit(ungroupCanvasNodes(canvas, selection))}>{t('studio.canvas.ungroup')}</Button>
      <Dropdown disabled={!selection.length} menu={{ items: ['left', 'centerX', 'right', 'top', 'centerY', 'bottom', 'distributeX', 'distributeY', 'front', 'back'].map((key) => ({ key, label: t(`studio.canvas.layout.${key}`), disabled: !['front', 'back'].includes(key) && selection.length < (key.startsWith('distribute') ? 3 : 2) })), onClick: ({ key }) => canvas && commit(layoutCanvasNodes(canvas, selection, key as CanvasLayoutAction, nodeSizes)) }}><Button>{t('studio.canvas.layout')}</Button></Dropdown>
      <Button disabled={!selection.length} onClick={() => canvas && commit({ ...canvas, nodes: canvas.nodes.map((node) => selection.includes(node.id) ? { ...node, layoutLocked: !canvas.nodes.filter((item) => selection.includes(item.id)).every((item) => item.layoutLocked) } : node) })}>{t(canvas?.nodes.filter((node) => selection.includes(node.id)).every((node) => node.layoutLocked) ? 'studio.canvas.unlock' : 'studio.canvas.lock')}</Button>
      {canvas && <Input key={`${canvas.id}:${canvas.name}`} aria-label={t('studio.rename')} defaultValue={canvas.name} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== canvas.name) commit({ ...canvas, name: event.target.value.trim() }); }} />}
      <Dropdown menu={{ items: ['text', 'image', 'video', 'audio', 'model', 'world'].map((key) => ({ key, label: t(`studio.kind.${key}`) })), onClick: ({ key }) => addNode(key as StudioNode['kind']) }}><Button type="primary" icon={<PlusOutlined />}>{t('studio.canvas.add')}</Button></Dropdown>
      <Tooltip title={t('studio.canvas.undo')}><Button icon={<UndoOutlined />} disabled={!undo.length} onClick={() => { if (!canvas) return; const previous = undo[undo.length - 1]; setUndo(undo.slice(0, -1)); setRedo([...redo, canvas]); store.saveCanvas(previous); }} /></Tooltip>
      <Tooltip title={t('studio.canvas.redo')}><Button icon={<RedoOutlined />} disabled={!redo.length} onClick={() => { if (!canvas) return; setUndo([...undo, canvas]); store.saveCanvas(redo[redo.length - 1]); setRedo(redo.slice(0, -1)); }} /></Tooltip>
      <Upload accept=".json" showUploadList={false} beforeUpload={(file) => { void importDocument(file); return false; }}><Button>{t('studio.import')}</Button></Upload>
      {canvas && <StudioDirector kind="canvas" document={canvas} onApply={(proposal) => commit(proposal as CanvasDocument)} />}<Button disabled={!canvas} onClick={() => void exportDocument()}>{t('studio.export')}</Button>
      <Popconfirm title={t('studio.deleteConfirm')} onConfirm={() => canvas && store.removeCanvas(canvas.id)}><Button danger disabled={!canvas} icon={<DeleteOutlined />} aria-label={t('studio.delete')} /></Popconfirm>
    </div>
    <div className="studio-canvas-body">
      <div className="studio-canvas-surface" ref={surface} tabIndex={0} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Delete') removeNode(); if (event.key === 'Escape') { setConnecting(undefined); setSelection([]); setSelected(undefined); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && canvas) { event.preventDefault(); setSelection(canvas.nodes.map((node) => node.id)); setSelected(canvas.nodes[0]?.id); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); } }} onWheel={(event) => { if ((event.target as HTMLElement).closest('textarea,video,audio')) return; zoom(event.deltaY > 0 ? 0.94 : 1.06); }} onPointerDown={(event) => { if ((event.target as HTMLElement).closest('.studio-canvas-node,.studio-canvas-group,.studio-canvas-minimap,.studio-canvas-zoom') || event.button !== 0) return; surface.current?.focus(); if (event.shiftKey) { const rect = event.currentTarget.getBoundingClientRect(); drag.current = { mode: 'marquee', startX: event.clientX, startY: event.clientY, x: event.clientX - rect.left, y: event.clientY - rect.top, selection: event.ctrlKey || event.metaKey ? selection : [] }; } else { setSelected(undefined); setSelection([]); drag.current = { mode: 'pan', startX: event.clientX, startY: event.clientY, x: viewport.x, y: viewport.y }; } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void importMedia(event.dataTransfer.files); }}>
        {!canvas?.nodes.length && <div className="studio-canvas-empty"><Empty description={t('studio.canvas.panHint')} /><Button loading={creating} onClick={() => addNode('text')}>{t('studio.canvas.add')}</Button></div>}
        <div className="studio-canvas-layer" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
          {canvas?.groups?.map((group) => { const members = canvas.nodes.filter((node) => group.nodeIds.includes(node.id)); if (!members.length) return null; const left = Math.min(...members.map((node) => positionOf(node).x)) - 20, top = Math.min(...members.map((node) => positionOf(node).y)) - 40; const right = Math.max(...members.map((node) => positionOf(node).x + (nodeSizes[node.id]?.width ?? node.width ?? 260))) + 20, bottom = Math.max(...members.map((node) => positionOf(node).y + (nodeSizes[node.id]?.height ?? node.height ?? 300))) + 20; return <div key={group.id} data-group-id={group.id} className={`studio-canvas-group ${group.nodeIds.every((id) => selection.includes(id)) ? 'is-selected' : ''}`} style={{ left, top, width: right - left, height: bottom - top }}><button type="button" onPointerDown={(event) => startNodeDrag(event, members[0].id)}>{group.name}</button></div>; })}
          <svg className="studio-canvas-edges" aria-hidden="true">{canvas?.edges.map((edge) => { const from = canvas.nodes.find((node) => node.id === edge.from), to = canvas.nodes.find((node) => node.id === edge.to); if (!from || !to) return null; const a = positionOf(from), b = positionOf(to); return <path key={edge.id} d={`M${a.x + (nodeSizes[from.id]?.width ?? from.width ?? 260)} ${a.y + 24} C${a.x + (nodeSizes[from.id]?.width ?? from.width ?? 260) + 100} ${a.y + 24},${b.x - 100} ${b.y + 24},${b.x} ${b.y + 24}`} />; })}</svg>
          {canvas?.nodes.map((node) => { const position = positionOf(node); const job = store.jobs.slice().reverse().find((item) => item.nodeId === node.id && item.canvasId === canvas.id); return <article key={node.id} data-node-id={node.id} className={`studio-canvas-node ${selection.includes(node.id) ? 'is-selected' : ''}`} style={{ left: position.x, top: position.y, width: resizing?.id === node.id ? resizing.width : node.width, minHeight: resizing?.id === node.id ? resizing.height : node.height }} onPointerDown={(event) => { selectNode(node.id, event.shiftKey || event.ctrlKey || event.metaKey); }}>
            <header onPointerDown={(event) => { if (!(event.target as HTMLElement).closest('button')) startNodeDrag(event, node.id); }}>
              <button type="button" className="studio-canvas-port is-input" aria-label={`${node.name} ${t('studio.canvas.input')}`} onClick={() => connect(node.id)} /><strong>{node.name}</strong>{node.layoutLocked && <Tag>{t('studio.canvas.locked')}</Tag>}<Tag>{t(`studio.kind.${node.kind}`)}</Tag><button type="button" className="studio-canvas-port is-output" aria-label={`${node.name} ${t('studio.canvas.output')}`} onClick={() => setConnecting(node.id)} />
            </header>
            <StudioMedia asset={store.assets.find((asset) => asset.id === node.assetId)} />
            <Input.TextArea key={`${node.id}:${node.prompt}`} aria-label={`${node.name} ${t('studio.creator.prompt')}`} defaultValue={node.prompt} placeholder={t('studio.creator.prompt')} autoSize={{ minRows: 2, maxRows: 5 }} onBlur={(event) => { if (event.target.value !== node.prompt) updateNode(node.id, { prompt: event.target.value }); }} />
            <footer>{job && <Tag color={job.status === 'failed' ? 'error' : 'processing'}>{t(`studio.task.${job.status}`)}</Tag>}{['image', 'video', 'text'].includes(node.kind) ? <Button size="small" type="primary" loading={job?.status === 'running' || job?.status === 'queued'} onClick={() => submitNode(node)}>{t('studio.canvas.generate')}</Button> : node.kind === 'world' ? <Button size="small" onClick={() => openWorld(node)}>{t('studio.canvas.openWorld')}</Button> : null}</footer>
            {!node.layoutLocked && <button type="button" className="studio-canvas-resize" aria-label={t('studio.canvas.resize')} onPointerDown={(event) => startResize(event, node)} />}
          </article>; })}
        </div>
        {marquee && <div className="studio-canvas-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
        <span className="studio-canvas-gesture-hint">{t('studio.canvas.selectionHint')}</span>
        <div className="studio-canvas-zoom"><Button icon={<MinusOutlined />} aria-label={t('studio.canvas.zoomOut')} onClick={() => zoom(0.8)} /><span>{Math.round(viewport.zoom * 100)}%</span><Button icon={<PlusOutlined />} aria-label={t('studio.canvas.zoomIn')} onClick={() => zoom(1.25)} /><Tooltip title={t('studio.canvas.fit')}><Button icon={<AimOutlined />} onClick={fit} /></Tooltip></div>
        {connecting && <Tag className="studio-canvas-connect-hint" color="blue" closable onClose={() => setConnecting(undefined)}>{t('studio.canvas.connectHint')}</Tag>}
        {canvas && canvas.nodes.length > 0 && <svg className="studio-canvas-minimap" viewBox="0 0 180 110" aria-label={t('studio.canvas.fit')} onClick={fit}>{canvas.nodes.map((node) => { const minX = Math.min(...canvas.nodes.map((n) => n.x)), minY = Math.min(...canvas.nodes.map((n) => n.y)); const sx = 160 / Math.max(600, ...canvas.nodes.map((n) => n.x + (nodeSizes[n.id]?.width ?? n.width ?? 260) - minX)), sy = 90 / Math.max(400, ...canvas.nodes.map((n) => n.y + (nodeSizes[n.id]?.height ?? n.height ?? 300) - minY)); return <rect key={node.id} x={10 + (node.x - minX) * sx} y={10 + (node.y - minY) * sy} width={(nodeSizes[node.id]?.width ?? node.width ?? 260) * sx} height={(nodeSizes[node.id]?.height ?? node.height ?? 300) * sy} className={selected === node.id ? 'is-selected' : ''} />; })}</svg>}
      </div>
      {active && <aside className="studio-canvas-inspector"><Input key={`${active.id}:${active.name}:name`} aria-label={t('studio.rename')} defaultValue={active.name} onBlur={(event) => { if (event.target.value !== active.name) updateNode(active.id, { name: event.target.value }); }} />{activeGroup && <label>{t('studio.canvas.groupName')}<Input key={`${activeGroup.id}:${activeGroup.name}`} aria-label={t('studio.canvas.groupName')} defaultValue={activeGroup.name} onBlur={(event) => { if (canvas && event.target.value.trim() && event.target.value !== activeGroup.name) commit({ ...canvas, groups: canvas.groups?.map((group) => group.id === activeGroup.id ? { ...group, name: event.target.value.trim() } : group) }); }} /></label>}<StudioNodeSettings node={active} onChange={(generation) => updateNode(active.id, { generation })} /><label>{t('studio.canvas.asset')}</label><Select allowClear showSearch optionFilterProp="label" value={active.assetId} onChange={(assetId) => updateNode(active.id, { assetId })} options={store.assets.filter((asset) => asset.kind === active.kind || active.kind === 'world' && asset.kind === 'image').map((asset) => ({ value: asset.id, label: asset.name }))} />{(() => { const asset = store.assets.find((asset) => asset.id === active.assetId); return asset ? <>{asset.kind === 'image' && <Button onClick={() => setEditing(asset)}>{t('studio.edit.title')}</Button>}<StudioProjectTransfer asset={asset} /></> : null; })()}<Button icon={<LinkOutlined />} onClick={() => setConnecting(active.id)}>{t('studio.canvas.connect')}</Button><Button onClick={() => canvas && commit({ ...canvas, edges: canvas.edges.filter((edge) => edge.from !== active.id && edge.to !== active.id) })}>{t('studio.canvas.unlink')}</Button><Button icon={<DeleteOutlined />} danger onClick={removeNode}>{t('studio.delete')}</Button></aside>}
    </div>
    {editing && <StudioImageEditor asset={editing} onClose={() => setEditing(undefined)} onSaved={(asset) => { if (!canvas) return; const latest = useVideoStudioStore.getState().canvases.find((item) => item.id === canvas.id) ?? canvas; commit({ ...latest, nodes: [...latest.nodes, { id: studioId(), kind: 'image', name: asset.name, prompt: '', assetId: asset.id, x: (active?.x ?? 0) + 300, y: active?.y ?? 100 }] }); }} />}
  </div>;
}

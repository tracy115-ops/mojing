import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Segmented, Slider, Space, Tag, Typography, message } from 'antd';
import { ClearOutlined, RedoOutlined, RotateRightOutlined, UndoOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { providerRouter } from '@/services/providers';
import { readAsDataUri } from '@/services/video/asset-store';
import { retainStudioMedia, submitStudioJob } from '@/services/video-studio/generation';
import { initialStudioInput } from '@/services/video-studio/input';
import { studioId, studioNow } from '@/services/video-studio/document';
import { imageMaskGuide, loadMaskImage, maskHasSelection, paintMaskOverlay, renderImageMask, type MaskPoint, type MaskStroke } from '@/services/video-studio/image-mask';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useProviderStore } from '@/stores/providerStore';
import type { StudioAsset, StudioGenerationInput } from '@/types/video-studio';
import type { ImageGenerationCapabilities } from '@/types/providers';
import StudioNodeSettings from './StudioNodeSettings';
import './StudioImageEditor.css';

type Region = { x: number; y: number; width: number; height: number };
function nearestAspectRatio(width: number, height: number): string {
  return ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'].reduce((best, ratio) => {
    const distance = (value: string) => { const [w, h] = value.split(':').map(Number); return Math.abs(Math.log(width / height / (w / h))); };
    return distance(ratio) < distance(best) ? ratio : best;
  });
}
const rectangleStroke = (region: Region): MaskStroke => ({ tool: 'rectangle', size: 0, points: [{ x: region.x, y: region.y }, { x: region.x + region.width, y: region.y + region.height }] });

export default function StudioImageEditor({ asset, onClose, onSaved }: { asset: StudioAsset; onClose: () => void; onSaved?: (asset: StudioAsset) => void }) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null), overlay = useRef<HTMLCanvasElement>(null), image = useRef<HTMLImageElement | null>(null);
  const pointer = useRef<{ id: number; first: MaskPoint; stroke?: MaskStroke } | null>(null);
  const [rotation, setRotation] = useState(0), [region, setRegion] = useState<Region>(), [mode, setMode] = useState('region');
  const [strokes, setStrokes] = useState<MaskStroke[]>([]), [redo, setRedo] = useState<MaskStroke[]>([]), [draft, setDraft] = useState<MaskStroke>();
  const [tool, setTool] = useState<'brush' | 'erase'>('brush'), [brushSize, setBrushSize] = useState(8), [feather, setFeather] = useState(1), [maskView, setMaskView] = useState('overlay'), [strength, setStrength] = useState(0.65);
  const [selected, setSelected] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [input, setInput] = useState<StudioGenerationInput>(() => ({ ...initialStudioInput(), kind: 'image' }));
  const providers = useProviderStore();
  let capabilities: ImageGenerationCapabilities | undefined;
  try { capabilities = providerRouter.getImageCapabilities('storyboard', input.model, input.endpointId); } catch { /* Model setup is available in the editor. */ }
  const nativeMask = !!capabilities?.references.maskSupported;
  const canEdit = (capabilities?.references.maxImages ?? 0) >= (selected && !nativeMask ? 2 : 1) && providers.getEndpointsByCategory('image').length > 0;
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const source = await loadMaskImage(await readAsDataUri(asset.url!));
        if (!disposed) { image.current = source; setInput((value) => ({ ...value, aspectRatio: nearestAspectRatio(source.naturalWidth, source.naturalHeight) })); setReady(true); }
      } catch { if (!disposed) setError(t('studio.edit.loadFailed')); }
    })();
    return () => { disposed = true; image.current = null; };
  }, [asset.id, asset.url, t]);

  const render = (target: HTMLCanvasElement) => {
    const source = image.current;
    if (!source) throw new Error(t('studio.edit.loadFailed'));
    target.width = rotation % 180 ? source.naturalHeight : source.naturalWidth;
    target.height = rotation % 180 ? source.naturalWidth : source.naturalHeight;
    const ctx = target.getContext('2d')!;
    ctx.translate(target.width / 2, target.height / 2); ctx.rotate(rotation * Math.PI / 180); ctx.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2); ctx.setTransform(1, 0, 0, 1, 0, 0);
    return target;
  };
  const activeStrokes = () => mode === 'brush' ? [...strokes, ...(draft ? [draft] : [])] : mode === 'region' && region ? [rectangleStroke(region)] : [];
  useEffect(() => { if (ready && canvas.current) render(canvas.current); }, [ready, rotation]);
  useEffect(() => {
    if (!ready || !canvas.current || !overlay.current) return;
    const base = canvas.current, scale = Math.min(1, 512 / Math.max(base.width, base.height));
    const mask = renderImageMask(Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale)), activeStrokes(), feather / 100);
    setSelected(maskHasSelection(mask));
    if (maskView === 'mask') { overlay.current.width = mask.width; overlay.current.height = mask.height; overlay.current.getContext('2d')!.drawImage(mask, 0, 0); }
    else paintMaskOverlay(overlay.current, mask, getComputedStyle(overlay.current).getPropertyValue('--accent-primary').trim());
  }, [ready, rotation, region, mode, strokes, draft, feather, maskView]);
  useEffect(() => {
    if (selected && canvas.current) {
      const ratio = nearestAspectRatio(canvas.current.width, canvas.current.height);
      setInput((value) => value.aspectRatio === ratio ? value : { ...value, aspectRatio: ratio });
    }
  }, [selected, rotation]);

  const clear = () => { setStrokes([]); setRedo([]); setRegion(undefined); setDraft(undefined); setSelected(false); pointer.current = null; };
  const save = async (target: HTMLCanvasElement, suffix: string): Promise<StudioAsset> => {
    const saved: StudioAsset = { id: studioId(), kind: 'image', name: `${asset.name} · ${suffix}`, category: 'reference', createdAt: studioNow(), folderId: asset.folderId, tags: asset.tags, width: target.width, height: target.height, mimeType: 'image/png', url: await retainStudioMedia(target.toDataURL('image/png'), 'image') };
    useVideoStudioStore.getState().addAsset(saved); return saved;
  };
  const fullMask = (base: HTMLCanvasElement) => renderImageMask(base.width, base.height, activeStrokes(), feather / 100);
  const saveMask = async () => {
    setBusy(true);
    try { const base = render(document.createElement('canvas')); await save(fullMask(base), t('studio.edit.mask.asset')); message.success(t('studio.saved')); }
    catch (failure) { message.error(String(failure)); } finally { setBusy(false); }
  };
  const saveCopy = async () => {
    setBusy(true);
    try {
      const base = render(document.createElement('canvas')); let output = base;
      if (region && mode === 'crop') {
        output = document.createElement('canvas'); output.width = Math.max(1, Math.round(base.width * region.width)); output.height = Math.max(1, Math.round(base.height * region.height));
        output.getContext('2d')!.drawImage(base, Math.round(base.width * region.x), Math.round(base.height * region.y), output.width, output.height, 0, 0, output.width, output.height);
      }
      const saved = await save(output, t('studio.edit.copy')); onSaved?.(saved); message.success(t('studio.saved')); onClose();
    } catch (failure) { message.error(String(failure)); } finally { setBusy(false); }
  };
  const edit = async () => {
    setBusy(true);
    try {
      const base = render(document.createElement('canvas')), source = await save(base, t('studio.edit.source')), refs = [source.id];
      let prompt = `Edit the supplied original image according to the user instruction. Preserve its identity, composition and all unrelated details.\nUser instruction: ${input.prompt}`;
      let imageEdit: StudioGenerationInput['imageEdit'];
      if (selected) {
        const mask = fullMask(base);
        if (!maskHasSelection(mask)) throw new Error(t('studio.edit.mask.empty'));
        const maskAsset = await save(mask, t('studio.edit.mask.asset'));
        imageEdit = { mode: nativeMask ? 'native_mask' : 'local_composite', sourceAssetId: source.id, maskAssetId: maskAsset.id, strength, instruction: input.prompt.trim() };
        if (nativeMask) prompt = `Edit the white area of the separate grayscale mask. Black areas must be preserved. Keep the source composition and identity.\nUser instruction: ${input.prompt}`;
        else {
          refs.push((await save(imageMaskGuide(base, mask), t('studio.edit.guide'))).id);
          prompt = `Image 1 is the original to edit. Image 2 is only a location guide: its red markings identify the requested edit region. Apply the user instruction within that region, preserve the source composition and alignment, and remove all red markings from the result.\nUser instruction: ${input.prompt}`;
        }
      }
      submitStudioJob({ ...input, kind: 'image', prompt, referenceAssetIds: refs, controlMode: 'text', imageEdit });
      message.success(t('studio.creator.queued')); onClose();
    } catch (failure) { message.error(String(failure)); } finally { setBusy(false); }
  };
  const point = (event: React.PointerEvent<HTMLDivElement>): MaskPoint => { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) }; };
  const updatePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = pointer.current; if (!current || current.id !== event.pointerId) return;
    const next = point(event);
    if (current.stroke) {
      const points = current.stroke.points, last = points[points.length - 1];
      if (points.length < 2000 && Math.hypot(last.x - next.x, last.y - next.y) > 0.001) { current.stroke = { ...current.stroke, points: [...points, next] }; setDraft(current.stroke); }
    } else setRegion({ x: Math.min(current.first.x, next.x), y: Math.min(current.first.y, next.y), width: Math.abs(next.x - current.first.x), height: Math.abs(next.y - current.first.y) });
  };
  return <Modal open width={1120} className="studio-image-editor" title={`${t('studio.edit.title')} · ${asset.name}`} onCancel={() => !busy && onClose()} footer={null} destroyOnClose>
    <div className="studio-image-editor-layout" data-testid="studio-image-editor"><section>
      <Space wrap><Segmented value={mode} disabled={busy} onChange={(value) => { clear(); setMode(value); }} options={['region', 'brush', 'crop'].map((value) => ({ value, label: t(`studio.edit.${value}`) }))} /><Button aria-label={t('studio.edit.rotate')} icon={<RotateRightOutlined />} disabled={!ready || busy} onClick={() => { clear(); setRotation((rotation + 90) % 360); setInput((value) => ({ ...value, aspectRatio: value.aspectRatio.split(':').reverse().join(':') })); }}>{t('studio.edit.rotate')}</Button><Button icon={<UndoOutlined />} disabled={busy} onClick={() => { clear(); setRotation(0); if (image.current) setInput((value) => ({ ...value, aspectRatio: nearestAspectRatio(image.current!.naturalWidth, image.current!.naturalHeight) })); }}>{t('studio.edit.reset')}</Button></Space>
      {mode !== 'crop' && <div className="studio-image-mask-tools">
        {mode === 'brush' && <><Segmented size="small" value={tool} disabled={busy} onChange={(value) => setTool(value as typeof tool)} options={['brush', 'erase'].map((value) => ({ value, label: t(`studio.edit.mask.${value}`) }))} /><label>{t('studio.edit.mask.size')}<Slider aria-label={t('studio.edit.mask.size')} min={1} max={40} value={brushSize} onChange={setBrushSize} disabled={busy} /></label><Button size="small" icon={<UndoOutlined />} aria-label={t('studio.edit.mask.undo')} disabled={busy || !strokes.length} onClick={() => { setRedo([...redo, strokes[strokes.length - 1]]); setStrokes(strokes.slice(0, -1)); }} /><Button size="small" icon={<RedoOutlined />} aria-label={t('studio.edit.mask.redo')} disabled={busy || !redo.length} onClick={() => { setStrokes([...strokes, redo[redo.length - 1]]); setRedo(redo.slice(0, -1)); }} /></>}
        <Button size="small" icon={<ClearOutlined />} disabled={busy || !selected} onClick={clear}>{t('studio.edit.mask.clear')}</Button><Segmented size="small" value={maskView} disabled={busy} onChange={setMaskView} options={['overlay', 'mask'].map((value) => ({ value, label: t(`studio.edit.mask.${value}`) }))} />
      </div>}
      {error && <Alert type="error" message={error} />}
      <div className="studio-image-editor-stage"><div className="studio-image-editor-preview" data-testid="studio-image-edit-surface" onPointerDown={(event) => {
        if (!ready || busy || event.button !== 0 || pointer.current || mode === 'brush' && strokes.length >= 200) return;
        event.currentTarget.setPointerCapture(event.pointerId); const first = point(event);
        pointer.current = { id: event.pointerId, first, ...(mode === 'brush' ? { stroke: { tool, size: brushSize / 100, points: [first] } } : {}) };
        if (mode === 'brush') setDraft(pointer.current.stroke); else setRegion(undefined);
      }} onPointerMove={updatePointer} onPointerUp={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        updatePointer(event); const current = pointer.current;
        if (current.stroke) { setStrokes((items) => [...items, current.stroke!]); setRedo([]); }
        else { const next = point(event); if (Math.abs(next.x - current.first.x) < 0.005 || Math.abs(next.y - current.first.y) < 0.005) setRegion(undefined); }
        setDraft(undefined); pointer.current = null;
      }} onPointerCancel={() => { pointer.current = null; setDraft(undefined); }}>
        <canvas ref={canvas} />{mode !== 'crop' && <canvas ref={overlay} className={`studio-image-mask-overlay ${maskView === 'mask' ? 'is-mask' : ''}`} data-testid="image-edit-mask" />}{region && <div className={`studio-image-editor-region is-${mode}`} style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />}
      </div></div>
      <Typography.Paragraph type="secondary">{t(mode === 'brush' ? 'studio.edit.mask.drawHint' : 'studio.edit.dragHint')}</Typography.Paragraph>
      <Space wrap><Button disabled={!ready || busy} loading={busy} onClick={() => void saveCopy()} data-testid="studio-image-save-copy">{t(mode === 'crop' ? 'studio.edit.saveCrop' : 'studio.edit.saveCopy')}</Button>{mode !== 'crop' && <Button disabled={!selected || busy} onClick={() => void saveMask()}>{t('studio.edit.mask.save')}</Button>}</Space>
    </section><aside><Typography.Text strong>{t('studio.edit.ai')}</Typography.Text><Tag color={selected ? nativeMask ? 'success' : 'processing' : undefined}>{t(selected ? nativeMask ? 'studio.edit.mask.native' : 'studio.edit.mask.composite' : 'studio.edit.mask.fullImage')}</Tag><Input.TextArea aria-label={t('studio.edit.instruction')} disabled={busy} value={input.prompt} onChange={(event) => setInput({ ...input, prompt: event.target.value })} rows={4} placeholder={t('studio.edit.placeholder')} />
      <div className={busy ? 'studio-image-editor-settings is-disabled' : 'studio-image-editor-settings'}><StudioNodeSettings fixedAspectRatio={selected} node={{ id: 'editor', kind: 'image', name: asset.name, prompt: '', x: 0, y: 0, generation: input }} onChange={(generation) => !busy && setInput({ ...initialStudioInput(), ...generation, kind: 'image' })} /></div>
      {mode !== 'crop' && <label className="studio-image-mask-slider">{t('studio.edit.mask.feather')}<Slider aria-label={t('studio.edit.mask.feather')} min={0} max={8} step={0.5} value={feather} onChange={setFeather} disabled={busy} /></label>}
      {selected && nativeMask && <label className="studio-image-mask-slider">{t('studio.edit.mask.strength')}<Slider aria-label={t('studio.edit.mask.strength')} min={0.05} max={1} step={0.05} value={strength} onChange={setStrength} disabled={busy} /></label>}
      <Alert type="info" message={t(mode === 'crop' ? 'studio.edit.mask.cropHint' : selected ? nativeMask ? 'studio.edit.mask.nativeHint' : 'studio.edit.mask.compositeHint' : 'studio.edit.mask.selectHint')} />{!canEdit && <Typography.Text type="warning">{t('studio.edit.modelRequired')}</Typography.Text>}
      <Button type="primary" disabled={!ready || !input.prompt.trim() || !canEdit || busy || mode === 'crop' && !!region || mode === 'brush' && !selected} loading={busy} onClick={() => void edit()} data-testid="studio-image-ai-edit">{t('studio.edit.submit')}</Button>
    </aside></div>
  </Modal>;
}

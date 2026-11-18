import { useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Popconfirm, Select, Space, Tag, Typography, Upload, message } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import { parseDirectorJSON } from '@/services/video-studio/director';
import { initialStudioInput } from '@/services/video-studio/input';
import { studioId, studioNow } from '@/services/video-studio/document';
import { downloadStudioFile, importStudioFile, submitStudioJob } from '@/services/video-studio/generation';
import { readAsDataUri } from '@/services/video/asset-store';
import type { StudioAsset, StudioCommerceProject } from '@/types/video-studio';
import type { ImageGenerationCapabilities } from '@/types/providers';
import StudioMedia from './StudioMedia';
import './StudioCommerce.css';

export default function StudioCommerce() {
  const { t } = useTranslation();
  const store = useVideoStudioStore(), providers = useProviderStore();
  const [projectId, setProjectId] = useState<string>(), [selected, setSelected] = useState<string[]>([]), [planning, setPlanning] = useState(false), [error, setError] = useState('');
  const [endpointId, setEndpointId] = useState<string>(), [model, setModel] = useState<string>(), [preview, setPreview] = useState<StudioAsset>();
  const project = store.commerceProjects.find((item) => item.id === projectId) ?? store.commerceProjects[0];
  const endpoint = providers.getEndpointsByCategory('image').find((item) => item.id === endpointId) ?? providers.getActiveEndpoint('image');
  let capabilities: ImageGenerationCapabilities | undefined;
  try { capabilities = providerRouter.getImageCapabilities('storyboard', model, endpoint?.id); } catch { /* Configuration gate below. */ }
  const update = (patch: Partial<StudioCommerceProject>) => { if (project) store.saveCommerceProject({ ...project, ...patch, updatedAt: studioNow() }); };
  const create = () => {
    const doc: StudioCommerceProject = { id: studioId(), name: `${t('studio.commerce.new')} ${store.commerceProjects.length + 1}`, product: '', facts: '', audience: '', platform: 'general', style: '', references: [], aspectRatio: '1:1', imageSize: '2K', plan: [], jobIds: [], updatedAt: studioNow() };
    store.saveCommerceProject(doc); setProjectId(doc.id); setSelected([]);
  };
  const briefFor = (doc: StudioCommerceProject) => `${t('studio.commerce.product')}: ${doc.product}\n${t('studio.commerce.facts')}: ${doc.facts}\n${t('studio.commerce.audience')}: ${doc.audience}\n${t('studio.commerce.platform')}: ${doc.platform}\n${t('studio.commerce.style')}: ${doc.style}`;
  const addSlot = () => {
    if (!project) return;
    update({ plan: [...project.plan, { id: studioId(), name: `${t('studio.commerce.material')} ${project.plan.length + 1}`, prompt: '' }] });
  };
  const defaultPlan = () => {
    if (!project) return;
    const plan = ['hero', 'detail', 'lifestyle'].map((key) => ({ id: studioId(), name: t(`studio.commerce.${key}`), prompt: t(`studio.commerce.${key}Prompt`) }));
    update({ plan }); setSelected(plan.map((slot) => slot.id));
  };
  const aiPlan = async () => {
    if (!project) return;
    const llm = providers.getActiveEndpoint('llm');
    if (!llm) { message.info(t('studio.creator.noEndpoint')); return; }
    setPlanning(true); setError('');
    const baseRevision = project.updatedAt;
    try {
      const result = await providerRouter.generate({ taskType: 'planning', endpointId: llm.id, responseFormat: 'json', maxTokens: 5000,
        systemPrompt: 'You are an ecommerce art director. Return JSON {"materials":[{"name":"...","prompt":"..."}]} with 3 to 8 complementary material plans in the user language: hero, details, lifestyle, packaging, or campaign. Preserve exact product shape, branding, color, materials and supplied facts. Never invent discounts, certifications, sales figures, specifications, health effects or performance claims. Distinguish product identity references from style references. Each prompt must describe a specific shot, composition, lighting, background, and space reserved for typography. These are editable plans, not image generation. No markdown.',
        userPrompt: briefFor(project),
      });
      const data = parseDirectorJSON(result.content) as { materials?: Array<{ name: string; prompt: string }> };
      if (!Array.isArray(data.materials) || !data.materials.length || data.materials.length > 12 || data.materials.some((slot) => !slot || typeof slot.name !== 'string' || typeof slot.prompt !== 'string' || !slot.prompt.trim())) throw new Error(t('studio.commerce.invalidPlan'));
      const latest = useVideoStudioStore.getState().commerceProjects.find((item) => item.id === project.id);
      if (latest?.updatedAt !== baseRevision) throw new Error(t('studio.director.stale'));
      const plan = data.materials.map((slot) => ({ id: studioId(), name: slot.name, prompt: slot.prompt }));
      update({ plan }); setSelected(plan.map((slot) => slot.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPlanning(false); }
  };
  const generate = (slotIds: string[]) => {
    if (!project || !endpoint) return;
    try {
      const references = project.references.map((reference) => ({ ...reference, asset: store.assets.find((asset) => asset.id === reference.assetId) }));
      if (references.some((reference) => !reference.asset?.url)) throw new Error(t('studio.commerce.missingReference'));
      if (references.length > (capabilities?.references.maxImages ?? 0)) throw new Error(t('studio.commerce.referenceLimit'));
      const ids = project.plan.filter((slot) => slotIds.includes(slot.id)).map((slot) => submitStudioJob({ ...initialStudioInput(), kind: 'image', endpointId: endpoint.id, model: model ?? capabilities?.model, aspectRatio: project.aspectRatio, imageSize: project.imageSize,
        prompt: `${briefFor(project)}\n\n${references.map((reference, index) => `Reference ${index + 1}: ${t(`studio.commerce.role.${reference.role}`)} — ${reference.asset?.name}`).join('\n')}\n\n${slot.name}\n${slot.prompt}\n${t('studio.commerce.identityRule')}`,
        referenceAssetIds: references.map((reference) => reference.assetId),
      }));
      update({ jobIds: [...project.jobIds, ...ids] }); message.success(t('studio.creator.queued'));
    } catch (reason) { message.error(`${t('studio.failed')}: ${String(reason)}`); }
  };
  const outputs = project ? project.jobIds.map((id) => store.jobs.find((job) => job.id === id)).filter((job) => !!job).reverse() : [];
  const exportGallery = async () => {
    if (!project) return;
    try {
      const assets = outputs.flatMap((job) => { const asset = store.assets.find((item) => item.id === job.outputAssetId); return asset?.kind === 'image' && asset.url ? [asset] : []; }).slice(0, 12);
      if (!assets.length) return;
      const images = await Promise.all(assets.map(async (asset) => { const uri = await readAsDataUri(asset.url!); if (!uri.startsWith('data:')) throw new Error(t('studio.commerce.missingReference')); const image = new Image(); image.src = uri; await image.decode(); return image; }));
      const width = 1200, columns = Math.min(3, images.length), cell = width / columns, canvas = document.createElement('canvas'); canvas.width = width; canvas.height = Math.ceil(images.length / columns) * cell;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((image, index) => { const ratio = Math.min((cell - 16) / image.width, (cell - 16) / image.height); ctx.drawImage(image, index % columns * cell + (cell - image.width * ratio) / 2, Math.floor(index / columns) * cell + (cell - image.height * ratio) / 2, image.width * ratio, image.height * ratio); });
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Image export failed')), 'image/png'));
      downloadStudioFile(blob, `${project.name}.png`);
    } catch (reason) { message.error(String(reason)); }
  };
  return <div className="video-studio-content" data-testid="studio-commerce">
    <div className="video-studio-toolbar"><Select aria-label={t('studio.commerce.history')} value={project?.id} onChange={(id) => { setProjectId(id); setSelected([]); }} options={store.commerceProjects.map((item) => ({ value: item.id, label: item.name }))} /><Button data-testid="studio-commerce-new" icon={<PlusOutlined />} onClick={create}>{t('studio.commerce.new')}</Button>{project && <Popconfirm title={t('studio.deleteConfirm')} onConfirm={() => store.removeCommerceProject(project.id)}><Button danger>{t('studio.delete')}</Button></Popconfirm>}</div>
    {!project ? <Empty description={t('studio.empty')} /> : <div className="studio-commerce-layout"><aside className="video-studio-card studio-commerce-brief">
      <Input aria-label={t('studio.rename')} value={project.name} onChange={(event) => update({ name: event.target.value })} />
      {(['product', 'facts', 'audience', 'style'] as const).map((field) => <label key={field}>{t(`studio.commerce.${field}`)}<Input.TextArea rows={field === 'facts' ? 4 : 2} value={project[field]} disabled={planning} onChange={(event) => update({ [field]: event.target.value })} /></label>)}
      <label>{t('studio.commerce.platform')}<Select value={project.platform} onChange={(platform) => update({ platform })} options={['general', 'taobao', 'douyin', 'xiaohongshu', 'amazon', 'shopify'].map((value) => ({ value, label: t(`studio.commerce.platform.${value}`) }))} /></label>
      <div className="video-studio-fields"><label>{t('studio.creator.ratio')}<Select value={project.aspectRatio} onChange={(aspectRatio) => update({ aspectRatio })} options={['1:1', '3:4', '4:3', '9:16', '16:9'].map((value) => ({ value, label: value }))} /></label><label>{t('studio.creator.size')}<Select value={project.imageSize} onChange={(imageSize) => update({ imageSize })} options={(capabilities?.parameters.find((spec) => spec.key === 'size')?.enumValues?.filter((value) => /K$/i.test(value)) ?? ['2K']).map((value) => ({ value, label: value }))} /></label></div>
      <Select aria-label={t('studio.creator.endpoint')} value={endpoint?.id} onChange={(id) => { setEndpointId(id); setModel(undefined); }} options={providers.getEndpointsByCategory('image').map((item) => ({ value: item.id, label: item.name }))} />
      <Select aria-label={t('studio.creator.models')} value={model ?? capabilities?.model} onChange={setModel} options={capabilities?.availableModels?.map((value) => ({ value, label: value })) ?? []} />
      <Typography.Text strong>{t('studio.creator.references')}</Typography.Text>
      <Select mode="multiple" aria-label={t('studio.creator.references')} value={project.references.map((reference) => reference.assetId)} onChange={(ids) => update({ references: ids.map((assetId) => project.references.find((reference) => reference.assetId === assetId) ?? { assetId, role: 'product' }) })} options={store.assets.filter((asset) => asset.kind === 'image').map((asset) => ({ value: asset.id, label: asset.name }))} />
      <Upload accept="image/*" showUploadList={false} beforeUpload={(file) => { void importStudioFile(file).then((asset) => update({ references: [...project.references, { assetId: asset.id, role: 'product' }] })).catch((reason) => message.error(String(reason))); return false; }}><Button>{t('studio.creator.upload')}</Button></Upload>
      {project.references.map((reference) => <div className="studio-commerce-reference" key={reference.assetId}><StudioMedia asset={store.assets.find((asset) => asset.id === reference.assetId)} /><Select size="small" aria-label={t('studio.commerce.referenceRole')} value={reference.role} onChange={(role) => update({ references: project.references.map((item) => item.assetId === reference.assetId ? { ...item, role } : item) })} options={['product', 'detail', 'style', 'logo', 'model'].map((value) => ({ value, label: t(`studio.commerce.role.${value}`) }))} /></div>)}
    </aside><section className="studio-commerce-production"><div className="video-studio-toolbar"><Button disabled={planning} onClick={defaultPlan}>{t('studio.commerce.defaultPlan')}</Button><Button loading={planning} disabled={!project.product.trim()} onClick={() => void aiPlan()}>{t('studio.commerce.aiPlan')}</Button><Button onClick={addSlot}>{t('studio.commerce.addMaterial')}</Button><Button type="primary" disabled={!endpoint || !selected.length || selected.some((id) => !project.plan.find((slot) => slot.id === id)?.prompt.trim())} onClick={() => generate(selected)}>{t('studio.commerce.generateSelected', { count: selected.length })}</Button></div>
      {!endpoint && <Alert type="info" message={t('studio.creator.noEndpoint')} />}{error && <Alert type="error" message={error} />}
      <div className="video-studio-grid">{project.plan.map((slot) => <article className="video-studio-card" key={slot.id}><Checkbox checked={selected.includes(slot.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, slot.id] : selected.filter((id) => id !== slot.id))}><strong>{slot.name}</strong></Checkbox><Input aria-label={t('studio.rename')} value={slot.name} onChange={(event) => update({ plan: project.plan.map((item) => item.id === slot.id ? { ...item, name: event.target.value } : item) })} /><Input.TextArea aria-label={t('studio.commerce.materialPrompt')} rows={6} value={slot.prompt} onChange={(event) => update({ plan: project.plan.map((item) => item.id === slot.id ? { ...item, prompt: event.target.value } : item) })} /><Space><Button disabled={!endpoint || !slot.prompt.trim()} onClick={() => generate([slot.id])}>{t('studio.creator.generate')}</Button><Button danger onClick={() => { update({ plan: project.plan.filter((item) => item.id !== slot.id) }); setSelected(selected.filter((id) => id !== slot.id)); }}>{t('studio.delete')}</Button></Space></article>)}</div>
      <div className="studio-creator-section-heading"><Typography.Title level={4}>{t('studio.commerce.results')}</Typography.Title><Button disabled={!outputs.some((job) => job.outputAssetId)} onClick={() => void exportGallery()}>{t('studio.commerce.exportSheet')}</Button></div>
      <div className="video-studio-grid">{outputs.map((job) => <article className="video-studio-card" key={job.id}><StudioMedia asset={store.assets.find((asset) => asset.id === job.outputAssetId)} /><Typography.Text ellipsis>{job.name}</Typography.Text><Tag>{t(`studio.task.${job.status}`)}</Tag>{job.error && <Typography.Text type="danger">{job.error}</Typography.Text>}{job.outputAssetId && <Button onClick={() => setPreview(store.assets.find((asset) => asset.id === job.outputAssetId))}>{t('studio.open')}</Button>}</article>)}</div>
    </section></div>}
    <Modal open={!!preview} title={preview?.name} onCancel={() => setPreview(undefined)} footer={null} width={900} destroyOnClose><StudioMedia asset={preview} /></Modal>
  </div>;
}

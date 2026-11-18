import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, InputNumber, Segmented, Select, Space, Tag, Typography, Upload, message } from 'antd';
import { ArrowRightOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { providerRouter } from '@/services/providers';
import { importStudioFile, submitStudioJob } from '@/services/video-studio/generation';
import { initialStudioInput, normalizeStudioVideoInput } from '@/services/video-studio/input';
import { getVideoParameter, normalizeNumberForParameter } from '@/services/video/core/video-capability-utils';
import type { StudioGenerationInput } from '@/types/video-studio';
import StudioMedia from './StudioMedia';
import StudioVideoReferences from './StudioVideoReferences';
import StudioImageEditor from './StudioImageEditor';
import StudioProjectTransfer from './StudioProjectTransfer';
import type { StudioAsset } from '@/types/video-studio';
import './StudioCreator.css';

export default function StudioCreator({ initialKind, home }: { initialKind: 'image' | 'video'; home?: boolean }) {
  const { t } = useTranslation();
  const [input, setInput] = useState<StudioGenerationInput>(() => ({ ...initialStudioInput(), kind: initialKind }));
  const [editing, setEditing] = useState<StudioAsset>();
  const draft = useVideoStudioStore((state) => state.draft);
  const assets = useVideoStudioStore((state) => state.assets);
  const jobs = useVideoStudioStore((state) => state.jobs);
  const recipes = useVideoStudioStore((state) => state.recipes);
  const setPage = useVideoStudioStore((state) => state.setPage);
  const providerState = useProviderStore();
  const category = input.kind === 'text' ? 'llm' : input.kind;
  const endpoints = providerState.getEndpointsByCategory(category);
  const endpoint = endpoints.find((item) => item.id === input.endpointId) ?? providerState.getActiveEndpoint(category);
  const capabilities = useMemo(() => {
    try {
      return input.kind === 'image' ? providerRouter.getImageCapabilities('storyboard', input.model, endpoint?.id)
        : input.kind === 'video' ? providerRouter.getVideoCapabilities('clip', input.model, endpoint?.id) : providerRouter.getLLMCapabilities('generation', input.model, endpoint?.id);
    } catch { return undefined; }
  }, [input.kind, input.model, endpoint?.id, providerState.config, providerState.endpoints]);
  const models = capabilities && 'availableModels' in capabilities && capabilities.availableModels?.length ? capabilities.availableModels : endpoint?.models ?? [];
  const selectedModel = input.model || capabilities?.model || (category === 'llm' ? providerState.config.llm.defaultModel : models[0]);
  const imageAssets = assets.filter((asset) => asset.kind === 'image');
  const durationRule = input.kind === 'video' ? getVideoParameter(capabilities?.modality === 'video' ? capabilities : undefined, 'durationSeconds') : undefined;
  const sizeOptions = capabilities?.modality === 'image' ? capabilities.parameters.find((spec) => spec.key === 'size')?.enumValues?.filter((value) => /K$/i.test(value)) ?? [] : [];
  const supportsNegative = capabilities && capabilities.modality !== 'llm' && capabilities.parameters.some((spec) => spec.key === 'negativePrompt');
  const supportsSeed = capabilities && capabilities.modality !== 'llm' && capabilities.parameters.some((spec) => spec.key === 'seed');
  const patch = (value: Partial<StudioGenerationInput>) => setInput((current) => ({ ...current, ...value }));

  useEffect(() => {
    if (!draft) return;
    setInput((current) => ({ ...current, ...draft }));
    useVideoStudioStore.setState({ draft: undefined });
  }, [draft]);
  useEffect(() => {
    if (!capabilities || input.kind === 'text') return;
    setInput((current) => ({ ...current, negativePrompt: supportsNegative ? current.negativePrompt : undefined, seed: supportsSeed ? current.seed : undefined }));
  }, [capabilities, supportsNegative, supportsSeed]);
  useEffect(() => {
    if (input.kind !== 'video' || capabilities?.modality !== 'video') return;
    setInput((current) => normalizeStudioVideoInput(current, capabilities));
  }, [capabilities]);
  const changeKind = (kind: StudioGenerationInput['kind']) => patch({ kind, endpointId: undefined, model: undefined, controlMode: 'text', referenceAssetIds: [], audioReferenceAssetIds: [], videoReferenceAssetIds: [], firstFrameAssetId: undefined, lastFrameAssetId: undefined, generateAudio: undefined, imageEdit: undefined });
  const chooseReferences = (ids: string[]) => {
    if (input.kind !== 'video') { patch({ referenceAssetIds: ids }); return; }
    if (capabilities?.modality === 'video' && capabilities.references.supportsSubjectReferences && input.controlMode !== 'keyframe') {
      patch({ referenceAssetIds: ids, controlMode: ids.length ? 'reference' : 'text' });
    } else if (capabilities?.modality === 'video' && capabilities.references.supportsFirstFrame) {
      if (ids.length > (capabilities.references.supportsLastFrame ? 2 : 1)) { message.warning(t('studio.creator.frameLimit')); return; }
      patch({ controlMode: ids.length ? 'keyframe' : 'text', firstFrameAssetId: ids[0], lastFrameAssetId: ids[1], referenceAssetIds: [] });
    } else { message.warning(t('studio.creator.noReferenceSupport')); }
  };
  const generate = () => {
    try {
      const snapshot = input.kind === 'video' && capabilities?.modality === 'video' ? normalizeStudioVideoInput(input, capabilities) : input;
      if (snapshot.kind === 'video' && snapshot.controlMode === 'keyframe' && !snapshot.firstFrameAssetId) throw new Error(t('studio.creator.first'));
      submitStudioJob({ ...snapshot, endpointId: endpoint?.id, model: selectedModel });
      message.success(t('studio.creator.queued'));
    } catch (error) { message.error(`${t('studio.failed')}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const imageOptions = imageAssets.map((asset) => ({ value: asset.id, label: asset.name }));
  const recent = jobs.filter((job) => home || job.input.kind === input.kind).slice(-6).reverse();

  return <div className="video-studio-content studio-creator" data-testid="studio-creator">
    <section className="studio-creator-compose">
      <div className="video-studio-card studio-creator-brief">
        <Segmented value={input.kind} onChange={(value) => changeKind(value as StudioGenerationInput['kind'])} options={['video', 'image', 'text'].map((value) => ({ value, label: t(`studio.kind.${value}`) }))} />
        <label className="studio-creator-prompt-label" htmlFor="studio-creative-prompt">{t('studio.creator.prompt')}</label>
        <Input.TextArea id="studio-creative-prompt" data-testid="studio-creative-prompt" value={input.prompt} onChange={(event) => patch({ prompt: event.target.value })} placeholder={t('studio.creator.placeholder')} autoSize={{ minRows: 6, maxRows: 14 }} />
        {recipes.some((recipe) => recipe.kind === input.kind) && <Select allowClear aria-label={t('studio.page.skills')} placeholder={t('studio.page.skills')} value={input.recipeId} onChange={(recipeId) => patch({ recipeId, recipePrompt: undefined })} options={recipes.filter((recipe) => recipe.kind === input.kind).map((recipe) => ({ value: recipe.id, label: recipe.name }))} />}
        <div className="studio-creator-reference-list">
          {input.referenceAssetIds.map((id) => { const asset = imageAssets.find((item) => item.id === id); return asset ? <div key={id}><StudioMedia asset={asset} /><Button size="small" type="text" onClick={() => setEditing(asset)}>{t('studio.edit.title')}</Button><Button size="small" type="text" onClick={() => patch({ referenceAssetIds: input.referenceAssetIds.filter((value) => value !== id) })}>{t('studio.delete')}</Button></div> : null; })}
        </div>
        {input.kind !== 'text' && <Space wrap>
          <Upload accept="image/*" showUploadList={false} beforeUpload={(file) => { void importStudioFile(file).then((asset) => chooseReferences(input.controlMode === 'keyframe' ? [input.firstFrameAssetId, input.lastFrameAssetId, asset.id].filter((id): id is string => !!id) : [...input.referenceAssetIds, asset.id])).catch((error) => message.error(String(error))); return false; }}><Button icon={<PlusOutlined />}>{t('studio.creator.upload')}</Button></Upload>
          {input.controlMode !== 'keyframe' && <Select mode="multiple" maxTagCount={1} aria-label={t('studio.creator.references')} placeholder={t('studio.creator.references')} value={input.referenceAssetIds} onChange={chooseReferences} options={imageOptions} className="studio-creator-library-select" />}
        </Space>}
        {!endpoint && <Alert type="info" message={t('studio.creator.noEndpoint')} action={<Button size="small" onClick={() => setPage('plugins')}>{t('studio.creator.configure')}</Button>} />}
        {input.kind === 'video' && capabilities?.modality === 'video' && !capabilities.references.supported && <Alert type="info" message={t('studio.creator.textOnlyContinuity')} />}
        <Button size="large" type="primary" icon={<PlayCircleOutlined />} disabled={!input.prompt.trim() || !endpoint || (capabilities && 'adapterAvailable' in capabilities && capabilities.adapterAvailable === false)} onClick={generate} data-testid="studio-generate">{t('studio.creator.generate')}</Button>
      </div>
      <aside className="video-studio-card studio-creator-settings">
        <Typography.Text strong>{t('studio.creator.models')}</Typography.Text>
        <div className="video-studio-fields">
          <label className="span-all">{t('studio.creator.endpoint')}<Select aria-label={t('studio.creator.endpoint')} value={endpoint?.id} onChange={(endpointId) => patch({ endpointId, model: undefined })} options={endpoints.map((item) => ({ value: item.id, label: item.name }))} /></label>
          <label className="span-all">{t('studio.creator.models')}<Select aria-label={t('studio.creator.models')} value={selectedModel} onChange={(model) => patch({ model })} options={models.map((model) => ({ value: model, label: model }))} /></label>
          {input.kind !== 'text' && <label>{t('studio.creator.ratio')}<Select value={input.aspectRatio} onChange={(aspectRatio) => patch({ aspectRatio })} options={['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((value) => ({ value, label: value }))} /></label>}
          {input.kind === 'image' && sizeOptions.length > 0 && <label>{t('studio.creator.size')}<Select value={input.imageSize} onChange={(imageSize) => patch({ imageSize })} options={sizeOptions.map((value) => ({ value, label: value }))} /></label>}
          {input.kind === 'video' && <>
            <label>{t('studio.creator.duration')}{!durationRule ? <Typography.Text type="secondary">{t('studio.creator.durationByModel')}</Typography.Text> : durationRule.allowedValues?.length ? <Select value={input.durationSeconds} options={durationRule.allowedValues.map((value) => ({ value, label: `${value}s` }))} onChange={(durationSeconds) => patch({ durationSeconds })} /> : <InputNumber aria-label={t('studio.creator.duration')} value={input.durationSeconds} min={durationRule.min ?? 1} max={durationRule.max} step={durationRule.type === 'integer' ? 1 : 0.5} onChange={(value) => patch({ durationSeconds: normalizeNumberForParameter(value ?? undefined, durationRule, 5) })} />}</label>
            <label>{t('studio.creator.resolution')}<Select value={input.resolution} onChange={(resolution) => patch({ resolution })} options={(capabilities?.modality === 'video' ? capabilities.resolutionTiers ?? [{ id: '720p' }] : [{ id: '720p' }]).map((tier) => ({ value: tier.id, label: tier.id }))} /></label>
            <label className="span-all">{t('studio.creator.mode')}<Select value={input.controlMode} onChange={(controlMode) => patch({ controlMode, referenceAssetIds: controlMode === 'reference' ? input.referenceAssetIds : [], audioReferenceAssetIds: controlMode === 'reference' ? input.audioReferenceAssetIds : [], videoReferenceAssetIds: controlMode === 'reference' ? input.videoReferenceAssetIds : [], firstFrameAssetId: controlMode === 'keyframe' ? input.firstFrameAssetId : undefined, lastFrameAssetId: controlMode === 'keyframe' ? input.lastFrameAssetId : undefined })} options={(['text', 'keyframe', 'reference'] as const).map((value) => ({ value, label: t(`studio.creator.mode.${value}`), disabled: value === 'keyframe' ? capabilities?.modality !== 'video' || !capabilities.references.supportsFirstFrame : value === 'reference' ? capabilities?.modality !== 'video' || !capabilities.references.supportsSubjectReferences : false }))} /></label>
            {input.controlMode === 'keyframe' && <><label className="span-all">{t('studio.creator.first')}<Select allowClear value={input.firstFrameAssetId} onChange={(firstFrameAssetId) => patch({ firstFrameAssetId })} options={imageOptions} /></label>{capabilities?.modality === 'video' && capabilities.references.supportsLastFrame && <label className="span-all">{t('studio.creator.last')}<Select allowClear value={input.lastFrameAssetId} onChange={(lastFrameAssetId) => patch({ lastFrameAssetId })} options={imageOptions} /></label>}</>}
          </>}
          {input.kind !== 'text' && <>{supportsNegative && <label className="span-all">{t('studio.creator.negative')}<Input.TextArea rows={2} value={input.negativePrompt} onChange={(event) => patch({ negativePrompt: event.target.value })} /></label>}{supportsSeed && <label>{t('studio.creator.seed')}<InputNumber min={0} precision={0} value={input.seed} onChange={(value) => patch({ seed: value ?? undefined })} /></label>}</>}
        </div>
        {input.kind === 'video' && capabilities?.modality === 'video' && <StudioVideoReferences input={input} capabilities={capabilities} onChange={patch} />}
      </aside>
    </section>
    {home && <section className="studio-creator-inspiration"><Typography.Title level={4}>{t('studio.creator.inspiration')}</Typography.Title><div className="video-studio-grid">{['product', 'character', 'motion', 'script'].map((goal) => <button type="button" className="video-studio-card studio-inspiration-card" key={goal} onClick={() => patch({ kind: goal === 'motion' ? 'video' : goal === 'script' ? 'text' : 'image', prompt: t(`studio.recipe.${goal}Prompt`), model: undefined, endpointId: undefined, controlMode: 'text', audioReferenceAssetIds: [], videoReferenceAssetIds: [], firstFrameAssetId: undefined, lastFrameAssetId: undefined, generateAudio: undefined })}><strong>{t(`studio.recipe.${goal}`)}</strong><span className="video-studio-muted">{t(`studio.recipe.${goal}Description`)}</span><ArrowRightOutlined /></button>)}</div></section>}
    <section className="studio-creator-recent"><div className="studio-creator-section-heading"><Typography.Title level={4}>{t('studio.creator.recent')}</Typography.Title><Button type="link" onClick={() => setPage('tasks')}>{t('studio.creator.tasks')}</Button></div><div className="video-studio-grid">{recent.map((job) => <article className="video-studio-card" key={job.id}><StudioMedia asset={assets.find((asset) => asset.id === job.outputAssetId)} /><Typography.Text ellipsis>{job.name}</Typography.Text><Space><Tag color={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'processing'}>{t(`studio.task.${job.status}`)}</Tag><Typography.Text type="secondary">{job.input.model}</Typography.Text></Space>{(() => { const output = assets.find((asset) => asset.id === job.outputAssetId); return output ? <Space wrap>{output.kind === 'image' && <Button size="small" onClick={() => setEditing(output)}>{t('studio.edit.title')}</Button>}<StudioProjectTransfer asset={output} /></Space> : null; })()}{job.error && <Typography.Text type="danger">{job.error}</Typography.Text>}</article>)}</div></section>
    {editing && <StudioImageEditor asset={editing} onClose={() => setEditing(undefined)} onSaved={(asset) => chooseReferences([asset.id])} />}
  </div>;
}

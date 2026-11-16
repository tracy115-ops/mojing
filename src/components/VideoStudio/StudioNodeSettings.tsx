import { Input, InputNumber, Select } from 'antd';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import { getVideoParameter, normalizeNumberForParameter } from '@/services/video/core/video-capability-utils';
import type { ImageGenerationCapabilities, LLMGenerationCapabilities, VideoControlMode, VideoGenerationCapabilities } from '@/types/providers';
import type { StudioGenerationInput, StudioNode } from '@/types/video-studio';
import StudioVideoReferences from './StudioVideoReferences';

export default function StudioNodeSettings({ node, onChange, fixedAspectRatio = false }: { node: StudioNode; onChange: (value: Partial<StudioGenerationInput>) => void; fixedAspectRatio?: boolean }) {
  const { t } = useTranslation(), providers = useProviderStore();
  if (!['image', 'video', 'text'].includes(node.kind)) return null;
  const input = node.generation ?? {}, category = node.kind === 'text' ? 'llm' : node.kind as 'image' | 'video';
  const endpoint = input.endpointId ? providers.getEndpoint(input.endpointId) : providers.getActiveEndpoint(category);
  let capabilities: ImageGenerationCapabilities | VideoGenerationCapabilities | LLMGenerationCapabilities | undefined;
  try { capabilities = node.kind === 'video' ? providerRouter.getVideoCapabilities('clip', input.model, endpoint?.id) : node.kind === 'image' ? providerRouter.getImageCapabilities('storyboard', input.model, endpoint?.id) : providerRouter.getLLMCapabilities('generation', input.model, endpoint?.id); } catch { /* An imported graph can be rebound here. */ }
  const patch = (value: Partial<StudioGenerationInput>) => onChange({ ...input, ...value });
  const rebind = (value: Partial<StudioGenerationInput>) => {
    const next = { ...input, ...value };
    for (const key of ['durationSeconds', 'resolution', 'imageSize', 'negativePrompt', 'seed', 'generateAudio'] as const) delete next[key];
    onChange(next);
  };
  const durationRule = capabilities?.modality === 'video' ? getVideoParameter(capabilities, 'durationSeconds') : undefined;
  return <div className="video-studio-fields" data-testid="canvas-node-settings"><label className="span-all">{t('studio.creator.endpoint')}<Select allowClear value={input.endpointId} placeholder={endpoint?.name ?? t('studio.creator.configure')} onChange={(endpointId) => rebind({ endpointId, model: undefined })} options={providers.getEndpointsByCategory(category).map((item) => ({ value: item.id, label: item.name }))} /></label>
    <label className="span-all">{t('studio.creator.models')}<Select allowClear value={input.model} placeholder={capabilities?.model} onChange={(model) => rebind({ model })} options={(capabilities && 'availableModels' in capabilities ? capabilities.availableModels : endpoint?.models)?.map((value) => ({ value, label: value })) ?? []} /></label>
    {node.kind !== 'text' && <label className="span-all">{t('studio.creator.ratio')}<Select disabled={fixedAspectRatio} value={input.aspectRatio ?? '16:9'} onChange={(aspectRatio) => patch({ aspectRatio })} options={['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((value) => ({ value, label: value }))} /></label>}
    {capabilities?.modality === 'image' && capabilities.parameters.some((spec) => spec.key === 'size' && spec.enumValues?.includes('2K')) && <label className="span-all">{t('studio.creator.size')}<Select value={input.imageSize ?? '2K'} onChange={(imageSize) => patch({ imageSize })} options={capabilities.parameters.find((spec) => spec.key === 'size')?.enumValues?.map((value) => ({ value, label: value }))} /></label>}
    {capabilities?.modality === 'video' && <><label className="span-all">{t('studio.creator.duration')}{durationRule?.allowedValues?.length ? <Select value={input.durationSeconds ?? 5} onChange={(durationSeconds) => patch({ durationSeconds })} options={durationRule.allowedValues.map((value) => ({ value, label: `${value}s` }))} /> : <InputNumber value={input.durationSeconds ?? 5} min={durationRule?.min ?? 1} max={durationRule?.max} step={durationRule?.type === 'integer' ? 1 : 0.5} onChange={(value) => patch({ durationSeconds: normalizeNumberForParameter(value ?? undefined, durationRule, 5) })} />}</label><label className="span-all">{t('studio.creator.resolution')}<Select value={input.resolution ?? '720p'} onChange={(resolution) => patch({ resolution })} options={capabilities.resolutionTiers?.map((tier) => ({ value: tier.id, label: tier.id }))} /></label><label className="span-all">{t('studio.creator.mode')}<Select value={input.controlMode ?? 'auto'} onChange={(value) => patch({ controlMode: value === 'auto' ? undefined : value as VideoControlMode })} options={[{ value: 'auto', label: t('studio.canvas.autoMode') }, ...(['text', 'keyframe', 'reference'] as const).filter((mode) => mode === 'text' || mode === 'keyframe' && capabilities.references.supportsFirstFrame || mode === 'reference' && capabilities.references.supportsSubjectReferences).map((value) => ({ value, label: t(`studio.creator.mode.${value}`) }))]} /></label></>}
    {capabilities && capabilities.modality !== 'llm' && capabilities.parameters.some((spec) => spec.key === 'negativePrompt') && <label className="span-all">{t('studio.creator.negative')}<Input.TextArea rows={2} value={input.negativePrompt ?? ''} onChange={(event) => patch({ negativePrompt: event.target.value })} /></label>}
    {capabilities?.modality === 'video' && <div className="span-all"><StudioVideoReferences input={input} capabilities={capabilities} onChange={patch} /></div>}
  </div>;
}

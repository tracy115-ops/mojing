import { providerRouter } from '@/services/providers';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useProviderStore } from '@/stores/providerStore';
import { readAsDataUri, saveAsset } from '@/services/video/asset-store';
import { resolutionForAspect } from '@/services/video/core/video-capability-utils';
import type { StudioAsset, StudioGenerationInput, StudioJob, StudioMediaKind } from '@/types/video-studio';
import { studioId, studioNow } from './document';
import { normalizeVideoReferences } from '@/services/providers/provider-capabilities';
import { probeStudioMedia, studioInputAssetIds, studioVideoMediaReferences } from './media';
import { compositeMaskedImage, inspectImageMask } from './image-mask';
import { validateStudioImageEdit } from './image-edit-input';
import { fingerprintPayload } from '@/services/providers/generation-snapshot';

export async function retainStudioMedia(url: string, kind: StudioMediaKind): Promise<string> {
  const retained = '__TAURI_INTERNALS__' in window
    ? await saveAsset('studio-library', kind === 'model' ? 'model' : kind === 'video' ? 'clip' : kind === 'audio' ? 'audio' : 'keyframe', url)
    : /^(https?:|blob:)/i.test(url) ? await fileAsDataUri(await (await fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Media download failed (${response.status})`);
      return response;
    })).blob()) : url;
  if (/^(https?:|blob:)/i.test(retained) && !/^https?:\/\/asset\.localhost\//i.test(retained)) throw new Error('The generated media could not be saved locally');
  return retained;
}
async function retainOutput(url: string, kind: StudioMediaKind): Promise<Pick<StudioAsset, 'url' | 'storage' | 'storageError' | 'sourceUrl'>> {
  try {
    const retained = await retainStudioMedia(url, kind);
    return { url: retained, storage: retained.startsWith('data:') ? 'embedded' : 'disk', ...(/^https?:/i.test(url) ? { sourceUrl: url } : {}) };
  } catch (error) {
    // Keep a successful provider output visible. A download failure must not encourage a paid resubmission.
    return { url, sourceUrl: url, storage: 'remote', storageError: error instanceof Error ? error.message : String(error) };
  }
}
export function fileAsDataUri(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
export async function importStudioFile(file: File, category: StudioAsset['category'] = 'reference'): Promise<StudioAsset> {
  const kind: StudioMediaKind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video'
    : file.type.startsWith('audio/') ? 'audio' : /\.glb$/i.test(file.name) ? 'model' : 'text';
  const asset: StudioAsset = { id: studioId(), name: file.name, kind, category, createdAt: studioNow() };
  if (kind === 'text') asset.text = await file.text();
  else {
    const data = await fileAsDataUri(file);
    if (kind !== 'model') Object.assign(asset, await probeStudioMedia(data, kind), { mimeType: file.type, sizeBytes: file.size });
    asset.url = await retainStudioMedia(data, kind);
  }
  useVideoStudioStore.getState().addAsset(asset);
  return asset;
}
export function downloadStudioFile(content: string | Blob, filename: string, type = 'application/json'): void {
  const url = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type }) : content);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function dimensions(ratio: string, edge: number) {
  const [w, h] = ratio.split(':').map(Number);
  if (!(w > 0 && h > 0)) throw new Error('Invalid aspect ratio');
  return w >= h ? { width: Math.round(edge * w / h), height: edge } : { width: edge, height: Math.round(edge * h / w) };
}
async function executeJob(job: StudioJob): Promise<StudioAsset> {
  const { input } = job;
  const library = useVideoStudioStore.getState().assets;
  if (input.kind !== 'video' && (input.audioReferenceAssetIds?.length || input.videoReferenceAssetIds?.length)) throw new Error('Audio/video references can only be used for video generation');
  const getImage = async (id: string) => {
    const asset = library.find((item) => item.id === id);
    if (!asset || asset.kind !== 'image' || !asset.url) throw new Error('A referenced image is no longer available');
    return { id: asset.id, label: asset.name, image: await readAsDataUri(asset.url) };
  };
  const references = await Promise.all(input.referenceAssetIds.map(getImage));
  const prompt = input.recipePrompt ? `${input.recipePrompt}\n\n${input.prompt}` : input.prompt;
  const asset: StudioAsset = { id: studioId(), name: job.name, kind: input.kind, category: 'output', createdAt: studioNow(), jobId: job.id };
  if (input.kind === 'text') {
    const capability = providerRouter.getLLMCapabilities('generation', input.model, input.endpointId);
    if (references.length && (!capability.supportsImageInputs || references.length > capability.maxImageInputs)) throw new Error('This language model cannot use the supplied image inputs');
    const result = await providerRouter.generate({ taskType: 'generation', endpointId: input.endpointId, systemPrompt: input.recipePrompt || 'Follow the user’s creative brief. Preserve supplied facts. Return the requested creative work.', userPrompt: input.prompt, model: input.model, ...(references.length ? { imageInputs: references.map((reference) => reference.image) } : {}) });
    return { ...asset, text: result.content, model: result.model, provider: result.provider };
  }
  if (input.kind === 'image') {
    validateStudioImageEdit(input);
    const edit = input.imageEdit, mask = edit ? await getImage(edit.maskAssetId) : undefined;
    const inspected = mask ? await inspectImageMask(references[0].image, mask.image) : undefined;
    const finishEdit = async (candidate: StudioAsset): Promise<StudioAsset> => {
      if (!edit || !mask || !candidate.url) throw new Error('The generated mask candidate is missing. Restore it before retrying local composition.');
      const generated = await readAsDataUri(candidate.url);
      const composed = await compositeMaskedImage(references[0].image, generated, mask.image);
      return { ...asset, id: studioId(), ...composed, url: await retainStudioMedia(composed.url, 'image'), model: candidate.model, provider: candidate.provider,
        editResult: { mode: edit.mode, sourceFingerprint: fingerprintPayload(references[0].image)!, maskFingerprint: fingerprintPayload(mask.image)!, candidateFingerprint: fingerprintPayload(generated)!, preserveOutside: true } };
    };
    if (job.rawOutputAssetId) {
      const candidate = library.find((item) => item.id === job.rawOutputAssetId);
      if (!candidate) throw new Error('The generated candidate is missing. Restore it before retrying local composition.');
      return finishEdit(candidate);
    }
    const capability = providerRouter.getImageCapabilities('storyboard', input.model, input.endpointId);
    if (capability.references.maxImages < references.length) throw new Error(`This model accepts at most ${capability.references.maxImages} reference images`);
    const sizeSpec = capability.parameters.find((spec) => spec.key === 'size');
    const result = await providerRouter.generateImage({
      taskType: 'storyboard', sourceLabel: `studio:${job.id}`, prompt, negativePrompt: input.negativePrompt,
      endpointId: input.endpointId, model: input.model,
      ...(edit?.mode === 'native_mask' && inspected ? { width: Math.max(64, Math.round(inspected.source.naturalWidth / 8) * 8), height: Math.max(64, Math.round(inspected.source.naturalHeight / 8) * 8) } : dimensions(input.aspectRatio, 1024)), aspectRatio: input.aspectRatio,
      ...(edit?.mode === 'native_mask' ? { mask: mask!.image, editStrength: edit.strength } : {}),
      ...(sizeSpec?.enumValues?.includes(input.imageSize) ? { size: input.imageSize } : {}),
      referenceImages: references.map((reference) => reference.image),
      referenceSlots: references.map((reference) => ({ id: reference.id, role: 'custom', label: reference.label, image: reference.image })), seed: input.seed,
    });
    const candidate: StudioAsset = { ...asset, ...await retainOutput(result.imageData, 'image'), width: result.width, height: result.height, model: result.model, provider: result.provider, requestSnapshot: result.requestSnapshot, responseSnapshot: result.responseSnapshot };
    if (!edit) return candidate;
    // Save the successful provider artifact before any fallible local processing.
    useVideoStudioStore.getState().addAsset(candidate);
    useVideoStudioStore.getState().updateJob(job.id, { rawOutputAssetId: candidate.id });
    return finishEdit(candidate);
  }
  const first = input.firstFrameAssetId ? await getImage(input.firstFrameAssetId) : undefined;
  const last = input.lastFrameAssetId ? await getImage(input.lastFrameAssetId) : undefined;
  const videoCapability = providerRouter.getVideoCapabilities('clip', input.model, input.endpointId);
  const media = await studioVideoMediaReferences(input, library, videoCapability, readAsDataUri);
  const tier = videoCapability.resolutionTiers?.find((item) => item.id === input.resolution)
    ?? { id: input.resolution, shortEdge: input.resolution === '1080p' ? 1080 : 720 };
  const [width, height] = resolutionForAspect(input.aspectRatio, tier).split('x').map(Number);
  const result = await providerRouter.generateVideo({
    taskType: 'clip', sourceLabel: `studio:${job.id}`, prompt, negativePrompt: input.negativePrompt,
    endpointId: input.endpointId, model: input.model, width, height, aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds, controlMode: input.controlMode,
    firstFrame: input.controlMode === 'keyframe' ? first?.image : undefined,
    lastFrame: input.controlMode === 'keyframe' ? last?.image : undefined,
    subjectReferences: input.controlMode === 'reference' ? references : undefined, seed: input.seed,
    ...media, generateAudio: input.generateAudio,
  });
  const retained = await retainOutput(result.videoData, 'video');
  // Provider metadata can describe the requested preset rather than the actual file.
  // Probe the saved output without turning a metadata failure into a paid retry.
  const measured = retained.url && retained.storage !== 'remote' ? await probeStudioMedia(retained.url, 'video') : {};
  return { ...asset, ...retained, width: result.width, height: result.height, durationSeconds: result.durationSeconds, ...measured, model: result.model, provider: result.provider, requestSnapshot: result.requestSnapshot, responseSnapshot: result.responseSnapshot };
}

let processing = false;
async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      const job = useVideoStudioStore.getState().jobs.find((item) => item.status === 'queued');
      if (!job) break;
      const store = useVideoStudioStore.getState();
      store.updateJob(job.id, { status: 'running', startedAt: studioNow(), error: undefined });
      try {
        const asset = await executeJob(job);
        store.addAsset(asset);
        store.updateJob(job.id, { status: 'completed', outputAssetId: asset.id, finishedAt: studioNow() });
        const canvas = useVideoStudioStore.getState().canvases.find((item) => item.id === job.canvasId);
        if (canvas) store.saveCanvas({ ...canvas, nodes: canvas.nodes.map((node) => node.id === job.nodeId ? { ...node, assetId: asset.id } : node), updatedAt: studioNow() }, false);
      } catch (error) {
        store.updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: studioNow() });
      }
    }
  } finally { processing = false; }
}
/** Only explicit submission or retry enters the queue. Restarted jobs require a new user action. */
export function submitStudioJob(input: StudioGenerationInput, binding?: { canvasId: string; nodeId: string }): string {
  if (!input.prompt.trim()) throw new Error('A creative brief is required');
  validateStudioImageEdit(input);
  if (studioInputAssetIds(input).some((id) => !useVideoStudioStore.getState().assets.some((asset) => asset.id === id))) throw new Error('A reference is missing or in the recycle bin. Restore it before submitting.');
  const providers = useProviderStore.getState();
  const category = input.kind === 'text' ? 'llm' : input.kind;
  const endpoint = input.endpointId ? providers.getEndpoint(input.endpointId) : providers.getActiveEndpoint(category);
  if (!endpoint?.enabled) throw new Error('Configure an enabled model endpoint first');
  if (input.imageEdit) {
    const caps = providerRouter.getImageCapabilities('storyboard', input.model, endpoint.id);
    if (input.imageEdit.mode === 'native_mask' && !caps.references.maskSupported) throw new Error('This image model does not support native mask editing');
    if (caps.references.maxImages < input.referenceAssetIds.length) throw new Error('This image model cannot use the required edit references');
  }
  if (input.kind === 'video') {
    if (input.controlMode !== 'reference' && input.referenceAssetIds.length) throw new Error('Choose reference mode before submitting subject images');
    if (input.controlMode !== 'keyframe' && (input.firstFrameAssetId || input.lastFrameAssetId)) throw new Error('First/last frame controls require keyframe mode');
    if (input.controlMode === 'keyframe' && !input.firstFrameAssetId) throw new Error('A first frame is required');
    if (input.controlMode === 'reference' && !input.referenceAssetIds.length && !input.audioReferenceAssetIds?.length && !input.videoReferenceAssetIds?.length) throw new Error('Choose at least one image, audio or video reference');
    const caps = providerRouter.getVideoCapabilities('clip', input.model, endpoint.id);
    // Validate the mode and image limits synchronously. Media payloads are checked after local files are read and before calling the router.
    if (!(input.audioReferenceAssetIds?.length || input.videoReferenceAssetIds?.length)) normalizeVideoReferences({ controlMode: input.controlMode, subjectReferences: input.controlMode === 'reference' ? input.referenceAssetIds.map((id) => ({ id, image: id })) : undefined, firstFrame: input.firstFrameAssetId, lastFrame: input.lastFrameAssetId }, caps);
    else {
      if (input.controlMode !== 'reference') throw new Error('Audio/video references require reference mode');
      if ((input.audioReferenceAssetIds?.length ?? 0) > (caps.references.audio?.maxCount ?? 0)) throw new Error('Too many audio references or audio is unsupported by this model');
      if ((input.videoReferenceAssetIds?.length ?? 0) > (caps.references.video?.maxCount ?? 0)) throw new Error('Too many video references or video is unsupported by this model');
    }
  }
  const recipePrompt = input.recipePrompt ?? useVideoStudioStore.getState().recipes.find((recipe) => recipe.id === input.recipeId)?.prompt ?? '';
  const model = input.model || (input.kind === 'image' ? providerRouter.getImageCapabilities('storyboard', undefined, endpoint.id).model
    : input.kind === 'video' ? providerRouter.getVideoCapabilities('clip', undefined, endpoint.id).model : providerRouter.getLLMCapabilities('generation', undefined, endpoint.id).model);
  const id = studioId();
  useVideoStudioStore.getState().addJob({ id, name: (input.imageEdit?.instruction ?? input.prompt).trim().slice(0, 80), input: structuredClone({ ...input, model, recipePrompt, endpointId: endpoint.id }), status: 'queued', createdAt: studioNow(), ...binding });
  void processQueue();
  return id;
}

/** A retained successful model candidate is never regenerated by a local-composition retry. */
export function retryStudioImageComposition(id: string): void {
  const state = useVideoStudioStore.getState(), job = state.jobs.find((item) => item.id === id);
  if (!job?.input.imageEdit || !job.rawOutputAssetId || !['failed', 'interrupted', 'cancelled'].includes(job.status)) throw new Error('This job has no local composition to resume');
  if ([...studioInputAssetIds(job.input), job.rawOutputAssetId].some((assetId) => !state.assets.some((asset) => asset.id === assetId))) throw new Error('Restore the source, mask and generated candidate before retrying composition');
  state.updateJob(id, { status: 'queued', error: undefined, finishedAt: undefined });
  void processQueue();
}
export function waitForStudioJob(id: string, signal?: AbortSignal): Promise<StudioJob> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const clean = () => { unsubscribe(); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new DOMException('Batch stopped', 'AbortError')); };
    const inspect = () => {
      const job = useVideoStudioStore.getState().jobs.find((item) => item.id === id);
      if (!job || ['failed', 'cancelled', 'interrupted'].includes(job.status)) { clean(); reject(new Error(job?.error || 'The dependency did not finish')); }
      else if (job.status === 'completed') { clean(); resolve(job); }
    };
    unsubscribe = useVideoStudioStore.subscribe(inspect);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else inspect();
  });
}

import type { StudioAsset, StudioGenerationInput } from '../../types/video-studio.ts';
import type { VideoGenerationCapabilities, VideoMediaReference } from '../../types/providers.ts';
import { assertPublicMediaUrl } from '../providers/video-media-contract.ts';
import { modelReadableMediaUrl } from './upload-contract.ts';

export function studioInputAssetIds(input?: Partial<StudioGenerationInput>): string[] {
  return [...new Set([...(input?.referenceAssetIds ?? []), ...(input?.audioReferenceAssetIds ?? []), ...(input?.videoReferenceAssetIds ?? []), input?.firstFrameAssetId, input?.lastFrameAssetId, input?.imageEdit?.sourceAssetId, input?.imageEdit?.maskAssetId].filter((id): id is string => !!id))];
}

export async function probeStudioMedia(url: string, kind: 'image' | 'audio' | 'video'): Promise<Partial<StudioAsset>> {
  return new Promise((resolve) => {
    const element = kind === 'image' ? new Image() : document.createElement(kind);
    const finish = (value: Partial<StudioAsset>) => { clearTimeout(timer); element.onload = null; element.onerror = null; if (element instanceof HTMLMediaElement) { element.onloadedmetadata = null; element.removeAttribute('src'); element.load(); } resolve(value); };
    const timer = setTimeout(() => finish({}), 8000);
    element.onerror = () => finish({});
    if (element instanceof HTMLImageElement) element.onload = () => finish({ width: element.naturalWidth, height: element.naturalHeight });
    else { element.preload = 'metadata'; element.onloadedmetadata = () => finish({ ...(Number.isFinite(element.duration) ? { durationSeconds: element.duration } : {}), ...(element instanceof HTMLVideoElement ? { width: element.videoWidth, height: element.videoHeight } : {}) }); }
    element.src = url;
  });
}

/** Keep public sources intact; never turn a provider-readable URL into an unsupported data URI. */
export async function studioVideoMediaReferences(input: StudioGenerationInput, assets: StudioAsset[], capabilities: VideoGenerationCapabilities, readLocal: (url: string) => Promise<string>): Promise<{ audioReferences: VideoMediaReference[]; videoReferences: VideoMediaReference[] }> {
  const read = async (ids: string[], kind: 'audio' | 'video') => Promise.all(ids.map(async (id) => {
    const asset = assets.find((candidate) => candidate.id === id);
    if (!asset || asset.kind !== kind || !asset.url) throw new Error(`A referenced ${kind} is no longer available`);
    const rule = capabilities.references[kind];
    if (!rule?.maxCount) throw new Error(`This model does not support ${kind} references`);
    let url = modelReadableMediaUrl(asset, capabilities.provider) || asset.sourceUrl || asset.url;
    if (rule.transport === 'public_url' && !modelReadableMediaUrl(asset, capabilities.provider)) throw new Error('Upload this local reference or renew its expired upload link before generating');
    if (!/^(https?:|data:|asset:)/i.test(url) && rule.transport === 'public_url_or_data') url = await readLocal(url);
    return { id: asset.id, label: asset.name, url, durationSeconds: asset.durationSeconds, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
  }));
  return { audioReferences: await read(input.audioReferenceAssetIds ?? [], 'audio'), videoReferences: await read(input.videoReferenceAssetIds ?? [], 'video') };
}

export function publicStudioAsset(url: string, kind: 'audio' | 'video' | 'image', name: string): Pick<StudioAsset, 'url' | 'sourceUrl' | 'name'> & { kind: 'image' | 'audio' | 'video' } {
  const sourceUrl = assertPublicMediaUrl(url.trim());
  return { url: sourceUrl, sourceUrl, kind, name: name.trim() || decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() || kind) };
}

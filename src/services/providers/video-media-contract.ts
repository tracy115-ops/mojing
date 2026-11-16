import type { VideoGenerationCapabilities, VideoMediaReference, VideoMediaReferenceCapability } from '../../types/providers.ts';

export function assertPublicMediaUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Reference media requires a public HTTP(S) URL'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const octets = host.split('.').map(Number);
  const privateIpv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
      || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
      || octets[0] === 192 && octets[1] === 168 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || !host.includes('.') && !host.includes(':') || privateIpv4
    || host.includes(':') && (/^(?:::|f[cd]|fe[89ab])/i.test(host) || host.startsWith('::ffff:'))) {
    throw new Error('The model cannot read local/private media. Import a public media URL instead.');
  }
  return url.href;
}

function validateMedia(references: VideoMediaReference[], rule: VideoMediaReferenceCapability | undefined, kind: 'audio' | 'video', provider: string): void {
  if (!references.length) return;
  if (!rule?.maxCount) throw new Error(`This model does not support ${kind} references`);
  if (references.length > rule.maxCount) throw new Error(`This model accepts at most ${rule.maxCount} ${kind} references`);
  let totalSeconds = 0;
  for (const reference of references) {
    if (!reference || typeof reference.url !== 'string' || !reference.url.trim()) throw new Error(`An ${kind} reference is missing`);
    const data = /^data:([^;,]+);base64,([A-Za-z0-9+/\r\n]*={0,2})$/i.exec(reference.url);
    let mime = reference.mimeType?.toLowerCase(), size = reference.sizeBytes;
    if (data) {
      if (rule.transport !== 'public_url_or_data') throw new Error(`This model requires a public ${kind} URL. Import a media link or select a model that accepts local files.`);
      mime = data[1].toLowerCase();
      const encoded = data[2].replace(/\s/g, '');
      if (!encoded.length || encoded.length % 4 !== 0) throw new Error(`Invalid ${kind} Base64 payload`);
      size = Math.max(size ?? 0, encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0));
    } else if (provider === 'doubao-video' && /^asset:\/\/[\w-]+$/.test(reference.url)) {
      // Ark's pre-uploaded media IDs can also be used by configured endpoints.
    } else assertPublicMediaUrl(reference.url);
    if (mime && !rule.mimeTypes.includes(mime)) throw new Error(`Unsupported ${kind} format: ${mime}. Accepted: ${rule.mimeTypes.join(', ')}`);
    if (size !== undefined && (!Number.isFinite(size) || size <= 0 || size > rule.maxBytes)) throw new Error(`Each ${kind} reference must be at most ${Math.round(rule.maxBytes / 1024 / 1024)} MB`);
    if (reference.durationSeconds !== undefined) {
      if (!Number.isFinite(reference.durationSeconds) || reference.durationSeconds < rule.minSeconds || reference.durationSeconds > rule.maxSeconds) throw new Error(`Each ${kind} reference must be ${rule.minSeconds}–${rule.maxSeconds} seconds`);
      totalSeconds += reference.durationSeconds;
    }
  }
  if (totalSeconds > rule.maxTotalSeconds + 0.001) throw new Error(`Total ${kind} reference duration must not exceed ${rule.maxTotalSeconds} seconds`);
}

/** Applied before normalization and in native adapters, so unsupported inputs never disappear. */
export function validateVideoMediaReferences(input: {
  controlMode: string;
  audioReferences?: VideoMediaReference[];
  videoReferences?: VideoMediaReference[];
}, capabilities: VideoGenerationCapabilities, imageCount: number): void {
  const audios = input.audioReferences ?? [], videos = input.videoReferences ?? [];
  if (!audios.length && !videos.length) return;
  if (input.controlMode !== 'reference') throw new Error('Audio and video references require reference mode; they cannot be mixed with first/last frame controls');
  validateMedia(audios, capabilities.references.audio, 'audio', capabilities.provider);
  validateMedia(videos, capabilities.references.video, 'video', capabilities.provider);
  if (audios.length && !videos.length && !imageCount && capabilities.references.audioRequiresVisual) throw new Error('This model requires an image or video alongside reference audio');
  if (capabilities.references.maxTotalMedia !== undefined && imageCount + audios.length + videos.length > capabilities.references.maxTotalMedia) throw new Error(`This model accepts at most ${capabilities.references.maxTotalMedia} reference files in total`);
}

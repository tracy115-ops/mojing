import type { StudioAsset } from '../../types/video-studio.ts';
import type { S3StorageConfig } from '../../types/studio-upload.ts';
import { assertPublicMediaUrl } from '../providers/video-media-contract.ts';

export const defaultS3Config = (): S3StorageConfig => ({ endpoint: '', region: 'us-east-1', bucket: '', pathStyle: true, prefix: 'ai-workstation/references', urlLifetimeHours: 24 });
export function validateS3Config(input: S3StorageConfig): S3StorageConfig {
  const config = { ...input, endpoint: input.endpoint.trim().replace(/\/+$/, ''), region: input.region.trim(), bucket: input.bucket.trim(), prefix: input.prefix.trim().replace(/^\/+|\/+$/g, '') };
  const endpoint = new URL(assertPublicMediaUrl(config.endpoint));
  if (endpoint.protocol !== 'https:' || endpoint.search || endpoint.hash || !/^[a-z0-9-]+$/.test(config.region) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || config.bucket.includes('..') || typeof config.pathStyle !== 'boolean' || !Number.isInteger(config.urlLifetimeHours) || config.urlLifetimeHours < 1 || config.urlLifetimeHours > 168 || config.prefix.split('/').some(part => part === '.' || part === '..') || new TextEncoder().encode(config.prefix).length > 800) throw new Error('Invalid S3 storage configuration');
  return config;
}
export function sameS3Target(a: S3StorageConfig, b: S3StorageConfig): boolean {
  return a.endpoint.replace(/\/+$/, '') === b.endpoint.replace(/\/+$/, '') && a.region === b.region && a.bucket === b.bucket && a.pathStyle === b.pathStyle;
}
/** Only verified, unexpired uploads can replace local files in a provider request. */
export function modelReadableMediaUrl(asset: StudioAsset, provider: string, now = Date.now()): string | undefined {
  const cloud = asset.cloudUpload;
  if (cloud && Date.parse(cloud.expiresAt) > now + 5 * 60_000 && /^[a-f\d]{64}$/.test(cloud.sha256)) {
    try { return assertPublicMediaUrl(cloud.url); } catch { /* Fall back to a separately imported public source. */ }
  }
  const source = asset.sourceUrl || asset.url || '';
  if (provider === 'doubao-video' && /^asset:\/\/[\w-]+$/.test(source)) return source;
  try { return assertPublicMediaUrl(source); } catch { return undefined; }
}
/** Embedded packages carry media, without temporary signed upload links. */
export function withoutCloudUpload(asset: StudioAsset): StudioAsset {
  const { cloudUpload: _cloud, ...copy } = asset;
  if (copy.sourceUrl === _cloud?.url) delete copy.sourceUrl;
  return copy;
}
export function sniffUploadMedia(bytes: Uint8Array, kind: StudioAsset['kind']): { mimeType: string; extension: string; maxBytes: number } {
  const text = (offset: number, count: number) => String.fromCharCode(...bytes.slice(offset, offset + count));
  let mimeType = '', extension = '';
  if (kind === 'image') {
    if ([137,80,78,71,13,10,26,10].every((value,index) => bytes[index] === value)) { mimeType = 'image/png'; extension = 'png'; }
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { mimeType = 'image/jpeg'; extension = 'jpg'; }
    else if (text(0,4) === 'RIFF' && text(8,4) === 'WEBP') { mimeType = 'image/webp'; extension = 'webp'; }
  } else if (kind === 'audio') {
    if (text(0,4) === 'RIFF' && text(8,4) === 'WAVE') { mimeType = 'audio/wav'; extension = 'wav'; }
    else if (text(0,3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] >> 3 & 3) !== 1 && (bytes[1] >> 1 & 3) !== 0) { mimeType = 'audio/mpeg'; extension = 'mp3'; }
  } else if (kind === 'video' && text(4,4) === 'ftyp') {
    mimeType = text(8,4) === 'qt  ' ? 'video/quicktime' : 'video/mp4'; extension = mimeType === 'video/mp4' ? 'mp4' : 'mov';
  }
  if (!mimeType) throw new Error('format');
  return { mimeType, extension, maxBytes: (kind === 'image' ? 30 : kind === 'audio' ? 15 : 200) * 1024 * 1024 };
}

import { fetch as httpFetch } from '@/services/providers/fetch-proxy';
import { readAsDataUri } from '@/services/video/asset-store';
import { retainStudioMedia } from './generation';
import { studioId, studioNow } from './document';
import type { StudioAsset } from '@/types/video-studio';

export interface EagleFolder { id: string; name: string; children?: EagleFolder[] }
export interface EagleLibrary { library: { path: string; name: string }; folders: EagleFolder[] }
export interface EagleItem { id: string; name: string; ext: string; width?: number; height?: number; size?: number; folders?: string[]; tags?: string[]; isDeleted?: boolean }
export function eagleBase(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the Eagle Local API address on this computer');
  return url.origin;
}
export async function eagleRequest<T>(base: string, path: string, body?: unknown): Promise<T> {
  const response = await httpFetch(`${eagleBase(base)}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Eagle HTTP ${response.status}`);
  const data = await response.json() as { status: string; data: T; message?: string };
  if (data.status !== 'success') throw new Error(data.message || 'Eagle did not report success');
  return data.data;
}
export async function importEagleItem(base: string, library: EagleLibrary, item: EagleItem): Promise<StudioAsset> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('EAGLE_DESKTOP_REQUIRED');
  if (!/^[a-zA-Z0-9_-]+$/.test(item.id) || !/^[a-zA-Z0-9]+$/.test(item.ext)) throw new Error('Invalid Eagle file metadata');
  const thumbnail = await eagleRequest<string>(base, `/api/item/thumbnail?id=${encodeURIComponent(item.id)}`);
  const normalized = thumbnail.replace(/\\/g, '/'), root = library.library.path.replace(/\\/g, '/').replace(/\/$/, '');
  const prefix = `${root}/images/${item.id}.info/`;
  if (!normalized.toLowerCase().startsWith(prefix.toLowerCase()) || normalized.slice(prefix.length).includes('/') || normalized.includes('/../')) throw new Error('Eagle returned a file outside its item folder');
  const original = normalized.replace(/(?:_thumbnail)?\.[^.\/]+$/, `.${item.ext}`);
  const uri = await readAsDataUri(original);
  if (!uri.startsWith('data:')) throw new Error('The Eagle original file could not be read');
  const kind = /^(png|jpe?g|webp|gif|avif|bmp)$/i.test(item.ext) ? 'image' : /^(mp4|webm|mov|mkv)$/i.test(item.ext) ? 'video' : /^(mp3|wav|ogg|m4a|flac|aac)$/i.test(item.ext) ? 'audio' : /^glb$/i.test(item.ext) ? 'model' : undefined;
  if (!kind) throw new Error('This Eagle file type is not supported in the studio');
  return { id: studioId(), name: item.name, kind, category: 'reference', createdAt: studioNow(), width: item.width, height: item.height, url: await retainStudioMedia(uri, kind), storage: 'disk' };
}
export async function uploadToEagle(base: string, asset: StudioAsset, folderId?: string): Promise<void> {
  if (!asset.url || !['image', 'video', 'audio'].includes(asset.kind)) throw new Error('Choose an image, video or audio asset');
  const uri = await readAsDataUri(asset.url);
  if (!uri.startsWith('data:')) throw new Error('The source asset could not be read');
  await eagleRequest(base, '/api/item/addFromURL', { url: uri, name: asset.name, ...(folderId ? { folderId } : {}), tags: ['AI WorkStation'] });
}

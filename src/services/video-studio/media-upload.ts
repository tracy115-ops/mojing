import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useStudioUploadStore } from '@/stores/studioUploadStore';
import { fetch as httpFetch } from '@/services/providers/fetch-proxy';
import { fingerprintPayload } from '@/services/providers/generation-snapshot';
import { isRemoteUrl, readAsDataUri, resolveLocalPath } from '@/services/video/asset-store';
import type { StudioAsset } from '@/types/video-studio';
import type { S3Credentials, S3StorageConfig, StudioUploadTask } from '@/types/studio-upload';
import { studioId, studioNow } from './document';
import { probeStudioMedia } from './media';
import { sameS3Target, sniffUploadMedia, validateS3Config } from './upload-contract';
import { presignS3, sha256 } from './s3-signing';

const controllers = new Map<string, AbortController>();
const failure = (code: string): never => { throw new Error(code); };
function settings() {
  const { config, credentials } = useStudioUploadStore.getState();
  let target: S3StorageConfig;
  try { target = validateS3Config(config); } catch { return failure('config'); }
  if (!credentials.accessKeyId.trim() || !credentials.secretAccessKey) return failure('credentials');
  return { target, credentials: { ...credentials } };
}
function patch(id: string, changes: Partial<StudioUploadTask>) {
  const store = useVideoStudioStore.getState(), task = store.uploadTasks.find(item => item.id === id);
  if (task) store.saveUploadTask({ ...task, ...changes });
}
async function readSource(asset: StudioAsset, signal: AbortSignal): Promise<Blob> {
  if (!asset.url) return failure('source');
  let url = resolveLocalPath(asset.url);
  if (!url.startsWith('data:') && !isRemoteUrl(url)) url = await readAsDataUri(url);
  if (!/^(data:|https?:)/i.test(url)) return failure('source');
  const response = url.startsWith('data:') ? await fetch(url, { signal }) : await httpFetch(url, { signal, credentials: 'omit', redirect: 'error' });
  if (!response.ok) return failure('source');
  if (Number(response.headers.get('content-length')) > 200 * 1024 * 1024) return failure('size');
  return response.blob();
}
async function verifyObject(task: StudioUploadTask, credentials: S3Credentials, signal: AbortSignal): Promise<boolean> {
  const url = await presignS3(task.target, credentials, task.objectKey, 'HEAD');
  const response = await httpFetch(url, { method: 'HEAD', signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  if (response.status === 404) return false;
  if (!response.ok) return failure(response.status === 401 || response.status === 403 ? 'denied' : 'verify');
  if (response.headers.get('x-amz-meta-sha256') !== task.sha256 || Number(response.headers.get('content-length')) !== task.sizeBytes) return failure('verify');
  return true;
}
async function runUpload(id: string, credentials: S3Credentials): Promise<void> {
  const controller = new AbortController(), { signal } = controller;
  controllers.set(id, controller);
  try {
    let task = useVideoStudioStore.getState().uploadTasks.find(item => item.id === id)!;
    const asset = useVideoStudioStore.getState().assets.find(item => item.id === task.assetId);
    if (!asset?.url || fingerprintPayload(asset.url) !== task.sourceFingerprint) return failure('stale');
    const sourceSha256 = await sha256(new TextEncoder().encode(asset.url));
    if (task.sourceSha256 && task.sourceSha256 !== sourceSha256) return failure('stale');
    task = { ...task, sourceSha256 }; patch(id, { sourceSha256 }); signal.throwIfAborted();
    let verified = false;
    // An interrupted PUT may already have succeeded. Inspect the fixed object before uploading again.
    if (task.sha256 && task.attempt > 1) {
      patch(id, { stage: 'verify' }); verified = await verifyObject(task, credentials, signal);
    }
    let metadata: Partial<StudioAsset> = task.metadata ?? {};
    if (!verified) {
      patch(id, { stage: 'read' });
      const original = await readSource(asset, signal), format = sniffUploadMedia(new Uint8Array(await original.slice(0,32).arrayBuffer()), asset.kind);
      if (!original.size || original.size > format.maxBytes) return failure('size');
      const blob = new Blob([original], { type: format.mimeType }), objectUrl = URL.createObjectURL(blob);
      try { metadata = await probeStudioMedia(objectUrl, asset.kind as 'image' | 'audio' | 'video'); } finally { URL.revokeObjectURL(objectUrl); }
      signal.throwIfAborted();
      if (asset.kind === 'image' ? !metadata.width || !metadata.height : !metadata.durationSeconds || asset.kind === 'video' && (!metadata.width || !metadata.height)) return failure('decode');
      const bytes = new Uint8Array(await blob.arrayBuffer()), hash = await sha256(bytes);
      if (task.sha256 && (task.sha256 !== hash || task.sizeBytes !== bytes.length)) return failure('stale');
      task = { ...task, sha256: hash, sizeBytes: bytes.length, mimeType: format.mimeType, metadata, objectKey: task.sha256 ? task.objectKey : `${task.objectKey}.${format.extension}`, stage: 'put' };
      patch(id, task); signal.throwIfAborted();
      const headers = { 'content-type': format.mimeType, 'x-amz-meta-sha256': hash };
      const putUrl = await presignS3(task.target, credentials, task.objectKey, 'PUT', { headers });
      const response = await httpFetch(putUrl, { method: 'PUT', headers, body: bytes.buffer as ArrayBuffer, signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) return failure(response.status === 401 || response.status === 403 ? 'denied' : 'server');
      patch(id, { putConfirmed: true, stage: 'verify' });
      if (!await verifyObject(task, credentials, signal)) return failure('missing');
    }
    signal.throwIfAborted();
    const current = useVideoStudioStore.getState().assets.find(item => item.id === task.assetId);
    if (!current || current.url !== asset.url) return failure('stale');
    const now = new Date(), url = await presignS3(task.target, credentials, task.objectKey, 'GET', { now, expires: task.target.urlLifetimeHours * 3600 });
    signal.throwIfAborted();
    if (useVideoStudioStore.getState().assets.find(item => item.id === task.assetId)?.url !== asset.url) return failure('stale');
    useVideoStudioStore.getState().updateAsset(task.assetId, { ...metadata, mimeType: task.mimeType, sizeBytes: task.sizeBytes,
      cloudUpload: { target: task.target, objectKey: task.objectKey, url, uploadedAt: now.toISOString(), expiresAt: new Date(now.getTime() + task.target.urlLifetimeHours * 3600_000).toISOString(), sha256: task.sha256!, sizeBytes: task.sizeBytes! } });
    patch(id, { status: 'completed', stage: 'verify', putConfirmed: true, finishedAt: studioNow(), error: undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = ['source','size','format','decode','stale','missing','verify','denied','server','credentials','config'].includes(message) ? message : 'network';
    patch(id, { status: signal.aborted ? 'cancelled' : 'failed', error: signal.aborted ? undefined : code, finishedAt: studioNow() });
  } finally { controllers.delete(id); }
}
export function startStudioMediaUpload(assetId: string): string {
  const store = useVideoStudioStore.getState(), asset = store.assets.find(item => item.id === assetId), { target, credentials } = settings();
  if (!asset?.url || !['image','audio','video'].includes(asset.kind)) return failure('source');
  if (store.uploadTasks.some(task => task.assetId === assetId && task.status === 'uploading')) return failure('busy');
  const id = studioId(), date = new Date().toISOString().slice(0,10);
  store.saveUploadTask({ id, assetId, name: asset.name, status: 'uploading', stage: 'read', attempt: 1, target, objectKey: `${target.prefix ? target.prefix + '/' : ''}${date}/${id}`, sourceFingerprint: fingerprintPayload(asset.url)!, createdAt: studioNow() });
  void runUpload(id, credentials); return id;
}
/** Retry verifies a retained object first; completed uploads use this path to renew their read URL. */
export function retryStudioMediaUpload(id: string): void {
  const task = useVideoStudioStore.getState().uploadTasks.find(item => item.id === id), { target, credentials } = settings();
  if (!task || task.status === 'uploading') return failure('busy');
  if (!sameS3Target(task.target, target)) return failure('target');
  if (useVideoStudioStore.getState().uploadTasks.some(item => item.assetId === task.assetId && item.status === 'uploading')) return failure('busy');
  patch(id, { status: 'uploading', stage: task.sha256 ? 'verify' : 'read', attempt: task.attempt + 1, target: { ...task.target, urlLifetimeHours: target.urlLifetimeHours }, finishedAt: undefined, error: undefined });
  void runUpload(id, credentials);
}
export function cancelStudioMediaUpload(id: string): void { controllers.get(id)?.abort(); }

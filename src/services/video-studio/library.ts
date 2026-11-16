import type { StudioAsset, StudioAssetFolder, StudioCanvas, StudioCommerceProject, StudioGenerationInput, StudioJob, StudioTrashedAsset, WorldDocument } from '../../types/video-studio.ts';
import { studioInputAssetIds } from './media.ts';
import type { StudioUploadTask } from '../../types/studio-upload.ts';

export function normalizeAssetTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

export function assetFolderPath(folders: StudioAssetFolder[], id: string): string {
  const names: string[] = [], seen = new Set<string>();
  let folder = folders.find((item) => item.id === id);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id); names.unshift(folder.name);
    folder = folders.find((item) => item.id === folder?.parentId);
  }
  return names.join(' / ');
}

export function folderDescendants(folders: StudioAssetFolder[], id: string): string[] {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const folder of folders) if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) { ids.add(folder.id); changed = true; }
  }
  return [...ids];
}

export function saveLibraryFolder(folders: StudioAssetFolder[], input: StudioAssetFolder): StudioAssetFolder[] {
  const folder = { ...input, name: input.name.trim() };
  if (!folder.id || !folder.name || folder.name.length > 80 || folder.parentId && !folders.some((item) => item.id === folder.parentId)) throw new Error('Invalid folder');
  if (folder.parentId && folderDescendants(folders, folder.id).includes(folder.parentId)) throw new Error('Folder cycle');
  if (folders.some((item) => item.id !== folder.id && item.parentId === folder.parentId && item.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase())) throw new Error('Duplicate folder');
  return folders.some((item) => item.id === folder.id) ? folders.map((item) => item.id === folder.id ? folder : item) : [...folders, folder];
}

export interface StudioLibraryReferences {
  canvases: StudioCanvas[];
  worlds: WorldDocument[];
  commerceProjects: StudioCommerceProject[];
  draft?: Partial<StudioGenerationInput>;
  jobs: StudioJob[];
  uploadTasks?: StudioUploadTask[];
}

/** Keep this guard in the store so batch actions and the UI use the same rules. */
export function referencedStudioAssets(state: StudioLibraryReferences): Set<string> {
  return new Set([
    ...state.canvases.flatMap((canvas) => canvas.nodes.flatMap((node) => [...(node.assetId ? [node.assetId] : []), ...studioInputAssetIds(node.generation)])),
    ...state.worlds.flatMap((world) => world.objects.flatMap((object) => object.assetId ? [object.assetId] : [])),
    ...state.commerceProjects.flatMap((project) => project.references.map((reference) => reference.assetId)),
    ...studioInputAssetIds(state.draft),
    ...(state.uploadTasks ?? []).filter((task) => task.status === 'uploading').map((task) => task.assetId),
    ...state.jobs.filter((job) => ['queued', 'running'].includes(job.status)).flatMap((job) => [...studioInputAssetIds(job.input), ...(job.rawOutputAssetId ? [job.rawOutputAssetId] : [])]),
  ]);
}

export function trashLibraryAssets(state: StudioLibraryReferences & { assets: StudioAsset[]; trashedAssets: StudioTrashedAsset[] }, ids: string[], trashedAt: string) {
  const wanted = new Set(ids), references = referencedStudioAssets(state);
  const moved = state.assets.filter((asset) => wanted.has(asset.id) && !references.has(asset.id));
  const changed = moved.map((asset) => asset.id), changedIds = new Set(changed);
  return {
    assets: state.assets.filter((asset) => !changedIds.has(asset.id)),
    trashedAssets: [...state.trashedAssets, ...moved.map((asset) => ({ ...asset, trashedAt }))],
    changed,
    blocked: state.assets.filter((asset) => wanted.has(asset.id) && references.has(asset.id)).map((asset) => asset.id),
  };
}

export function restoreLibraryAssets(state: { assets: StudioAsset[]; trashedAssets: StudioTrashedAsset[]; assetFolders: StudioAssetFolder[] }, ids: string[]) {
  const wanted = new Set(ids), existing = new Set(state.assets.map((asset) => asset.id));
  const restored = state.trashedAssets.filter((asset) => wanted.has(asset.id) && !existing.has(asset.id)).map(({ trashedAt: _trashedAt, ...asset }) => ({ ...asset, folderId: state.assetFolders.some((folder) => folder.id === asset.folderId) ? asset.folderId : undefined }));
  const restoredIds = new Set(restored.map((asset) => asset.id));
  return { assets: [...state.assets, ...restored], trashedAssets: state.trashedAssets.filter((asset) => !restoredIds.has(asset.id)) };
}

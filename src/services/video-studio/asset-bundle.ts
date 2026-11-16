import type { StudioAsset, StudioAssetFolder } from '../../types/video-studio.ts';
import { parseStudioBundle, studioId } from './document.ts';
import { assetFolderPath, saveLibraryFolder } from './library.ts';

export const ASSET_BUNDLE_MAX_BYTES = 256 * 1024 * 1024;
export const ASSET_BUNDLE_MAX_COUNT = 200;

export function assetBundleFolders(assets: StudioAsset[], folders: StudioAssetFolder[]): StudioAssetFolder[] {
  const ids = new Set(assets.flatMap((asset) => asset.folderId ? [asset.folderId] : []));
  for (const id of [...ids]) {
    let folder = folders.find((item) => item.id === id);
    const seen = new Set<string>();
    while (folder?.parentId && !seen.has(folder.id)) { seen.add(folder.id); ids.add(folder.parentId); folder = folders.find((item) => item.id === folder!.parentId); }
  }
  return folders.filter((folder) => ids.has(folder.id));
}

/** No library mutation until the complete package, hierarchy and references pass. */
export function parseAssetBundle(value: unknown): { assets: StudioAsset[]; folders: StudioAssetFolder[] } {
  const data = value as { format?: string; assets?: StudioAsset[]; folders?: StudioAssetFolder[] };
  if (!data || data.format !== 'mojing.assets/1' || !Array.isArray(data.assets) || !data.assets.length || data.assets.length > ASSET_BUNDLE_MAX_COUNT || !Array.isArray(data.folders) || data.folders.length > 1000) throw new Error('Invalid asset package');
  const ids = new Map<string, string>();
  for (const folder of data.folders) {
    if (!folder || typeof folder.id !== 'string' || !folder.id || ids.has(folder.id) || typeof folder.name !== 'string' || folder.parentId !== undefined && typeof folder.parentId !== 'string') throw new Error('Invalid package folder');
    ids.set(folder.id, studioId());
  }
  let folders: StudioAssetFolder[] = [], pending = [...data.folders];
  while (pending.length) {
    const ready = pending.filter((folder) => !folder.parentId || folders.some((item) => item.id === ids.get(folder.parentId!)));
    if (!ready.length) throw new Error('Missing parent or cyclic package folders');
    for (const folder of ready) folders = saveLibraryFolder(folders, { id: ids.get(folder.id)!, name: folder.name, parentId: folder.parentId ? ids.get(folder.parentId) : undefined });
    pending = pending.filter((folder) => !ready.includes(folder));
  }
  for (const asset of data.assets) {
    if (!asset || asset.kind !== 'text' && (typeof asset.url !== 'string' || !/^data:[\w.+/-]+;base64,[a-z\d+/=\s]+$/i.test(asset.url))) throw new Error('Asset package must contain embedded media');
    if (asset.folderId !== undefined && (typeof asset.folderId !== 'string' || !ids.has(asset.folderId))) throw new Error('Missing asset folder');
  }
  const assets = parseStudioBundle({ assets: data.assets, canvas: { nodes: [], edges: [] } }, 'canvas').assets.map((asset, index) => {
    const result = { ...asset, folderId: data.assets![index].folderId ? ids.get(data.assets![index].folderId!) : undefined, storage: asset.kind === 'text' ? undefined : 'embedded' as const, storageError: undefined };
    delete (result as StudioAsset & { projectId?: string }).projectId;
    return result;
  });
  return { assets, folders };
}

export function sortedAssetFolders(folders: StudioAssetFolder[]): StudioAssetFolder[] {
  return [...folders].sort((a, b) => assetFolderPath(folders, a.id).localeCompare(assetFolderPath(folders, b.id)));
}

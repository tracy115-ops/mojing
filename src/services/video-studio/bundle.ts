import type { StudioAsset, StudioCanvas, WorldDocument } from '@/types/video-studio';
import { readAsDataUri } from '@/services/video/asset-store';
import { studioInputAssetIds } from './media';
import { withoutCloudUpload } from './upload-contract';

export async function embedAssets(ids: Set<string>, assets: StudioAsset[]): Promise<StudioAsset[]> {
  return Promise.all([...ids].map(async (id) => {
    const asset = assets.find((item) => item.id === id);
    if (!asset) throw new Error('A referenced asset is missing from the library');
    if (!asset.url) return withoutCloudUpload(asset);
    const url = await readAsDataUri(asset.url);
    if (!url.startsWith('data:')) throw new Error(`Could not embed ${asset.name}. Download the media before exporting.`);
    return { ...withoutCloudUpload(asset), url, storage: 'embedded' as const, storageError: undefined };
  }));
}
export async function exportWorldBundle(world: WorldDocument, assets: StudioAsset[]) {
  return { format: 'mojing.world/1', world, assets: await embedAssets(new Set(world.objects.flatMap((object) => object.assetId ? [object.assetId] : [])), assets) };
}
export async function exportCanvasBundle(canvas: StudioCanvas, assets: StudioAsset[], libraryWorlds: WorldDocument[]) {
  const worlds = libraryWorlds.filter((world) => canvas.nodes.some((node) => node.worldId === world.id));
  const ids = new Set([...canvas.nodes.flatMap((node) => [...(node.assetId ? [node.assetId] : []), ...studioInputAssetIds(node.generation)]), ...worlds.flatMap((world) => world.objects.flatMap((object) => object.assetId ? [object.assetId] : []))]);
  return { format: 'mojing.canvas/1', canvas, worlds, assets: await embedAssets(ids, assets) };
}

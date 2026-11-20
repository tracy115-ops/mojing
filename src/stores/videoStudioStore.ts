import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StudioAsset, StudioAssetFolder, StudioTrashedAsset, StudioCanvas, StudioCommerceProject, StudioGenerationInput, StudioJob, StudioPage, StudioRecipe, WorldDocument } from '@/types/video-studio';
import { videoStudioStorage } from '@/services/video-studio/storage';
import { normalizeAssetTags, restoreLibraryAssets, saveLibraryFolder, trashLibraryAssets } from '@/services/video-studio/library';
import type { StudioUploadTask } from '@/types/studio-upload';

interface StudioState {
  hydrated: boolean;
  storageError?: string;
  eagleBaseUrl: string;
  page: StudioPage;
  assets: StudioAsset[];
  assetFolders: StudioAssetFolder[];
  trashedAssets: StudioTrashedAsset[];
  saveAssetFolder: (folder: StudioAssetFolder) => boolean;
  removeAssetFolder: (id: string) => void;
  organizeAssets: (ids: string[], patch: Pick<Partial<StudioAsset>, 'folderId' | 'category'> & { addTags?: string[]; removeTags?: string[] }) => void;
  trashAssets: (ids: string[]) => { changed: string[]; blocked: string[] };
  restoreAssets: (ids: string[]) => void;
  purgeAssets: (ids: string[]) => void;
  jobs: StudioJob[];
  uploadTasks: StudioUploadTask[];
  saveUploadTask: (task: StudioUploadTask) => void;
  canvases: StudioCanvas[];
  worlds: WorldDocument[];
  recipes: StudioRecipe[];
  commerceProjects: StudioCommerceProject[];
  saveCommerceProject: (project: StudioCommerceProject) => void;
  removeCommerceProject: (id: string) => void;
  activeCanvasId?: string;
  activeWorldId?: string;
  draft?: Partial<StudioGenerationInput>;
  setPage: (page: StudioPage) => void;
  setDraft: (draft: Partial<StudioGenerationInput>) => void;
  addAsset: (asset: StudioAsset) => void;
  updateAsset: (id: string, patch: Partial<StudioAsset>) => void;
  removeAsset: (id: string) => void;
  addJob: (job: StudioJob) => void;
  updateJob: (id: string, patch: Partial<StudioJob>) => void;
  saveCanvas: (canvas: StudioCanvas, activate?: boolean) => void;
  removeCanvas: (id: string) => void;
  saveWorld: (world: WorldDocument) => void;
  removeWorld: (id: string) => void;
  saveRecipe: (recipe: StudioRecipe) => void;
  removeRecipe: (id: string) => void;
}
const replace = <T extends { id: string }>(items: T[], item: T) => items.some((value) => value.id === item.id) ? items.map((value) => value.id === item.id ? item : value) : [...items, item];

export const useVideoStudioStore = create<StudioState>()(persist((set, get) => ({
  hydrated: false, eagleBaseUrl: 'http://127.0.0.1:41595', page: 'home', assets: [], assetFolders: [], trashedAssets: [], jobs: [], uploadTasks: [], canvases: [], worlds: [], recipes: [], commerceProjects: [],
  saveUploadTask: (task) => set((state) => ({ uploadTasks: replace(state.uploadTasks, task) })),
  saveAssetFolder: (folder) => {
    try { const assetFolders = saveLibraryFolder(get().assetFolders, folder); set({ assetFolders }); return true; } catch { return false; }
  },
  removeAssetFolder: (id) => set((state) => {
    const folder = state.assetFolders.find((item) => item.id === id);
    if (!folder) return {};
    const rehome = <T extends StudioAsset>(asset: T): T => asset.folderId === id ? { ...asset, folderId: folder.parentId } : asset;
    // Keep all media and children when removing a folder.
    return { assetFolders: state.assetFolders.filter((item) => item.id !== id).map((item) => item.parentId === id ? { ...item, parentId: folder.parentId } : item), assets: state.assets.map(rehome), trashedAssets: state.trashedAssets.map(rehome) };
  }),
  organizeAssets: (ids, patch) => set((state) => ({ assets: state.assets.map((asset) => ids.includes(asset.id) ? { ...asset,
    ...('folderId' in patch ? { folderId: state.assetFolders.some((folder) => folder.id === patch.folderId) ? patch.folderId : undefined } : {}),
    ...(patch.category ? { category: patch.category } : {}),
    ...(patch.addTags || patch.removeTags ? { tags: normalizeAssetTags([...(asset.tags ?? []), ...(patch.addTags ?? [])]).filter((tag) => !patch.removeTags?.includes(tag)) } : {}),
  } : asset) })),
  trashAssets: (ids) => {
    const { assets, trashedAssets, changed, blocked } = trashLibraryAssets(get(), ids, new Date().toISOString());
    set({ assets, trashedAssets }); return { changed, blocked };
  },
  restoreAssets: (ids) => set((state) => restoreLibraryAssets(state, ids)),
  purgeAssets: (ids) => set((state) => ({ trashedAssets: state.trashedAssets.filter((asset) => !ids.includes(asset.id)) })),
  saveCommerceProject: (project) => set((state) => ({ commerceProjects: replace(state.commerceProjects, project) })),
  removeCommerceProject: (id) => set((state) => ({ commerceProjects: state.commerceProjects.filter((project) => project.id !== id) })),
  setPage: (page) => set({ page }),
  setDraft: (draft) => set({ draft }),
  addAsset: (asset) => set((state) => ({ assets: replace(state.assets, asset) })),
  updateAsset: (id, patch) => set((state) => ({ assets: state.assets.map((asset) => asset.id === id ? { ...asset, ...patch, ...(patch.url !== undefined && patch.url !== asset.url ? { cloudUpload: undefined } : {}), id } : asset) })),
  removeAsset: (id) => { get().trashAssets([id]); },
  addJob: (job) => set((state) => ({ jobs: [...state.jobs, job] })),
  updateJob: (id, patch) => set((state) => ({ jobs: state.jobs.map((job) => job.id === id ? { ...job, ...patch, id } : job) })),
  saveCanvas: (canvas, activate = true) => set((state) => ({ canvases: replace(state.canvases, canvas), activeCanvasId: activate ? canvas.id : state.activeCanvasId })),
  removeCanvas: (id) => set((state) => ({ canvases: state.canvases.filter((canvas) => canvas.id !== id), activeCanvasId: state.activeCanvasId === id ? undefined : state.activeCanvasId })),
  saveWorld: (world) => set((state) => ({ worlds: replace(state.worlds, world), activeWorldId: world.id })),
  removeWorld: (id) => set((state) => ({ worlds: state.worlds.filter((world) => world.id !== id), activeWorldId: state.activeWorldId === id ? undefined : state.activeWorldId })),
  saveRecipe: (recipe) => set((state) => ({ recipes: replace(state.recipes, recipe) })),
  removeRecipe: (id) => set((state) => ({ recipes: state.recipes.filter((recipe) => recipe.id !== id) })),
}), {
  name: 'video-studio', storage: createJSONStorage(() => videoStudioStorage),
  partialize: ({ page, assets, assetFolders, trashedAssets, jobs, uploadTasks, canvases, worlds, recipes, commerceProjects, eagleBaseUrl, activeCanvasId, activeWorldId }) => ({ page, assets, assetFolders, trashedAssets, jobs, uploadTasks, canvases, worlds, recipes, commerceProjects, eagleBaseUrl, activeCanvasId, activeWorldId }),
  onRehydrateStorage: () => (state, error) => {
    useVideoStudioStore.setState({ hydrated: true, storageError: error ? String(error) : undefined,
      ...(state ? { jobs: state.jobs.map((job) => job.status === 'queued' || job.status === 'running' ? { ...job, status: 'interrupted' as const } : job), uploadTasks: (state.uploadTasks ?? []).map((task) => task.status === 'uploading' ? { ...task, status: 'interrupted' as const } : task) } : {}),
    });
  },
}));

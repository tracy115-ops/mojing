import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  CreativeProject,
  CreativeProjectType,
  ProjectStatus,
  NovelMetadata,
  NovelChapter,
  NovelVolume,
  ComicMetadata,
  VideoMetadata,
  NarrativeSnapshot,
} from '@/types';
import type { StoryNode } from '@/types/narrative';
import { StoryTreeService, type CreateNodeParams } from '@/services/novel/story-tree';

const generateId = () => crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function createDefaultMetadata(type: CreativeProjectType): NovelMetadata | ComicMetadata | VideoMetadata {
  switch (type) {
    case 'novel':
      return { genre: 'fantasy', targetWordCount: 100000, currentWordCount: 0, chapters: [], volumes: [], style: 'literary', language: 'zh-CN' };
    case 'comic':
      return { style: 'manga', panelLayout: 'grid', pageCount: 0, characters: [] };
    case 'video':
      return { duration: 0, resolution: '1920x1080', style: 'cinematic', aspectRatio: '16:9', fps: 24 };
  }
}

interface ProjectState {
  projects: CreativeProject[];
  activeProjectId: string | null;

  createProject: (type: CreativeProjectType, title: string, description: string, metadata?: Partial<NovelMetadata & ComicMetadata & VideoMetadata>) => CreativeProject;
  updateProject: (id: string, updates: Partial<Pick<CreativeProject, 'title' | 'description' | 'status' | 'tags' | 'coverImage'>>) => void;
  updateProjectMetadata: (id: string, metadataUpdates: Record<string, unknown>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  toggleFavorite: (id: string) => void;

  // Novel-specific
  addChapter: (projectId: string, volumeId?: string) => void;
  deleteChapter: (projectId: string, chapterId: string) => void;
  updateChapter: (projectId: string, chapterId: string, updates: Partial<NovelChapter>) => void;
  updateNarrativeData: (projectId: string, data: NarrativeSnapshot) => void;
  addVolume: (projectId: string, title?: string, level?: import('@/types').VolumeLevel, parentId?: string) => void;
  updateVolume: (projectId: string, volumeId: string, updates: Partial<NovelVolume>) => void;
  deleteVolume: (projectId: string, volumeId: string) => void;
  moveChapterToVolume: (projectId: string, chapterId: string, volumeId: string | undefined) => void;

  // StoryNode (unified tree model)
  getStoryNodes: (projectId: string) => StoryNode[];
  setStoryNodes: (projectId: string, nodes: StoryNode[]) => void;
  createStoryNode: (projectId: string, params: CreateNodeParams) => void;
  updateStoryNode: (projectId: string, nodeId: string, updates: Partial<StoryNode>) => void;
  deleteStoryNode: (projectId: string, nodeId: string) => void;
  reorderStoryNodes: (projectId: string, parentId: string | null, orderedIds: string[]) => void;

  // Comic-specific
  addComicCharacter: (projectId: string, character: Omit<import('@/types').ComicCharacter, 'id'>) => void;
  deleteComicCharacter: (projectId: string, characterId: string) => void;
  updateComicCharacter: (projectId: string, characterId: string, updates: Partial<import('@/types').ComicCharacter>) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,

      createProject: (type, title, description, metadataOverrides) => {
        const now = new Date().toISOString();
        const defaultMeta = createDefaultMetadata(type);
        const metadata = { ...defaultMeta, ...metadataOverrides } as NovelMetadata | ComicMetadata | VideoMetadata;

        const project: CreativeProject = {
          id: generateId(),
          type,
          title,
          description,
          status: 'planning',
          createdAt: now,
          updatedAt: now,
          tags: [],
          isFavorite: false,
          metadata,
        };

        set((s) => ({ projects: [...s.projects, project] }));
        return project;
      },

      updateProject: (id, updates) => {
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p,
          ),
        }));
      },

      updateProjectMetadata: (id, metadataUpdates) => {
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id
              ? { ...p, metadata: { ...p.metadata, ...metadataUpdates }, updatedAt: new Date().toISOString() }
              : p,
          ),
        }));
      },

      deleteProject: (id) => {
        const target = get().projects.find((p) => p.id === id);
        const isSeries = target?.type === 'video' && (target.metadata as VideoMetadata).seriesRole === 'series';
        const deletedIds = isSeries
          ? get().projects
            .filter((project) => project.id === id || (project.type === 'video' && (project.metadata as VideoMetadata).seriesId === id))
            .map((project) => project.id)
          : [id];
        set((s) => ({
          projects: s.projects.filter((p) => !deletedIds.includes(p.id)),
          activeProjectId: s.activeProjectId && deletedIds.includes(s.activeProjectId) ? null : s.activeProjectId,
        }));
        // 级联清理 video 产物文件(只在 novel 类型时落盘,其他类型跳过)
        if (target) {
          void import('../services/video/asset-store')
            .then(({ cleanProjectAssets }) => Promise.all(deletedIds.map((projectId) => cleanProjectAssets(projectId))))
            .catch(() => {
              // 清理失败不影响项目删除本身
            });
        }
      },

      setActiveProject: (id) => set({ activeProjectId: id }),

      toggleFavorite: (id) => {
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, isFavorite: !p.isFavorite, updatedAt: new Date().toISOString() } : p,
          ),
        }));
      },

      // --- Novel ---

      addChapter: (projectId, volumeId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            const newChapter: NovelChapter = {
              id: generateId(),
              title: `${meta.chapters.length + 1}`,
              outline: '',
              content: '',
              status: 'planned',
              wordCount: 0,
              order: meta.chapters.length,
              volumeId,
            };
            return {
              ...p,
              metadata: { ...meta, chapters: [...meta.chapters, newChapter] },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      deleteChapter: (projectId, chapterId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            const remaining = meta.chapters.filter((c) => c.id !== chapterId);
            const currentWordCount = remaining.reduce((sum, c) => sum + c.wordCount, 0);
            const reindexed = remaining.map((c, i) => ({ ...c, order: i }));
            return {
              ...p,
              metadata: { ...meta, chapters: reindexed, currentWordCount },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      updateChapter: (projectId, chapterId, updates) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            const wordCount = updates.content !== undefined
              ? updates.content.length
              : meta.chapters.find((c) => c.id === chapterId)?.wordCount ?? 0;
            const totalWords = meta.chapters.reduce((sum, c) => {
              if (c.id === chapterId) return sum + (updates.content !== undefined ? updates.content.length : c.wordCount);
              return sum + c.wordCount;
            }, 0);

            return {
              ...p,
              metadata: {
                ...meta,
                currentWordCount: totalWords,
                chapters: meta.chapters.map((c) =>
                  c.id === chapterId ? { ...c, ...updates, wordCount } : c,
                ),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      updateNarrativeData: (projectId, data) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            return {
              ...p,
              metadata: { ...meta, narrativeData: data },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      addVolume: (projectId, title, level, parentId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            const volLevel = level ?? 'volume';
            const defaultTitles: Record<string, string> = {
              part: `部 ${meta.volumes.filter((v) => v.level === 'part').length + 1}`,
              act: `幕 ${meta.volumes.filter((v) => v.level === 'act').length + 1}`,
              volume: `卷 ${meta.volumes.filter((v) => (v.level ?? 'volume') === 'volume').length + 1}`,
            };
            const volume: NovelVolume = {
              id: generateId(),
              title: title || defaultTitles[volLevel],
              order: meta.volumes.length,
              level: volLevel,
              parentId,
            };
            return {
              ...p,
              metadata: { ...meta, volumes: [...meta.volumes, volume] },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      updateVolume: (projectId, volumeId, updates) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            return {
              ...p,
              metadata: {
                ...meta,
                volumes: meta.volumes.map((v) =>
                  v.id === volumeId ? { ...v, ...updates } : v,
                ),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      deleteVolume: (projectId, volumeId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            // Move all chapters in this volume to unassigned
            const chapters = meta.chapters.map((c) =>
              c.volumeId === volumeId ? { ...c, volumeId: undefined } : c,
            );
            const remaining = meta.volumes.filter((v) => v.id !== volumeId);
            return {
              ...p,
              metadata: { ...meta, volumes: remaining, chapters },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      moveChapterToVolume: (projectId, chapterId, volumeId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            return {
              ...p,
              metadata: {
                ...meta,
                chapters: meta.chapters.map((c) =>
                  c.id === chapterId ? { ...c, volumeId } : c,
                ),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      // --- StoryNode (unified tree) ---

      getStoryNodes: (projectId) => {
        const proj = get().projects.find((p) => p.id === projectId);
        if (!proj || proj.type !== 'novel') return [];
        const meta = proj.metadata as NovelMetadata;

        // Already migrated
        if (meta.storyNodes && meta.storyNodes.length > 0) return meta.storyNodes;

        const volumes = meta.volumes ?? [];
        const chapters = meta.chapters ?? [];

        // No legacy data to migrate
        if (volumes.length === 0 && chapters.length === 0) return meta.storyNodes ?? [];

        // Migrate legacy volumes + chapters → StoryNodes
        const nodes = StoryTreeService.migrateFromLegacy(volumes, chapters, projectId);

        // Also keep chapters in sync for backward-compatible readers (Export, Reader)
        const syncedChapters = nodes
          .filter((n) => n.nodeType === 'chapter')
          .sort((a, b) => a.order - b.order)
          .map((n, i) => ({
            id: n.id,
            title: n.title,
            outline: n.outline ?? '',
            content: n.content ?? '',
            status: n.status ?? 'planned',
            wordCount: n.wordCount ?? 0,
            order: i,
          }));

        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const m = p.metadata as NovelMetadata;
            return {
              ...p,
              metadata: {
                ...m,
                storyNodes: nodes,
                chapters: syncedChapters,
                volumes: [],
                currentWordCount: syncedChapters.reduce((s, c) => s + c.wordCount, 0),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));

        return nodes;
      },

      setStoryNodes: (projectId, nodes) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            const chapterNodes = nodes
              .filter((n) => n.nodeType === 'chapter')
              .sort((a, b) => a.order - b.order);
            const currentWordCount = chapterNodes.reduce((sum, n) => sum + (n.wordCount ?? 0), 0);
            // Sync chapters for backward compat (Export, Reader, ChapterEditor)
            const chapters: NovelChapter[] = chapterNodes.map((n, i) => ({
              id: n.id,
              title: n.title,
              outline: n.outline ?? '',
              content: n.content ?? '',
              status: n.status ?? 'planned',
              wordCount: n.wordCount ?? 0,
              order: i,
              volumeId: n.parentId ?? undefined,
            }));
            return {
              ...p,
              metadata: { ...meta, storyNodes: nodes, chapters, currentWordCount },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      createStoryNode: (projectId, params) => {
        const current = get().getStoryNodes(projectId);
        const nodes = StoryTreeService.createNode(current, params);
        get().setStoryNodes(projectId, nodes);
      },

      updateStoryNode: (projectId, nodeId, updates) => {
        const current = get().getStoryNodes(projectId);
        const nodes = StoryTreeService.updateNode(current, nodeId, updates);
        get().setStoryNodes(projectId, nodes);
      },

      deleteStoryNode: (projectId, nodeId) => {
        const current = get().getStoryNodes(projectId);
        const nodes = StoryTreeService.deleteNode(current, nodeId);
        get().setStoryNodes(projectId, nodes);
      },

      reorderStoryNodes: (projectId, parentId, orderedIds) => {
        const current = get().getStoryNodes(projectId);
        const nodes = StoryTreeService.reorderNodes(current, parentId, orderedIds);
        get().setStoryNodes(projectId, nodes);
      },

      // --- Comic ---

      addComicCharacter: (projectId, character) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'comic') return p;
            const meta = p.metadata as ComicMetadata;
            return {
              ...p,
              metadata: {
                ...meta,
                characters: [...meta.characters, { ...character, id: generateId() }],
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      deleteComicCharacter: (projectId, characterId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'comic') return p;
            const meta = p.metadata as ComicMetadata;
            return {
              ...p,
              metadata: { ...meta, characters: meta.characters.filter((c) => c.id !== characterId) },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      updateComicCharacter: (projectId, characterId, updates) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'comic') return p;
            const meta = p.metadata as ComicMetadata;
            return {
              ...p,
              metadata: {
                ...meta,
                characters: meta.characters.map((c) =>
                  c.id === characterId ? { ...c, ...updates } : c,
                ),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      // --- Video ---
      // (legacy manual Scenes editor removed — pipeline handles sceneSpec internally)
    }),
    {
      name: 'mojing-projects',
      partialize: (state) => ({
        projects: state.projects,
        activeProjectId: state.activeProjectId,
      }),
    },
  ),
);

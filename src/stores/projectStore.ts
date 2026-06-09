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

const generateId = () => crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function createDefaultMetadata(type: CreativeProjectType): NovelMetadata | ComicMetadata | VideoMetadata {
  switch (type) {
    case 'novel':
      return { genre: 'fantasy', targetWordCount: 100000, currentWordCount: 0, chapters: [], volumes: [], style: 'literary', language: 'zh-CN' };
    case 'comic':
      return { style: 'manga', panelLayout: 'grid', pageCount: 0, characters: [] };
    case 'video':
      return { duration: 0, resolution: '1920x1080', style: 'cinematic', scenes: [], aspectRatio: '16:9', fps: 24 };
  }
}

interface ProjectState {
  projects: CreativeProject[];
  activeProjectId: string | null;

  createProject: (type: CreativeProjectType, title: string, description: string, metadata?: Partial<NovelMetadata & ComicMetadata & VideoMetadata>) => CreativeProject;
  updateProject: (id: string, updates: Partial<Pick<CreativeProject, 'title' | 'description' | 'status' | 'tags' | 'coverImage'>>) => void;
  deleteProject: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  toggleFavorite: (id: string) => void;

  // Novel-specific
  addChapter: (projectId: string, volumeId?: string) => void;
  deleteChapter: (projectId: string, chapterId: string) => void;
  updateChapter: (projectId: string, chapterId: string, updates: Partial<NovelChapter>) => void;
  updateNarrativeData: (projectId: string, data: NarrativeSnapshot) => void;
  addVolume: (projectId: string, title?: string) => void;
  updateVolume: (projectId: string, volumeId: string, updates: Partial<NovelVolume>) => void;
  deleteVolume: (projectId: string, volumeId: string) => void;
  moveChapterToVolume: (projectId: string, chapterId: string, volumeId: string | undefined) => void;

  // Comic-specific
  addComicCharacter: (projectId: string, character: Omit<import('@/types').ComicCharacter, 'id'>) => void;
  deleteComicCharacter: (projectId: string, characterId: string) => void;
  updateComicCharacter: (projectId: string, characterId: string, updates: Partial<import('@/types').ComicCharacter>) => void;

  // Video-specific
  addScene: (projectId: string) => void;
  deleteScene: (projectId: string, sceneId: string) => void;
  updateScene: (projectId: string, sceneId: string, updates: Partial<import('@/types').VideoScene>) => void;
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

      deleteProject: (id) => {
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
        }));
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

      addVolume: (projectId, title) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'novel') return p;
            const meta = p.metadata as NovelMetadata;
            const volume: NovelVolume = {
              id: generateId(),
              title: title || `卷 ${meta.volumes.length + 1}`,
              order: meta.volumes.length,
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

      addScene: (projectId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'video') return p;
            const meta = p.metadata as VideoMetadata;
            const newScene: import('@/types').VideoScene = {
              id: generateId(),
              title: `Scene ${meta.scenes.length + 1}`,
              description: '',
              duration: 5,
              order: meta.scenes.length,
              status: 'scripted',
            };
            return {
              ...p,
              metadata: {
                ...meta,
                scenes: [...meta.scenes, newScene],
                duration: meta.duration + 5,
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      deleteScene: (projectId, sceneId) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'video') return p;
            const meta = p.metadata as VideoMetadata;
            const scene = meta.scenes.find((s) => s.id === sceneId);
            return {
              ...p,
              metadata: {
                ...meta,
                scenes: meta.scenes.filter((s) => s.id !== sceneId),
                duration: meta.duration - (scene?.duration ?? 0),
              },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },

      updateScene: (projectId, sceneId, updates) => {
        set((s) => ({
          projects: s.projects.map((p) => {
            if (p.id !== projectId || p.type !== 'video') return p;
            const meta = p.metadata as VideoMetadata;
            const updatedScenes = meta.scenes.map((sc) =>
              sc.id === sceneId ? { ...sc, ...updates } : sc,
            );
            const duration = updatedScenes.reduce((sum, sc) => sum + sc.duration, 0);
            return {
              ...p,
              metadata: { ...meta, scenes: updatedScenes, duration },
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
      },
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

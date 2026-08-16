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

  // Video Series Seeder
  seedShawBrothersMartialCatProject: () => { series: CreativeProject; episode: CreativeProject };
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

      seedShawBrothersMartialCatProject: () => {
        const existingSeries = get().projects.find(
          (p) => p.type === 'video' && p.title.includes('猫大师'),
        );
        if (existingSeries) {
          const existingEpisode = get().projects.find(
            (p) => p.type === 'video' && (p.metadata as VideoMetadata).seriesId === existingSeries.id,
          );
          set({ activeProjectId: existingSeries.id });
          return { series: existingSeries, episode: existingEpisode ?? existingSeries };
        }

        const now = new Date().toISOString();
        const seriesId = `series_shaw_brothers_${Date.now()}`;
        const episodeId = `episode_shaw_cat_${Date.now()}`;

        const seriesProject: CreativeProject = {
          id: seriesId,
          type: 'video',
          title: '《80年代港风武侠·猫大师与小师妹》',
          description: '视频高度还原80-90年代邵氏电影或早期港产武侠剧的美学视觉，温暖高饱和度怀旧胶片质感。',
          status: 'in_progress',
          createdAt: now,
          updatedAt: now,
          tags: ['港风武侠', '邵氏美学', '复古胶片', '猫大师'],
          isFavorite: true,
          metadata: {
            duration: 30,
            resolution: '1920x1080',
            style: 'vintage',
            aspectRatio: '16:9',
            fps: 24,
            seriesRole: 'series',
            seriesStyleGuide:
              '80年代香港武侠电影风格, 邵氏电影美学, 怀旧中式武侠片, 复古电视剧质感。色调: 温暖且高饱和度的调色, 怀旧胶片颗粒感, 轻微的彩色胶片色偏。画面: 35mm胶片拍摄, 复古胶片纹理, 细微的色差(色散), 软焦效果, 灯光闪烁, 高亮表面有强烈的晕光效果。',
            seriesCharacters: [
              {
                id: 'char_girl_jk',
                name: '甜美年轻女生',
                aliases: ['女生', '长发女生', '小师妹'],
                gender: 'female',
                ageGroup: 'young',
                appearance:
                  '甜美年轻女生，黑长直长发，五官清秀，深色眼线，桃粉色唇膏，精致的编发，点缀粉色丝带与花朵发饰。身穿jk服装，现代服饰。',
                voiceRef: 'zh-CN-XiaoxiaoNeural',
              },
              {
                id: 'char_cat_master',
                name: '胖橘猫',
                aliases: ['胖橘猫大师', '猫大师', '猫咪', '大师'],
                gender: 'male',
                ageGroup: 'middle',
                appearance:
                  '胖橘猫，佩戴黑色圆墨镜，身穿黄色古风僧袍，脸型体态全程不变，神态慵懒又狡黠。',
                voiceRef: 'zh-CN-YunyangNeural',
              },
            ],
            seriesScenes: [
              {
                id: 'scene_courtyard',
                name: '古风庭院',
                description:
                  '古风禅意庭院，石桌石凳，樱花缓缓飘落，温暖高饱和度80年代邵氏武侠胶片色调，阳光晕光。',
              },
            ],
          } as VideoMetadata,
        };

        const demoSceneSpec: import('@/types/video').SceneSpec = {
          characters: (seriesProject.metadata as VideoMetadata).seriesCharacters ?? [],
          scenes: (seriesProject.metadata as VideoMetadata).seriesScenes ?? [],
          meta: {
            title: '第1集：大师，我有一事相求',
            style: 'vintage',
            genre: 'script',
            aspectRatio: '16:9',
            defaultShotDuration: 5,
            sourceMode: 'multishot',
            channel: 'novel',
          },
          shots: [
            {
              id: 'shot_1',
              index: 0,
              videoPrompt:
                '80s Shaw Brothers cinematic martial arts film, ancient courtyard, stone table, young sweet girl in JK modern dress hands folded, facing a chubby ginger cat monk master sitting cross-legged holding a tiny whisk, zen atmosphere, warm vintage film grain, soft glow.',
              narration: '大师，我有一事相求！',
              dialogue: [{ speaker: '甜美年轻女生', text: '大师，我有一事相求！' }],
              characterIds: ['char_girl_jk', 'char_cat_master'],
              sceneId: 'scene_courtyard',
              cameraMovement: 'pan_left',
              durationSeconds: 5,
            },
            {
              id: 'shot_2',
              index: 1,
              videoPrompt:
                '80s vintage martial arts TV series, medium shot, young girl leaning forward with hopeful eyes, chubby ginger cat in yellow monk robe and dark round sunglasses calmly stroking whiskers and listening, warm color grading, 35mm film texture.',
              narration: '我温柔体贴、善良可爱、长相又不差，为什么就是找不到对象啊？',
              dialogue: [{ speaker: '甜美年轻女生', text: '我温柔体贴、善良可爱、长相又不差，为什么就是找不到对象啊？' }],
              characterIds: ['char_girl_jk', 'char_cat_master'],
              sceneId: 'scene_courtyard',
              cameraMovement: 'zoom_in',
              durationSeconds: 5,
            },
            {
              id: 'shot_3',
              index: 2,
              videoPrompt:
                '80s Shaw Brothers movie close up, chubby ginger cat face, wearing dark round sunglasses, yellow monk robe, eyes closed in deep thought, tail gently swishing, atmospheric vintage cinematic lighting, chromatic aberration, halation.',
              narration: '竹篮打水一场空。',
              dialogue: [{ speaker: '胖橘猫', text: '竹篮打水一场空。' }],
              characterIds: ['char_cat_master'],
              sceneId: 'scene_courtyard',
              cameraMovement: 'static',
              durationSeconds: 5,
            },
            {
              id: 'shot_4',
              index: 3,
              videoPrompt:
                '80s vintage film medium close up, sweet young girl tilting head and frowning, scratching her head with confused puzzled expression, delicate braided hair with pink ribbons, retro 35mm film grain, soft focus.',
              narration: '大师，你是说我缘分未到吗？',
              dialogue: [{ speaker: '甜美年轻女生', text: '大师，你是说我缘分未到吗？' }],
              characterIds: ['char_girl_jk'],
              sceneId: 'scene_courtyard',
              cameraMovement: 'zoom_in',
              durationSeconds: 5,
            },
            {
              id: 'shot_5',
              index: 4,
              videoPrompt:
                '80s Hong Kong martial arts close up, chubby ginger cat suddenly opens sharp eyes behind round sunglasses, one paw pointing forward at the girl with smug mocking expression, yellow monk robe, dramatic vintage kung fu movie lighting.',
              narration: '我的意思是，你接着编！',
              dialogue: [{ speaker: '胖橘猫', text: '我的意思是，你接着编！' }],
              characterIds: ['char_cat_master'],
              sceneId: 'scene_courtyard',
              cameraMovement: 'zoom_in',
              durationSeconds: 5,
            },
            {
              id: 'shot_6',
              index: 5,
              videoPrompt:
                '80s Shaw Brothers movie wide shot ending, girl pouting with hands on hips acting cute and annoyed, chubby ginger cat happily lying on stone table, cherry blossom petals slowly falling, warm nostalgic vintage film aesthetics.',
              narration: '哼！你这臭猫！',
              dialogue: [{ speaker: '甜美年轻女生', text: '哼！你这臭猫！' }],
              characterIds: ['char_girl_jk', 'char_cat_master'],
              sceneId: 'scene_courtyard',
              cameraMovement: 'zoom_out',
              durationSeconds: 5,
            },
          ],
        };

        const episodeProject: CreativeProject = {
          id: episodeId,
          type: 'video',
          title: '第1集：大师，我有一事相求',
          description:
            '古风庭院，长发JK女生双手合十向胖橘猫大师请教姻缘，大师神态慵懒闭眼沉思后傲娇怼人。',
          status: 'in_progress',
          createdAt: new Date(Date.now() + 1000).toISOString(),
          updatedAt: now,
          tags: ['第1集', '分镜1-6'],
          isFavorite: false,
          metadata: {
            duration: 30,
            resolution: '1920x1080',
            style: 'vintage',
            aspectRatio: '16:9',
            fps: 24,
            seriesRole: 'episode',
            seriesId: seriesId,
            initialSceneSpec: demoSceneSpec,
          } as VideoMetadata,
        };

        set((s) => ({
          projects: [...s.projects, seriesProject, episodeProject],
          activeProjectId: seriesId,
        }));

        // 自动将第 1 集的 6 个分镜与场景规范预置到 videoStore 中
        try {
          void import('./videoStore').then(({ useVideoStore }) => {
            const videoStore = useVideoStore.getState();
            videoStore.initProject(
              episodeId,
              ['shot_1', 'shot_2', 'shot_3', 'shot_4', 'shot_5', 'shot_6'],
              {
                aspectRatio: '16:9',
                resolution: '1920x1080',
                fps: 24,
                shotDurationSeconds: 5,
                videoTier: 'value',
                imageTier: 'value',
                ttsTier: 'free',
                hardcodeSubtitles: true,
                bgmStyle: 'vintage',
              },
              '第1集：大师，我有一事相求',
            );
            videoStore.setSceneSpec(episodeId, demoSceneSpec);
          });
        } catch {
          // ignore
        }

        return { series: seriesProject, episode: episodeProject };
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

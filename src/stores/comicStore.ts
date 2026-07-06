// ============================================================================
// Comic Store — Phase 1 MVP
// ============================================================================
// 管理漫画生成流水线的运行时状态。每个漫画项目对应一个 ComicPipelineProject。
// 持久化策略:projects 通过 zustand persist 落到 localStorage,让关闭重开 /
// 切换项目都能恢复进度。
//
// 接口完全平行 videoStore.ts 的结构(setStageStatus / setSceneSpec /
// resetStagesFrom / setStageInput / upsertPanel 等),便于复用 stage-handlers
// 架构和单步重跑能力。

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { logger } from '@/services/log';
import type {
  ComicStage,
  ComicStageState,
  ComicStageStatus,
  ComicStageInput,
  ComicStageInputSummary,
  ComicPipelineProject,
  ComicPipelineOptions,
  ComicSceneSpec,
  ComicPanelSpec,
  ComicSourceMode,
} from '@/types/comic';
import { COMIC_PIPELINE_STAGES, COMIC_DEFAULT_OPTIONS } from '@/types/comic';
import type { AspectRatio } from '@/types/video';

/** 包了一层的 localStorage(同 videoStore,吞掉 QuotaExceededError)。 */
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch (err) {
      void logger.warn(`[comic-store] getItem(${name}) failed: ${String(err)}`, 'store');
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch (err) {
      void logger.warn(
        `[comic-store] setItem(${name}) failed (${value?.length ?? 0} chars): ${err instanceof Error ? err.message : String(err)}`,
        'store',
      );
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch (err) {
      void logger.warn(`[comic-store] removeItem(${name}) failed: ${String(err)}`, 'store');
    }
  },
};

// --- Create input ---

export interface CreateComicInput {
  title: string;
  sourceMode: ComicSourceMode;
  sourceText?: string;
  /** novel 模式:关联的小说项目 ID */
  novelProjectId?: string;
  style: string;
  aspectRatio: AspectRatio;
  panelLayout: ComicSceneSpec['meta']['panelLayout'];
  panelCount: number;
  /** 初始角色列表(可空,空时 panel_script 阶段 LLM 自动生成) */
  characters?: { id: string; name: string; appearance: string; personality?: string }[];
  options?: Partial<ComicPipelineOptions>;
}

// --- Store interface ---

interface ComicStoreState {
  projects: Record<string, ComicPipelineProject>;
  activeProjectId: string | undefined;
  setActiveProjectId: (id: string | undefined) => void;

  // --- selectors ---
  getProject: (id: string) => ComicPipelineProject | undefined;

  // --- lifecycle ---
  createProject: (input: CreateComicInput) => ComicPipelineProject;
  deleteProject: (id: string) => void;

  // --- stage control ---
  setStageStatus: (
    id: string,
    stage: ComicStage,
    status: ComicStageStatus,
    extra?: Partial<ComicStageState>,
  ) => void;
  advanceToStage: (id: string, stage: ComicStage) => void;

  // --- artifacts ---
  setSceneSpec: (id: string, spec: ComicSceneSpec) => void;
  /** upsert 单个 panel(有同 id 替换,无则追加) */
  upsertPanel: (id: string, panel: ComicPanelSpec) => void;
  /** 批量替换 panels(panel_script 阶段产物) */
  setPanels: (id: string, panels: ComicPanelSpec[]) => void;
  /** 批量替换 pages(page_compose 阶段产物) */
  setPages: (id: string, pages: import('@/types/comic').ComicPageSpec[]) => void;
  setFinalPages: (id: string, urls: string[]) => void;

  /** 把从 fromStage 开始(含)的所有 stage 重置为 pending,清掉相关产物。
   *  保留 stage.input(用户改过的参数),只清 status / progress / 产物字段。 */
  resetStagesFrom: (id: string, fromStage: ComicStage) => void;

  // --- stage input (单步重跑) ---
  setStageInputSummary: (id: string, stage: ComicStage, summary: ComicStageInputSummary) => void;
  setStageInput: (id: string, stage: ComicStage, patch: Partial<ComicStageInput>) => void;
}

// --- helpers ---

type TrackedStage = Exclude<ComicStage, 'idle' | 'complete' | 'error'>;

function buildInitialStages(
  options: ComicPipelineOptions,
): Record<TrackedStage, ComicStageState> {
  const stages = {} as Record<TrackedStage, ComicStageState>;
  for (const s of COMIC_PIPELINE_STAGES) {
    const skipped = s === 'character_anchor' && !options.enableCharacterAnchor;
    stages[s] = {
      stage: s,
      status: skipped ? 'skipped' : 'pending',
      progress: 0,
    };
  }
  return stages;
}

function now(): string {
  return new Date().toISOString();
}

function touch<T extends { updatedAt: string }>(project: T): T {
  project.updatedAt = now();
  return project;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- store impl ---

export const useComicStore = create<ComicStoreState>()(
  persist(
    (set, get) => ({
      projects: {},
      activeProjectId: undefined,
      setActiveProjectId: (id) => set({ activeProjectId: id }),

      getProject: (id) => get().projects[id],

      createProject: (input) => {
        const id = genId('comic');
        const options = { ...COMIC_DEFAULT_OPTIONS, ...input.options };
        const characters = (input.characters ?? []).map((c, idx) => ({
          id: c.id,
          name: c.name,
          appearance: c.appearance,
          personality: c.personality,
          firstAppearPanelIndex: idx,
        }));
        const project: ComicPipelineProject = {
          id,
          novelProjectId: input.novelProjectId,
          title: input.title,
          sourceMode: input.sourceMode,
          sourceText: input.sourceText,
          style: input.style,
          aspectRatio: input.aspectRatio,
          panelLayout: input.panelLayout,
          panelCount: input.panelCount,
          spec: {
            characters,
            panels: [],
            meta: {
              title: input.title,
              style: input.style,
              aspectRatio: input.aspectRatio,
              panelLayout: input.panelLayout,
              sourceMode: input.sourceMode,
              channel: input.novelProjectId ? 'novel' : 'direct',
            },
          },
          options,
          stages: buildInitialStages(options),
          currentStage: 'idle',
          finalPageUrls: [],
          createdAt: now(),
          updatedAt: now(),
        };
        set((s) => ({
          projects: { ...s.projects, [id]: project },
          activeProjectId: id,
        }));
        return project;
      },

      deleteProject: (id) =>
        set((s) => {
          const { [id]: _removed, ...rest } = s.projects;
          void _removed;
          const activeProjectId =
            s.activeProjectId === id ? undefined : s.activeProjectId;
          return { projects: rest, activeProjectId };
        }),

      setStageStatus: (id, stage, status, extra) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          if (stage === 'idle' || stage === 'complete' || stage === 'error') {
            // idle/complete/error 不在 stages map 里,只更新 currentStage
            return {
              projects: {
                ...s.projects,
                [id]: touch({ ...proj, currentStage: stage }),
              },
            };
          }
          const oldStage = proj.stages[stage];
          const newStage: ComicStageState = {
            ...oldStage,
            stage,
            status,
            progress: extra?.progress ?? oldStage.progress,
            ...(extra ?? {}),
          };
          if (status === 'running' && !newStage.startedAt) {
            newStage.startedAt = now();
          }
          if (status === 'completed' || status === 'error' || status === 'skipped') {
            newStage.completedAt = now();
          }
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                stages: { ...proj.stages, [stage]: newStage },
              }),
            },
          };
        }),

      advanceToStage: (id, stage) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          return {
            projects: {
              ...s.projects,
              [id]: touch({ ...proj, currentStage: stage }),
            },
          };
        }),

      setSceneSpec: (id, spec) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          return {
            projects: {
              ...s.projects,
              [id]: touch({ ...proj, spec }),
            },
          };
        }),

      upsertPanel: (id, panel) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          const exists = proj.spec.panels.some((p) => p.id === panel.id);
          const panels = exists
            ? proj.spec.panels.map((p) => (p.id === panel.id ? panel : p))
            : [...proj.spec.panels, panel];
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                spec: { ...proj.spec, panels },
              }),
            },
          };
        }),

      setPanels: (id, panels) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                spec: { ...proj.spec, panels },
              }),
            },
          };
        }),

      setPages: (id, pages) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                spec: { ...proj.spec, pages },
              }),
            },
          };
        }),

      setFinalPages: (id, urls) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                finalPageUrls: urls,
                currentStage: 'complete',
              }),
            },
          };
        }),

      resetStagesFrom: (id, fromStage) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          if (
            fromStage === 'idle' ||
            fromStage === 'complete' ||
            fromStage === 'error'
          ) {
            return s;
          }
          const fromIdx = COMIC_PIPELINE_STAGES.indexOf(fromStage);
          if (fromIdx < 0) return s;
          const newStages = { ...proj.stages };
          for (let i = fromIdx; i < COMIC_PIPELINE_STAGES.length; i++) {
            const stage = COMIC_PIPELINE_STAGES[i];
            const old = proj.stages[stage];
            // 保留 input(用户改过的参数),只清 status / progress / 产物
            newStages[stage] = {
              stage,
              status: stage === 'character_anchor' && !proj.options.enableCharacterAnchor
                ? 'skipped'
                : 'pending',
              progress: 0,
              input: old?.input,
              inputSummary: old?.inputSummary,
            };
          }
          // 清对应产物
          const newSpec: ComicSceneSpec = { ...proj.spec };
          if (fromStage === 'character_anchor') {
            // 清角色立绘 + 全部下游
            newSpec.characters = proj.spec.characters.map((c) => ({
              ...c,
              portraitImage: undefined,
              turnaroundImage: undefined,
            }));
            newSpec.panels = proj.spec.panels.map((p) => ({ ...p, imageUrl: undefined }));
            newSpec.pages = undefined;
          } else if (fromStage === 'panel_script') {
            // 清 panels(下游 panel_image/page_compose/dialogue_burn 全失效)
            newSpec.panels = [];
            newSpec.pages = undefined;
          } else if (fromStage === 'panel_image') {
            newSpec.panels = proj.spec.panels.map((p) => ({ ...p, imageUrl: undefined }));
            newSpec.pages = undefined;
          } else if (fromStage === 'page_compose') {
            // 清 pages(dialogue_burn 也失效)
            newSpec.pages = undefined;
          } else if (fromStage === 'dialogue_burn') {
            // dialogue_burn 把气泡烧进 panel.imageUrl(覆盖原值,无法恢复),
            // 同时 page_compose 是下游也会失效。
            // 因此:清 pages(强制 page_compose 重跑),
            //      并把 panel_image 状态退回 pending(强制重出干净底图)
            newSpec.pages = undefined;
            newStages.panel_image = {
              stage: 'panel_image',
              status: 'pending',
              progress: 0,
              input: newStages.panel_image?.input,
              inputSummary: newStages.panel_image?.inputSummary,
            };
            newSpec.panels = proj.spec.panels.map((p) => ({ ...p, imageUrl: undefined }));
          }
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                stages: newStages,
                spec: newSpec,
                finalPageUrls: [],
              }),
            },
          };
        }),

      setStageInputSummary: (id, stage, summary) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          if (
            stage === 'idle' ||
            stage === 'complete' ||
            stage === 'error'
          ) {
            return s;
          }
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                stages: {
                  ...proj.stages,
                  [stage]: { ...proj.stages[stage], inputSummary: summary },
                },
              }),
            },
          };
        }),

      setStageInput: (id, stage, patch) =>
        set((s) => {
          const proj = s.projects[id];
          if (!proj) return s;
          if (
            stage === 'idle' ||
            stage === 'complete' ||
            stage === 'error'
          ) {
            return s;
          }
          const oldStage = proj.stages[stage];
          const merged: ComicStageInput = { ...oldStage.input, ...patch };
          return {
            projects: {
              ...s.projects,
              [id]: touch({
                ...proj,
                stages: {
                  ...proj.stages,
                  [stage]: { ...oldStage, input: merged },
                },
              }),
            },
          };
        }),
    }),
    {
      name: 'mojing-comic-store',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ projects: s.projects }),
    },
  ),
);

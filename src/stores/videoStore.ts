// ============================================================================
// Video Store — Phase 1 MVP
// ============================================================================
// 管理视频生成流水线的运行时状态。每个小说项目对应一个 VideoProjectState。
// 持久化策略：暂不 persist（重启后重建即可），避免长期堆积临时 URL。

import { create } from 'zustand';
import { logger } from '@/services/log';
import type {
  VideoProjectState,
  VideoStage,
  VideoStageState,
  VideoStageStatus,
  VideoSpec,
  StoryboardShot,
  GeneratedClip,
  GeneratedAudio,
  AnchorImage,
  AspectRatio,
  ModelTier,
  SceneSpec,
  PipelineOptions,
  StageInvocation,
  StageTotals,
  StageInputSummary,
} from '@/types/video';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';

interface VideoStoreState {
  /** 按 novelProjectId 索引 */
  projects: Record<string, VideoProjectState>;
  /** 直接生成的 clip 列表（不绑小说，用户手写 prompt 直接 T2V） */
  directClips: GeneratedClip[];
  /** 直接生成进行中标志 */
  directGenerating: boolean;
  /** 直接生成的最后错误 */
  directError: string | undefined;
  /**
   * 当前在主面板展示的流水线 id（novelProjectId 或合成 direct_xxx）。
   * 由 VideoGeneratorModal/DirectVideoModal 启动时写入,VideoPipelinePanel 据此渲染。
   */
  activePipelineId: string | undefined;
  setActivePipelineId: (id: string | undefined) => void;

  // --- selectors ---
  getProject: (novelProjectId: string) => VideoProjectState | undefined;

  // --- lifecycle ---
  initProject: (novelProjectId: string, selectedChapterIds: string[], spec: VideoSpec) => VideoProjectState;
  resetProject: (novelProjectId: string) => void;
  updateSpec: (novelProjectId: string, specUpdates: Partial<VideoSpec>) => void;

  // --- stage control ---
  setStageStatus: (
    novelProjectId: string,
    stage: VideoStage,
    status: VideoStageStatus,
    extra?: Partial<VideoStageState>,
  ) => void;
  advanceToStage: (novelProjectId: string, stage: VideoStage) => void;
  setError: (novelProjectId: string, error: string | undefined) => void;

  // --- artifacts ---
  setShots: (novelProjectId: string, shots: StoryboardShot[]) => void;
  updateShot: (novelProjectId: string, shotId: string, updates: Partial<StoryboardShot>) => void;
  addClip: (novelProjectId: string, clip: GeneratedClip) => void;
  addAudio: (novelProjectId: string, audio: GeneratedAudio) => void;
  addAnchorImage: (novelProjectId: string, anchor: AnchorImage) => void;
  setFinalVideo: (
    novelProjectId: string,
    url: string,
    meta?: { durationSeconds?: number; sizeBytes?: number },
  ) => void;
  /** Phase 2:写入跨步复用的 SceneSpec(含角色立绘/场景图/分镜) */
  setSceneSpec: (novelProjectId: string, spec: SceneSpec) => void;
  /** Phase 2:写入用户选择的步骤开关 */
  setPipelineOptions: (novelProjectId: string, options: PipelineOptions) => void;

  /** 把 router 上报的一次 provider 调用追加到对应 stage 的 invocations[],
   *  同时重算 totals。空 stage 跳过(避免误写)。 */
  appendInvocation: (
    novelProjectId: string,
    stage: VideoStage,
    invocation: StageInvocation,
  ) => void;
  /** 设置某 stage 的输入摘要(UI 账本第一段)。 */
  setStageInputSummary: (
    novelProjectId: string,
    stage: VideoStage,
    summary: StageInputSummary,
  ) => void;

  // --- direct (no-novel) mode ---
  setDirectGenerating: (inProgress: boolean) => void;
  setDirectError: (error: string | undefined) => void;
  addDirectClip: (clip: GeneratedClip) => void;
  clearDirectClips: () => void;
}

const DEFAULT_SPEC: VideoSpec = {
  aspectRatio: '16:9',
  resolution: '1920x1080',
  fps: 24,
  shotDurationSeconds: 5,
  videoTier: 'value',
  imageTier: 'value',
  ttsTier: 'free',
  hardcodeSubtitles: true,
  bgmStyle: 'cinematic',
};

function buildInitialStages(): Record<VideoStage, VideoStageState> {
  const stages = {} as Record<VideoStage, VideoStageState>;
  const allStages: VideoStage[] = ['idle', ...VIDEO_PIPELINE_STAGES, 'complete', 'error'];
  for (const s of allStages) {
    if (s === 'idle' || s === 'complete' || s === 'error') continue; // not tracked as stage-state
    stages[s] = {
      stage: s,
      status: DEFAULT_SKIPPED_STAGES.has(s) ? 'skipped' : 'pending',
      progress: 0,
    };
  }
  return stages;
}

function now(): string {
  return new Date().toISOString();
}

function recomputeTotals(invocations: StageInvocation[] | undefined): StageTotals {
  if (!invocations || invocations.length === 0) {
    return { calls: 0, durationMs: 0 };
  }
  const totals: StageTotals = { calls: invocations.length, durationMs: 0 };
  let hasTokens = false, hasImages = false, hasAudio = false, hasVideo = false, hasCost = false;
  for (const inv of invocations) {
    totals.durationMs += inv.durationMs ?? 0;
    if (inv.inputTokens !== undefined) {
      totals.inputTokens = (totals.inputTokens ?? 0) + inv.inputTokens;
      hasTokens = true;
    }
    if (inv.outputTokens !== undefined) {
      totals.outputTokens = (totals.outputTokens ?? 0) + inv.outputTokens;
      hasTokens = true;
    }
    if (inv.imageCount !== undefined) {
      totals.imageCount = (totals.imageCount ?? 0) + inv.imageCount;
      hasImages = true;
    }
    if (inv.audioSeconds !== undefined) {
      totals.audioSeconds = (totals.audioSeconds ?? 0) + inv.audioSeconds;
      hasAudio = true;
    }
    if (inv.videoSeconds !== undefined) {
      totals.videoSeconds = (totals.videoSeconds ?? 0) + inv.videoSeconds;
      hasVideo = true;
    }
    if (inv.cost !== undefined) {
      totals.cost = (totals.cost ?? 0) + inv.cost;
      hasCost = true;
    }
  }
  if (!hasTokens) totals.inputTokens = totals.outputTokens = undefined;
  if (!hasImages) totals.imageCount = undefined;
  if (!hasAudio) totals.audioSeconds = undefined;
  if (!hasVideo) totals.videoSeconds = undefined;
  if (!hasCost) totals.cost = undefined;
  return totals;
}

function touch(state: VideoProjectState): VideoProjectState {
  return { ...state, updatedAt: now() };
}

export const useVideoStore = create<VideoStoreState>((set, get) => ({
  projects: {},
  directClips: [],
  directGenerating: false,
  directError: undefined,
  activePipelineId: undefined,
  setActivePipelineId: (id) => set({ activePipelineId: id }),

  getProject: (novelProjectId) => get().projects[novelProjectId],

  initProject: (novelProjectId, selectedChapterIds, spec) => {
    const existing = get().projects[novelProjectId];
    const project: VideoProjectState = {
      novelProjectId,
      selectedChapterIds,
      spec: { ...DEFAULT_SPEC, ...spec },
      stages: buildInitialStages(),
      currentStage: 'script_slicing',
      shots: [],
      anchorImages: [],
      clips: [],
      audios: [],
      createdAt: now(),
      updatedAt: now(),
    };
    set((s) => ({
      projects: { ...s.projects, [novelProjectId]: project },
    }));
    return existing ?? project;
  },

  resetProject: (novelProjectId) => {
    set((s) => {
      const next = { ...s.projects };
      delete next[novelProjectId];
      return { projects: next };
    });
  },

  updateSpec: (novelProjectId, specUpdates) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, spec: { ...proj.spec, ...specUpdates } }),
        },
      };
    });
  },

  setStageStatus: (novelProjectId, stage, status, extra) => {
    // 仅 error 状态写日志(running 高频,信息量低)
    if (status === 'error') {
      void logger.error(`[store] ${stage} → error: ${extra?.error ?? '(no msg)'}`, 'diag');
    }
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const prev = proj.stages[stage];
      if (!prev) return s;
      const next: VideoStageState = {
        ...prev,
        ...extra,
        stage,
        status,
        startedAt: status === 'running' && !prev.startedAt ? now() : prev.startedAt,
        completedAt: status === 'completed' || status === 'skipped' ? now() : prev.completedAt,
      };
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            stages: { ...proj.stages, [stage]: next },
          }),
        },
      };
    });
  },

  advanceToStage: (novelProjectId, stage) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, currentStage: stage }),
        },
      };
    });
  },

  setError: (novelProjectId, error) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, error, currentStage: error ? 'error' : proj.currentStage }),
        },
      };
    });
  },

  setShots: (novelProjectId, shots) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, shots }),
        },
      };
    });
  },

  updateShot: (novelProjectId, shotId, updates) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            shots: proj.shots.map((sh) => (sh.id === shotId ? { ...sh, ...updates } : sh)),
          }),
        },
      };
    });
  },

  addClip: (novelProjectId, clip) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const exists = proj.clips.some((c) => c.shotId === clip.shotId);
      const clips = exists
        ? proj.clips.map((c) => (c.shotId === clip.shotId ? clip : c))
        : [...proj.clips, clip];
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, clips }),
        },
      };
    });
  },

  addAudio: (novelProjectId, audio) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const exists = proj.audios.some((a) => a.shotId === audio.shotId);
      const audios = exists
        ? proj.audios.map((a) => (a.shotId === audio.shotId ? audio : a))
        : [...proj.audios, audio];
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, audios }),
        },
      };
    });
  },

  addAnchorImage: (novelProjectId, anchor) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const exists = proj.anchorImages.some((a) => a.characterId === anchor.characterId);
      const anchorImages = exists
        ? proj.anchorImages.map((a) => (a.characterId === anchor.characterId ? anchor : a))
        : [...proj.anchorImages, anchor];
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, anchorImages }),
        },
      };
    });
  },

  setFinalVideo: (novelProjectId, url, meta) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            finalVideoUrl: url,
            finalDurationSeconds: meta?.durationSeconds ?? proj.finalDurationSeconds,
            finalSizeBytes: meta?.sizeBytes ?? proj.finalSizeBytes,
            currentStage: 'complete',
          }),
        },
      };
    });
  },

  setSceneSpec: (novelProjectId, spec) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, sceneSpec: spec }),
        },
      };
    });
  },

  setPipelineOptions: (novelProjectId, options) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, options }),
        },
      };
    });
  },

  appendInvocation: (novelProjectId, stage, invocation) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const prevStage = proj.stages[stage];
      if (!prevStage) return s;
      const invocations = [...(prevStage.invocations ?? []), invocation];
      const totals = recomputeTotals(invocations);
      const next: VideoStageState = { ...prevStage, invocations, totals };
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            stages: { ...proj.stages, [stage]: next },
          }),
        },
      };
    });
  },

  setStageInputSummary: (novelProjectId, stage, summary) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const prevStage = proj.stages[stage];
      if (!prevStage) return s;
      const next: VideoStageState = { ...prevStage, inputSummary: summary };
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            stages: { ...proj.stages, [stage]: next },
          }),
        },
      };
    });
  },

  // --- direct (no-novel) mode ---

  setDirectGenerating: (inProgress) => {
    set({ directGenerating: inProgress });
  },

  setDirectError: (error) => {
    set({ directError: error });
  },

  addDirectClip: (clip) => {
    set((s) => ({ directClips: [clip, ...s.directClips] }));
  },

  clearDirectClips: () => {
    set({ directClips: [] });
  },
}));

// --- Re-exports for convenience ---

export type { AspectRatio, ModelTier };

// --- 订阅 provider router 的 invocation 上报 ---
// router 每次发一个 invocation,自动追加到栈顶 stage 的账本。
// 栈顶由 pipeline 进入/退出 stage 时通过 pushStageContext/popStageContext 设置。
import { subscribeInvocation } from '@/services/providers/invocation-context';

subscribeInvocation((ctx, invocation) => {
  useVideoStore.getState().appendInvocation(ctx.novelProjectId, ctx.stage as VideoStage, invocation);
});

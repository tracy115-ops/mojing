// ============================================================================
// Video Store — Phase 1 MVP
// ============================================================================
// 管理视频生成流水线的运行时状态。每个小说项目对应一个 VideoProjectState。
// 持久化策略：暂不 persist（重启后重建即可），避免长期堆积临时 URL。

import { create } from 'zustand';
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
} from '@/types/video';
import { VIDEO_PIPELINE_STAGES, PHASE1_SKIPPED_STAGES } from '@/types/video';

interface VideoStoreState {
  /** 按 novelProjectId 索引 */
  projects: Record<string, VideoProjectState>;

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
  setFinalVideo: (novelProjectId: string, url: string) => void;
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
      status: PHASE1_SKIPPED_STAGES.has(s) ? 'skipped' : 'pending',
      progress: 0,
    };
  }
  return stages;
}

function now(): string {
  return new Date().toISOString();
}

function touch(state: VideoProjectState): VideoProjectState {
  return { ...state, updatedAt: now() };
}

export const useVideoStore = create<VideoStoreState>((set, get) => ({
  projects: {},

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

  setFinalVideo: (novelProjectId, url) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, finalVideoUrl: url, currentStage: 'complete' }),
        },
      };
    });
  },
}));

// --- Re-exports for convenience ---

export type { AspectRatio, ModelTier };

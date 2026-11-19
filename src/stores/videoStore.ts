// ============================================================================
// Video Store — Phase 1 MVP
// ============================================================================
// 管理视频生成流水线的运行时状态。每个小说项目对应一个 VideoProjectState。
// 持久化策略:projects + directClips 通过 zustand persist 落到 localStorage,
// 让关闭重开 / 切换任务都能恢复进度。运行时标志(directGenerating 等)不持久化。
//
// 失效过滤:blob: URL 在进程结束即失效,rehydrate 时扫一遍把 blob: 标记的
// clip / audio / 立绘清空,避免渲染破图。远程 http(s) URL 和 data: URI 不动
// (前者由 CDN 兜底,后者自带数据)。

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { logger } from '@/services/log';
import {
  reconcileSceneSpecArtifacts,
  resetVideoStagesFrom,
} from '@/services/video/core/derived-artifact-invalidation';
import {
  allShotsHaveVideoCandidates,
  isShotAssemblyReady,
  registerPersistedShotVersions,
  restoreClipFromShotVersion,
} from '@/services/video/core/shot-production-contract';
import { fingerprintImportedVideoContext, isGeneratedVideoCurrent } from '@/services/video/core/shot-generation-receipt';
import { resolveVideoQualityPolicy } from '@/services/video/core/quality-policy';

/** 包了一层的 localStorage:把 setItem 的 QuotaExceededError 吞掉,
 *  避免整个 store 卡死/抛到 UI 上。失败时记 warn,业务继续跑(数据只在内存里)。
 *  读失败 getItem 返回 null 时也降级,不阻塞 rehydrate。 */
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch (err) {
      void logger.warn(`[video-store] getItem(${name}) failed: ${String(err)}`, 'store');
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch (err) {
      // 多半是 QuotaExceededError。记 warn 不抛,保住运行时状态。
      void logger.warn(
        `[video-store] setItem(${name}) failed (${(value?.length ?? 0)} chars): ${err instanceof Error ? err.message : String(err)}`,
        'store',
      );
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch (err) {
      void logger.warn(`[video-store] removeItem(${name}) failed: ${String(err)}`, 'store');
    }
  },
};
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
  ShotSpec,
  CharacterAnchor,
  SceneAnchor,
  PipelineOptions,
  StageInvocation,
  StageTotals,
  StageInputSummary,
  StageInput,
  VideoExecutionBinding,
  VideoTimelineState,
  ShotReviewStatus,
  ShotVersion,
} from '@/types/video';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES, DEFAULT_PIPELINE_OPTIONS } from '@/types/video';
import { normalizeTimelineState } from '@/services/video/core/timeline-state';

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
  initProject: (novelProjectId: string, selectedChapterIds: string[], spec: VideoSpec, title?: string) => VideoProjectState;
  /** 更新可读标题(用于 Direct 任务列表/面板 header 显示) */
  setProjectTitle: (novelProjectId: string, title: string) => void;
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
  setClips: (novelProjectId: string, clips: GeneratedClip[]) => void;
  addAudio: (novelProjectId: string, audio: GeneratedAudio) => void;
  addAnchorImage: (novelProjectId: string, anchor: AnchorImage) => void;
  setFinalVideo: (
    novelProjectId: string,
    url: string,
    meta?: { durationSeconds?: number; sizeBytes?: number },
  ) => void;
  clearFinalVideo: (novelProjectId: string) => void;
  /** Phase 2:写入跨步复用的 SceneSpec(含角色立绘/场景图/分镜) */
  setSceneSpec: (novelProjectId: string, spec: SceneSpec) => void;
  setTimelineState: (novelProjectId: string, patch: Partial<VideoTimelineState>) => void;
  /** Phase 2:写入用户选择的步骤开关 */
  setPipelineOptions: (novelProjectId: string, options: PipelineOptions) => void;
  setExecutionBinding: (novelProjectId: string, binding: VideoExecutionBinding) => void;

  /**
   * 把从 fromStage 开始(含)的所有 stage 状态重置为 pending,
   * 并清掉相关产物(anchor/clips/audios/finalVideoUrl/sceneSpec 里对应的图字段)。
   * 用于"从失败处重试"——让 pipeline-runner 的 isStageLiveCompleted 失效,
   * 强制重跑该 stage 及其之后的所有 stage。
   *
   * 注意:不清 script_slicing/storyboard/extraction,这三步的 sceneSpec 是
   * 整体使用的,单独重置某个没意义,由 resume() 自己决定是否重跑。
   */
  resetStagesFrom: (novelProjectId: string, fromStage: VideoStage) => void;

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
  /** 更新某步的可编辑输入参数(单步重跑用)。浅合并。 */
  setStageInput: (
    novelProjectId: string,
    stage: VideoStage,
    patch: Partial<StageInput>,
  ) => void;

  // --- Granular Manual Interventions (Human-in-the-Loop) ---
  updateSceneSpecShot: (novelProjectId: string, shotId: string, updates: Partial<StoryboardShot> & Partial<ShotSpec>) => void;
  applyWorldSequenceReferences: (novelProjectId: string, expected: SceneSpec, worldId: string, frames: Array<{ shotId: string; url: string }>) => boolean;
  addSceneSpecShot: (novelProjectId: string, shot: Omit<StoryboardShot, 'id' | 'index'> & Partial<ShotSpec>) => void;
  deleteSceneSpecShot: (novelProjectId: string, shotId: string) => void;
  addShotVersion: (novelProjectId: string, shotId: string, version: ShotVersion, options?: { select?: boolean }) => void;
  adoptImportedVideo: (novelProjectId: string, shotId: string, version: ShotVersion) => boolean;
  selectShotVersion: (novelProjectId: string, shotId: string, versionId: string) => void;
  reviewShotVersion: (
    novelProjectId: string,
    shotId: string,
    versionId: string,
    status: ShotReviewStatus,
    note?: string,
  ) => void;
  lockShotVersion: (novelProjectId: string, shotId: string, versionId: string) => boolean;
  ensureShotVersionHistory: (novelProjectId: string) => void;
  updateSceneSpecCharacter: (novelProjectId: string, characterId: string, updates: Partial<CharacterAnchor>) => void;
  updateSceneSpecScene: (novelProjectId: string, sceneId: string, updates: Partial<SceneAnchor>) => void;
  updateSceneSpec: (novelProjectId: string, patch: Partial<SceneSpec>) => void;

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

function markProjectAwaitingVideoReview(
  project: VideoProjectState,
  shots: ShotSpec[],
): VideoProjectState {
  if (!allShotsHaveVideoCandidates(shots, project.clips)) return project;
  const clipsByShot = new Map(project.clips.map((clip) => [clip.shotId, clip]));
  const qualityPolicy = resolveVideoQualityPolicy(project.options);
  const allLocked = shots.every((shot) => isShotAssemblyReady(shot, clipsByShot.get(shot.id), {
    visualReviewRequired: qualityPolicy.visualReviewRequired,
    blockOnVisualReviewUnavailable: qualityPolicy.blockOnVisualReviewUnavailable,
  }));
  if (allLocked) return project;

  const stages = { ...project.stages };
  const videoGeneration = stages.video_generation;
  if (videoGeneration) {
    stages.video_generation = {
      ...videoGeneration,
      status: 'awaiting_review',
      progress: 1,
      error: undefined,
      completedAt: undefined,
    };
  }
  for (const stage of ['video_review', 'audio_merge', 'composing'] as VideoStage[]) {
    const state = stages[stage];
    if (!state) continue;
    stages[stage] = {
      ...state,
      status: 'pending',
      progress: 0,
      error: undefined,
      completedAt: undefined,
    };
  }

  return touch({
    ...project,
    stages,
    currentStage: 'video_generation',
    finalVideoUrl: undefined,
    finalDurationSeconds: undefined,
    finalSizeBytes: undefined,
  });
}

/**
 * 判断一个资源 URL 是否在重启后仍然可用。
 * - blob: URL 进程结束即失效 → 不可用
 * - data: URI 自带数据 → 可用(但可能很大,见下方 DATA_URI_MAX_BYTES)
 * - http(s):// 远程 URL → 可用(CDN 兜底)
 * - 文件路径(如 /path/to, C:\..., tauri://) → 假定可用
 */
function isAssetLive(url: string | undefined | null): boolean {
  if (!url) return false;
  const s = url.trim();
  if (!s) return false;
  if (s.startsWith('blob:')) return false;
  return true;
}

/** 持久化时单个 data: URI 的最大允许长度(字符数)。
 *  超过这个值的 data: URI 不写 localStorage,避免一张大图把 5MB 配额撑爆。
 *  运行时仍然在内存里用,只是不落盘——下次重启需要重跑或走 asset-store 落盘的本地路径。
 *  100KB ≈ 一张 1024x1024 PNG base64 后的下限。 */
const DATA_URI_MAX_BYTES = 100 * 1024;

/** 把 URL 里超过阈值的 data: URI 替换为空串。
 *  blob:/http(s):/本地路径 都原样返回。 */
function stripOversizedDataUri(url: string | undefined): string | undefined {
  if (!url) return url;
  if (url.startsWith('data:') && url.length > DATA_URI_MAX_BYTES) return '';
  return url;
}

/** 必填字段版:返回值类型仍是 string(剥掉则返回空串)。 */
function stripOversizedDataUriReq(url: string): string {
  if (url.startsWith('data:') && url.length > DATA_URI_MAX_BYTES) return '';
  return url;
}

/** 持久化前的体积控制:扫描所有产物字段,把超大 data: URI 清空。
 *  不动其他 URL 形式。返回的对象是 store 的持久化快照。
 *
 *  覆盖范围:
 *   - proj.anchorImages[].imageUrl       (旧字段,目前没用但保留)
 *   - proj.audios[].audioUrl
 *   - proj.clips[].{videoUrl,thumbnailUrl,keyframeImage,audioTrack}
 *   - proj.finalVideoUrl
 *   - proj.sceneSpec.characters[].portraitImage + turnaroundImage + costumeVariants[].portraitImage
 *   - proj.sceneSpec.scenes[].backgroundImage
 *   - proj.sceneSpec.shots[].keyframeImage  ←  历史上漏掉的就是这个
 */
function shrinkForPersistence(proj: VideoProjectState): VideoProjectState {
  let changed = false;
  const anchorImages = proj.anchorImages.map((a) => {
    const imageUrl = stripOversizedDataUriReq(a.imageUrl);
    if (imageUrl !== a.imageUrl) { changed = true; return { ...a, imageUrl }; }
    return a;
  });
  const audios = proj.audios.map((a) => {
    const audioUrl = stripOversizedDataUriReq(a.audioUrl);
    if (audioUrl !== a.audioUrl) { changed = true; return { ...a, audioUrl }; }
    return a;
  });
  const clips = proj.clips.map((c) => {
    const videoUrl = stripOversizedDataUriReq(c.videoUrl);
    const thumbnailUrl = stripOversizedDataUri(c.thumbnailUrl);
    const lastFrameImage = stripOversizedDataUri(c.lastFrameImage);
    const keyframeImage = stripOversizedDataUri(c.keyframeImage);
    const audioTrack = stripOversizedDataUri(c.audioTrack);
    if (
      videoUrl !== c.videoUrl ||
      thumbnailUrl !== c.thumbnailUrl ||
      lastFrameImage !== c.lastFrameImage ||
      keyframeImage !== c.keyframeImage ||
      audioTrack !== c.audioTrack
    ) {
      changed = true;
      return { ...c, videoUrl, thumbnailUrl, lastFrameImage, keyframeImage, audioTrack };
    }
    return c;
  });
  const finalVideoUrl = stripOversizedDataUri(proj.finalVideoUrl);
  if (finalVideoUrl !== proj.finalVideoUrl) changed = true;

  // sceneSpec:跨步复用的角色/场景/分镜,所有图字段都可能是漏网的 base64
  let sceneSpec = proj.sceneSpec;
  if (sceneSpec) {
    let specChanged = false;
    const characters = sceneSpec.characters?.map((ch) => {
      const portraitImage = stripOversizedDataUri(ch.portraitImage);
      const turnaroundImage = stripOversizedDataUri(ch.turnaroundImage);
      const turnaroundSourcePortrait = stripOversizedDataUri(ch.turnaroundSourcePortrait);
      const costumeVariants = ch.costumeVariants?.map((v) => {
        const vp = stripOversizedDataUri(v.portraitImage);
        if (vp !== v.portraitImage) { specChanged = true; return { ...v, portraitImage: vp }; }
        return v;
      });
      if (
        portraitImage !== ch.portraitImage ||
        turnaroundImage !== ch.turnaroundImage ||
        turnaroundSourcePortrait !== ch.turnaroundSourcePortrait ||
        costumeVariants !== ch.costumeVariants
      ) {
        specChanged = true;
        return { ...ch, portraitImage, turnaroundImage, turnaroundSourcePortrait, costumeVariants };
      }
      return ch;
    });
    const scenes = sceneSpec.scenes?.map((sc) => {
      const backgroundImage = stripOversizedDataUri(sc.backgroundImage);
      if (backgroundImage !== sc.backgroundImage) { specChanged = true; return { ...sc, backgroundImage }; }
      return sc;
    });
    const shots = sceneSpec.shots?.map((sh) => {
      const keyframeImage = stripOversizedDataUri(sh.keyframeImage);
      const customReferenceImages = sh.customReferenceImages?.map(stripOversizedDataUri).filter(Boolean) as string[] | undefined;
      const referenceAssets = sh.referenceAssets?.map((asset) => ({
        ...asset,
        imageUrl: stripOversizedDataUri(asset.imageUrl) || '',
      })).filter((asset) => !!asset.imageUrl);
      const versionHistory = sh.versionHistory?.map((v) => ({
        ...v,
        url: stripOversizedDataUri(v.url) || v.url,
      }));
      if (
        keyframeImage !== sh.keyframeImage ||
        customReferenceImages !== sh.customReferenceImages ||
        referenceAssets !== sh.referenceAssets ||
        versionHistory !== sh.versionHistory
      ) {
        specChanged = true;
        return { ...sh, keyframeImage, customReferenceImages, referenceAssets, versionHistory };
      }
      return sh;
    });
    if (specChanged) {
      changed = true;
      sceneSpec = { ...sceneSpec, characters, scenes, shots };
    }
  }

  if (!changed) return proj;
  return { ...proj, anchorImages, audios, clips, finalVideoUrl, sceneSpec };
}

/**
 * 扫描一个 project 的所有产物,把 blob: URL 失效的条目清空。
 * 返回清理过的 project(若有变更)或原对象(无变更)。
 */
function purgeDeadAssets(proj: VideoProjectState): {
  project: VideoProjectState;
  purged: number;
} {
  let purged = 0;

  // 立绘
  const anchorImages = proj.anchorImages.map((a) => {
    if (!isAssetLive(a.imageUrl)) {
      purged++;
      return { ...a, imageUrl: '' };
    }
    return a;
  });

  // 音频
  const audios = proj.audios.map((a) => {
    if (!isAssetLive(a.audioUrl)) {
      purged++;
      return { ...a, audioUrl: '' };
    }
    return a;
  });

  // 视频 clip — videoUrl / thumbnailUrl / lastFrameImage / keyframeImage / audioTrack 都可能 blob
  const clips = proj.clips.map((c) => {
    const videoUrl = isAssetLive(c.videoUrl) ? c.videoUrl : (purged++, '');
    const thumbnailUrl = isAssetLive(c.thumbnailUrl) ? c.thumbnailUrl : undefined;
    const lastFrameImage = isAssetLive(c.lastFrameImage) ? c.lastFrameImage : undefined;
    const keyframeImage = isAssetLive(c.keyframeImage) ? c.keyframeImage : undefined;
    const audioTrack = isAssetLive(c.audioTrack) ? c.audioTrack : undefined;
    return { ...c, videoUrl, thumbnailUrl, lastFrameImage, keyframeImage, audioTrack };
  });

  // 最终视频
  let finalVideoUrl = proj.finalVideoUrl;
  if (!isAssetLive(finalVideoUrl)) {
    if (finalVideoUrl) purged++;
    finalVideoUrl = undefined;
  }

  if (purged === 0) return { project: proj, purged: 0 };
  return {
    project: { ...proj, anchorImages, audios, clips, finalVideoUrl },
    purged,
  };
}

export const useVideoStore = create<VideoStoreState>()(
  persist(
    (set, get) => ({
  projects: {},
  directClips: [],
  directGenerating: false,
  directError: undefined,
  activePipelineId: undefined,
  setActivePipelineId: (id) => set({ activePipelineId: id }),

  getProject: (novelProjectId) => get().projects[novelProjectId],

  initProject: (novelProjectId, selectedChapterIds, spec, title) => {
    const existing = get().projects[novelProjectId];
    if (existing) {
      // Project initialization is idempotent. Resume/reopen must never replace
      // persisted stages or generated assets with an empty project shell.
      return existing;
    }
    const project: VideoProjectState = {
      novelProjectId,
      title,
      selectedChapterIds,
      spec: { ...DEFAULT_SPEC, ...spec },
      options: { ...DEFAULT_PIPELINE_OPTIONS },
      stages: buildInitialStages(),
      currentStage: 'script_slicing',
      shots: [],
      timelineState: normalizeTimelineState(undefined, []),
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

  setProjectTitle: (novelProjectId, title) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return {};
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: { ...proj, title, updatedAt: now() },
        },
      };
    });
  },

  resetProject: (novelProjectId) => {
    set((s) => {
      const next = { ...s.projects };
      delete next[novelProjectId];
      return { projects: next };
    });
    // 级联清理:删掉该项目的全部 video-assets 文件(portrait/scene/keyframe/clip/audio)。
    // fire-and-forget,失败不影响 store 状态(Rust 命令内部处理)。
    void import('../services/video/asset-store')
      .then(({ cleanProjectAssets }) => cleanProjectAssets(novelProjectId))
      .then(({ deletedFiles }) => {
        if (deletedFiles > 0) {
          void logger.info(`[store] resetProject 清理了 ${deletedFiles} 个产物文件`, 'store');
        }
      })
      .catch((err) => {
        void logger.warn(`[store] resetProject 清理产物失败: ${String(err)}`, 'store');
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
      if (status !== 'running') next.queueRetry = undefined;
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

  setClips: (novelProjectId, clips) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, clips: [...clips] }),
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
            stages: {
              ...proj.stages,
              composing: { ...proj.stages.composing, stage: 'composing', status: 'completed', progress: 1, completedAt: now(), error: undefined },
            },
            currentStage: 'complete',
          }),
        },
      };
    });
  },

  clearFinalVideo: (novelProjectId) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj?.finalVideoUrl) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            finalVideoUrl: undefined,
            finalDurationSeconds: undefined,
            finalSizeBytes: undefined,
          }),
        },
      };
    });
  },

  setSceneSpec: (novelProjectId, spec) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const registeredSpec: SceneSpec = {
        ...spec,
        shots: registerPersistedShotVersions(spec.shots, proj.clips),
      };
      const reconciled = reconcileSceneSpecArtifacts(
        proj.sceneSpec,
        registeredSpec,
        proj.clips,
        proj.finalVideoUrl,
      );
      const nextSpec = reconciled.spec;
      const shots = nextSpec.shots && nextSpec.shots.length > 0 ? (nextSpec.shots as any) : proj.shots;
      const timelineState = normalizeTimelineState(
        proj.timelineState,
        nextSpec.shots?.map((shot) => shot.id) ?? [],
      );
      let stages = proj.stages;
      if (reconciled.invalidateFrom) {
        stages = resetVideoStagesFrom(stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES);
      }
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            sceneSpec: nextSpec,
            shots,
            timelineState,
            stages,
            clips: reconciled.clips,
            finalVideoUrl: reconciled.finalVideoUrl,
            finalDurationSeconds: reconciled.finalVideoUrl ? proj.finalDurationSeconds : undefined,
            finalSizeBytes: reconciled.finalVideoUrl ? proj.finalSizeBytes : undefined,
          }),
        },
      };
    });
  },

  ensureShotVersionHistory: (novelProjectId) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj?.sceneSpec) return s;
      const shots = registerPersistedShotVersions(proj.sceneSpec.shots, proj.clips, proj.updatedAt || now());
      const sceneSpecChanged = shots.some((shot, index) => shot !== proj.sceneSpec?.shots[index]);
      const nextProject = sceneSpecChanged
        ? { ...proj, sceneSpec: { ...proj.sceneSpec, shots }, shots: shots as unknown as StoryboardShot[] }
        : proj;
      const gatedProject = markProjectAwaitingVideoReview(nextProject, shots);
      if (!sceneSpecChanged && gatedProject === proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: gatedProject,
        },
      };
    });
  },

  setTimelineState: (novelProjectId, patch) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const shotIds = proj.sceneSpec?.shots?.map((shot) => shot.id) ?? proj.shots.map((shot) => shot.id);
      const current = normalizeTimelineState(proj.timelineState, shotIds);
      const timelineState = normalizeTimelineState({ ...current, ...patch }, shotIds);
      if (JSON.stringify(current) === JSON.stringify(timelineState)) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            timelineState,
            finalVideoUrl: undefined,
            finalDurationSeconds: undefined,
            finalSizeBytes: undefined,
            stages: { ...proj.stages, composing: { stage: 'composing', status: 'pending', progress: 0 } },
            currentStage: proj.currentStage === 'complete' ? 'composing' : proj.currentStage,
          }),
        },
      };
    });
  },

  updateSceneSpecShot: (novelProjectId, shotId, updates) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const shots = proj.shots.map((sh) => (sh.id === shotId ? ({ ...sh, ...updates } as StoryboardShot) : sh));
      let sceneSpec = proj.sceneSpec;
      let clips = proj.clips;
      let finalVideoUrl = proj.finalVideoUrl;
      let stages = proj.stages;
      if (sceneSpec?.shots) {
        const nextSpec = {
          ...sceneSpec,
          shots: sceneSpec.shots.map((sh) => (sh.id === shotId ? ({ ...sh, ...updates } as any) : sh)),
        };
        const reconciled = reconcileSceneSpecArtifacts(
          sceneSpec,
          nextSpec,
          proj.clips,
          proj.finalVideoUrl,
        );
        sceneSpec = reconciled.spec;
        clips = reconciled.clips;
        finalVideoUrl = reconciled.finalVideoUrl;
        if (reconciled.invalidateFrom) {
          stages = resetVideoStagesFrom(stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES);
        }
      }
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            shots: sceneSpec?.shots ? (sceneSpec.shots as any) : shots,
            sceneSpec,
            clips,
            finalVideoUrl,
            finalDurationSeconds: finalVideoUrl ? proj.finalDurationSeconds : undefined,
            finalSizeBytes: finalVideoUrl ? proj.finalSizeBytes : undefined,
            stages,
          }),
        },
      };
    });
  },

  applyWorldSequenceReferences: (novelProjectId, expected, worldId, frames) => {
    let applied = false;
    set((s) => {
      const proj = s.projects[novelProjectId], spec = proj?.sceneSpec;
      if (!spec || JSON.stringify(spec) !== JSON.stringify(expected) || Object.values(proj.stages).some((stage) => stage.status === 'running') || !frames.length || frames.length > 24 || new Set(frames.map((frame) => frame.shotId)).size !== frames.length || frames.some((frame) => !frame.url || !spec.shots.some((shot) => shot.id === frame.shotId))) return s;
      const references = new Map(frames.map((frame) => [frame.shotId, frame.url]));
      const reconciled = reconcileSceneSpecArtifacts(spec, {
        ...spec,
        shots: spec.shots.map((shot) => references.has(shot.id) ? { ...shot, previsReferenceImage: references.get(shot.id), previsWorldId: worldId, manualReferenceImage: undefined, transition: 'cut' } : shot),
      }, proj.clips, proj.finalVideoUrl);
      applied = true;
      return { projects: { ...s.projects, [novelProjectId]: touch({
        ...proj,
        sceneSpec: reconciled.spec,
        shots: reconciled.spec.shots as unknown as StoryboardShot[],
        clips: reconciled.clips,
        finalVideoUrl: reconciled.finalVideoUrl,
        finalDurationSeconds: reconciled.finalVideoUrl ? proj.finalDurationSeconds : undefined,
        finalSizeBytes: reconciled.finalVideoUrl ? proj.finalSizeBytes : undefined,
        stages: reconciled.invalidateFrom ? resetVideoStagesFrom(proj.stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES) : proj.stages,
      }) } };
    });
    return applied;
  },

  addSceneSpecShot: (novelProjectId, newShotData) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const newId = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const existingSceneShots = proj.sceneSpec?.shots ?? (proj.shots as unknown as ShotSpec[]);
      const index = existingSceneShots.length;
      const newShot: StoryboardShot & Partial<ShotSpec> = {
        ...newShotData,
        id: newId,
        index,
        referenceAssets: undefined,
        audioTrack: undefined,
        versionHistory: undefined,
        selectedVersionId: undefined,
        sourceText: newShotData.sourceText || newShotData.videoPrompt || '',
        videoPrompt: newShotData.videoPrompt || '',
        durationSeconds: newShotData.durationSeconds || 5,
        characters: newShotData.characters || newShotData.characterIds || [],
        characterIds: newShotData.characterIds || newShotData.characters || [],
      };
      let sceneSpec = proj.sceneSpec;
      let stages = proj.stages;
      let clips = proj.clips;
      const baseSceneSpec: SceneSpec = sceneSpec ?? {
        characters: [],
        scenes: [],
        props: [],
        shots: [],
        meta: {
          title: proj.title,
          style: proj.spec.style,
          aspectRatio: proj.spec.aspectRatio,
          defaultShotDuration: proj.spec.shotDurationSeconds,
          sourceMode: 'multishot',
          channel: novelProjectId.startsWith('direct_') ? 'direct' : 'novel',
        },
      };
      const nextSpec = {
        ...baseSceneSpec,
        shots: [...existingSceneShots, newShot as ShotSpec],
      };
      const reconciled = reconcileSceneSpecArtifacts(
        baseSceneSpec,
        nextSpec,
        proj.clips,
        proj.finalVideoUrl,
      );
      sceneSpec = reconciled.spec;
      clips = reconciled.clips;
      stages = resetVideoStagesFrom(stages, 'keyframe_image', DEFAULT_SKIPPED_STAGES);
      const planningCompletedAt = now();
      for (const stage of ['script_slicing', 'storyboard_prompt', 'extraction'] as const) {
        stages = {
          ...stages,
          [stage]: {
            ...stages[stage],
            stage,
            status: 'completed',
            progress: 1,
            completedAt: stages[stage].completedAt || planningCompletedAt,
          },
        };
      }
      const timelineState = normalizeTimelineState(
        proj.timelineState,
        sceneSpec.shots.map((shot) => shot.id),
      );
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            shots: sceneSpec.shots as unknown as StoryboardShot[],
            sceneSpec,
            timelineState,
            stages,
            clips,
            finalVideoUrl: undefined,
            finalDurationSeconds: undefined,
            finalSizeBytes: undefined,
          }),
        },
      };
    });
  },

  deleteSceneSpecShot: (novelProjectId, shotId) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const shots = proj.shots
        .filter((sh) => sh.id !== shotId)
        .map((sh, i) => ({ ...sh, index: i }));
      let sceneSpec = proj.sceneSpec;
      let clips = proj.clips.filter((clip) => clip.shotId !== shotId);
      let stages = proj.stages;
      let finalVideoUrl = proj.finalVideoUrl;
      if (sceneSpec?.shots) {
        const nextSpec = {
          ...sceneSpec,
          shots: sceneSpec.shots
            .filter((sh) => sh.id !== shotId)
            .map((sh, i) => ({ ...sh, index: i } as any)),
        };
        const reconciled = reconcileSceneSpecArtifacts(
          sceneSpec,
          nextSpec,
          clips,
          proj.finalVideoUrl,
        );
        sceneSpec = reconciled.spec;
        clips = reconciled.clips;
        stages = resetVideoStagesFrom(stages, 'keyframe_image', DEFAULT_SKIPPED_STAGES);
        finalVideoUrl = undefined;
      }
      const timelineState = normalizeTimelineState(
        proj.timelineState,
        sceneSpec?.shots?.map((shot) => shot.id) ?? shots.map((shot) => shot.id),
      );
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, shots, sceneSpec, timelineState, clips, stages, finalVideoUrl, finalDurationSeconds: undefined, finalSizeBytes: undefined }),
        },
      };
    });
  },

  adoptImportedVideo: (novelProjectId, shotId, version) => {
    const shot = get().projects[novelProjectId]?.sceneSpec?.shots.find((item) => item.id === shotId);
    if (!shot || version.type !== 'video' || !version.importedVideo || !version.qualityReview || version.qualityReview.status === 'failed') return false;
    if (version.importedVideo.visualContextFingerprint !== fingerprintImportedVideoContext(get().projects[novelProjectId]?.sceneSpec)) return false;
    const clip = restoreClipFromShotVersion({ shotId, videoUrl: version.url, durationSeconds: 0, provider: 'custom', model: 'imported-video', hasAudio: true, generatedAt: version.createdAt }, version);
    if (!isGeneratedVideoCurrent(shot, clip)) return false;
    get().addShotVersion(novelProjectId, shotId, { ...version, reviewStatus: 'unreviewed', reviewedAt: undefined, reviewNote: undefined });
    return true;
  },

  addShotVersion: (novelProjectId, shotId, version, options) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      if (options?.select === false) {
        if (!proj.sceneSpec?.shots.some((shot) => shot.id === shotId)) return s;
        const shots = proj.sceneSpec.shots.map((shot) => shot.id === shotId ? { ...shot, versionHistory: [{ ...version, reviewStatus: 'unreviewed' as const }, ...(shot.versionHistory ?? [])] } : shot);
        return { projects: { ...s.projects, [novelProjectId]: touch({ ...proj, sceneSpec: { ...proj.sceneSpec, shots }, shots: shots as unknown as StoryboardShot[] }) } };
      }
      let sceneSpec = proj.sceneSpec;
      let clips = proj.clips;
      let finalVideoUrl = proj.finalVideoUrl;
      let stages = proj.stages;
      if (sceneSpec?.shots) {
        const nextSpec = {
          ...sceneSpec,
          shots: sceneSpec.shots.map((sh) => {
            if (sh.id === shotId) {
              const nextVersion: ShotVersion = {
                ...version,
                reviewStatus: version.reviewStatus ?? 'unreviewed',
              };
              const history = [nextVersion, ...(sh.versionHistory || [])];
              const updates: Partial<ShotSpec> = {
                versionHistory: history,
                selectedVersionId: version.id,
                lockedVersionId: undefined,
              };
              if (version.type === 'image') {
                updates.keyframeImage = version.url;
                updates.keyframeInputFingerprint = version.inputFingerprint;
                updates.keyframeGenerationContext = version.imageGenerationContext;
                updates.referenceAssets = version.imageReferenceAssets;
                updates.generationPlan = version.generationPlan;
              } else if (version.generationPlan) {
                updates.generationPlan = version.generationPlan;
              }
              return { ...sh, ...updates };
            }
            return sh;
          }),
        };
        const reconciled = reconcileSceneSpecArtifacts(
          sceneSpec,
          nextSpec,
          proj.clips,
          proj.finalVideoUrl,
        );
        sceneSpec = reconciled.spec;
        clips = reconciled.clips;
        finalVideoUrl = reconciled.finalVideoUrl;
        if (reconciled.invalidateFrom) {
          stages = resetVideoStagesFrom(stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES);
        }

        if (version.type === 'video') {
          const currentClip = clips.find((clip) => clip.shotId === shotId);
          if (currentClip) {
            clips = clips.map((clip) => clip.shotId === shotId
              ? restoreClipFromShotVersion(clip, version)
              : clip);
            finalVideoUrl = undefined;
          } else if (version.importedVideo) {
            clips = [...clips, restoreClipFromShotVersion({ shotId, videoUrl: version.url, durationSeconds: 0, provider: 'custom', model: 'imported-video', hasAudio: true, generatedAt: version.createdAt }, version)];
            finalVideoUrl = undefined;
          }
        }
      }
      const nextProject = touch({
        ...proj,
        sceneSpec,
        clips,
        finalVideoUrl,
        finalDurationSeconds: finalVideoUrl ? proj.finalDurationSeconds : undefined,
        finalSizeBytes: finalVideoUrl ? proj.finalSizeBytes : undefined,
        stages,
      });
      const gatedProject = version.type === 'video' && sceneSpec
        ? markProjectAwaitingVideoReview(nextProject, sceneSpec.shots)
        : nextProject;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: gatedProject,
        },
      };
    });
  },

  reviewShotVersion: (novelProjectId, shotId, versionId, status, note) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      const sceneSpec = proj?.sceneSpec;
      if (!proj || !sceneSpec) return s;
      const shot = sceneSpec.shots.find((candidate) => candidate.id === shotId);
      const version = shot?.versionHistory?.find((candidate) => candidate.id === versionId);
      if (!shot || !version) return s;
      const nextVersionHistory = shot.versionHistory?.map((candidate) => (
        candidate.id === versionId
          ? {
              ...candidate,
              reviewStatus: status,
              reviewNote: note?.trim() || undefined,
              reviewedAt: new Date().toISOString(),
            }
          : candidate
      ));
      const nextSpec: SceneSpec = {
        ...sceneSpec,
        shots: sceneSpec.shots.map((candidate) => candidate.id === shotId
          ? {
              ...candidate,
              versionHistory: nextVersionHistory,
              ...(status === 'approved' ? { selectedVersionId: versionId } : {}),
            }
          : candidate),
      };
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, sceneSpec: nextSpec, shots: nextSpec.shots as any }),
        },
      };
    });
  },

  lockShotVersion: (novelProjectId, shotId, versionId) => {
    let locked = false;
    set((s) => {
      const proj = s.projects[novelProjectId];
      const sceneSpec = proj?.sceneSpec;
      if (!proj || !sceneSpec) return s;
      const shot = sceneSpec.shots.find((candidate) => candidate.id === shotId);
      const version = shot?.versionHistory?.find((candidate) => candidate.id === versionId);
      const clip = proj.clips.find((candidate) => candidate.shotId === shotId);
      const clipMatchesVersion = !!clip?.videoUrl && (
        clip.shotVersionId === versionId
          || (!clip.shotVersionId && clip.videoUrl === version?.url)
      );
      const inputReceiptMatches = !!version?.inputFingerprint
        && !!clip?.inputFingerprint
        && version.inputFingerprint === clip.inputFingerprint
        && !!shot
        && isGeneratedVideoCurrent(shot, clip);
      const qualityPolicy = resolveVideoQualityPolicy(proj.options);
      const visualReviewBlocksLock = qualityPolicy.visualReviewRequired
        && (!clip?.visualReview
          || (qualityPolicy.blockOnVisualReviewUnavailable && clip.visualReview.status === 'unavailable'));
      if (
        !shot
        || !version
        || version.type !== 'video'
        || version.reviewStatus !== 'approved'
        || !clipMatchesVersion
        || !inputReceiptMatches
        || clip?.qualityReview?.status === 'failed'
        || (clip?.importedVideo && !clip.qualityReview)
        || clip?.visualReview?.status === 'failed'
        || visualReviewBlocksLock
      ) return s;
      locked = true;
      const nextSpec: SceneSpec = {
        ...sceneSpec,
        shots: sceneSpec.shots.map((candidate) => candidate.id === shotId
          ? { ...candidate, selectedVersionId: versionId, lockedVersionId: versionId }
          : candidate),
      };
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, sceneSpec: nextSpec, shots: nextSpec.shots as any }),
        },
      };
    });
    return locked;
  },

  selectShotVersion: (novelProjectId, shotId, versionId) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      let sceneSpec = proj.sceneSpec;
      let clips = proj.clips;
      let finalVideoUrl = proj.finalVideoUrl;
      let stages = proj.stages;
      if (sceneSpec?.shots) {
        const nextSpec = {
          ...sceneSpec,
          shots: sceneSpec.shots.map((sh) => {
            if (sh.id === shotId) {
              const found = sh.versionHistory?.find((v) => v.id === versionId);
              const updates: Partial<ShotSpec> = {
                selectedVersionId: versionId,
                lockedVersionId: sh.lockedVersionId === versionId ? versionId : undefined,
              };
              if (found?.type === 'image') {
                updates.keyframeImage = found.url;
                updates.keyframeInputFingerprint = found.inputFingerprint;
                updates.keyframeGenerationContext = found.imageGenerationContext;
                updates.referenceAssets = found.imageReferenceAssets;
                updates.generationPlan = found.generationPlan;
              } else if (found?.type === 'video' && found.generationPlan) {
                updates.generationPlan = found.generationPlan;
              }
              return { ...sh, ...updates };
            }
            return sh;
          }),
        };
        const found = nextSpec.shots.find((shot) => shot.id === shotId)?.versionHistory?.find((version) => version.id === versionId);
        if (!found) return s;
        const reconciled = reconcileSceneSpecArtifacts(
          sceneSpec,
          nextSpec,
          proj.clips,
          proj.finalVideoUrl,
        );
        sceneSpec = reconciled.spec;
        clips = reconciled.clips;
        finalVideoUrl = reconciled.finalVideoUrl;
        if (reconciled.invalidateFrom) {
          stages = resetVideoStagesFrom(stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES);
        }
        if (found.type === 'video') {
          const currentClip = clips.find((clip) => clip.shotId === shotId);
          if (currentClip) {
            clips = clips.map((clip) => clip.shotId === shotId
              ? restoreClipFromShotVersion(clip, found)
              : clip);
            finalVideoUrl = undefined;
          } else if (found.importedVideo) {
            clips = [...clips, restoreClipFromShotVersion({ shotId, videoUrl: found.url, durationSeconds: 0, provider: 'custom', model: 'imported-video', hasAudio: true, generatedAt: found.createdAt }, found)];
            finalVideoUrl = undefined;
          }
        }
      }
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            sceneSpec,
            clips,
            finalVideoUrl,
            finalDurationSeconds: finalVideoUrl ? proj.finalDurationSeconds : undefined,
            finalSizeBytes: finalVideoUrl ? proj.finalSizeBytes : undefined,
            stages,
          }),
        },
      };
    });
  },

  updateSceneSpecCharacter: (novelProjectId, characterId, updates) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj || !proj.sceneSpec) return s;
      const characters = proj.sceneSpec.characters?.map((c) =>
        c.id === characterId ? { ...c, ...updates } : c,
      );
      const reconciled = reconcileSceneSpecArtifacts(
        proj.sceneSpec,
        { ...proj.sceneSpec, characters },
        proj.clips,
        proj.finalVideoUrl,
      );
      const stages = reconciled.invalidateFrom
        ? resetVideoStagesFrom(proj.stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES)
        : proj.stages;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            sceneSpec: reconciled.spec,
            shots: reconciled.spec.shots as any,
            clips: reconciled.clips,
            finalVideoUrl: reconciled.finalVideoUrl,
            finalDurationSeconds: reconciled.finalVideoUrl ? proj.finalDurationSeconds : undefined,
            finalSizeBytes: reconciled.finalVideoUrl ? proj.finalSizeBytes : undefined,
            stages,
          }),
        },
      };
    });
  },

  updateSceneSpecScene: (novelProjectId, sceneId, updates) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj || !proj.sceneSpec) return s;
      const scenes = proj.sceneSpec.scenes?.map((sc) =>
        sc.id === sceneId ? { ...sc, ...updates } : sc,
      );
      const reconciled = reconcileSceneSpecArtifacts(
        proj.sceneSpec,
        { ...proj.sceneSpec, scenes },
        proj.clips,
        proj.finalVideoUrl,
      );
      const stages = reconciled.invalidateFrom
        ? resetVideoStagesFrom(proj.stages, reconciled.invalidateFrom, DEFAULT_SKIPPED_STAGES)
        : proj.stages;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            sceneSpec: reconciled.spec,
            shots: reconciled.spec.shots as any,
            clips: reconciled.clips,
            finalVideoUrl: reconciled.finalVideoUrl,
            finalDurationSeconds: reconciled.finalVideoUrl ? proj.finalDurationSeconds : undefined,
            finalSizeBytes: reconciled.finalVideoUrl ? proj.finalSizeBytes : undefined,
            stages,
          }),
        },
      };
    });
  },

  updateSceneSpec: (novelProjectId, patch) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const prevSpec = proj.sceneSpec || {
        shots: [],
        characters: [],
        scenes: [],
        meta: {
          aspectRatio: '16:9',
          defaultShotDuration: 5,
          sourceMode: 'multishot' as const,
          channel: 'novel' as const,
        },
      };
      const nextSpec: SceneSpec = {
        ...prevSpec,
        ...patch,
        characters: patch.characters || prevSpec.characters || [],
        scenes: patch.scenes || prevSpec.scenes || [],
        shots: patch.shots || prevSpec.shots || [],
        meta: patch.meta || prevSpec.meta || {
          aspectRatio: '16:9',
          defaultShotDuration: 5,
          sourceMode: 'multishot' as const,
          channel: 'novel' as const,
        },
      };
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, sceneSpec: nextSpec }),
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

  setExecutionBinding: (novelProjectId, binding) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({ ...proj, executionBinding: binding }),
        },
      };
    });
  },

  resetStagesFrom: (novelProjectId, fromStage) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const startIdx = VIDEO_PIPELINE_STAGES.indexOf(fromStage);
      if (startIdx < 0) return s;
      const toReset = VIDEO_PIPELINE_STAGES.slice(startIdx);

      // 重建 stages:把 toReset 里的 stage 置 pending、清进度/错误/时间戳
      const stages = { ...proj.stages };
      for (const stage of toReset) {
        const prev = stages[stage];
        if (!prev) continue;
        stages[stage] = {
          stage,
          status: DEFAULT_SKIPPED_STAGES.has(stage) ? 'skipped' : 'pending',
          progress: 0,
          // 保留用户改过的 input(单步重跑场景:reset 后用户改的参数还在)
          input: prev.input,
        };
      }

      // 清相关产物。每个 stage 对应的产物字段:
      //   character_anchor → anchorImages
      //   scene_image      → sceneSpec.scenes[].backgroundImage
      //   tts              → audios + sceneSpec.shots[].audioTrack
      //   keyframe_image   → sceneSpec.shots[].keyframeImage
      //   video_generation → clips
      //   audio_merge      → clips(合并后产物会被覆盖,清掉让原始 clip 还在)
      //                       注意:不删 clips 本身,删掉 videoUrl 即可
      //   composing        → finalVideoUrl
      let anchorImages = proj.anchorImages;
      let audios = proj.audios;
      let clips = proj.clips;
      let finalVideoUrl = proj.finalVideoUrl;
      let sceneSpec = proj.sceneSpec;

      if (toReset.includes('character_anchor')) {
        anchorImages = [];
        if (sceneSpec) {
          sceneSpec = {
            ...sceneSpec,
            characters: sceneSpec.characters?.map((character) => ({
              ...character,
              portraitImage: undefined,
              turnaroundImage: undefined,
              turnaroundSourcePortrait: undefined,
              costumeVariants: character.costumeVariants?.map((variant) => ({
                ...variant,
                portraitImage: undefined,
              })),
            })),
          };
        }
      }
      if (toReset.includes('tts')) {
        audios = [];
        if (sceneSpec) {
          sceneSpec = {
            ...sceneSpec,
            shots: sceneSpec.shots.map((sh) => ({ ...sh, audioTrack: undefined })),
          };
        }
      }
      if (toReset.includes('keyframe_image') && sceneSpec) {
        sceneSpec = {
          ...sceneSpec,
          shots: sceneSpec.shots.map((sh) => ({ ...sh, keyframeImage: undefined, referenceAssets: undefined })),
        };
      }
      if (toReset.includes('video_generation')) {
        clips = [];
      }
      if (toReset.includes('audio_merge')) {
        // audio_merge 把音频合到 clip 上,清掉 clip 的 audioTrack 引用
        // 但保留 clip 本身(video_generation 的产物)
        clips = clips.map((c) => ({ ...c, audioTrack: undefined }));
      }
      if (toReset.includes('composing')) {
        finalVideoUrl = undefined;
      }

      return {
        projects: {
          ...s.projects,
          [novelProjectId]: touch({
            ...proj,
            stages,
            anchorImages,
            audios,
            clips,
            finalVideoUrl,
            sceneSpec,
            error: undefined,
            currentStage: fromStage,
          }),
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

  setStageInput: (novelProjectId, stage, patch) => {
    set((s) => {
      const proj = s.projects[novelProjectId];
      if (!proj) return s;
      const prevStage = proj.stages[stage];
      if (!prevStage) return s;
      const prevInput = prevStage.input ?? {};
      const next: VideoStageState = {
        ...prevStage,
        input: { ...prevInput, ...patch },
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
    }),
    {
      name: 'mojing-video',
      storage: createJSONStorage(() => safeStorage),
      // activePipelineId 必须持久化,否则重启后用户看不到之前的执行过程
      // (VideoPipelinePanel 靠它决定渲染哪个项目)。
      // shrinkForPersistence:把超大 data: URI(>100KB)剥掉,避免撑爆 localStorage 配额。
      partialize: (state) => ({
        projects: Object.fromEntries(
          Object.entries(state.projects).map(([id, p]) => [id, shrinkForPersistence(p)]),
        ),
        directClips: state.directClips.map((c) => ({
          ...c,
          videoUrl: stripOversizedDataUriReq(c.videoUrl),
          thumbnailUrl: stripOversizedDataUri(c.thumbnailUrl),
          lastFrameImage: stripOversizedDataUri(c.lastFrameImage),
          keyframeImage: stripOversizedDataUri(c.keyframeImage),
          audioTrack: stripOversizedDataUri(c.audioTrack),
        })),
        activePipelineId: state.activePipelineId,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // 进程重启后 blob: URL 全部失效。扫一遍每个 project,把失效产物清空。
        // 保留中断的步骤和产物，重新打开项目时可以看到上一次停在哪里。
        let totalPurged = 0;
        const nextProjects: Record<string, VideoProjectState> = {};
        for (const [pid, proj] of Object.entries(state.projects)) {
          const { project, purged } = purgeDeadAssets(proj);
          totalPurged += purged;

          let interruptedStage: VideoStage | undefined;
          const nextStages = { ...project.stages };
          for (const [stageKey, stageState] of Object.entries(nextStages)) {
            if (stageState && stageState.status === 'running') {
              const stage = stageKey as VideoStage;
              if (!interruptedStage || stage === project.currentStage) interruptedStage = stage;
              nextStages[stage] = {
                ...stageState,
                status: 'interrupted',
                error: undefined,
                queueRetry: undefined,
              };
            }
          }

          nextProjects[pid] = {
            ...project,
            stages: nextStages,
            currentStage: interruptedStage ?? project.currentStage,
            error: interruptedStage ? undefined : project.error,
          };
        }
        // directClips 同样扫一遍
        const nextDirectClips = state.directClips.map((c) => {
          const videoUrl = isAssetLive(c.videoUrl) ? c.videoUrl : '';
          if (!videoUrl) totalPurged++;
          return { ...c, videoUrl };
        });
        state.projects = nextProjects;
        state.directClips = nextDirectClips;
        state.directGenerating = false;
        // activePipelineId 校验:如果指向的 project 不在 store 里(被删 / 数据损坏),
        // 清掉它避免面板渲染一个不存在的 pipeline。
        if (state.activePipelineId && !nextProjects[state.activePipelineId]) {
          void logger.warn(
            `[video-store] rehydrate: activePipelineId=${state.activePipelineId} 指向的项目不存在,清空`,
            'store',
          );
          state.activePipelineId = undefined;
        }
        if (totalPurged > 0) {
          void logger.warn(
            `[video-store] rehydrate: 清理了 ${totalPurged} 个失效(blob:)产物引用`,
            'store',
          );
        }
      },
    },
  ),
);

// --- Re-exports for convenience ---

export type { AspectRatio, ModelTier };

// --- 订阅 provider router 的 invocation 上报 ---
// 每条调用记录追加到发起请求的 stage 的账本。
import { subscribeInvocation } from '@/services/providers/invocation-context';

subscribeInvocation((ctx, invocation) => {
  useVideoStore.getState().appendInvocation(ctx.novelProjectId, ctx.stage as VideoStage, invocation);
});

// pipeline-runner.ts — 14 步流水线编排器
// 输入:SceneSpec + PipelineOptions + callbacks
// 按 options 编排骨分子集。每步失败降级见文档 §10。
//
// 期 1(本次):实装步 3/6/7/9/10/12-14。步 4/8/11(音频链路)留 stub 跳过,期 3 补全。

import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { logger } from '@/services/log';
import type {
  SceneSpec,
  PipelineOptions,
  VideoStage,
  VideoProjectState,
  ShotSpec,
  GeneratedClip,
} from '@/types/video';
import type { PipelineCallbacks } from './types';
import { isValidVideoClip } from '../asset-store';
import { parseStructuredPromptShots } from '../direct-scene-builder';
import {
  RUNTIME_STAGE_ORDER,
  STAGE_HANDLERS,
  isStageEnabled,
  applyStageInput,
} from './stage-handlers';
import type { VideoGenOptions } from './step-video-gen';

export interface RunPipelineArgs {
  novelProjectId: string;
  spec: SceneSpec;
  options: PipelineOptions;
  callbacks?: PipelineCallbacks;
  /** 视频生成参数(Novel pipeline 传 resolution/fps/tier;Direct modal 传 endpointId/model) */
  videoGen: VideoGenOptions;
  /** 中止信号 */
  shouldAbort?: () => boolean;
}

const activeAborts = new Map<string, boolean>();

/**
 * 终止指定项目的流水线生成
 */
export function abortPipeline(pid: string): void {
  void logger.info(`[pipeline] abortPipeline request pid=${pid}`, 'pipeline');
  activeAborts.set(pid, true);
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (proj) {
    store.setError(pid, '已被用户强行终止生成');
    if (proj.currentStage && proj.currentStage !== 'complete' && proj.currentStage !== 'idle') {
      store.setStageStatus(pid, proj.currentStage, 'error', { error: '已被用户强行终止生成', progress: 0 });
      store.advanceToStage(pid, 'idle');
    }
  }
}

/**
 * 14 步流水线入口。返回最终 VideoProjectState。
 * 异常不中断整条流水线,只标记单步失败。
 */
export async function runPipeline(args: RunPipelineArgs): Promise<VideoProjectState | null> {
  const { novelProjectId, spec, options, callbacks, videoGen, shouldAbort } = args;
  activeAborts.delete(novelProjectId);
  const checkAbort = () => !!activeAborts.get(novelProjectId) || (shouldAbort ? shouldAbort() : false);
  void logger.info(`[pipeline] RUN start pid=${novelProjectId} shots=${spec.shots.length} chars=${spec.characters?.length ?? 0} scenes=${spec.scenes?.length}`, 'pipeline');
  const store = useVideoStore.getState();

  // 合并持久化状态:如果 store 里已经有该项目(从上次运行恢复),优先用
  // 持久化的 workingSpec —— 它带有已经跑完的 stage 产物(立绘/场景图/关键帧)。
  // 入参 spec 里的 meta/style/option 等配置类字段仍然以本次传入为准。
  const existingProj = store.getProject(novelProjectId);
  const persistedSceneSpec = existingProj?.sceneSpec;
  const persistedShots = persistedSceneSpec?.shots ?? [];
  const persistedCharacters = persistedSceneSpec?.characters ?? [];
  const persistedScenes = persistedSceneSpec?.scenes ?? [];

  // 工作副本:优先复用持久化产物,否则用入参 spec 的拷贝。
  // 检测「持久化的 shots 是否仍然有效」:长度一致且每个 shot 有 id 匹配。
  const shotsMatchPersisted =
    persistedShots.length > 0 &&
    persistedShots.length === spec.shots.length &&
    spec.shots.every((s, i) => s.id === persistedShots[i].id);

  let workingSpec: SceneSpec = {
    ...spec,
    meta: {
      ...spec.meta,
      openingReferenceImage: spec.meta.openingReferenceImage ?? getPreviousEpisodeKeyframe(novelProjectId),
    },
    characters: (persistedCharacters.length && charactersMatch(persistedCharacters, spec.characters ?? []))
      ? deepCloneCharacters(persistedCharacters)
      : spec.characters?.map((c) => ({ ...c, costumeVariants: c.costumeVariants?.map((v) => ({ ...v })) })),
    scenes: (persistedScenes.length && scenesMatch(persistedScenes, spec.scenes ?? []))
      ? persistedScenes.map((s) => ({ ...s }))
      : spec.scenes?.map((s) => ({ ...s })),
    shots: shotsMatchPersisted
      ? persistedShots.map((s) => ({ ...s, characterIds: [...s.characterIds] }))
      : spec.shots.map((s) => ({ ...s, characterIds: [...s.characterIds] })),
  };

  void logger.info(
    `[pipeline] resume check: persisted=${!!persistedSceneSpec} shotsMatch=${shotsMatchPersisted} ` +
      `stages=${summarizeStageStatuses(existingProj)}`,
    'pipeline',
  );

  // 先把初始 SceneSpec 落进 store,让 UI 能在 character_anchor 完成前
  // 就看到"提取"出的角色/场景/道具数据(否则面板会显示 Empty)。
  store.setSceneSpec(novelProjectId, workingSpec);

  // 循环调度 8 个 runtime stage。每个 stage 的执行逻辑抽到了 stage-handlers.ts,
  // 这里只负责「跳过 / 跑 / 失败降级」的决策。
  let clips: GeneratedClip[] = [];

  for (const stage of RUNTIME_STAGE_ORDER) {
    if (checkAbort()) break;

    // composing 需要 clips 非空
    if (stage === 'composing' && clips.length === 0) {
      void logger.info('[pipeline] composing: 无 clips,跳过', 'pipeline');
      skipStage(store, novelProjectId, stage, callbacks);
      continue;
    }

    const enabled = isStageEnabled(stage, options, workingSpec);
    if (!enabled) {
      skipStage(store, novelProjectId, stage, callbacks);
      continue;
    }

    // 已完成且产物仍在 → 跳过(断点续跑的核心)
    if (existingProj && isStageLiveCompleted(existingProj, stage)) {
      // video_generation 跳过时要从持久化拿 clips,供后续 audio_merge/composing 用
      if (stage === 'video_generation') {
        clips = [...existingProj.clips];
        callbacks?.onShotProgress?.(clips.length, workingSpec.shots.length);
      }
      void logger.info(`[pipeline] ${stage}: 已完成且产物仍在,跳过`, 'pipeline');
      callbacks?.onStageProgress?.(stage, 1);
      continue;
    }

    const handler = STAGE_HANDLERS[stage];
    if (!handler) {
      void logger.warn(`[pipeline] ${stage}: 无 handler,跳过`, 'pipeline');
      skipStage(store, novelProjectId, stage, callbacks);
      continue;
    }

    const result = await handler({
      pid: novelProjectId,
      workingSpec,
      options,
      videoGen,
      callbacks,
      shouldAbort: checkAbort,
      // video_generation 用 preExistingClips 做增量;auido_merge/composing 用累积 clips
      clips: stage === 'video_generation' ? (existingProj?.clips ?? []) : clips,
    });
    if (result) {
      workingSpec = result.spec;
      if (result.clips) clips = result.clips;
    } else {
      void logger.warn(`[pipeline] stage ${stage} 失败，流水线暂停在当前步骤等待用户处理`, 'pipeline');
      break;
    }

    // 系列剧集在关键帧完成后暂停：让用户先核对角色、场景与镜头连续性，
    // 明确确认后才进入昂贵且不可逆的视频生成阶段。
    if (result && stage === 'keyframe_image' && requiresKeyframeReview(novelProjectId)) {
      store.advanceToStage(novelProjectId, 'video_generation');
      store.setStageStatus(novelProjectId, 'video_generation', 'awaiting_review', { progress: 0, error: undefined });
      store.setStageInputSummary(novelProjectId, 'video_generation', {
        headline: '关键帧已生成，等待人工确认后开始视频生成。',
      });
      break;
    }
  }

  // 写回 sceneSpec,供 UI 展示角色立绘/场景图/关键帧
  store.setSceneSpec(novelProjectId, workingSpec);

  void logger.info(`[pipeline] RUN end pid=${novelProjectId} clips=${clips.length}`, 'pipeline');
  return useVideoStore.getState().getProject(novelProjectId) ?? null;
}

function skipStage(
  store: ReturnType<typeof useVideoStore.getState>,
  novelProjectId: string,
  stage: VideoStage,
  callbacks?: PipelineCallbacks,
): void {
  store.setStageStatus(novelProjectId, stage, 'skipped', { progress: 0 });
}

/**
 * 判断某 stage 是否「已完成且产物仍在」— 这种情况可以跳过重跑。
 *
 * 判断标准:
 * 1. stage 状态 === 'completed'
 * 2. 该 stage 对应的产物字段在 project 上仍然非空(重启后 blob: 失效会被
 *    videoStore.purgeDeadAssets 清空,这种 completed 就变成"假完成"需要重跑)
 *
 * 对不同 stage 检查不同字段:
 *  - character_anchor: anchorImages 中至少 1 个有 imageUrl
 *  - scene_image: sceneSpec.scenes 中至少 1 个有 imageUrl
 *  - keyframe_image: shots 中至少 1 个有 keyframeImage
 *  - video_generation: clips 中至少 1 个有 videoUrl,且数量 == shots.length
 *  - tts: audios 非空
 *  - 其他(voice_assignment/script_slicing 等):只要 status === 'completed' 即可
 */
function isStageLiveCompleted(proj: VideoProjectState, stage: VideoStage): boolean {
  const st = proj.stages[stage];
  if (!st || st.status !== 'completed') return false;
  switch (stage) {
    case 'script_slicing':
      return proj.shots.length > 0;
    case 'storyboard_prompt':
      return proj.shots.length > 0 && proj.shots.some((s) => !!s.videoPrompt);
    case 'extraction':
      return (proj.sceneSpec?.characters?.length ?? 0) > 0 || (proj.sceneSpec?.scenes?.length ?? 0) > 0;
    case 'character_anchor':
      return proj.anchorImages.some((a) => !!a.imageUrl);
    case 'scene_image':
      return (proj.sceneSpec?.scenes ?? []).some((s) => !!s.backgroundImage);
    case 'keyframe_image':
      return (proj.sceneSpec?.shots ?? []).some((s) => !!s.keyframeImage);
    case 'video_generation':
      // 完整性的判据:每个 shot 都有对应 clip 且 videoUrl 非空且有效
      return (
        proj.shots.length > 0 &&
        proj.clips.length >= proj.shots.length &&
        proj.clips.every((c) => isValidVideoClip(c))
      );
    case 'tts':
      return proj.audios.length > 0;
    case 'audio_merge':
      // 至少一个 clip 标记为 hasAudio 且 videoUrl 仍在
      return proj.clips.some((c) => c.hasAudio && !!c.videoUrl);
    case 'composing':
      return !!proj.finalVideoUrl;
    default:
      return true;
  }
}

// Re-export step-video-gen's options type for callers
export type { VideoGenOptions, ShotSpec };

// --- resume helpers ---

function charactersMatch(
  persisted: NonNullable<SceneSpec['characters']>,
  incoming: NonNullable<SceneSpec['characters']>,
): boolean {
  if (persisted.length !== incoming.length) return false;
  return incoming.every((c, i) => c.id === persisted[i].id);
}

function scenesMatch(
  persisted: NonNullable<SceneSpec['scenes']>,
  incoming: NonNullable<SceneSpec['scenes']>,
): boolean {
  if (persisted.length !== incoming.length) return false;
  return incoming.every((s, i) => s.id === persisted[i].id);
}

function deepCloneCharacters(
  chars: NonNullable<SceneSpec['characters']>,
): NonNullable<SceneSpec['characters']> {
  return chars.map((c) => ({
    ...c,
    costumeVariants: c.costumeVariants?.map((v) => ({ ...v })),
  }));
}

function summarizeStageStatuses(proj: VideoProjectState | undefined): string {
  if (!proj) return '(no existing project)';
  const stages = Object.values(proj.stages);
  const completed = stages.filter((s) => s.status === 'completed').length;
  const errored = stages.filter((s) => s.status === 'error').length;
  const skipped = stages.filter((s) => s.status === 'skipped').length;
  return `${completed}c/${errored}e/${skipped}s`;
}

// ============================================================================
// 单步重跑 API
// ============================================================================

/** 从 store 重建 StageContext(单步重跑用)。
 *  和 runPipeline 的初始化不同:这里完全信任 store 里的 sceneSpec,
 *  因为单步重跑的前提是「前面步骤都已经跑过,产物在 store 里」。 */
function buildContextFromStore(pid: string): {
  ctx: import('./stage-handlers').StageContext;
  proj: VideoProjectState;
} | null {
  const store = useVideoStore.getState();
  let proj = store.getProject(pid);

  // 如果 store 中没有 proj 或 sceneSpec 为空，自动从 projectStore 恢复
  if (!proj || !proj.sceneSpec || !proj.sceneSpec.shots || proj.sceneSpec.shots.length === 0) {
    const project = useProjectStore.getState().projects.find((p) => p.id === pid);
    if (!project) return null;

    const metadata = (project.metadata || {}) as any;
    const seriesProject = metadata.seriesId
      ? useProjectStore.getState().projects.find((p) => p.id === metadata.seriesId)
      : undefined;
    const seriesMetadata = (seriesProject?.metadata || {}) as any;

    const characters = metadata.seriesCharacters ?? seriesMetadata.seriesCharacters ?? [];
    const scenes = metadata.seriesScenes ?? seriesMetadata.seriesScenes ?? [];

    let specToUse: SceneSpec | undefined = metadata.initialSceneSpec || metadata.sceneSpec;

    if (!specToUse) {
      const parsedShots = parseStructuredPromptShots(project.description || project.title, {
        aspectRatio: metadata.aspectRatio || '16:9',
        defaultShotDuration: (metadata.duration as any) || 5,
      });

      const fallbackShot: ShotSpec = {
        id: `shot_1`,
        index: 0,
        videoPrompt: project.description || project.title,
        durationSeconds: 5,
        characterIds: characters.map((c: any) => c.id),
        sceneId: scenes[0]?.id,
      };

      const shots = parsedShots && parsedShots.length > 0 ? parsedShots : [fallbackShot];

      specToUse = {
        characters,
        scenes,
        meta: {
          title: project.title,
          style: metadata.style || 'cinematic',
          genre: 'script',
          aspectRatio: metadata.aspectRatio || '16:9',
          defaultShotDuration: 5,
          sourceMode: 'multishot',
          channel: 'novel',
        },
        shots,
      };
    }

    store.initProject(
      pid,
      specToUse.shots.map((s) => s.id),
      {
        aspectRatio: metadata.aspectRatio || '16:9',
        resolution: metadata.resolution || '1920x1080',
        fps: metadata.fps || 24,
        shotDurationSeconds: 5,
        videoTier: 'value',
        imageTier: 'value',
        ttsTier: 'free',
        hardcodeSubtitles: false,
        bgmStyle: metadata.style || 'cinematic',
      },
      project.title,
    );

    store.setSceneSpec(pid, specToUse);
    proj = store.getProject(pid);
    if (!proj || !proj.sceneSpec) return null;
  }

  return {
    proj,
    ctx: {
      pid,
      workingSpec: proj.sceneSpec,
      options: proj.options ?? {
        enableCharacterAnchor: true,
        enableSceneImage: true,
        enableTTS: true,
        enableKeyframe: true,
        enableI2V: true,
        enableAudioMerge: true,
        enableSubtitles: false,
        characterAnchorLimit: 5,
      },
      videoGen: {
        spec: {
          resolution: proj.spec.resolution,
          fps: proj.spec.fps,
          videoTier: proj.spec.videoTier,
        },
        novelProjectId: pid,
      },
      clips: [...proj.clips],
    },
  };
}

/**
 * 单步重跑:只跑指定 stage,不推进 currentStage,不动后续 stage。
 *
 * 行为:
 * - 从 store 读 sceneSpec / options / videoGen 重建 context
 * - 调用该 stage 的 handler
 * - 产物写回 store(handler 内部做)
 * - 后续 stage 产物保持不变(用户明确只重跑这一步)
 *
 * 返回 true = 成功,false = 失败(项目不存在 / handler 失败 / 无 handler)。
 */
export async function runSingleStage(pid: string, stage: VideoStage): Promise<boolean> {
  void logger.info(`[pipeline] runSingleStage pid=${pid} stage=${stage}`, 'pipeline');
  const built = buildContextFromStore(pid);
  if (!built) {
    void logger.warn(`[pipeline] runSingleStage: 项目不存在或无 sceneSpec pid=${pid}`, 'pipeline');
    return false;
  }
  const handler = STAGE_HANDLERS[stage];
  if (!handler) {
    void logger.warn(`[pipeline] runSingleStage: stage ${stage} 无 handler`, 'pipeline');
    return false;
  }
  // 应用用户改过的 input(prompt/seed/resolution 等)到 workingSpec/videoGen
  const ctx = applyStageInput(built.ctx, stage);
  const result = await handler(ctx);
  if (!result) {
    void logger.warn(`[pipeline] runSingleStage: stage ${stage} 执行失败`, 'pipeline');
    return false;
  }
  // 单步重跑时也要把更新后的 spec 落盘
  useVideoStore.getState().setSceneSpec(pid, result.spec);
  return true;
}

/**
 * 从指定 stage 跑到结尾(含该 stage)。
 *
 * 行为:
 * - 先 resetStagesFrom(pid, stage) 清掉该 stage 及后续的产物
 * - 从该 stage 开始循环跑 RUNTIME_STAGE_ORDER
 * - 保留该 stage 之前的所有产物
 *
 * 返回 true = 全部成功,false = 中途有失败。
 */
export async function runFromStage(pid: string, stage: VideoStage): Promise<boolean> {
  void logger.info(`[pipeline] runFromStage pid=${pid} stage=${stage}`, 'pipeline');
  const built = buildContextFromStore(pid);
  if (!built) {
    void logger.warn(`[pipeline] runFromStage: 项目不存在或无 sceneSpec pid=${pid}`, 'pipeline');
    return false;
  }

  const store = useVideoStore.getState();
  // 清掉从 stage 起的所有 stage 状态 + 产物
  store.resetStagesFrom(pid, stage);

  // 重新读 proj(reset 后 sceneSpec 可能被改 — keyframe/tts 会清对应字段)
  const freshProj = store.getProject(pid);
  if (!freshProj || !freshProj.sceneSpec) return false;

  let workingSpec = freshProj.sceneSpec;
  let clips = [...freshProj.clips];

  const startIdx = RUNTIME_STAGE_ORDER.indexOf(stage);
  if (startIdx < 0) {
    void logger.warn(`[pipeline] runFromStage: stage ${stage} 不在 RUNTIME_STAGE_ORDER`, 'pipeline');
    return false;
  }

  activeAborts.delete(pid);
  const checkAbort = () => !!activeAborts.get(pid);

  let allOk = true;
  for (let i = startIdx; i < RUNTIME_STAGE_ORDER.length; i++) {
    if (checkAbort()) {
      allOk = false;
      break;
    }
    const s = RUNTIME_STAGE_ORDER[i];

    // composing 需要 clips 非空
    if (s === 'composing' && clips.length === 0) {
      store.setStageStatus(pid, s, 'skipped', { progress: 0 });
      continue;
    }

    const enabled = isStageEnabled(s, built.ctx.options, workingSpec);
    if (!enabled) {
      store.setStageStatus(pid, s, 'skipped', { progress: 0 });
      continue;
    }

    const handler = STAGE_HANDLERS[s];
    if (!handler) continue;

    // 应用用户改过的 input(prompt/seed/resolution 等)到 workingSpec/videoGen
    const stageCtx = applyStageInput(
      {
        pid,
        workingSpec,
        options: built.ctx.options,
        videoGen: built.ctx.videoGen,
        clips,
        shouldAbort: checkAbort,
      },
      s,
    );
    // applyStageInput 可能改了 workingSpec,同步给循环外层变量
    workingSpec = stageCtx.workingSpec;

    const result = await handler(stageCtx);
    if (result) {
      workingSpec = result.spec;
      if (result.clips) clips = result.clips;
    } else {
      allOk = false;
      void logger.warn(`[pipeline] runFromStage: stage ${s} 执行失败，流水线暂停在当前步骤等待处理`, 'pipeline');
      break;
    }

    if (result && s === 'keyframe_image' && requiresKeyframeReview(pid)) {
      store.advanceToStage(pid, 'video_generation');
      store.setStageStatus(pid, 'video_generation', 'awaiting_review', { progress: 0, error: undefined });
      store.setStageInputSummary(pid, 'video_generation', {
        headline: '关键帧已重新生成，等待人工确认后开始视频生成。',
      });
      break;
    }
  }

  store.setSceneSpec(pid, workingSpec);
  return allOk;
}

/**
 * 自动寻找第一个失败或待执行的 Stage，重置并向下恢复重跑。
 */
export async function runFromFirstFailedStage(pid: string): Promise<boolean> {
  void logger.info(`[pipeline] runFromFirstFailedStage pid=${pid}`, 'pipeline');
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj) return false;

  // 1. 优先寻找真实出错的 stage (status === 'error')
  const errorStage = RUNTIME_STAGE_ORDER.find((s) => proj.stages[s]?.status === 'error');
  if (errorStage) {
    void logger.info(`[pipeline] runFromFirstFailedStage: 命中出错步骤 ${errorStage}`, 'pipeline');
    return runFromStage(pid, errorStage);
  }

  // 2. 寻找等待人工审核确认的 stage
  const reviewStage = RUNTIME_STAGE_ORDER.find((s) => proj.stages[s]?.status === 'awaiting_review');
  if (reviewStage) {
    void logger.info(`[pipeline] runFromFirstFailedStage: 命中待审核步骤 ${reviewStage}`, 'pipeline');
    return runFromStage(pid, reviewStage);
  }

  // 3. 寻找未完成的第一个 stage (跳过已完成 completed 且产物存在的 stage)
  const incompleteStage = RUNTIME_STAGE_ORDER.find((s) => {
    const st = proj.stages[s];
    if (!st || st.status === 'pending' || st.status === 'running') return true;
    return !isStageLiveCompleted(proj, s);
  });

  const targetStage = incompleteStage || RUNTIME_STAGE_ORDER[0];
  void logger.info(`[pipeline] runFromFirstFailedStage: 恢复执行起始步骤 ${targetStage}`, 'pipeline');
  return runFromStage(pid, targetStage);
}

function requiresKeyframeReview(projectId: string): boolean {
  const project = useProjectStore.getState().projects.find((item) => item.id === projectId);
  return project?.type === 'video' && (project.metadata as { seriesRole?: string }).seriesRole === 'episode';
}

function getPreviousEpisodeKeyframe(projectId: string): string | undefined {
  const project = useProjectStore.getState().projects.find((item) => item.id === projectId);
  const previousEpisodeId = (project?.metadata as { previousEpisodeId?: string } | undefined)?.previousEpisodeId;
  if (!previousEpisodeId) return undefined;
  const previous = useVideoStore.getState().getProject(previousEpisodeId);
  return previous?.sceneSpec?.shots
    .slice()
    .reverse()
    .find((shot) => !!shot.keyframeImage)
    ?.keyframeImage;
}

/**
 * 单镜头关键帧独立重新生成：让用户在审核或修改分镜提示词后单独刷新某镜关键帧。
 */
export async function rerunSingleKeyframe(pid: string, shotId: string): Promise<string | null> {
  void logger.info(`[pipeline] rerunSingleKeyframe pid=${pid} shotId=${shotId}`, 'pipeline');
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj || !proj.sceneSpec) {
    void logger.warn(`[pipeline] rerunSingleKeyframe fail: project not found pid=${pid}`, 'pipeline');
    return null;
  }

  const shotIndex = proj.sceneSpec.shots.findIndex((s) => s.id === shotId);
  if (shotIndex === -1) {
    void logger.warn(`[pipeline] rerunSingleKeyframe fail: shot not found id=${shotId}`, 'pipeline');
    return null;
  }
  const shot = proj.sceneSpec.shots[shotIndex];

  const stage: VideoStage = 'keyframe_image';
  store.setStageStatus(pid, stage, 'running');
  const { pushStageContext, popStageContext } = await import('@/services/providers/invocation-context');
  pushStageContext({ novelProjectId: pid, stage });

  try {
    const { generateSingleKeyframe } = await import('./step-keyframe');
    const imagePath = await generateSingleKeyframe(shot, shotIndex, proj.sceneSpec.shots, {
      characters: proj.sceneSpec.characters ?? [],
      scenes: proj.sceneSpec.scenes ?? [],
      aspectRatio: proj.spec.aspectRatio,
      style: proj.sceneSpec.meta.style,
      imageTier: proj.spec.imageTier,
      novelProjectId: pid,
      openingReferenceImage: proj.sceneSpec.meta.openingReferenceImage ?? getPreviousEpisodeKeyframe(pid),
    });

    const updatedShots = proj.sceneSpec.shots.map((s, idx) =>
      idx === shotIndex ? { ...s, keyframeImage: imagePath } : s,
    );
    store.setSceneSpec(pid, { ...proj.sceneSpec, shots: updatedShots });
    store.setStageStatus(pid, stage, 'completed');
    void logger.info(`[pipeline] rerunSingleKeyframe SUCCESS shotId=${shotId}`, 'pipeline');
    return imagePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[pipeline] rerunSingleKeyframe FAIL shotId=${shotId}: ${msg}`, 'pipeline');
    store.setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  } finally {
    popStageContext();
  }
}

/**
 * 单镜头独立重试/重新生成：仅针对单个 Shot 重新跑 T2V / I2V 生成 Clip。
 */
export async function rerunSingleShot(pid: string, shotId: string): Promise<GeneratedClip | null> {
  void logger.info(`[pipeline] rerunSingleShot pid=${pid} shotId=${shotId}`, 'pipeline');
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj || !proj.sceneSpec) {
    void logger.warn(`[pipeline] rerunSingleShot fail: project not found pid=${pid}`, 'pipeline');
    return null;
  }

  const shot = proj.sceneSpec.shots.find((s) => s.id === shotId);
  if (!shot) {
    void logger.warn(`[pipeline] rerunSingleShot fail: shot not found id=${shotId}`, 'pipeline');
    return null;
  }

  const stage: VideoStage = 'video_generation';
  store.setStageStatus(pid, stage, 'running');
  const { generateSingleVideoClip } = await import('./step-video-gen');
  const { pushStageContext, popStageContext } = await import('@/services/providers/invocation-context');

  pushStageContext({ novelProjectId: pid, stage });

  try {
    const videoGenOpts: VideoGenOptions = {
      spec: {
        resolution: proj.spec.resolution,
        fps: proj.spec.fps,
        videoTier: proj.spec.videoTier,
      },
      sceneSource: 'novel',
      sourceMode: 'multishot',
      novelProjectId: pid,
      characters: proj.sceneSpec.characters,
    };

    const clip = await generateSingleVideoClip(shot, videoGenOpts, true);

    store.addClip(pid, clip);
    store.setStageStatus(pid, stage, 'completed');
    void logger.info(`[pipeline] rerunSingleShot SUCCESS shotId=${shotId} provider=${clip.provider}`, 'pipeline');

    // 体验极速更新：单镜重跑成功后，自动在后台更新音视对齐与成片合成！
    try {
      const { executeAudioMerge, executeCompose } = await import('./stage-handlers');
      const updatedProj = useVideoStore.getState().getProject(pid);
      if (updatedProj && updatedProj.sceneSpec) {
        const stageCtx = {
          pid,
          workingSpec: updatedProj.sceneSpec,
          options: {
            enableCharacterAnchor: true,
            enableSceneImage: true,
            enableTTS: true,
            enableKeyframe: true,
            enableI2V: true,
            enableAudioMerge: true,
            enableSubtitles: true,
            characterAnchorLimit: 5,
          },
          videoGen: { spec: updatedProj.spec },
          clips: updatedProj.clips,
        };
        await executeAudioMerge(stageCtx);
        await executeCompose({ ...stageCtx, clips: useVideoStore.getState().getProject(pid)?.clips || updatedProj.clips });
      }
    } catch (composeErr) {
      void logger.warn(`[pipeline] rerunSingleShot auto-compose skipped: ${composeErr}`, 'pipeline');
    }

    return clip;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[pipeline] rerunSingleShot FAIL shotId=${shotId}: ${msg}`, 'pipeline');
    store.setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  } finally {
    popStageContext();
  }
}

export const rerunSingleVideoGen = rerunSingleShot;

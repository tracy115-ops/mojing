// pipeline-runner.ts — 14 步流水线编排器
// 输入:SceneSpec + PipelineOptions + callbacks
// 按 options 编排骨分子集。每步失败降级见文档 §10。
//
// 期 1(本次):实装步 3/6/7/9/10/12-14。步 4/8/11(音频链路)留 stub 跳过,期 3 补全。

import { useVideoStore } from '@/stores/videoStore';
import { useProviderStore } from '@/stores/providerStore';
import { useProjectStore } from '@/stores/projectStore';
import { providerRouter } from '@/services/providers';
import { logger } from '@/services/log';
import type {
  SceneSpec,
  PipelineOptions,
  VideoStage,
  VideoProjectState,
  ShotSpec,
  GeneratedClip,
  VideoExecutionBinding,
} from '@/types/video';
import type { PipelineCallbacks } from './types';
import { isAssetAvailable, isValidVideoClip } from '../asset-store';
import { parseStructuredPromptShots } from '../direct-scene-builder';
import {
  RUNTIME_STAGE_ORDER,
  STAGE_HANDLERS,
  isStageEnabled,
  applyStageInput,
} from './stage-handlers';
import type { VideoGenOptions } from './step-video-gen';
import { resolveTemporalAuthority, shotsShareScene, shotsShareSubjects } from './shot-continuity';
import { applySeriesProjectLibrary } from '../series-character-library';
import { ENVIRONMENT_REFERENCE_VERSION } from './asset-reference-contract';
import { isStageLiveCompleted as checkStageArtifactHealth } from './stage-artifact-health';
import {
  mergePersistedSceneSpecArtifacts,
  reconcileSceneSpecArtifacts,
} from './derived-artifact-invalidation';
import {
  allShotsHaveApprovedKeyframes,
  allShotsHaveVideoCandidates,
  getAssemblyBlockers,
  isApprovedVideoClip,
  isShotKeyframeApproved,
} from './shot-production-contract';
import { updateShotGenerationPlan } from './shot-generation-plan';
import { collectVideoPipelinePreflight } from './pipeline-preflight';
import type { PipelinePreflightResult } from './pipeline-preflight-rules';
import { resolveAssemblyQualityRequirements, resolveVideoQualityPolicy } from './quality-policy';

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

export interface RunStageOptions {
  /** Explicit UI reruns must invalidate the stage output before execution. */
  force?: boolean;
}

const activeRuns = new Map<string, symbol>();

function beginPipelineRun(pid: string): symbol {
  const token = Symbol(pid);
  activeRuns.set(pid, token);
  return token;
}

function isPipelineRunActive(pid: string, token: symbol): boolean {
  return activeRuns.get(pid) === token;
}

function finishPipelineRun(pid: string, token: symbol): void {
  if (isPipelineRunActive(pid, token)) activeRuns.delete(pid);
}

/**
 * Resolve provider/model choices once per project and reuse them for every
 * stage, including resumed and single-shot runs. A missing endpoint is kept
 * as an explicit error by the provider router instead of silently switching
 * to whichever endpoint happens to be active later.
 */
function ensureExecutionBinding(
  pid: string,
  requested: VideoGenOptions,
  imageRequired = requested.sourceMode !== 'pure',
): VideoGenOptions {
  const store = useVideoStore.getState();
  const providerStore = useProviderStore.getState();
  const existing = store.getProject(pid)?.executionBinding;
  const imageEndpointId = imageRequired
    ? existing?.image?.endpointId
      ?? requested.imageEndpointId
      ?? providerStore.getActiveEndpoint('image')?.id
    : undefined;
  const imageModel = imageRequired ? existing?.image?.model ?? requested.imageModel : undefined;
  const videoEndpointId = existing?.video.endpointId
    ?? requested.endpointId
    ?? providerStore.getActiveEndpoint('video')?.id;
  const videoModel = existing?.video.model ?? requested.model;
  if (!videoEndpointId) {
    throw new Error('No video endpoint is configured for this pipeline.');
  }
  const videoEndpoint = providerStore.getEndpoint(videoEndpointId);
  if (!videoEndpoint?.enabled) {
    throw new Error(`Configured video endpoint "${videoEndpointId}" is missing or disabled.`);
  }
  const imageEndpoint = imageRequired && imageEndpointId
    ? providerStore.getEndpointsByCategory('image').find((endpoint) => endpoint.id === imageEndpointId)
    : undefined;
  const imageCapabilities = imageEndpoint
    ? providerRouter.getImageCapabilities('storyboard', imageModel, imageEndpointId)
    : undefined;
  const videoCapabilities = providerRouter.getVideoCapabilities('clip', videoModel, videoEndpointId);
  const binding: VideoExecutionBinding = {
    ...(imageCapabilities ? {
      image: {
        provider: imageCapabilities.provider,
        model: imageCapabilities.model,
        endpointId: imageCapabilities.endpointId,
      },
    } : {}),
    video: {
      provider: videoCapabilities.provider,
      model: videoCapabilities.model,
      endpointId: videoCapabilities.endpointId,
    },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  if (!existing || JSON.stringify(existing) !== JSON.stringify(binding)) {
    if (store.getProject(pid)) store.setExecutionBinding(pid, binding);
  }

  void logger.info(
    `[pipeline] execution binding pid=${pid} image=${binding.image?.provider}/${binding.image?.model}@${binding.image?.endpointId ?? '-'} `
      + `video=${binding.video.provider}/${binding.video.model}@${binding.video.endpointId ?? '-'}`,
    'pipeline',
  );

  return {
    ...requested,
    imageEndpointId: binding.image?.endpointId,
    imageModel: binding.image?.model,
    endpointId: binding.video.endpointId,
    model: binding.video.model,
  };
}

/**
 * 终止指定项目的流水线生成
 */
export function abortPipeline(pid: string): void {
  void logger.info(`[pipeline] abortPipeline request pid=${pid}`, 'pipeline');
  activeRuns.delete(pid);
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
 * Close the planning checkpoint without starting production. The caller may
 * then invoke runFromStage('character_anchor') to begin the asset pipeline.
 * Keeping these operations separate makes the approval auditable and prevents
 * a UI navigation event from spending provider credits by accident.
 */
export function approvePlanning(pid: string): boolean {
  const store = useVideoStore.getState();
  const project = store.getProject(pid);
  if (!project?.sceneSpec?.shots.length) return false;

  const planningStage = project.stages.extraction;
  if (planningStage?.status === 'awaiting_review') {
    store.setStageStatus(pid, 'extraction', 'completed', {
      progress: 1,
      error: undefined,
    });
    store.setStageInputSummary(pid, 'extraction', {
      headline: '分镜规划已确认，可以开始生产资产',
      details: [
        `已确认 ${project.sceneSpec.shots.length} 个镜头`,
        '角色、场景、关键帧和视频生产将使用这份已确认规划',
      ],
    });
    store.setError(pid, undefined);
    return true;
  }

  // Existing projects created before the checkpoint are already considered
  // approved when extraction completed successfully.
  return planningStage?.status === 'completed';
}

/**
 * 14 步流水线入口。返回最终 VideoProjectState。
 * 异常不中断整条流水线,只标记单步失败。
 */
export async function runPipeline(args: RunPipelineArgs): Promise<VideoProjectState | null> {
  const { novelProjectId, spec, options, callbacks, videoGen, shouldAbort } = args;
  const runToken = beginPipelineRun(novelProjectId);
  const checkAbort = () => !isPipelineRunActive(novelProjectId, runToken) || (shouldAbort ? shouldAbort() : false);
  void logger.info(`[pipeline] RUN start pid=${novelProjectId} shots=${spec.shots.length} chars=${spec.characters?.length ?? 0} scenes=${spec.scenes?.length}`, 'pipeline');
  const store = useVideoStore.getState();
  const preflight = collectVideoPipelinePreflight({
    channel: spec.meta.channel,
    sourceMode: spec.meta.sourceMode,
    options,
    startStage: 'character_anchor',
    planningRequired: false,
    sceneSpec: spec,
    hasCharacterReferences: options.enableCharacterAnchor && (spec.characters?.length ?? 0) > 0,
    hasSpeech: spec.shots.some(shotHasSpeech),
    imageEndpointId: videoGen.imageEndpointId,
    imageModel: videoGen.imageModel,
    videoEndpointId: videoGen.endpointId,
    videoModel: videoGen.model,
  });
  if (!preflight.ok) {
    const message = describePreflightFailure(preflight);
    store.setError(novelProjectId, message);
    finishPipelineRun(novelProjectId, runToken);
    return null;
  }
  const boundVideoGen = ensureExecutionBinding(
    novelProjectId,
    videoGen,
    requiresImageStage(options, spec),
  );

  // Merge only reusable derived artifacts into the current input. The incoming
  // spec remains authoritative for story, bindings, prompts, and model inputs.
  const existingProj = store.getProject(novelProjectId);
  const persistedSceneSpec = existingProj?.sceneSpec;
  const reusableSpec = mergePersistedSceneSpecArtifacts(persistedSceneSpec, spec);
  const reconciled = reconcileSceneSpecArtifacts(
    persistedSceneSpec,
    reusableSpec,
    existingProj?.clips ?? [],
    existingProj?.finalVideoUrl,
  );
  let workingSpec: SceneSpec = {
    ...reconciled.spec,
    meta: {
      ...reconciled.spec.meta,
      openingReferenceImage: reconciled.spec.meta.openingReferenceImage ?? getPreviousEpisodeKeyframe(novelProjectId),
    },
  };

  void logger.info(
    `[pipeline] resume check: persisted=${!!persistedSceneSpec} ` +
      `invalidateFrom=${reconciled.invalidateFrom ?? '-'} reusableClips=${reconciled.clips.length} ` +
      `stages=${summarizeStageStatuses(existingProj)}`,
    'pipeline',
  );

  // 先把初始 SceneSpec 落进 store,让 UI 能在 character_anchor 完成前
  // 就看到"提取"出的角色/场景/道具数据(否则面板会显示 Empty)。
  store.setSceneSpec(novelProjectId, workingSpec);

  // 循环调度 8 个 runtime stage。每个 stage 的执行逻辑抽到了 stage-handlers.ts,
  // 这里只负责「跳过 / 跑 / 失败降级」的决策。
  let clips: GeneratedClip[] = [...reconciled.clips];
  store.ensureShotVersionHistory(novelProjectId);
  workingSpec = store.getProject(novelProjectId)?.sceneSpec ?? workingSpec;

  for (const stage of RUNTIME_STAGE_ORDER) {
    if (checkAbort()) break;

    // composing 需要 clips 非空
    if (stage === 'composing' && clips.length === 0) {
      void logger.info('[pipeline] composing: 无 clips,跳过', 'pipeline');
      skipStage(store, novelProjectId, stage);
      continue;
    }

    const enabled = isStageEnabled(stage, options, workingSpec);
    if (!enabled) {
      skipStage(store, novelProjectId, stage);
      continue;
    }

    // 已完成且产物仍在 → 跳过(断点续跑的核心)
    const currentProj = store.getProject(novelProjectId);
    if (currentProj && await isStageLiveCompleted(currentProj, stage)) {
      // video_generation 跳过时要从持久化拿 clips,供后续 audio_merge/composing 用
      if (stage === 'video_generation') {
        clips = [...currentProj.clips];
        callbacks?.onShotProgress?.(clips.length, workingSpec.shots.length);
      }
      void logger.info(`[pipeline] ${stage}: 已完成且产物仍在,跳过`, 'pipeline');
      callbacks?.onStageProgress?.(stage, 1);
      continue;
    }

    const handler = STAGE_HANDLERS[stage];
    if (!handler) {
      void logger.warn(`[pipeline] ${stage}: 无 handler,跳过`, 'pipeline');
      skipStage(store, novelProjectId, stage);
      continue;
    }

    const result = await handler({
      pid: novelProjectId,
      workingSpec,
      options,
      videoGen: boundVideoGen,
      callbacks,
      shouldAbort: checkAbort,
      isCurrentRun: () => isPipelineRunActive(novelProjectId, runToken),
      // video_generation 用 preExistingClips 做增量;auido_merge/composing 用累积 clips
      clips,
    });
    if (!isPipelineRunActive(novelProjectId, runToken)) {
      void logger.info(`[pipeline] ${stage}: result discarded because a newer run owns pid=${novelProjectId}`, 'pipeline');
      return null;
    }
    if (result) {
      workingSpec = result.spec;
      if (result.clips) clips = result.clips;
    } else {
      void logger.warn(`[pipeline] stage ${stage} 失败，流水线暂停在当前步骤等待用户处理`, 'pipeline');
      break;
    }

    // 系列剧集在关键帧完成后暂停：让用户先核对角色、场景与镜头连续性，
    // 明确确认后才进入昂贵且不可逆的视频生成阶段。
    if (result && isPipelineRunActive(novelProjectId, runToken) && stage === 'keyframe_image' && requiresKeyframeReview(novelProjectId)) {
      store.advanceToStage(novelProjectId, 'video_generation');
      store.setStageStatus(novelProjectId, 'video_generation', 'awaiting_review', { progress: 0, error: undefined });
      store.setStageInputSummary(novelProjectId, 'video_generation', {
        headline: '关键帧已生成，等待人工确认后开始视频生成。',
      });
      break;
    }

    if (result && isPipelineRunActive(novelProjectId, runToken) && stage === 'video_review') {
      const reviewedProject = store.getProject(novelProjectId);
      if (reviewedProject?.sceneSpec
        && allShotsHaveVideoCandidates(reviewedProject.sceneSpec.shots, reviewedProject.clips)
        && getAssemblyBlockers(
          reviewedProject.sceneSpec.shots,
          reviewedProject.clips,
          resolveAssemblyQualityRequirements(reviewedProject.options),
        ).length > 0) {
        store.advanceToStage(novelProjectId, 'video_review');
        store.setStageStatus(novelProjectId, 'video_review', 'awaiting_review', { progress: 1, error: undefined });
        store.setStageInputSummary(novelProjectId, 'video_review', {
          headline: '视频候选已生成，等待人工审核后进入合成。',
          details: reviewedProject.sceneSpec.shots.map((shot) => `镜头 ${shot.index + 1} · 选择一个视频版本并锁定`),
        });
        break;
      }
    }
  }

  // 写回 sceneSpec,供 UI 展示角色立绘/场景图/关键帧
  if (!isPipelineRunActive(novelProjectId, runToken)) return null;
  store.setSceneSpec(novelProjectId, workingSpec);

  void logger.info(`[pipeline] RUN end pid=${novelProjectId} clips=${clips.length}`, 'pipeline');
  const finalProject = useVideoStore.getState().getProject(novelProjectId) ?? null;
  finishPipelineRun(novelProjectId, runToken);
  return finalProject;
}

function skipStage(
  store: ReturnType<typeof useVideoStore.getState>,
  novelProjectId: string,
  stage: VideoStage,
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
export async function isStageLiveCompleted(proj: VideoProjectState, stage: VideoStage): Promise<boolean> {
  return checkStageArtifactHealth(proj, stage, {
    isAssetAvailable,
    isValidVideoClip,
    environmentReferenceVersion: ENVIRONMENT_REFERENCE_VERSION,
  });
}

// Re-export step-video-gen's options type for callers
export type { VideoGenOptions, ShotSpec };

function summarizeStageStatuses(proj: VideoProjectState | undefined): string {
  if (!proj) return '(no existing project)';
  const stages = Object.values(proj.stages);
  const completed = stages.filter((s) => s.status === 'completed').length;
  const errored = stages.filter((s) => s.status === 'error').length;
  const skipped = stages.filter((s) => s.status === 'skipped').length;
  return `${completed}c/${errored}e/${skipped}s`;
}

function applyPersistedSeriesLibrary(pid: string, sceneSpec: SceneSpec): SceneSpec {
  const project = useProjectStore.getState().projects.find((item) => item.id === pid);
  const metadata = (project?.metadata || {}) as any;
  const seriesProject = metadata.seriesId
    ? useProjectStore.getState().projects.find((item) => item.id === metadata.seriesId)
    : undefined;
  const seriesMetadata = (seriesProject?.metadata || {}) as any;
  const characters = seriesMetadata.seriesCharacters ?? metadata.seriesCharacters;
  const scenes = seriesMetadata.seriesScenes ?? metadata.seriesScenes;
  const styleGuide = seriesMetadata.seriesStyleGuide ?? metadata.seriesStyleGuide;

  if (!characters?.length && !scenes?.length && !styleGuide) return sceneSpec;
  return applySeriesProjectLibrary(sceneSpec, { characters, scenes, styleGuide });
}

// ============================================================================
// 单步重跑 API
// ============================================================================

/** 从 store 重建 StageContext(单步重跑用)。
 *  和 runPipeline 的初始化不同:这里完全信任 store 里的 sceneSpec,
 *  因为单步重跑的前提是「前面步骤都已经跑过,产物在 store 里」。 */
function buildContextFromStore(pid: string, imageRequired = true): {
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

    const characters = Array.isArray(metadata.seriesCharacters)
      ? metadata.seriesCharacters
      : Array.isArray(seriesMetadata.seriesCharacters)
        ? seriesMetadata.seriesCharacters
        : [];
    const scenes = Array.isArray(metadata.seriesScenes)
      ? metadata.seriesScenes
      : Array.isArray(seriesMetadata.seriesScenes)
        ? seriesMetadata.seriesScenes
        : [];

    const metadataSpec = metadata.initialSceneSpec || metadata.sceneSpec;
    const hasUsableMetadataSpec = metadataSpec
      && typeof metadataSpec === 'object'
      && Array.isArray(metadataSpec.shots)
      && metadataSpec.shots.length > 0;
    const sourceText = Array.isArray(metadata.chapters)
      ? metadata.chapters
        .map((chapter: any) => String(chapter?.content || '').trim())
        .filter(Boolean)
        .join('\n\n')
      : String(metadata.scriptText || project.description || project.title || '').trim();

    let specToUse: SceneSpec | undefined = hasUsableMetadataSpec
      ? {
        ...metadataSpec,
        characters: Array.isArray(metadataSpec.characters) ? metadataSpec.characters : characters,
        scenes: Array.isArray(metadataSpec.scenes) ? metadataSpec.scenes : scenes,
        meta: {
          title: project.title,
          style: metadata.style || 'cinematic',
          genre: 'script',
          aspectRatio: metadata.aspectRatio || '16:9',
          defaultShotDuration: 5,
          sourceMode: 'multishot',
          channel: 'novel',
          ...(metadataSpec.meta && typeof metadataSpec.meta === 'object' ? metadataSpec.meta : {}),
        },
      }
      : undefined;

    if (!specToUse) {
      const parsedShots = parseStructuredPromptShots(sourceText, {
        aspectRatio: metadata.aspectRatio || '16:9',
        defaultShotDuration: (metadata.duration as any) || 5,
      });

      const fallbackShot: ShotSpec = {
        id: `shot_1`,
        index: 0,
        videoPrompt: sourceText || project.title,
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

  const videoGen = ensureExecutionBinding(pid, {
    spec: {
      resolution: proj.spec.resolution,
      fps: proj.spec.fps,
      videoTier: proj.spec.videoTier,
      aspectRatio: proj.spec.aspectRatio,
    },
    imageStyle: proj.spec.style,
    novelProjectId: pid,
    sceneSource: 'novel',
    sourceMode: 'multishot',
    characters: proj.sceneSpec.characters,
    scenes: proj.sceneSpec.scenes,
    allShots: proj.sceneSpec.shots,
    requireKeyframeForI2V: true,
  }, imageRequired);

  return {
    proj,
    ctx: {
      pid,
      workingSpec: proj.sceneSpec,
      options: proj.options ?? defaultPipelineOptions(),
      videoGen,
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
export async function runSingleStage(
  pid: string,
  stage: VideoStage,
  stageOptions: RunStageOptions = {},
): Promise<boolean> {
  void logger.info(`[pipeline] runSingleStage pid=${pid} stage=${stage}`, 'pipeline');
  const runToken = beginPipelineRun(pid);
  const preflightProject = useVideoStore.getState().getProject(pid);
  if (preflightProject?.sceneSpec) {
    const preflight = preflightStoredProject(preflightProject, stage);
    if (!preflight.ok) {
      markPipelineBoundaryFailure(pid, stage, new Error(describePreflightFailure(preflight)));
      finishPipelineRun(pid, runToken);
      return false;
    }
  }
  if (stageOptions.force) {
    useVideoStore.getState().resetStagesFrom(pid, stage);
  }
  let built: ReturnType<typeof buildContextFromStore>;
  try {
    built = buildContextFromStore(pid, stage === 'character_anchor' || stage === 'scene_image' || stage === 'keyframe_image');
  } catch (err) {
    markPipelineBoundaryFailure(pid, stage, err);
    finishPipelineRun(pid, runToken);
    return false;
  }
  if (!built) {
    void logger.warn(`[pipeline] runSingleStage: 项目不存在或无 sceneSpec pid=${pid}`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return false;
  }
  try {
    built.ctx.workingSpec = applyPersistedSeriesLibrary(pid, built.ctx.workingSpec);
  } catch (err) {
    markPipelineBoundaryFailure(pid, stage, err);
    finishPipelineRun(pid, runToken);
    return false;
  }
  useVideoStore.getState().setSceneSpec(pid, built.ctx.workingSpec);
  const handler = STAGE_HANDLERS[stage];
  if (!handler) {
    void logger.warn(`[pipeline] runSingleStage: stage ${stage} 无 handler`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return false;
  }
  // 应用用户改过的 input(prompt/seed/resolution 等)到 workingSpec/videoGen
  const ctx = {
    ...applyStageInput(built.ctx, stage),
    isCurrentRun: () => isPipelineRunActive(pid, runToken),
  };
  const result = await handler(ctx);
  if (!result || !isPipelineRunActive(pid, runToken)) {
    void logger.warn(`[pipeline] runSingleStage: stage ${stage} 执行失败`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return false;
  }
  // 单步重跑时也要把更新后的 spec 落盘
  useVideoStore.getState().setSceneSpec(pid, result.spec);
  finishPipelineRun(pid, runToken);
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
export async function runFromStage(
  pid: string,
  stage: VideoStage,
  stageOptions: RunStageOptions = {},
): Promise<boolean> {
  void logger.info(`[pipeline] runFromStage pid=${pid} stage=${stage}`, 'pipeline');
  const runToken = beginPipelineRun(pid);
  const preflightProject = useVideoStore.getState().getProject(pid);
  if (preflightProject?.sceneSpec) {
    const options = preflightProject.options ?? defaultPipelineOptions();
    const effectiveStart: VideoStage = stage === 'video_generation'
      && options.enableTTS
      && preflightProject.stages.tts?.status !== 'completed'
      ? 'voice_assignment'
      : stage;
    const preflight = preflightStoredProject(preflightProject, effectiveStart);
    if (!preflight.ok) {
      markPipelineBoundaryFailure(pid, stage, new Error(describePreflightFailure(preflight)));
      finishPipelineRun(pid, runToken);
      return false;
    }
  }
  let built: ReturnType<typeof buildContextFromStore>;
  try {
    built = buildContextFromStore(pid, requiresImageFromStage(preflightProject, stage));
  } catch (err) {
    markPipelineBoundaryFailure(pid, stage, err);
    finishPipelineRun(pid, runToken);
    return false;
  }
  if (!built) {
    void logger.warn(`[pipeline] runFromStage: 项目不存在或无 sceneSpec pid=${pid}`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return false;
  }

  // Repair historical shot bindings before reset/re-running a later stage. Old
  // projects may contain generated IDs that no longer point at the series assets.
  try {
    built.ctx.workingSpec = applyPersistedSeriesLibrary(pid, built.ctx.workingSpec);
  } catch (err) {
    markPipelineBoundaryFailure(pid, stage, err);
    finishPipelineRun(pid, runToken);
    return false;
  }
  useVideoStore.getState().setSceneSpec(pid, built.ctx.workingSpec);
  useVideoStore.getState().ensureShotVersionHistory(pid);

  const store = useVideoStore.getState();
  const effectiveStage: VideoStage = stage === 'video_generation'
    && built.ctx.options.enableTTS
    && built.proj.stages.tts?.status !== 'completed'
    ? 'voice_assignment'
    : stage;
  if (effectiveStage !== stage) {
    void logger.info(`[pipeline] runFromStage: ${stage} requires pending TTS, rewinding to ${effectiveStage}`, 'pipeline');
  }
  // 清掉从 stage 起的所有 stage 状态 + 产物
  if (stageOptions.force !== false) {
    store.resetStagesFrom(pid, effectiveStage);
  }

  // 重新读 proj(reset 后 sceneSpec 可能被改 — keyframe/tts 会清对应字段)
  const freshProj = store.getProject(pid);
  if (!freshProj || !freshProj.sceneSpec) {
    finishPipelineRun(pid, runToken);
    return false;
  }

  let workingSpec = freshProj.sceneSpec;
  let clips = [...freshProj.clips];

  const startIdx = RUNTIME_STAGE_ORDER.indexOf(effectiveStage);
  if (startIdx < 0) {
    void logger.warn(`[pipeline] runFromStage: stage ${stage} 不在 RUNTIME_STAGE_ORDER`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return false;
  }

  const checkAbort = () => !isPipelineRunActive(pid, runToken);

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

    // A keyframe is a production input, not merely a generated file. Keep the
    // video stage at its checkpoint until every current keyframe has a human
    // approval. This prevents a stale or rejected still from silently driving
    // an expensive I2V request.
    if (s === 'video_generation'
      && built.ctx.options.enableI2V
      && built.ctx.options.enableKeyframe
      && !allShotsHaveApprovedKeyframes(workingSpec.shots)) {
      store.advanceToStage(pid, 'video_generation');
      store.setStageStatus(pid, 'video_generation', 'awaiting_review', {
        progress: 0,
        error: undefined,
      });
      store.setStageInputSummary(pid, 'video_generation', {
        headline: 'Keyframe review is required before video generation',
        details: workingSpec.shots
          .filter((shot) => !shot.keyframeImage || !isShotKeyframeApproved(shot))
          .slice(0, 12)
          .map((shot) => `Shot ${shot.index + 1}: approve the current keyframe`),
      });
      allOk = false;
      break;
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
        isCurrentRun: () => isPipelineRunActive(pid, runToken),
      },
      s,
    );
    // applyStageInput 可能改了 workingSpec,同步给循环外层变量
    workingSpec = stageCtx.workingSpec;

    const result = await handler(stageCtx);
    if (!isPipelineRunActive(pid, runToken)) {
      allOk = false;
      break;
    }
    if (result) {
      workingSpec = result.spec;
      if (result.clips) clips = result.clips;
    } else {
      allOk = false;
      void logger.warn(`[pipeline] runFromStage: stage ${s} 执行失败，流水线暂停在当前步骤等待处理`, 'pipeline');
      break;
    }

    if (result && isPipelineRunActive(pid, runToken) && s === 'keyframe_image' && requiresKeyframeReview(pid)) {
      store.advanceToStage(pid, 'video_generation');
      store.setStageStatus(pid, 'video_generation', 'awaiting_review', { progress: 0, error: undefined });
      store.setStageInputSummary(pid, 'video_generation', {
        headline: '关键帧已重新生成，等待人工确认后开始视频生成。',
      });
      break;
    }

    if (result && isPipelineRunActive(pid, runToken) && s === 'video_review') {
      const reviewedProject = store.getProject(pid);
      if (reviewedProject?.sceneSpec
        && allShotsHaveVideoCandidates(reviewedProject.sceneSpec.shots, reviewedProject.clips)
        && getAssemblyBlockers(
          reviewedProject.sceneSpec.shots,
          reviewedProject.clips,
          resolveAssemblyQualityRequirements(reviewedProject.options),
        ).length > 0) {
        store.advanceToStage(pid, 'video_review');
        store.setStageStatus(pid, 'video_review', 'awaiting_review', { progress: 1, error: undefined });
        store.setStageInputSummary(pid, 'video_review', {
          headline: '视频候选已生成，等待人工审核后进入合成。',
          details: reviewedProject.sceneSpec.shots.map((shot) => `镜头 ${shot.index + 1} · 选择一个视频版本并锁定`),
        });
        break;
      }
    }
  }

  if (!isPipelineRunActive(pid, runToken)) {
    finishPipelineRun(pid, runToken);
    return false;
  }
  store.setSceneSpec(pid, workingSpec);
  finishPipelineRun(pid, runToken);
  return allOk;
}

function markPipelineBoundaryFailure(pid: string, stage: VideoStage, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const store = useVideoStore.getState();
  store.setStageStatus(pid, stage, 'error', { error: message, progress: 1 });
  store.setError(pid, message);
  void logger.error(`[pipeline] ${stage} preflight FAIL: ${message}`, 'pipeline');
}

function preflightStoredProject(
  project: VideoProjectState,
  startStage: VideoStage,
): PipelinePreflightResult {
  const sceneSpec = project.sceneSpec;
  if (!sceneSpec) {
    return {
      ok: false,
      requiredCategories: [],
      providers: {},
      blocking: [{ code: 'missing-endpoint', category: 'video', detail: 'Project has no scene specification.' }],
      warnings: [],
    };
  }
  const options = project.options ?? defaultPipelineOptions();
  return collectVideoPipelinePreflight({
    channel: sceneSpec.meta.channel,
    sourceMode: sceneSpec.meta.sourceMode,
    options,
    startStage,
    planningRequired: false,
    sceneSpec,
    hasCharacterReferences: options.enableCharacterAnchor && (sceneSpec.characters?.length ?? 0) > 0,
    hasSpeech: sceneSpec.shots.some(shotHasSpeech),
    imageEndpointId: project.executionBinding?.image?.endpointId,
    imageModel: project.executionBinding?.image?.model,
    videoEndpointId: project.executionBinding?.video.endpointId,
    videoModel: project.executionBinding?.video.model,
  });
}

function describePreflightFailure(result: PipelinePreflightResult): string {
  const details = result.blocking.map((issue) => {
    const provider = issue.provider ? ` ${issue.provider}/${issue.model ?? '-'}` : '';
    const shot = issue.shotId ? ` shot=${issue.shotId}` : '';
    return `${issue.category}:${issue.code}${shot}${provider}${issue.detail ? ` (${issue.detail})` : ''}`;
  });
  return `Generation preflight failed: ${details.join('; ') || 'unknown issue'}`;
}

function defaultPipelineOptions(): PipelineOptions {
  return {
    enableCharacterAnchor: true,
    enableSceneImage: true,
    enableTTS: true,
    enableKeyframe: true,
    enableI2V: true,
    enableAudioMerge: true,
    enableSubtitles: false,
    characterAnchorLimit: 5,
    qualityProfile: 'quality',
    keyframeCandidatesPerShot: 2,
    videoCandidatesPerShot: 2,
    enableVisualQualityGate: true,
    blockOnVisualReviewUnavailable: true,
  };
}

function shotHasSpeech(shot: ShotSpec): boolean {
  return !!(
    shot.dialogue?.some((dialogue) => !!dialogue.text?.trim())
    || shot.narration?.trim()
    || shot.sourceText?.trim()
    || shot.videoPrompt?.trim()
  );
}

function requiresImageStage(options: PipelineOptions, spec: SceneSpec): boolean {
  return !!(
    (options.enableCharacterAnchor && (spec.characters?.length ?? 0) > 0)
    || (options.enableSceneImage && (spec.scenes?.length ?? 0) > 0)
    || options.enableKeyframe
  );
}

function requiresImageFromStage(project: VideoProjectState | undefined, startStage: VideoStage): boolean {
  if (!project?.sceneSpec) return true;
  const sceneSpec = project.sceneSpec;
  const startIndex = RUNTIME_STAGE_ORDER.indexOf(startStage);
  if (startIndex < 0) return false;
  return (['character_anchor', 'scene_image', 'keyframe_image'] as VideoStage[]).some((imageStage) => {
    const imageIndex = RUNTIME_STAGE_ORDER.indexOf(imageStage);
    return imageIndex >= startIndex && isStageEnabled(
      imageStage,
      project.options ?? defaultPipelineOptions(),
      sceneSpec,
    );
  });
}

function requiresKeyframeReview(projectId: string): boolean {
  const project = useVideoStore.getState().getProject(projectId);
  return !!project?.sceneSpec?.shots.length && project.options?.enableKeyframe !== false;
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
  const runToken = beginPipelineRun(pid);
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj || !proj.sceneSpec) {
    void logger.warn(`[pipeline] rerunSingleKeyframe fail: project not found pid=${pid}`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return null;
  }

  const shotIndex = proj.sceneSpec.shots.findIndex((s) => s.id === shotId);
  if (shotIndex === -1) {
    void logger.warn(`[pipeline] rerunSingleKeyframe fail: shot not found id=${shotId}`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return null;
  }
  const shot = proj.sceneSpec.shots[shotIndex];
  const boundVideoGen = ensureExecutionBinding(pid, {
    spec: {
      resolution: proj.spec.resolution,
      fps: proj.spec.fps,
      videoTier: proj.spec.videoTier,
    },
    sceneSource: 'novel',
    sourceMode: 'multishot',
    novelProjectId: pid,
    characters: proj.sceneSpec.characters,
    allShots: proj.sceneSpec.shots,
    requireKeyframeForI2V: true,
  }, true);

  const stage: VideoStage = 'keyframe_image';
  store.setStageStatus(pid, stage, 'running');
  const { pushStageContext, popStageContext } = await import('@/services/providers/invocation-context');
  pushStageContext({ novelProjectId: pid, stage });

  try {
    const { generateSingleKeyframe } = await import('./step-keyframe');
    const keyframeResult = await generateSingleKeyframe(shot, shotIndex, proj.sceneSpec.shots, {
      characters: proj.sceneSpec.characters ?? [],
      scenes: proj.sceneSpec.scenes ?? [],
      aspectRatio: proj.spec.aspectRatio,
      style: proj.sceneSpec.meta.style,
      imageTier: proj.spec.imageTier,
      imageEndpointId: boundVideoGen.imageEndpointId,
      imageModel: boundVideoGen.imageModel,
      novelProjectId: pid,
      openingReferenceImage: proj.sceneSpec.meta.openingReferenceImage ?? getPreviousEpisodeKeyframe(pid),
      requireCharacterReferences: proj.options?.enableCharacterAnchor ?? true,
    });
    if (!isPipelineRunActive(pid, runToken)) return null;

    const nextShot = proj.sceneSpec.shots[shotIndex + 1];
    const nextSameScene = !!nextShot
      && shotsShareScene(shot, nextShot)
      && shotsShareSubjects(shot, nextShot);
    const affectedShotIds = new Set([shot.id]);
    if (nextSameScene && nextShot) affectedShotIds.add(nextShot.id);
    const updatedShots = proj.sceneSpec.shots.map((s, idx) => {
      if (idx === shotIndex) {
        return {
          ...s,
          keyframeImage: keyframeResult.imagePath,
          referenceAssets: keyframeResult.referenceAssets,
          keyframeInputFingerprint: keyframeResult.inputFingerprint,
          keyframeGenerationContext: keyframeResult.executionContext,
          generationPlan: keyframeResult.generationPlan,
        };
      }
      if (nextSameScene && idx === shotIndex + 1) {
        return {
          ...s,
          keyframeImage: undefined,
          keyframeInputFingerprint: undefined,
          keyframeGenerationContext: undefined,
          referenceAssets: undefined,
          generationPlan: undefined,
        };
      }
      return s;
    });
    store.setSceneSpec(pid, { ...proj.sceneSpec, shots: updatedShots });
    store.addShotVersion(pid, shotId, {
      id: `keyframe_${shotId}_${Date.now()}`,
      type: 'image',
      url: keyframeResult.imagePath,
      createdAt: new Date().toISOString(),
      seed: keyframeResult.seed,
      inputFingerprint: keyframeResult.inputFingerprint,
      imageReferenceAssets: keyframeResult.referenceAssets,
      imageGenerationContext: keyframeResult.executionContext,
      generationPlan: keyframeResult.generationPlan,
      reviewStatus: 'unreviewed',
    });
    invalidateClips(pid, proj.clips, affectedShotIds);
    store.setStageStatus(pid, 'video_generation', 'pending', { progress: 0, error: undefined });
    store.setStageStatus(pid, 'audio_merge', 'pending', { progress: 0, error: undefined });
    store.setStageStatus(pid, 'composing', 'pending', { progress: 0, error: undefined });
    store.setStageStatus(pid, stage, 'completed');
    void logger.info(`[pipeline] rerunSingleKeyframe SUCCESS shotId=${shotId}`, 'pipeline');
    return keyframeResult.imagePath;
  } catch (err) {
    if (!isPipelineRunActive(pid, runToken)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[pipeline] rerunSingleKeyframe FAIL shotId=${shotId}: ${msg}`, 'pipeline');
    store.setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  } finally {
    popStageContext();
    finishPipelineRun(pid, runToken);
  }
}

/**
 * 单镜头独立重试/重新生成：仅针对单个 Shot 重新跑 T2V / I2V 生成 Clip。
 */
export async function rerunSingleShot(pid: string, shotId: string): Promise<GeneratedClip | null> {
  void logger.info(`[pipeline] rerunSingleShot pid=${pid} shotId=${shotId}`, 'pipeline');
  const runToken = beginPipelineRun(pid);
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj || !proj.sceneSpec) {
    void logger.warn(`[pipeline] rerunSingleShot fail: project not found pid=${pid}`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return null;
  }

  const shot = proj.sceneSpec.shots.find((s) => s.id === shotId);
  if (!shot) {
    void logger.warn(`[pipeline] rerunSingleShot fail: shot not found id=${shotId}`, 'pipeline');
    finishPipelineRun(pid, runToken);
    return null;
  }

  const stage: VideoStage = 'video_generation';
  store.setStageStatus(pid, stage, 'running');
  const { generateSingleVideoClip } = await import('./step-video-gen');
  const { pushStageContext, popStageContext } = await import('@/services/providers/invocation-context');

  pushStageContext({ novelProjectId: pid, stage });

  try {
    const qualityPolicy = resolveVideoQualityPolicy(proj.options);
    const shotIndex = proj.sceneSpec.shots.findIndex((candidate) => candidate.id === shotId);
    const previousShot = shotIndex > 0 ? proj.sceneSpec.shots[shotIndex - 1] : undefined;
    const previousClip = previousShot ? proj.clips.find((candidate) => candidate.shotId === previousShot.id) : undefined;
    const previousLastFrameImage = previousShot
      && shotsShareScene(previousShot, shot)
      && shotsShareSubjects(previousShot, shot)
      && isApprovedVideoClip(previousShot, previousClip)
      ? previousClip?.lastFrameImage
      : undefined;
    const temporalAuthority = resolveTemporalAuthority(
      qualityPolicy.continuityMode,
      previousShot,
      shot,
      previousClip,
    );
    const videoGenOpts = ensureExecutionBinding(pid, {
      spec: {
        resolution: proj.spec.resolution,
        fps: proj.spec.fps,
        videoTier: proj.spec.videoTier,
        aspectRatio: proj.spec.aspectRatio,
      },
      imageStyle: proj.spec.style,
      sceneSource: 'novel',
      sourceMode: 'multishot',
      novelProjectId: pid,
      characters: proj.sceneSpec.characters,
      scenes: proj.sceneSpec.scenes,
      allShots: proj.sceneSpec.shots,
      requireKeyframeForI2V: true,
    }, false);

    let continuityShotUpdate: ShotSpec | undefined;
    const clip = await generateSingleVideoClip(
      shot,
      {
        ...videoGenOpts,
        requireContinuityHandoff: true,
        temporalAuthority,
        continuityKeyframeMode: 'off',
      },
      true,
      previousLastFrameImage,
      (updatedShot) => {
        continuityShotUpdate = updatedShot;
      },
    );
    if (!isPipelineRunActive(pid, runToken)) return null;

    const effectiveShot = continuityShotUpdate ?? shot;
    if (continuityShotUpdate?.keyframeImage) {
      store.updateSceneSpecShot(pid, shotId, {
        keyframeImage: continuityShotUpdate.keyframeImage,
        keyframeInputFingerprint: continuityShotUpdate.keyframeInputFingerprint,
        keyframeGenerationContext: continuityShotUpdate.keyframeGenerationContext,
        referenceAssets: continuityShotUpdate.referenceAssets,
        generationPlan: continuityShotUpdate.generationPlan,
      });
      store.addShotVersion(pid, shotId, {
        id: `keyframe_${shot.id}_${Date.now()}_${shot.index}`,
        type: 'image',
        url: continuityShotUpdate.keyframeImage,
        createdAt: new Date().toISOString(),
        prompt: continuityShotUpdate.imagePrompt || continuityShotUpdate.videoPrompt,
        seed: continuityShotUpdate.keyframeGenerationContext?.seed,
        inputFingerprint: continuityShotUpdate.keyframeInputFingerprint,
        imageReferenceAssets: continuityShotUpdate.referenceAssets,
        imageGenerationContext: continuityShotUpdate.keyframeGenerationContext,
        generationPlan: continuityShotUpdate.generationPlan,
        reviewStatus: 'unreviewed',
      });
    }

    store.addClip(pid, clip);
    const versionId = `video_${shot.id}_${Date.now()}`;
    const generationPlan = updateShotGenerationPlan(effectiveShot, {
      video: {
        inputFingerprint: clip.inputFingerprint,
        executionContext: clip.generationContext,
        controlMode: clip.videoControlMode,
        referenceMode: clip.videoReferenceMode,
        references: clip.videoReferenceAssets ?? [],
        outputUrl: clip.videoUrl,
      },
    });
    store.addShotVersion(pid, shotId, {
      id: versionId,
      type: 'video',
      url: clip.videoUrl,
      createdAt: clip.generatedAt,
      seed: clip.seed,
      provider: clip.provider,
      model: clip.model,
      durationSeconds: clip.durationSeconds,
      inputFingerprint: clip.inputFingerprint,
      generationContext: clip.generationContext,
      videoReferenceAssets: clip.videoReferenceAssets,
      videoReferenceMode: clip.videoReferenceMode,
      videoControlMode: clip.videoControlMode,
      lastFrameImage: clip.lastFrameImage,
      thumbnailUrl: clip.thumbnailUrl,
      hasAudio: clip.hasAudio,
      generationPlan,
      qualityReview: clip.qualityReview,
      visualReview: clip.visualReview,
      reviewStatus: 'unreviewed',
    });
    const nextShot = shotIndex >= 0 ? proj.sceneSpec.shots[shotIndex + 1] : undefined;
    const nextNeedsRegeneration = !!nextShot
      && shotsShareScene(effectiveShot, nextShot)
      && shotsShareSubjects(effectiveShot, nextShot);
    if (nextNeedsRegeneration && nextShot) {
      const latestProj = useVideoStore.getState().getProject(pid);
      invalidateClips(pid, latestProj?.clips ?? [], new Set([nextShot.id]));
      store.setStageStatus(pid, stage, 'pending', { progress: 0, error: undefined });
    } else {
      store.advanceToStage(pid, stage);
      store.setStageStatus(pid, stage, 'awaiting_review', { progress: 1, error: undefined });
    }
    store.setStageStatus(pid, 'audio_merge', 'pending', { progress: 0, error: undefined });
    store.setStageStatus(pid, 'composing', 'pending', { progress: 0, error: undefined });
    void logger.info(`[pipeline] rerunSingleShot SUCCESS shotId=${shotId} provider=${clip.provider}`, 'pipeline');

    // 体验极速更新：单镜重跑成功后，自动在后台更新音视对齐与成片合成！
    return clip;
  } catch (err) {
    if (!isPipelineRunActive(pid, runToken)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[pipeline] rerunSingleShot FAIL shotId=${shotId}: ${msg}`, 'pipeline');
    store.setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  } finally {
    popStageContext();
    finishPipelineRun(pid, runToken);
  }
}


function invalidateClips(pid: string, clips: GeneratedClip[], shotIds: Set<string>): void {
  const store = useVideoStore.getState();
  store.setClips(
    pid,
    clips.map((clip) => shotIds.has(clip.shotId)
      ? { ...clip, videoUrl: '', lastFrameImage: undefined, audioTrack: undefined, hasAudio: false }
      : clip),
  );
}

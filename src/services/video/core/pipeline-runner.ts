// pipeline-runner.ts — 14 步流水线编排器
// 输入:SceneSpec + PipelineOptions + callbacks
// 按 options 编排骨分子集。每步失败降级见文档 §10。
//
// 期 1(本次):实装步 3/6/7/9/10/12-14。步 4/8/11(音频链路)留 stub 跳过,期 3 补全。

import { useVideoStore } from '@/stores/videoStore';
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

/**
 * 14 步流水线入口。返回最终 VideoProjectState。
 * 异常不中断整条流水线,只标记单步失败。
 */
export async function runPipeline(args: RunPipelineArgs): Promise<VideoProjectState | null> {
  const { novelProjectId, spec, options, callbacks, videoGen, shouldAbort } = args;
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
    if (shouldAbort?.()) break;

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
      shouldAbort,
      // video_generation 用 preExistingClips 做增量;auido_merge/composing 用累积 clips
      clips: stage === 'video_generation' ? (existingProj?.clips ?? []) : clips,
    });
    if (result) {
      workingSpec = result.spec;
      if (result.clips) clips = result.clips;
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
    case 'character_anchor':
      return proj.anchorImages.some((a) => !!a.imageUrl);
    case 'scene_image':
      return (proj.sceneSpec?.scenes ?? []).some((s) => !!s.backgroundImage);
    case 'keyframe_image':
      return (proj.sceneSpec?.shots ?? []).some((s) => !!s.keyframeImage);
    case 'video_generation':
      // 完整性的判据:每个 shot 都有对应 clip 且 videoUrl 非空
      return (
        proj.shots.length > 0 &&
        proj.clips.length >= proj.shots.length &&
        proj.clips.every((c) => !!c.videoUrl)
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
  const proj = store.getProject(pid);
  if (!proj || !proj.sceneSpec) return null;
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

  let allOk = true;
  for (let i = startIdx; i < RUNTIME_STAGE_ORDER.length; i++) {
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
      // 单步失败不中断,继续跑后续(handler 内部已标 error)
    }
  }

  store.setSceneSpec(pid, workingSpec);
  return allOk;
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
  const { providerRouter } = await import('@/services/providers');
  const { pushStageContext, popStageContext } = await import('@/services/providers/invocation-context');

  pushStageContext({ novelProjectId: pid, stage });

  try {
    const is916 = proj.spec.aspectRatio === '9:16';
    const is11 = proj.spec.aspectRatio === '1:1';
    const w = is916 ? 1080 : is11 ? 1080 : 1920;
    const h = is916 ? 1920 : is11 ? 1080 : 1080;

    const response = await providerRouter.generateVideo({
      taskType: 'clip',
      prompt: shot.videoPrompt || shot.sourceText || 'Cinematic video shot',
      referenceImages: shot.keyframeImage ? [shot.keyframeImage] : undefined,
      width: w,
      height: h,
      durationSeconds: (shot.durationSeconds as 5 | 10) || 5,
      fps: proj.spec.fps || 24,
    });

    const clip: GeneratedClip = {
      shotId: shot.id,
      videoUrl: response.videoData,
      durationSeconds: (shot.durationSeconds as 5 | 10) || 5,
      provider: response.provider,
      model: response.model,
      hasAudio: false,
      generatedAt: new Date().toISOString(),
      sceneSource: 'direct',
      directProjectId: pid,
    };

    store.addClip(pid, clip);
    store.setStageStatus(pid, stage, 'completed');
    void logger.info(`[pipeline] rerunSingleShot SUCCESS shotId=${shotId} provider=${response.provider}`, 'pipeline');
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


// stage-handlers.ts — 把 runPipeline 里的每个 stage 执行块抽成独立函数。
//
// 目的:支持单步重跑(runSingleStage)和从某步重跑(runFromStage)。
// 每个 handler 接收 StageContext,返回更新后的 workingSpec(+ 可选 clips),
// 内部逻辑和原 runPipeline 完全一致,只是换了载体。
//
// 注意:handler 不负责「是否跳过」的决策(isStageLiveCompleted 检查)——
// 那个决策留在 runPipeline / runSingleStage 主体,handler 只管「真正跑这一步」。

import { useVideoStore } from '@/stores/videoStore';
import { logger } from '@/services/log';
import { providerRouter } from '@/services/providers';
import { pushStageContext } from '@/services/providers/invocation-context';
import type {
  SceneSpec,
  PipelineOptions,
  VideoStage,
  ShotSpec,
  StoryboardShot,
  GeneratedClip,
  StageInput,
} from '@/types/video';
import type { PipelineCallbacks } from './types';
import { stepVoice } from './step-voice';
import { runCharacterAnchor } from './step-character-anchor';
import { runSceneImage } from './step-scene-image';
import { runTTS } from './step-tts';
import { runKeyframe } from './step-keyframe';
import { runVideoGen, type VideoGenOptions } from './step-video-gen';
import { describeAudioMergeFailure, runAudioMerge } from './step-audio-merge';
import { runCompose } from './step-compose';
import { sliceChaptersWithLLM, type RawShot } from '../chapter-slicer';
import { buildStoryboard, type StoryboardContext } from '../storyboard-prompt';
import { detectInputLanguage } from './lang-detector';
import { stepExtract } from './step-extract';
import { parseStructuredPromptShots } from '../direct-scene-builder';
import { useProjectStore } from '@/stores/projectStore';
import { applySeriesProjectLibrary } from '../series-character-library';
import { isAssetAvailable, isValidVideoClip } from '../asset-store';
import { evaluateVideoClipQuality } from './video-quality-gate';
import { evaluateVideoClipVisually } from './visual-quality-review';
import { makeAutomaticClips, makeAutomaticKeyframes } from './automatic-shot-production';
import { toWebviewUrl } from '../asset-store';
import { orderClipsByShots } from './clip-order';
import { resolveTemporalAuthority, shotsShareScene, shotsShareSubjects } from './shot-continuity';
import { updateShotGenerationPlan } from './shot-generation-plan';
import { getCandidateSeed } from './shot-continuity';
import { resolveAssemblyQualityRequirements, resolveVideoQualityPolicy } from './quality-policy';
import { getAssemblyBlockers } from './shot-production-contract';
import { assertShotPlanContract } from './shot-plan-contract';

/** Stage 执行上下文。handler 从这里读输入,通过 store action 写输出。 */
export interface StageContext {
  pid: string;
  workingSpec: SceneSpec;
  options: PipelineOptions;
  videoGen: VideoGenOptions;
  callbacks?: PipelineCallbacks;
  shouldAbort?: () => boolean;
  signal?: AbortSignal;
  automatic?: boolean;
  /** False when another run for the same project has taken ownership. */
  isCurrentRun?: () => boolean;
  /** 累积的 clips(video_generation 产出,audio_merge/composing 消费)。
   *  放在 ctx 里而不是从 store 读,是为了让单步重跑时能传入任意初始 clips。 */
  clips: GeneratedClip[];
}

/** handler 返回值:更新后的 spec + clips(如果有变化)。null = 执行失败。 */
export interface StageResult {
  spec: SceneSpec;
  clips?: GeneratedClip[];
}

function addGeneratedShotVersion(
  shot: ShotSpec,
  version: NonNullable<ShotSpec['versionHistory']>[number],
): ShotSpec {
  const history = shot.versionHistory ?? [];
  if (history.some((candidate) => candidate.id === version.id)) return shot;
  return {
    ...shot,
    versionHistory: [version, ...history],
    selectedVersionId: version.id,
    lockedVersionId: undefined,
  };
}

// --- 共用 helper(从 pipeline-runner 搬过来,避免循环依赖) ---

async function withStageContext<T>(
  ctx: StageContext,
  stage: VideoStage,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseContext = pushStageContext({
    novelProjectId: ctx.pid,
    stage,
    signal: ctx.signal,
    onVideoQueueRetry: stage === 'video_generation' ? (queueRetry) => {
      const store = useVideoStore.getState();
      if (isStageRunActive(ctx) && store.projects[ctx.pid]?.stages[stage]?.status === 'running') {
        store.setStageStatus(ctx.pid, stage, 'running', { queueRetry });
      }
    } : undefined,
  });
  try {
    return await fn();
  } finally {
    releaseContext();
  }
}

async function safeRunStage<T>(
  pid: string,
  stage: VideoStage,
  fn: () => Promise<T>,
  isCurrentRun?: () => boolean,
): Promise<T | null> {
  void logger.info(`[pipeline] ${stage} enter`, 'pipeline');
  const t0 = performance.now();
  try {
    const r = await fn();
    if (isCurrentRun && !isCurrentRun()) {
      void logger.info(`[pipeline] ${stage} result discarded because a newer run owns pid=${pid}`, 'pipeline');
      return null;
    }
    void logger.info(`[pipeline] ${stage} ok (${Math.round(performance.now() - t0)}ms)`, 'pipeline');
    return r;
  } catch (err) {
    if (isCurrentRun && !isCurrentRun()) return null;
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[pipeline] ${stage} FAIL (${Math.round(performance.now() - t0)}ms): ${msg}`, 'pipeline');
    useVideoStore.getState().setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  }
}

function isStageRunActive(ctx: StageContext): boolean {
  return !ctx.isCurrentRun || ctx.isCurrentRun();
}

/**
 * 把「这次 stage 实际会用的参数」回填进 stage.input,让 UI 显示当前值而非空表单。
 *
 * 策略:只填用户还没改过的字段(避免覆盖用户编辑)。已存在的值不动。
 * 抽取来源:
 *  - prompt 类:对 character_anchor/scene_image/keyframe_image/video_generation,
 *    按第一镜/第一个对象拼一个代表 prompt(和 step 内部 build 逻辑保持一致),
 *    用户改这个值 → 重跑时覆盖所有 shots 的对应字段(applyStageInput 做)
 *  - style:从 workingSpec.meta.style(step 用它做样式兜底)
 *  - resolution/fps:从 project.spec
 *  - durationSeconds:从 shots[0].durationSeconds
 *  - seed:从第一镜头读取默认值;重跑时作为每个镜头的可复现基准派生
 */
export function populateStageInput(pid: string, stage: VideoStage, workingSpec: SceneSpec): void {
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj) return;
  const existing = proj.stages[stage]?.input ?? {};
  const patch: Partial<StageInput> = {};

  const firstShot = workingSpec.shots[0];
  const style = workingSpec.meta.style;

  switch (stage) {
    case 'storyboard_prompt':
      if (existing.prompt === undefined && firstShot?.sourceText) {
        patch.prompt = firstShot.sourceText;
      }
      break;
    case 'character_anchor':
      // 风格:有就显示真实值,没有显示兜底值(让用户看到 step 实际会用的值)
      if (existing.style === undefined && style) {
        patch.style = style;
      }
      // anchorMode 默认 turnaround(同时生成高清单图立绘 + 角色三视图，保证全角度一致性)
      if (existing.anchorMode === undefined) {
        patch.anchorMode = 'turnaround';
      }
      // prompt 只控制单图立绘(三视图是附加产物,内部用固定 prompt 不暴露给用户改)
      break;
    case 'scene_image':
      if (existing.style === undefined && style) {
        patch.style = style;
      }
      break;
    case 'keyframe_image':
      if (existing.style === undefined && style) {
        patch.style = style;
      }
      if (existing.prompt === undefined && firstShot) {
        patch.prompt = firstShot.videoPrompt || firstShot.narration || '';
      }
      if (existing.seed === undefined) {
        const seed = firstShot?.seed;
        if (seed !== undefined) patch.seed = seed;
      }
      break;
    case 'video_generation':
      if (existing.prompt === undefined && firstShot) {
        patch.prompt = firstShot.videoPrompt || firstShot.narration || '';
      }
      if (existing.resolution === undefined) {
        patch.resolution = proj.spec.resolution;
      }
      if (existing.fps === undefined) {
        patch.fps = proj.spec.fps;
      }
      if (existing.durationSeconds === undefined && firstShot?.durationSeconds) {
        patch.durationSeconds = firstShot.durationSeconds;
      }
      if (existing.seed === undefined) {
        const seed = firstShot?.seed;
        if (seed !== undefined) patch.seed = seed;
      }
      break;
  }

  if (Object.keys(patch).length > 0) {
    store.setStageInput(pid, stage, patch);
  }
}

/**
 * 把用户改过的 stage.input 应用到 workingSpec / videoGen,让重跑真正生效。
 * 导出给 pipeline-runner 的 runSingleStage / runFromStage 用。
 *
 * 应用规则:
 *  - prompt(keyframe/video_generation)→ 写回所有 shots 的 videoPrompt
 *    (单步重跑时用户改的是「这一步用的 prompt」,对所有 shot 生效)
 *  - prompt(storyboard)→ 写回 shots 的 sourceText
 *  - style → workingSpec.meta.style
 *  - resolution/fps → videoGen.spec(影响 video_generation)
 *  - durationSeconds → shots[].durationSeconds
 *
 * 返回新的 ctx(workingSpec / videoGen 可能被替换)。
 */
export function applyStageInput(ctx: StageContext, stage: VideoStage): StageContext {
  const store = useVideoStore.getState();
  const proj = store.getProject(ctx.pid);
  if (!proj) return ctx;
  const input = proj.stages[stage]?.input;
  if (!input) return ctx;

  let { workingSpec, videoGen } = ctx;
  let specChanged = false;
  let genChanged = false;

  if (input.prompt !== undefined) {
    if (stage === 'storyboard_prompt') {
      if (workingSpec.shots.length <= 1) {
        workingSpec = {
          ...workingSpec,
          shots: workingSpec.shots.map((s) => ({ ...s, sourceText: input.prompt! })),
        };
        specChanged = true;
      }
    } else if (stage === 'keyframe_image' || stage === 'video_generation') {
      if (workingSpec.shots.length <= 1) {
        workingSpec = {
          ...workingSpec,
          shots: workingSpec.shots.map((s) => ({ ...s, videoPrompt: input.prompt! })),
        };
        specChanged = true;
      }
    }
  }

  if (input.style !== undefined && (stage === 'character_anchor' || stage === 'scene_image')) {
    workingSpec = {
      ...workingSpec,
      meta: { ...workingSpec.meta, style: input.style! },
    };
    specChanged = true;
  }

  if (input.durationSeconds !== undefined && stage === 'video_generation') {
    const dur = input.durationSeconds as ShotSpec['durationSeconds'];
    workingSpec = {
      ...workingSpec,
      shots: workingSpec.shots.map((s) => ({ ...s, durationSeconds: dur })),
    };
    specChanged = true;
  }

  if (
    Object.prototype.hasOwnProperty.call(input, 'seed')
    && (stage === 'keyframe_image' || stage === 'video_generation')
  ) {
    videoGen = { ...videoGen, seed: input.seed };
    genChanged = true;
  }

  if (stage === 'video_generation') {
    const newSpec = { ...videoGen.spec };
    let changed = false;
    if (input.resolution !== undefined) {
      newSpec.resolution = input.resolution;
      changed = true;
    }
    if (input.fps !== undefined) {
      newSpec.fps = input.fps;
      changed = true;
    }
    if (changed) {
      videoGen = { ...videoGen, spec: newSpec };
      genChanged = true;
    }
  }

  if (!specChanged && !genChanged) return ctx;
  return { ...ctx, workingSpec, videoGen };
}

// --- 8 个 stage handler ---

/** 步:角色立绘(character_anchor) */
export async function executeCharacterAnchor(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, videoGen, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('character_anchor');
  store.advanceToStage(pid, 'character_anchor');
  store.setStageStatus(pid, 'character_anchor', 'running');
  populateStageInput(pid, 'character_anchor', workingSpec);
  store.setStageInputSummary(pid, 'character_anchor', {
    headline: `${workingSpec.characters!.length} 个角色,limit=${options.characterAnchorLimit}`,
    details: workingSpec.characters!.slice(0, 10).map((c) => `${c.name} · ${c.appearance.slice(0, 40)}`),
  });

  const anchorChars = workingSpec.characters!;
  const uncovered = anchorChars
    .slice(Math.max(0, options.characterAnchorLimit))
    .filter((character) => !character.portraitImage && !character.turnaroundImage);
  if (uncovered.length > 0) {
    const msg = `角色锚点上限为 ${options.characterAnchorLimit}，以下角色没有参考图：${uncovered.map((character) => character.name).join('、')}。请提高上限或先补齐角色立绘。`;
    store.setStageStatus(pid, 'character_anchor', 'error', { error: msg, progress: 0 });
    callbacks?.onError?.(msg);
    return null;
  }
  // 读用户在 UI 里改过的 anchorMode / characterPrompts(单步重跑用)
  const proj0 = useVideoStore.getState().getProject(pid);
  const anchorInput = proj0?.stages['character_anchor']?.input;
  const anchorMode = anchorInput?.anchorMode ?? 'turnaround';
  const characterPrompts = (anchorInput as any)?.characterPrompts as Record<string, string> | undefined;
  const turnaroundPrompts = (anchorInput as any)?.turnaroundPrompts as Record<string, string> | undefined;

  const result = await safeRunStage(pid, 'character_anchor', () =>
    withStageContext(ctx, 'character_anchor', () =>
      runCharacterAnchor(
        anchorChars,
        {
          style: workingSpec.meta.style,
          imageTier: 'value',
          limit: options.characterAnchorLimit,
          imageEndpointId: videoGen.imageEndpointId,
          imageModel: videoGen.imageModel,
          novelProjectId: pid,
          anchorMode,
          characterPrompts,
          turnaroundPrompts,
          shouldAbort: ctx.shouldAbort,
          signal: ctx.signal,
        },
        (done, total) => {
          if (!isStageRunActive(ctx)) return;
          store.setStageStatus(pid, 'character_anchor', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('character_anchor', done / total);
        },
      ),
    ),
    ctx.isCurrentRun,
  );
  if (!result || !isStageRunActive(ctx)) return null;
  const spec = { ...workingSpec, characters: result.characters };
  store.setSceneSpec(pid, spec);
  if (result.failed.length > 0) {
    const msg = `角色参考图生成失败：${result.failed.join('、')}。已保留成功结果，请重试当前步骤。`;
    store.setStageStatus(pid, 'character_anchor', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
  store.setStageStatus(pid, 'character_anchor', 'completed', { progress: 1 });
  return { spec };
}

/** 步:分配音色(voice_assignment) */
export async function executeVoiceAssignment(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('voice_assignment');
  store.advanceToStage(pid, 'voice_assignment');
  store.setStageStatus(pid, 'voice_assignment', 'running');
  const voiceChars = workingSpec.characters!;
  store.setStageInputSummary(pid, 'voice_assignment', {
    headline: `${voiceChars.length} 个角色待分配音色`,
  });

  const voiceResult = await safeRunStage(pid, 'voice_assignment', () =>
    withStageContext(ctx, 'voice_assignment', () => stepVoice(voiceChars)),
    ctx.isCurrentRun,
  );
  if (!voiceResult || !isStageRunActive(ctx)) return null;
  const spec = { ...workingSpec, characters: voiceResult.characters };
  store.setSceneSpec(pid, spec);
  store.setStageStatus(pid, 'voice_assignment', 'completed', { progress: 1 });
  return { spec };
}

/** 步:场景图(scene_image) */
export async function executeSceneImage(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, videoGen, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('scene_image');
  store.advanceToStage(pid, 'scene_image');
  store.setStageStatus(pid, 'scene_image', 'running');
  populateStageInput(pid, 'scene_image', workingSpec);
  store.setStageInputSummary(pid, 'scene_image', {
    headline: `${workingSpec.scenes!.length} 个场景`,
    details: workingSpec.scenes!.slice(0, 10).map((s) => `${s.name} · ${s.description.slice(0, 40)}`),
  });

  const result = await safeRunStage(pid, 'scene_image', () =>
    withStageContext(ctx, 'scene_image', () =>
      runSceneImage(
        workingSpec.scenes!,
        {
          aspectRatio: workingSpec.meta.aspectRatio,
          style: workingSpec.meta.style,
          imageTier: 'value',
          imageEndpointId: videoGen.imageEndpointId,
          imageModel: videoGen.imageModel,
          novelProjectId: pid,
          characters: workingSpec.characters,
          shouldAbort: ctx.shouldAbort,
          signal: ctx.signal,
        },
        (done, total) => {
          if (!isStageRunActive(ctx)) return;
          store.setStageStatus(pid, 'scene_image', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('scene_image', done / total);
        },
      ),
    ),
    ctx.isCurrentRun,
  );
  if (!result || !isStageRunActive(ctx)) return null;
  const spec = { ...workingSpec, scenes: result.scenes };
  store.setSceneSpec(pid, spec);
  if (result.failed.length > 0) {
    const msg = `场景图生成失败：${result.failed.join('、')}。已保留成功结果，请重试当前步骤。`;
    store.setStageStatus(pid, 'scene_image', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
  store.setStageStatus(pid, 'scene_image', 'completed', { progress: 1 });
  return { spec };
}

/** 步:TTS */
export async function executeTTS(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('tts');
  store.advanceToStage(pid, 'tts');
  store.setStageStatus(pid, 'tts', 'running');
  populateStageInput(pid, 'tts', workingSpec);
  const getShotSpeechText = (s: ShotSpec) => {
    const dialogueStr = s.dialogue?.map((d) => d.text).join(' ');
    return (s.narration || dialogueStr || s.sourceText || s.videoPrompt)?.trim();
  };

  const narrationShots = workingSpec.shots.filter((s) => getShotSpeechText(s));
  store.setStageInputSummary(pid, 'tts', {
    headline: `${narrationShots.length} 个镜头带有配音台词/文本`,
    details: narrationShots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${(getShotSpeechText(s) ?? '').slice(0, 40)}`),
  });

  const stageInput = store.getProject(pid)?.stages.tts?.input;
  const customModel = stageInput?.model as string | undefined;

  const ttsResult = await safeRunStage(pid, 'tts', () =>
    withStageContext(ctx, 'tts', () =>
      runTTS(
        workingSpec.shots,
        workingSpec.characters ?? [],
        { ttsTier: 'free', novelProjectId: pid, model: customModel, shouldAbort: ctx.shouldAbort, signal: ctx.signal },
        (done, total) => {
          if (!isStageRunActive(ctx)) return;
          store.setStageStatus(pid, 'tts', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('tts', done / total);
        },
      ),
    ),
    ctx.isCurrentRun,
  );
  if (!ttsResult || !isStageRunActive(ctx)) return null;
  const spec = { ...workingSpec, shots: ttsResult.shots };
  store.setSceneSpec(pid, spec);
  const attempted = narrationShots.length;
  const failed = ttsResult.failedShotIds.length;
  const ok = attempted - failed;
  if (failed > 0) {
    const failedShots = ttsResult.failedShotIds
      .map((id) => spec.shots.find((s) => s.id === id))
      .filter((s): s is ShotSpec => !!s);
    const details = failedShots
      .slice(0, 5)
      .map((s) => `镜头 ${s.index + 1}: ${(s.narration ?? '').slice(0, 30)}`)
      .join('; ');
    const msg = `部分 TTS 失败：${ok}/${attempted} 成功，${failed} 个镜头未生成音频。涉及：${details}`;
    store.setStageStatus(pid, 'tts', 'error', { progress: 1, error: msg });
    callbacks?.onError?.(msg);
    return null;
  } else {
    store.setStageStatus(pid, 'tts', 'completed', { progress: 1 });
  }
  return { spec };
}

/** 步:关键帧(keyframe_image) */
async function executeKeyframePass(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, videoGen, callbacks } = ctx;
  const store = useVideoStore.getState();
  if (options.enableCharacterAnchor && (workingSpec.characters?.length ?? 0) > 0) {
    try {
      assertShotPlanContract(workingSpec.shots, {
        characters: workingSpec.characters,
        scenes: workingSpec.scenes,
        requireAssetBindings: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setStageStatus(pid, 'keyframe_image', 'error', { error: message, progress: 0 });
      callbacks?.onError?.(message);
      return null;
    }
  }
  callbacks?.onStageChange?.('keyframe_image');
  store.advanceToStage(pid, 'keyframe_image');
  store.setStageStatus(pid, 'keyframe_image', 'running');
  populateStageInput(pid, 'keyframe_image', workingSpec);
  store.setStageInputSummary(pid, 'keyframe_image', {
    headline: `${workingSpec.shots.length} 个镜头`,
    details: workingSpec.shots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${(s.videoPrompt || '').slice(0, 40)}`),
  });

  const result = await safeRunStage(pid, 'keyframe_image', () =>
    withStageContext(ctx, 'keyframe_image', () =>
      runKeyframe(
        workingSpec.shots,
        {
          characters: workingSpec.characters ?? [],
          scenes: workingSpec.scenes ?? [],
          aspectRatio: workingSpec.meta.aspectRatio,
          style: workingSpec.meta.style,
          imageTier: 'value',
          imageEndpointId: videoGen.imageEndpointId,
          imageModel: videoGen.imageModel,
          novelProjectId: pid,
          openingReferenceImage: workingSpec.meta.openingReferenceImage,
          requireCharacterReferences: options.enableCharacterAnchor,
          shouldAbort: ctx.shouldAbort,
          signal: ctx.signal,
        },
        (done, total) => {
          if (!isStageRunActive(ctx)) return;
          store.setStageStatus(pid, 'keyframe_image', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('keyframe_image', done / total);
          callbacks?.onShotProgress?.(done, total);
        },
      ),
    ),
    ctx.isCurrentRun,
  );
  if (!result || !isStageRunActive(ctx)) return null;
  const generatedAt = new Date().toISOString();
  const spec = {
    ...workingSpec,
    shots: result.shots.map((shot) => shot.keyframeImage
      ? addGeneratedShotVersion(shot, {
          id: `keyframe_${shot.id}_${Date.now()}_${shot.index}_${shot.seed ?? 'random'}`,
          type: 'image',
          url: shot.keyframeImage,
          createdAt: generatedAt,
          prompt: shot.imagePrompt || shot.videoPrompt,
          model: videoGen.imageModel,
          seed: shot.seed,
          inputFingerprint: shot.keyframeInputFingerprint,
          imageReferenceAssets: shot.referenceAssets,
          imageGenerationContext: shot.keyframeGenerationContext,
          requestSnapshot: shot.generationPlan?.keyframe?.requestSnapshot,
          responseSnapshot: shot.generationPlan?.keyframe?.responseSnapshot,
          generationPlan: shot.generationPlan,
          reviewStatus: 'unreviewed',
        })
      : shot),
  };
  store.setSceneSpec(pid, spec);
  store.setStageStatus(pid, 'keyframe_image', 'completed', { progress: 1 });
  return { spec };
}

/** 步:视频生成(video_generation) */
/**
 * Generate independent still candidates before the human keyframe gate.
 * The pass above remains the single-shot implementation; this wrapper only
 * supplies reproducible candidate seeds and carries each pass's version
 * history forward. No story-specific prompt or subject rule is introduced.
 */
export async function executeKeyframe(ctx: StageContext): Promise<StageResult | null> {
  if (ctx.automatic) return withStageContext(ctx, 'keyframe_image', () => makeAutomaticKeyframes(ctx));
  const candidateCount = resolveVideoQualityPolicy(ctx.options).keyframeCandidatesPerShot;
  const baseShots = ctx.workingSpec.shots;
  let currentContext = ctx;
  let result: StageResult | null = null;

  for (let candidateIndex = 1; candidateIndex <= candidateCount; candidateIndex += 1) {
    const seededSpec: SceneSpec = {
      ...currentContext.workingSpec,
      shots: currentContext.workingSpec.shots.map((shot) => {
        const baseShot = baseShots.find((candidate) => candidate.id === shot.id) ?? shot;
        return {
          ...shot,
          seed: getCandidateSeed(baseShot, baseShot.seed, candidateIndex),
        };
      }),
    };
    const resultContext = await executeKeyframePass({
      ...currentContext,
      workingSpec: seededSpec,
      callbacks: currentContext.callbacks
        ? {
            ...currentContext.callbacks,
            onStageProgress: (stage, progress) => currentContext.callbacks?.onStageProgress?.(
              stage,
              ((candidateIndex - 1) + progress) / candidateCount,
            ),
          }
        : undefined,
    });
    if (!resultContext || !isStageRunActive(ctx)) return null;
    result = resultContext;
    currentContext = { ...currentContext, workingSpec: resultContext.spec };
  }

  return result;
}

async function executeVideoGenPass(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, videoGen, callbacks, shouldAbort, clips: preExistingClips } = ctx;
  const store = useVideoStore.getState();
  const qualityPolicy = resolveVideoQualityPolicy(options);
  if (options.enableCharacterAnchor && (workingSpec.characters?.length ?? 0) > 0) {
    try {
      assertShotPlanContract(workingSpec.shots, {
        characters: workingSpec.characters,
        scenes: workingSpec.scenes,
        requireAssetBindings: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setStageStatus(pid, 'video_generation', 'error', { error: message, progress: 0 });
      callbacks?.onError?.(message);
      return null;
    }
  }
  callbacks?.onStageChange?.('video_generation');
  store.advanceToStage(pid, 'video_generation');
  store.setStageStatus(pid, 'video_generation', 'running');
  populateStageInput(pid, 'video_generation', workingSpec);
  const alreadyDoneCount = preExistingClips.filter((c) => isValidVideoClip(c)).length;
  if (alreadyDoneCount > 0) {
    void logger.info(
      `[pipeline] video_generation: 增量续跑 ${alreadyDoneCount}/${workingSpec.shots.length} 已有`,
      'pipeline',
    );
  }
  store.setStageInputSummary(pid, 'video_generation', {
    headline: `${workingSpec.shots.length} 个镜头 · ${options.enableI2V ? 'I2V' : 'T2V'} 模式${
      alreadyDoneCount > 0 ? ` · 已有 ${alreadyDoneCount} 个,仅重跑剩余` : ''
    }`,
    details: workingSpec.shots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${s.durationSeconds}s`),
  });

  const continuityShotUpdates = new Map<string, ShotSpec>();

  const result = await safeRunStage(pid, 'video_generation', () =>
    withStageContext(ctx, 'video_generation', () =>
      runVideoGen(
        workingSpec.shots,
        {
          ...videoGen,
          signal: ctx.signal,
          novelProjectId: pid,
          characters: workingSpec.characters ?? videoGen.characters,
          scenes: workingSpec.scenes ?? videoGen.scenes,
          imageStyle: workingSpec.meta.style ?? videoGen.imageStyle,
          allShots: workingSpec.shots,
          requireKeyframeForI2V: options.enableI2V && options.enableKeyframe,
          requireContinuityHandoff: options.enableI2V && options.enableKeyframe,
          temporalAuthority: qualityPolicy.continuityMode,
          // The approved keyframe remains the reviewed composition target.
          // Matching shots may additionally use the actual previous tail as
          // the temporal handoff when the selected quality policy allows it.
          continuityKeyframeMode: 'off',
        },
        options.enableI2V,
        (done, total) => {
          if (!isStageRunActive(ctx)) return;
          const totalDone = done;
          const totalAll = Math.max(total, 1);
          store.setStageStatus(pid, 'video_generation', 'running', {
            progress: totalDone / totalAll,
          });
          callbacks?.onStageProgress?.('video_generation', totalDone / totalAll);
          callbacks?.onShotProgress?.(totalDone, totalAll);
        },
        shouldAbort,
        (clip) => {
          if (isStageRunActive(ctx)) store.addClip(pid, clip);
        },
        preExistingClips,
        (updatedShot) => {
          if (!isStageRunActive(ctx)) return;
          const generatedAt = new Date().toISOString();
          const persistedShot = addGeneratedShotVersion(updatedShot, {
            id: `keyframe_${updatedShot.id}_${Date.now()}_${updatedShot.index}_${updatedShot.seed ?? 'random'}`,
            type: 'image',
            url: updatedShot.keyframeImage ?? '',
            createdAt: generatedAt,
            prompt: updatedShot.imagePrompt || updatedShot.videoPrompt,
            model: updatedShot.keyframeGenerationContext?.model,
            seed: updatedShot.keyframeGenerationContext?.seed,
            inputFingerprint: updatedShot.keyframeInputFingerprint,
            imageReferenceAssets: updatedShot.referenceAssets,
            imageGenerationContext: updatedShot.keyframeGenerationContext,
            requestSnapshot: updatedShot.generationPlan?.keyframe?.requestSnapshot,
            responseSnapshot: updatedShot.generationPlan?.keyframe?.responseSnapshot,
            generationPlan: updatedShot.generationPlan,
            reviewStatus: 'unreviewed',
          });
          continuityShotUpdates.set(updatedShot.id, persistedShot);
          const liveSpec = useVideoStore.getState().getProject(pid)?.sceneSpec ?? workingSpec;
          store.setSceneSpec(pid, {
            ...liveSpec,
            shots: liveSpec.shots.map((shot) => shot.id === persistedShot.id ? persistedShot : shot),
          });
        },
      ),
    ),
    ctx.isCurrentRun,
  );
  if (!result || !isStageRunActive(ctx)) return null;
  const productionSpec: SceneSpec = {
    ...workingSpec,
    shots: workingSpec.shots.map((shot) => continuityShotUpdates.get(shot.id) ?? shot),
  };
  const generatedClipsWithQuality = await Promise.all(result.clips.map(async (clip) => {
    const shot = productionSpec.shots.find((candidate) => candidate.id === clip.shotId);
    if (!shot) return clip;
    const previousShot = productionSpec.shots[shot.index - 1];
    const nextShot = productionSpec.shots[shot.index + 1];
    const previousClip = result.clips.find((candidate) => candidate.shotId === previousShot?.id);
    const expectedTemporalAuthority = options.enableI2V && options.enableKeyframe
      ? resolveTemporalAuthority(qualityPolicy.continuityMode, previousShot, shot, previousClip)
      : undefined;
    const visualReview = qualityPolicy.visualReviewRequired
      ? await evaluateVideoClipVisually(shot, clip, {
          projectId: pid,
          characters: productionSpec.characters,
          scenes: productionSpec.scenes,
          signal: ctx.signal,
        })
      : undefined;
    return {
      ...clip,
      qualityReview: evaluateVideoClipQuality(shot, clip, {
        assetAvailable: await isAssetAvailable(clip.videoUrl),
        requireI2V: options.enableI2V,
        requiredControlMode: options.enableI2V && options.enableKeyframe ? 'keyframe' : undefined,
        requiredTemporalAuthority: expectedTemporalAuthority,
        requirePreviousTail: expectedTemporalAuthority === 'previous_tail',
        requireTailFrame: !!nextShot && shotsShareScene(shot, nextShot) && shotsShareSubjects(shot, nextShot),
      }),
      ...(visualReview ? { visualReview } : {}),
    };
  }));
  if (!isStageRunActive(ctx)) return null;
  // runVideoGen returns the complete current candidate set, including clips
  // reused during a partial retry. Keeping that set together prevents a
  // successful clip from disappearing from version history on the next run.
  const clips = orderClipsByShots(generatedClipsWithQuality, productionSpec.shots);
  const generatedAt = new Date().toISOString();
  const generatedClipByShot = new Map(generatedClipsWithQuality.map((clip) => [clip.shotId, clip]));
  const versionIdByShot = new Map<string, string>();
  const spec = {
    ...productionSpec,
    shots: productionSpec.shots.map((shot) => {
      const clip = generatedClipByShot.get(shot.id);
      if (!clip?.videoUrl) return shot;
      const existingVersion = shot.versionHistory?.find((version) => (
        version.type === 'video'
          && version.url === clip.videoUrl
          && (
            version.id === clip.shotVersionId
            || !clip.inputFingerprint
            || !version.inputFingerprint
            || version.inputFingerprint === clip.inputFingerprint
          )
      ));
      const persistedClipVersion = clip.shotVersionId
        && shot.versionHistory?.some((version) => version.id === clip.shotVersionId && version.url === clip.videoUrl)
        ? clip.shotVersionId
        : undefined;
      const versionId = existingVersion?.id
        ?? persistedClipVersion
        ?? `video_${shot.id}_${Date.now()}_${shot.index}_${clip.seed ?? 'random'}`;
      versionIdByShot.set(shot.id, versionId);
      const plannedShot = {
        ...shot,
        generationPlan: updateShotGenerationPlan(shot, {
          video: {
            inputFingerprint: clip.inputFingerprint,
            executionContext: clip.generationContext,
            requestSnapshot: clip.requestSnapshot,
            responseSnapshot: clip.responseSnapshot,
            controlMode: clip.videoControlMode,
            referenceMode: clip.videoReferenceMode,
            references: clip.videoReferenceAssets ?? [],
            outputUrl: clip.videoUrl,
          },
        }),
      };
      return addGeneratedShotVersion(plannedShot, {
        id: versionId,
        type: 'video',
        url: clip.videoUrl,
        createdAt: generatedAt,
        prompt: shot.videoPrompt || shot.sourceText,
        seed: clip.seed,
        provider: clip.provider,
        model: clip.model,
        durationSeconds: clip.durationSeconds,
        inputFingerprint: clip.inputFingerprint,
        generationContext: clip.generationContext,
        requestSnapshot: clip.requestSnapshot,
        responseSnapshot: clip.responseSnapshot,
        videoReferenceAssets: clip.videoReferenceAssets,
        videoReferenceMode: clip.videoReferenceMode,
        videoControlMode: clip.videoControlMode,
        lastFrameImage: clip.lastFrameImage,
        thumbnailUrl: clip.thumbnailUrl,
        hasAudio: clip.hasAudio,
        generationPlan: plannedShot.generationPlan,
        qualityReview: clip.qualityReview,
        visualReview: clip.visualReview,
        reviewStatus: 'unreviewed',
      });
    }),
  };
  const clipsWithVersionIds = clips.map((clip) => {
    const shotVersionId = versionIdByShot.get(clip.shotId);
    return shotVersionId ? { ...clip, shotVersionId } : clip;
  });
  store.setSceneSpec(pid, spec);
  store.setClips(pid, clipsWithVersionIds);
  if (result.failedShotIds.length > 0) {
    const failedIndexes = result.failedShotIds
      .map((shotId) => productionSpec.shots.find((shot) => shot.id === shotId)?.index)
      .filter((index): index is number => index !== undefined)
      .map((index) => index + 1);
    const msg = `部分视频生成失败：${productionSpec.shots.length - result.failedShotIds.length}/${productionSpec.shots.length} 成功，失败镜头：${failedIndexes.join('、')}`;
    store.setStageStatus(pid, 'video_generation', 'error', { progress: clipsWithVersionIds.length / Math.max(1, productionSpec.shots.length), error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
  // A generated clip is a candidate, not an approved assembly input. The
  // pipeline runner keeps the project at this checkpoint until every shot has
  // a human-locked video version.
  store.setStageStatus(pid, 'video_generation', 'awaiting_review', { progress: 1, error: undefined });
  return { spec, clips: clipsWithVersionIds };
}

/** 步:视频技术质检(video_review)。视觉身份评分需由后续多模态 provider 实现。 */
/**
 * Generate independent video candidates from the approved still. Each pass
 * gets a distinct shot seed and the active clip slot is updated to the newest
 * candidate while all versions remain in the shot history for comparison.
 */
export async function executeVideoGen(ctx: StageContext): Promise<StageResult | null> {
  if (ctx.automatic) return withStageContext(ctx, 'video_generation', () => makeAutomaticClips(ctx));
  const candidateCount = resolveVideoQualityPolicy(ctx.options).videoCandidatesPerShot;
  const baseShots = ctx.workingSpec.shots;
  let currentContext = ctx;
  let result: StageResult | null = null;

  for (let candidateIndex = 1; candidateIndex <= candidateCount; candidateIndex += 1) {
    const seededSpec: SceneSpec = {
      ...currentContext.workingSpec,
      shots: currentContext.workingSpec.shots.map((shot) => {
        const baseShot = baseShots.find((candidate) => candidate.id === shot.id) ?? shot;
        return {
          ...shot,
          seed: getCandidateSeed(baseShot, baseShot.seed, candidateIndex),
        };
      }),
    };
    const resultContext = await executeVideoGenPass({
      ...currentContext,
      workingSpec: seededSpec,
      // A multi-candidate pass must not treat the previous pass's active clip
      // as completed work. The pass itself persists every candidate version.
      clips: candidateCount > 1 ? [] : currentContext.clips,
      callbacks: currentContext.callbacks
        ? {
            ...currentContext.callbacks,
            onStageProgress: (stage, progress) => currentContext.callbacks?.onStageProgress?.(
              stage,
              ((candidateIndex - 1) + progress) / candidateCount,
            ),
          }
        : undefined,
    });
    if (!resultContext || !isStageRunActive(ctx)) return null;
    result = resultContext;
    currentContext = {
      ...currentContext,
      workingSpec: resultContext.spec,
      clips: resultContext.clips ?? currentContext.clips,
    };
  }

  return result;
}

export async function executeVideoReview(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, callbacks, clips } = ctx;
  const store = useVideoStore.getState();
  const qualityPolicy = resolveVideoQualityPolicy(options);
  callbacks?.onStageChange?.('video_review');
  store.advanceToStage(pid, 'video_review');
  store.setStageStatus(pid, 'video_review', 'running');

  const availability = new Map(await Promise.all(clips.map(async (clip) => [clip.shotId, await isAssetAvailable(clip.videoUrl)] as const)));
  if (!isStageRunActive(ctx)) return null;
  const reviewedClips = await Promise.all(clips.map(async (clip) => {
    const shot = workingSpec.shots.find((candidate) => candidate.id === clip.shotId);
    if (!shot) return clip;
    const previousShot = workingSpec.shots[shot.index - 1];
    const nextShot = workingSpec.shots[shot.index + 1];
    const previousClip = clips.find((candidate) => candidate.shotId === previousShot?.id);
    const expectedTemporalAuthority = options.enableI2V && options.enableKeyframe
      ? resolveTemporalAuthority(qualityPolicy.continuityMode, previousShot, shot, previousClip)
      : undefined;
    const qualityReview = evaluateVideoClipQuality(shot, clip, {
      assetAvailable: availability.get(clip.shotId) ?? false,
      requireI2V: options.enableI2V,
      requiredControlMode: options.enableI2V && options.enableKeyframe ? 'keyframe' : undefined,
      requiredTemporalAuthority: expectedTemporalAuthority,
      requirePreviousTail: expectedTemporalAuthority === 'previous_tail',
      requireTailFrame: !!nextShot && shotsShareScene(shot, nextShot) && shotsShareSubjects(shot, nextShot),
    });
    const visualReview = ctx.automatic && clip.visualReview
      ? clip.visualReview
      : !qualityPolicy.visualReviewRequired
      ? undefined
      : await evaluateVideoClipVisually(shot, clip, {
          projectId: pid,
          characters: workingSpec.characters,
          scenes: workingSpec.scenes,
          signal: ctx.signal,
        });
    return {
      ...clip,
      qualityReview,
      ...(visualReview ? { visualReview } : {}),
    };
  }));
  if (!isStageRunActive(ctx)) return null;
  store.setClips(pid, reviewedClips);
  const reviewedSpec: SceneSpec = {
    ...workingSpec,
    shots: workingSpec.shots.map((shot) => {
      const clip = reviewedClips.find((candidate) => candidate.shotId === shot.id);
      if (!clip?.shotVersionId) return shot;
      return {
        ...shot,
        versionHistory: shot.versionHistory?.map((version) => version.id === clip.shotVersionId
          ? {
              ...version,
              provider: clip.provider,
              model: clip.model,
              durationSeconds: clip.durationSeconds,
              inputFingerprint: clip.inputFingerprint,
              generationContext: clip.generationContext,
              requestSnapshot: clip.requestSnapshot,
              responseSnapshot: clip.responseSnapshot,
              videoReferenceAssets: clip.videoReferenceAssets,
              videoReferenceMode: clip.videoReferenceMode,
              videoControlMode: clip.videoControlMode,
              lastFrameImage: clip.lastFrameImage,
              thumbnailUrl: clip.thumbnailUrl,
              hasAudio: clip.hasAudio,
              qualityReview: clip.qualityReview,
              visualReview: clip.visualReview,
            }
          : version),
      };
    }),
  };
  // Persist the same quality receipt on the candidate version before any
  // review failure can stop the pipeline. Otherwise the clip and its version
  // would show different quality evidence after a blocked run.
  store.setSceneSpec(pid, reviewedSpec);
  const clipByShot = new Map(reviewedClips.filter((clip) =>
    isValidVideoClip(clip) && availability.get(clip.shotId),
  ).map((clip) => [clip.shotId, clip]));
  const missingShots = workingSpec.shots.filter((shot) => !clipByShot.has(shot.id));
  const t2vShots = options.enableI2V
    ? workingSpec.shots.filter((shot) => {
      const clip = clipByShot.get(shot.id);
      return !!clip && clip.videoReferenceMode !== 'i2v';
    })
    : [];
  const missingReferences = options.enableI2V
    ? workingSpec.shots.filter((shot) => {
      const clip = clipByShot.get(shot.id);
      return !!clip && !(clip.videoReferenceAssets ?? []).some((asset) => asset.sentToProvider !== false);
    })
    : [];
  const qualityFailedShots = reviewedClips
    .filter((clip) => clip.qualityReview?.status === 'failed')
    .map((clip) => workingSpec.shots.find((shot) => shot.id === clip.shotId)?.index)
    .filter((index): index is number => index !== undefined);
  const visualFailedShots = reviewedClips
    .filter((clip) => clip.visualReview?.status === 'failed')
    .map((clip) => workingSpec.shots.find((shot) => shot.id === clip.shotId)?.index)
    .filter((index): index is number => index !== undefined);
  const visualUnavailableShots = qualityPolicy.blockOnVisualReviewUnavailable
    ? reviewedClips
      .filter((clip) => clip.visualReview?.status === 'unavailable')
      .map((clip) => workingSpec.shots.find((shot) => shot.id === clip.shotId)?.index)
      .filter((index): index is number => index !== undefined)
    : [];
  const missingTailFrames = workingSpec.shots.slice(0, -1).filter((shot, index) => {
    const nextShot = workingSpec.shots[index + 1];
    return shotsShareScene(shot, nextShot) && shotsShareSubjects(shot, nextShot) && !clipByShot.get(shot.id)?.lastFrameImage;
  });

  const details = [
    `有效片段 ${clipByShot.size}/${workingSpec.shots.length}`,
    options.enableI2V ? `I2V 片段 ${workingSpec.shots.length - t2vShots.length}/${workingSpec.shots.length}` : 'T2V 模式',
    `尾帧可追溯 ${Math.max(0, workingSpec.shots.length - 1 - missingTailFrames.length)}/${Math.max(0, workingSpec.shots.length - 1)}`,
  ];
  store.setStageInputSummary(pid, 'video_review', {
    ...(ctx.automatic ? {
      automaticReviewMode: reviewedClips.every((clip) => clip.visualReview?.status === 'passed') ? 'visual' : 'technical',
    } : {}),
    headline: missingShots.length || t2vShots.length || missingReferences.length || qualityFailedShots.length || visualFailedShots.length || visualUnavailableShots.length
      ? '视频技术质检未通过'
      : '视频技术质检通过',
    details,
  });

  const blockingIssues = [
    missingShots.length ? `缺少镜头：${missingShots.map((shot) => shot.index + 1).join('、')}` : '',
    t2vShots.length ? `未使用 I2V：${t2vShots.map((shot) => shot.index + 1).join('、')}` : '',
    missingReferences.length ? `无视频参考来源：${missingReferences.map((shot) => shot.index + 1).join('、')}` : '',
    qualityFailedShots.length ? `质量门禁失败：${qualityFailedShots.map((index) => index + 1).join('、')}` : '',
    visualFailedShots.length ? `视觉一致性失败：${visualFailedShots.map((index) => index + 1).join('、')}` : '',
    visualUnavailableShots.length ? `visual review unavailable: ${visualUnavailableShots.map((index) => index + 1).join(', ')}` : '',
  ].filter(Boolean);

  if (blockingIssues.length > 0) {
    const msg = blockingIssues.join('；');
    store.setStageStatus(pid, 'video_review', 'error', { error: msg, progress: 1 });
    callbacks?.onError?.(msg);
    return null;
  }

  store.setStageStatus(pid, 'video_review', 'completed', { progress: 1 });
  return { spec: reviewedSpec, clips: reviewedClips };
}

/** 步:音视合并(audio_merge) */
export async function executeAudioMerge(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks, clips } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('audio_merge');
  store.advanceToStage(pid, 'audio_merge');
  store.setStageStatus(pid, 'audio_merge', 'running');
  const mergeShots = workingSpec.shots.filter((s) => s.audioTrack);
  store.setStageInputSummary(pid, 'audio_merge', {
    headline: `${mergeShots.length} 个镜头需合并音轨`,
  });

  const mergeResult = await safeRunStage(pid, 'audio_merge', () =>
    runAudioMerge(
      workingSpec.shots,
      { novelProjectId: pid, clips, signal: ctx.signal },
      (done, total) => {
        if (!isStageRunActive(ctx)) return;
        store.setStageStatus(pid, 'audio_merge', 'running', { progress: done / total });
        callbacks?.onStageProgress?.('audio_merge', done / total);
      },
    ),
    ctx.isCurrentRun,
  );
  if (!mergeResult || !isStageRunActive(ctx)) return null;
  store.setClips(pid, mergeResult.clips);
  if (mergeResult.failedShotIds.length > 0) {
    const error = describeAudioMergeFailure(workingSpec.shots, mergeResult.failedShotIds);
    store.setStageStatus(pid, 'audio_merge', 'error', { error });
    callbacks?.onError?.(error);
    return null;
  }
  store.setStageStatus(pid, 'audio_merge', 'completed', { progress: 1 });
  return { spec: workingSpec, clips: mergeResult.clips };
}

/** 步:拼接合成(composing) */
export async function executeCompose(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, callbacks, clips } = ctx;
  const store = useVideoStore.getState();
  const qualityPolicy = resolveVideoQualityPolicy(options);
  callbacks?.onStageChange?.('composing');
  store.advanceToStage(pid, 'composing');
  store.setStageStatus(pid, 'composing', 'running');

  try {
    const assemblyBlockers = getAssemblyBlockers(workingSpec.shots, clips, {
      visualReviewRequired: qualityPolicy.visualReviewRequired,
      blockOnVisualReviewUnavailable: qualityPolicy.blockOnVisualReviewUnavailable,
    });
    if (assemblyBlockers.length > 0) {
      const message = `Assembly blocked: ${assemblyBlockers.map(({ shot, reason }) => `shot ${shot.index + 1} (${reason})`).join(', ')}`;
      store.setStageStatus(pid, 'composing', 'error', { error: message, progress: 0 });
      callbacks?.onError?.(message);
      return null;
    }
    const result = await runCompose({
      novelProjectId: pid,
      clips,
      shots: workingSpec.shots,
      hardcodeSubtitles: options.enableSubtitles,
      style: workingSpec.meta.style,
      timelineState: store.getProject(pid)?.timelineState,
      assemblyRequirements: resolveAssemblyQualityRequirements(options),
      signal: ctx.signal,
    });
    if (!isStageRunActive(ctx)) return null;
    store.setFinalVideo(pid, toWebviewUrl(result.finalVideoUrl), {
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
    });
    store.setStageStatus(pid, 'composing', 'completed', { progress: 1 });
    return { spec: workingSpec };
  } catch (err) {
    if (!isStageRunActive(ctx)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    store.setStageStatus(pid, 'composing', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
}

/** 步 1: 剧本切片 (script_slicing) */
export async function executeScriptSlicing(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('script_slicing');
  store.advanceToStage(pid, 'script_slicing');
  store.setStageStatus(pid, 'script_slicing', 'running');

  try {
    const pStore = useProjectStore.getState();
    const globalProj = pStore.projects.find((p) => p.id === pid);
    const meta = globalProj?.metadata as any;

    // 1. 获取真实的章节正文或剧本文本
    let rawText = '';
    const chapters = meta?.chapters || [];
    if (chapters.length > 0) {
      rawText = chapters.map((c: any) => c.content || '').join('\n\n');
    } else if (meta?.scriptText) {
      rawText = meta.scriptText;
    } else if (globalProj?.description) {
      rawText = globalProj.description;
    } else if (workingSpec.shots && workingSpec.shots.length > 0) {
      rawText = workingSpec.shots.map((s) => s.sourceText || s.videoPrompt || s.narration || '').filter(Boolean).join('\n\n');
    }

    if (!rawText.trim()) {
      throw new Error('没有可用于分镜切片的源文本');
    }

    // 检查分镜是否被污染为全部一模一样的内容
    const areShotsIdentical = (shots: any[] | undefined) => {
      if (!shots || shots.length <= 1) return false;
      const first = (shots[0].videoPrompt || shots[0].sourceText || '').trim();
      return !!first && shots.every((s) => (s.videoPrompt || s.sourceText || '').trim() === first);
    };

    // 仅在没有章节文本的纯 Demo 预置项目下使用 initialSceneSpec
    const hasCustomSource = !!(meta?.chapters?.length || meta?.scriptText);
    const initialShots = (!hasCustomSource && meta?.initialSceneSpec?.shots && meta.initialSceneSpec.shots.length > 1)
      ? meta.initialSceneSpec.shots
      : null;

    const existingShots = initialShots
      ? initialShots
      : (!hasCustomSource && workingSpec.shots && workingSpec.shots.length > 1 && !areShotsIdentical(workingSpec.shots))
        ? workingSpec.shots
        : null;

    if (existingShots && existingShots.length > 1) {
      const storyboardShots: StoryboardShot[] = (existingShots as any[]).map((s: any, idx: number) => ({
        id: s.id || `shot_${idx + 1}`,
        index: idx,
        sourceChapterId: s.sourceChapterId || 'ch_1',
        sourceText: s.sourceText || s.videoPrompt || s.narration || `镜头 ${idx + 1}`,
        videoPrompt: s.videoPrompt || s.sourceText || '',
        imagePrompt: s.imagePrompt,
        imageNegativePrompt: s.imageNegativePrompt,
        videoNegativePrompt: s.videoNegativePrompt,
        imageParameters: s.imageParameters,
        videoParameters: s.videoParameters,
        startState: s.startState,
        endState: s.endState,
        seed: typeof s.seed === 'number' ? s.seed : undefined,
        durationSeconds: (typeof s.durationSeconds === 'number' && s.durationSeconds > 0 ? s.durationSeconds : 4) as any,
        characters: (s as any).characters || s.characterIds || [],
        location: s.location,
        mood: s.mood,
        narration: s.narration || (s.dialogue?.[0]?.text) || s.sourceText || '',
        dialogue: s.dialogue,
      }));

      store.setShots(pid, storyboardShots);
      const updatedSpec: SceneSpec = {
        ...workingSpec,
        shots: storyboardShots as any,
      };
      store.setSceneSpec(pid, updatedSpec);
      store.setStageInputSummary(pid, 'script_slicing', {
        headline: `切片就绪: 共 ${storyboardShots.length} 个独立镜头`,
        details: storyboardShots.slice(0, 5).map((r, i) => `镜头 ${i + 1} · ${(r.sourceText || r.videoPrompt || '').slice(0, 40)}…`),
      });
      store.setStageStatus(pid, 'script_slicing', 'completed', { progress: 1 });
      callbacks?.onStageProgress?.('script_slicing', 1);
      return { spec: updatedSpec };
    }

    // 优先使用结构化分镜解析 (分镜1/镜头1/Shot 1/【镜头一】等)
    const structured = parseStructuredPromptShots(rawText, {
      aspectRatio: workingSpec.meta.aspectRatio || '16:9',
      defaultShotDuration: ([3, 5, 10, 18].includes(workingSpec.meta.defaultShotDuration as any) ? workingSpec.meta.defaultShotDuration : 5) as any,
    });

    let rawShots: RawShot[] = [];
    if (structured && structured.length > 1) {
      rawShots = structured.map((s, idx) => ({
        id: s.id || `shot_${idx + 1}`,
        index: idx,
        sourceChapterId: 'ch_1',
        sourceChapterNumber: 1,
        rawText: s.videoPrompt || s.sourceText || `镜头 ${idx + 1}`,
        characters: s.characterIds || [],
        location: s.location,
        mood: s.mood,
        hasDialogue: !!s.dialogue?.length || !!s.narration,
        hasAction: true,
      }));
    } else {
      const isScript = /^(镜头|第?\d+镜|Shot\s*\d+|Scene\s*\d+|【镜头|【分镜|【场)/im.test(rawText);
      rawShots = await sliceChaptersWithLLM(
        [{ id: 'ch_1', number: 1, content: rawText }],
        {
          isScript,
          targetWordsPerShot: isScript ? 50 : 80,
          minWordsPerShot: 10,
          maxWordsPerShot: isScript ? 200 : 250,
        },
        ctx.signal,
      );
    }
    if (!isStageRunActive(ctx)) return null;

    // 如果切分后依然只有 1 个镜头且文本有多行，按换行切分
    if (rawShots.length <= 1 && rawText.trim()) {
      const lines = rawText
        .split(/\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 3);
      if (lines.length > 1) {
        rawShots = lines.map((line, idx) => ({
          id: `shot_${idx + 1}`,
          index: idx,
          sourceChapterId: 'ch_1',
          sourceChapterNumber: 1,
          rawText: line,
          characters: [],
          hasDialogue: /["「『":：]/.test(line),
          hasAction: true,
        }));
      }
    }

    const storyboardShots: StoryboardShot[] = rawShots.map((raw) => ({
      id: raw.id,
      index: raw.index,
      sourceChapterId: raw.sourceChapterId,
      sourceText: raw.rawText,
      videoPrompt: '',
      durationSeconds: (workingSpec.meta?.defaultShotDuration || 5) as any,
      characters: raw.characters,
      location: raw.location,
      mood: raw.mood,
      narration: raw.rawText,
    }));

    store.setShots(pid, storyboardShots);
    const updatedSpec: SceneSpec = {
      ...workingSpec,
      shots: storyboardShots as any,
    };
    store.setSceneSpec(pid, updatedSpec);
    store.setStageInputSummary(pid, 'script_slicing', {
      headline: `切片完成: 共 ${rawShots.length} 个候选镜头`,
      details: rawShots.slice(0, 5).map((r, i) => `镜头 ${i + 1} · ${(r.rawText || '').slice(0, 40)}…`),
    });
    store.setStageStatus(pid, 'script_slicing', 'completed', { progress: 1 });
    callbacks?.onStageProgress?.('script_slicing', 1);
    return { spec: updatedSpec };
  } catch (err) {
    if (!isStageRunActive(ctx)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    store.setStageStatus(pid, 'script_slicing', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
}

/** 步 2: 分镜规划 (storyboard_prompt) */
export async function executeStoryboardPrompt(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('storyboard_prompt');
  store.advanceToStage(pid, 'storyboard_prompt');
  store.setStageStatus(pid, 'storyboard_prompt', 'running');

  try {
    const projState = store.getProject(pid);
    const rawShots = (workingSpec.shots?.length ? workingSpec.shots : (projState?.shots || [])).map((s, idx) => {
      const sourceShot = s as ShotSpec & Partial<StoryboardShot>;
      return {
      id: s.id || `shot_${idx}`,
      index: idx,
      sourceChapterId: s.sourceChapterId || 'ch_1',
      sourceChapterNumber: 1,
      rawText: s.sourceText || s.videoPrompt || s.narration || '',
      characters: sourceShot.visibleCharacters || sourceShot.characters || s.visibleCharacterIds || s.characterIds || [],
      offscreenCharacters: sourceShot.offscreenCharacters || sourceShot.offscreenCharacterIds || [],
      characterBinding: s.characterBinding,
      location: s.location,
      mood: s.mood,
      hasDialogue: !!s.dialogue || /["「『":：]/.test(s.sourceText || ''),
      hasAction: true,
      };
    });

    const defaultDuration: 3 | 5 | 10 | 18 =
      ([3, 5, 10, 18].includes(workingSpec.meta.defaultShotDuration as any)
        ? (workingSpec.meta.defaultShotDuration as any)
        : 5);

    const sbCtx: StoryboardContext = {
      novelTitle: workingSpec.meta.title || '漫剧分镜',
      sourceContext: (useProjectStore.getState().projects.find((project) => project.id === pid)?.metadata as any)?.scriptText,
      genre: workingSpec.meta.genre || 'general',
      style: workingSpec.meta.style || '',
      aspectRatio: workingSpec.meta.aspectRatio || '16:9',
      defaultShotDuration: defaultDuration,
      allowFallback: false,
      signal: ctx.signal,
      sourceLanguage: detectInputLanguage(rawShots.map((shot) => shot.rawText).join('\n\n')),
      imageCapabilities: providerRouter.getImageCapabilities('storyboard'),
      videoCapabilities: providerRouter.getVideoCapabilities('clip'),
    };

    const storyboardShots = await buildStoryboard(rawShots, sbCtx, (done, total) => {
      if (!isStageRunActive(ctx)) return;
      store.setStageStatus(pid, 'storyboard_prompt', 'running', { progress: done / total });
      callbacks?.onStageProgress?.('storyboard_prompt', done / total);
    });
    if (!isStageRunActive(ctx)) return null;

    store.setShots(pid, storyboardShots);
    const updatedSpec: SceneSpec = {
      ...workingSpec,
      shots: storyboardShots.map((s) => ({
        id: s.id,
        index: s.index,
        sourceChapterId: s.sourceChapterId,
        sourceText: s.sourceText,
        videoPrompt: s.videoPrompt,
        imagePrompt: s.imagePrompt,
        imageNegativePrompt: s.imageNegativePrompt,
        videoNegativePrompt: s.videoNegativePrompt,
        imageParameters: s.imageParameters,
        videoParameters: s.videoParameters,
        startState: s.startState,
        endState: s.endState,
        seed: s.seed,
        narration: s.narration,
        dialogue: s.dialogue,
        characterIds: s.visibleCharacters || s.characters || s.visibleCharacterIds || s.characterIds || [],
        visibleCharacterIds: s.visibleCharacters || s.visibleCharacterIds || s.characters || s.characterIds || [],
        offscreenCharacterIds: s.offscreenCharacters || s.offscreenCharacterIds || [],
        characterBinding: s.characterBinding,
        location: s.location,
        mood: s.mood,
        cameraMovement: s.cameraMovement,
        transition: s.transition,
        durationSeconds: (typeof s.durationSeconds === 'number' && s.durationSeconds > 0 ? s.durationSeconds : 4) as any,
      })),
    };
    store.setSceneSpec(pid, updatedSpec);
    store.setStageInputSummary(pid, 'storyboard_prompt', {
      headline: `规划完成: ${storyboardShots.length} 个分镜已生成视觉 Prompt`,
      details: storyboardShots.slice(0, 5).map((s) => `镜头 ${s.index + 1} · ${(s.videoPrompt || '').slice(0, 40)}…`),
    });
    store.setStageStatus(pid, 'storyboard_prompt', 'completed', { progress: 1 });
    callbacks?.onStageProgress?.('storyboard_prompt', 1);
    return { spec: updatedSpec };
  } catch (err) {
    if (!isStageRunActive(ctx)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    store.setStageStatus(pid, 'storyboard_prompt', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
}

/** 步 3: 实体提取 (extraction) */
export async function executeExtraction(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('extraction');
  store.advanceToStage(pid, 'extraction');
  store.setStageStatus(pid, 'extraction', 'running');

  try {
    const pStore = useProjectStore.getState();
    const globalProj = pStore.projects.find((p) => p.id === pid);
    const meta = globalProj?.metadata as any;

    const sourceContexts: string[] = [];
    if (meta?.scriptText) sourceContexts.push(meta.scriptText);
    if (meta?.chapters?.length) sourceContexts.push(meta.chapters.map((c: any) => c.content).join('\n\n'));
    if (globalProj?.description) sourceContexts.push(globalProj.description);

    const shotsText = (workingSpec.shots || [])
      .map((s, idx) => `镜头 ${idx + 1}: ${s.sourceText || ''} ${s.videoPrompt || ''} ${s.narration || ''}`)
      .join('\n\n');

    const fullText = [sourceContexts.join('\n\n'), shotsText].filter(Boolean).join('\n\n【分镜详情】\n');
    if (!fullText.trim()) {
      throw new Error('没有可用于实体提取的源文本');
    }

    const seriesProject = meta?.seriesId
      ? pStore.projects.find((candidate: any) => candidate.id === meta.seriesId)
      : undefined;
    const seriesMeta = (seriesProject?.metadata || {}) as any;
    const seriesChars = seriesMeta.seriesCharacters || meta?.seriesCharacters || meta?.characters;
    const seriesScenes = seriesMeta.seriesScenes || meta?.seriesScenes;
    const seriesStyleGuide = seriesMeta.seriesStyleGuide || meta?.seriesStyleGuide;

    const extractResult = await stepExtract({
      text: fullText,
      shots: workingSpec.shots,
      existingCharacters: seriesChars?.length ? seriesChars : workingSpec.characters,
      allowFallback: false,
    }, ctx.signal);
    if (!isStageRunActive(ctx)) return null;

    const knownCharNames = new Set(extractResult.characters.map((c) => c.name));
    const knownCharIds = new Set(extractResult.characters.map((c) => c.id));
    const finalShots: ShotSpec[] = (extractResult.resolvedShots ?? workingSpec.shots).map((sh) => ({
      ...sh,
      characterIds: (sh.characterIds || []).filter((id) => knownCharIds.has(id) || knownCharNames.has(id)),
    }));

    const nameToId = new Map(extractResult.characters.map((c) => [c.name, c.id] as const));
    for (const sh of finalShots) {
      sh.characterIds = (sh.characterIds || [])
        .map((id) => nameToId.get(id) ?? id)
        .filter((id, idx, arr) => knownCharIds.has(id) && arr.indexOf(id) === idx);
      sh.visibleCharacterIds = sh.characterIds;
      sh.offscreenCharacterIds = (sh.offscreenCharacterIds || [])
        .map((id) => nameToId.get(id) ?? id)
        .filter((id, idx, arr) => knownCharIds.has(id) && arr.indexOf(id) === idx);
      sh.unresolvedCharacterRefs = sh.unresolvedCharacterRefs?.filter(Boolean).filter(
        (ref, idx, arr) => arr.indexOf(ref) === idx,
      );
    }

    let updatedSpec: SceneSpec = {
      ...workingSpec,
      characters: extractResult.characters.length > 0 ? extractResult.characters : (workingSpec.characters || []),
      scenes: extractResult.scenes.length > 0 ? extractResult.scenes : (workingSpec.scenes || []),
      props: extractResult.props,
      shots: finalShots,
    };

    if ((seriesChars && seriesChars.length > 0) || (seriesScenes && seriesScenes.length > 0) || seriesStyleGuide) {
      updatedSpec = applySeriesProjectLibrary(updatedSpec, {
        characters: seriesChars,
        scenes: seriesScenes,
        styleGuide: seriesStyleGuide,
      });
    }

    store.setSceneSpec(pid, updatedSpec);
    store.setStageInputSummary(pid, 'extraction', {
      headline: `提取完成: ${updatedSpec.characters?.length ?? 0} 个角色, ${updatedSpec.scenes?.length ?? 0} 个场景`,
      details: (updatedSpec.characters || []).map((c) => `角色: ${c.name} (${c.gender || '未知'}) · ${(c.appearance || '').slice(0, 30)}`),
    });
    store.setStageStatus(pid, 'extraction', 'completed', { progress: 1 });
    callbacks?.onStageProgress?.('extraction', 1);
    return { spec: updatedSpec };
  } catch (err) {
    if (!isStageRunActive(ctx)) return null;
    const msg = err instanceof Error ? err.message : String(err);
    store.setStageStatus(pid, 'extraction', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
}

// --- handler 注册表 ---

/** 完整 11 步统一全流程流水线顺序 */
export const RUNTIME_STAGE_ORDER: VideoStage[] = [
  'script_slicing',
  'storyboard_prompt',
  'extraction',
  'character_anchor',
  'scene_image',
  'keyframe_image',
  'voice_assignment',
  'tts',
  'video_generation',
  'video_review',
  'audio_merge',
  'composing',
];

/** stage → handler 映射。runPipeline / runSingleStage / runFromStage 共用。 */
export const STAGE_HANDLERS: Partial<Record<VideoStage, (ctx: StageContext) => Promise<StageResult | null>>> = {
  script_slicing: executeScriptSlicing,
  storyboard_prompt: executeStoryboardPrompt,
  extraction: executeExtraction,
  character_anchor: executeCharacterAnchor,
  voice_assignment: executeVoiceAssignment,
  scene_image: executeSceneImage,
  tts: executeTTS,
  keyframe_image: executeKeyframe,
  video_generation: executeVideoGen,
  video_review: executeVideoReview,
  audio_merge: executeAudioMerge,
  composing: executeCompose,
};

/** stage → 是否启用(根据 options 判断该 stage 该不该跑)。 */
export function isStageEnabled(stage: VideoStage, options: PipelineOptions, spec: SceneSpec): boolean {
  switch (stage) {
    case 'script_slicing':
      return spec.meta.channel !== 'direct';
    case 'storyboard_prompt':
      return spec.meta.channel !== 'direct';
    case 'extraction':
      return spec.meta.channel !== 'direct';
    case 'character_anchor':
      return !!options.enableCharacterAnchor && !!spec.characters?.length;
    case 'voice_assignment':
      return !!options.enableTTS && !!spec.characters?.length;
    case 'scene_image':
      return !!options.enableSceneImage && !!spec.scenes?.length;
    case 'tts':
      return !!options.enableTTS && spec.shots.some(shotHasSpeech);
    case 'keyframe_image':
      return !!options.enableKeyframe;
    case 'video_generation':
      return true; // 总是跑
    case 'video_review':
      return true;
    case 'audio_merge':
      return !!options.enableAudioMerge && spec.shots.some((s) => s.audioTrack);
    case 'composing':
      return true; // 由 clips.length > 0 控制,在调用处判断
    default:
      return false;
  }
}

function shotHasSpeech(shot: ShotSpec): boolean {
  return !!(
    shot.dialogue?.some((dialogue) => !!dialogue.text?.trim())
    || shot.narration?.trim()
    || shot.sourceText?.trim()
    || shot.videoPrompt?.trim()
  );
}

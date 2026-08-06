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
import { pushStageContext, popStageContext } from '@/services/providers/invocation-context';
import type {
  SceneSpec,
  PipelineOptions,
  VideoStage,
  ShotSpec,
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
import { runAudioMerge } from './step-audio-merge';
import { runCompose } from './step-compose';
import { toWebviewUrl } from '../asset-store';

/** Stage 执行上下文。handler 从这里读输入,通过 store action 写输出。 */
export interface StageContext {
  pid: string;
  workingSpec: SceneSpec;
  options: PipelineOptions;
  videoGen: VideoGenOptions;
  callbacks?: PipelineCallbacks;
  shouldAbort?: () => boolean;
  /** 累积的 clips(video_generation 产出,audio_merge/composing 消费)。
   *  放在 ctx 里而不是从 store 读,是为了让单步重跑时能传入任意初始 clips。 */
  clips: GeneratedClip[];
}

/** handler 返回值:更新后的 spec + clips(如果有变化)。null = 执行失败。 */
export interface StageResult {
  spec: SceneSpec;
  clips?: GeneratedClip[];
}

// --- 共用 helper(从 pipeline-runner 搬过来,避免循环依赖) ---

async function withStageContext<T>(
  pid: string,
  stage: VideoStage,
  fn: () => Promise<T>,
): Promise<T> {
  pushStageContext({ novelProjectId: pid, stage });
  try {
    return await fn();
  } finally {
    popStageContext();
  }
}

async function safeRunStage<T>(
  pid: string,
  stage: VideoStage,
  fn: () => Promise<T>,
): Promise<T | null> {
  void logger.info(`[pipeline] ${stage} enter`, 'pipeline');
  const t0 = performance.now();
  try {
    const r = await fn();
    void logger.info(`[pipeline] ${stage} ok (${Math.round(performance.now() - t0)}ms)`, 'pipeline');
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logger.error(`[pipeline] ${stage} FAIL (${Math.round(performance.now() - t0)}ms): ${msg}`, 'pipeline');
    useVideoStore.getState().setStageStatus(pid, stage, 'error', { error: msg });
    return null;
  }
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
 *  - seed:目前 step 不接收,留空(未来扩展)
 */
export function populateStageInput(pid: string, stage: VideoStage, workingSpec: SceneSpec): void {
  const store = useVideoStore.getState();
  const proj = store.getProject(pid);
  if (!proj) return;
  const existing = proj.stages[stage]?.input ?? {};
  const patch: Partial<StageInput> = {};

  const firstShot = workingSpec.shots[0];
  const firstChar = workingSpec.characters?.[0];
  const firstScene = workingSpec.scenes?.[0];
  const style = workingSpec.meta.style;

  switch (stage) {
    case 'storyboard_prompt':
      if (existing.prompt === undefined && firstShot?.sourceText) {
        patch.prompt = firstShot.sourceText;
      }
      break;
    case 'character_anchor':
      // 风格:有就显示真实值,没有显示兜底值(让用户看到 step 实际会用的值)
      if (existing.style === undefined) {
        patch.style = style || 'cinematic';
      }
      // anchorMode 默认 turnaround(单图+三视图都生成),用户可手动切到 single 只生成单图
      if (existing.anchorMode === undefined) {
        patch.anchorMode = 'turnaround';
      }
      // prompt 只控制单图立绘(三视图是附加产物,内部用固定 prompt 不暴露给用户改)
      if (existing.prompt === undefined && firstChar) {
        patch.prompt = buildSamplePortraitPrompt(firstChar, style);
      }
      break;
    case 'scene_image':
      if (existing.style === undefined) {
        patch.style = style || 'cinematic';
      }
      if (existing.prompt === undefined && firstScene) {
        patch.prompt = buildSampleScenePrompt(firstScene, style);
      }
      break;
    case 'keyframe_image':
      if (existing.style === undefined) {
        patch.style = style || 'cinematic';
      }
      if (existing.prompt === undefined && firstShot) {
        patch.prompt = firstShot.videoPrompt || firstShot.narration || '';
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
      break;
  }

  if (Object.keys(patch).length > 0) {
    store.setStageInput(pid, stage, patch);
  }
}

/** 和 step-character-anchor 的 buildPortraitPrompt 首对象保持一致(代表 prompt)。 */
function buildSamplePortraitPrompt(
  c: NonNullable<SceneSpec['characters']>[number],
  style?: string,
): string {
  const parts = [
    `character reference portrait of ${c.name}`,
    c.appearance,
    'neutral pose, plain background, soft studio lighting',
    'full body visible from head to knee',
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark, no signature',
  ];
  return parts.join(', ');
}

function buildSampleScenePrompt(
  s: NonNullable<SceneSpec['scenes']>[number],
  style?: string,
): string {
  const parts = [
    `scene background of ${s.name}`,
    s.description,
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark',
  ];
  return parts.join(', ');
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
      workingSpec = {
        ...workingSpec,
        shots: workingSpec.shots.map((s) => ({ ...s, sourceText: input.prompt! })),
      };
      specChanged = true;
    } else if (stage === 'keyframe_image' || stage === 'video_generation') {
      workingSpec = {
        ...workingSpec,
        shots: workingSpec.shots.map((s) => ({ ...s, videoPrompt: input.prompt! })),
      };
      specChanged = true;
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
  const { pid, workingSpec, options, callbacks } = ctx;
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
  // 读用户在 UI 里改过的 anchorMode / characterPrompts(单步重跑用)
  const proj0 = useVideoStore.getState().getProject(pid);
  const anchorInput = proj0?.stages['character_anchor']?.input;
  const anchorMode = anchorInput?.anchorMode;
  const characterPrompts = (anchorInput as any)?.characterPrompts as Record<string, string> | undefined;

  const result = await safeRunStage(pid, 'character_anchor', () =>
    withStageContext(pid, 'character_anchor', () =>
      runCharacterAnchor(
        anchorChars,
        {
          style: workingSpec.meta.style,
          imageTier: 'value',
          limit: options.characterAnchorLimit,
          novelProjectId: pid,
          anchorMode,
          characterPrompts,
        },
        (done, total) => {
          store.setStageStatus(pid, 'character_anchor', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('character_anchor', done / total);
        },
      ),
    ),
  );
  if (!result) return null;
  const spec = { ...workingSpec, characters: result.characters };
  store.setSceneSpec(pid, spec);
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
    withStageContext(pid, 'voice_assignment', () => stepVoice(voiceChars)),
  );
  if (!voiceResult) return null;
  const spec = { ...workingSpec, characters: voiceResult.characters };
  store.setSceneSpec(pid, spec);
  store.setStageStatus(pid, 'voice_assignment', 'completed', { progress: 1 });
  return { spec };
}

/** 步:场景图(scene_image) */
export async function executeSceneImage(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
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
    withStageContext(pid, 'scene_image', () =>
      runSceneImage(
        workingSpec.scenes!,
        {
          aspectRatio: workingSpec.meta.aspectRatio,
          style: workingSpec.meta.style,
          imageTier: 'value',
          novelProjectId: pid,
        },
        (done, total) => {
          store.setStageStatus(pid, 'scene_image', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('scene_image', done / total);
        },
      ),
    ),
  );
  if (!result) return null;
  const spec = { ...workingSpec, scenes: result.scenes };
  store.setSceneSpec(pid, spec);
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
  const narrationShots = workingSpec.shots.filter((s) => s.narration);
  store.setStageInputSummary(pid, 'tts', {
    headline: `${narrationShots.length} 个镜头有旁白`,
    details: narrationShots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${(s.narration ?? '').slice(0, 40)}`),
  });

  const stageInput = store.getProject(pid)?.stages.tts?.input;
  const customModel = stageInput?.model as string | undefined;

  const ttsResult = await safeRunStage(pid, 'tts', () =>
    withStageContext(pid, 'tts', () =>
      runTTS(
        workingSpec.shots,
        workingSpec.characters ?? [],
        { ttsTier: 'free', novelProjectId: pid, model: customModel },
        (done, total) => {
          store.setStageStatus(pid, 'tts', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('tts', done / total);
        },
      ),
    ),
  );
  if (!ttsResult) return null;
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
    store.setStageStatus(pid, 'tts', 'completed', {
      progress: 1,
      error: `部分 TTS 失败:${ok}/${attempted} 成功,${failed} 个镜头未生成音频。涉及:${details}`,
    });
  } else {
    store.setStageStatus(pid, 'tts', 'completed', { progress: 1 });
  }
  return { spec };
}

/** 步:关键帧(keyframe_image) */
export async function executeKeyframe(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, callbacks } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('keyframe_image');
  store.advanceToStage(pid, 'keyframe_image');
  store.setStageStatus(pid, 'keyframe_image', 'running');
  populateStageInput(pid, 'keyframe_image', workingSpec);
  store.setStageInputSummary(pid, 'keyframe_image', {
    headline: `${workingSpec.shots.length} 个镜头`,
    details: workingSpec.shots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${(s.videoPrompt || '').slice(0, 40)}`),
  });

  const result = await safeRunStage(pid, 'keyframe_image', () =>
    withStageContext(pid, 'keyframe_image', () =>
      runKeyframe(
        workingSpec.shots,
        {
          characters: workingSpec.characters ?? [],
          scenes: workingSpec.scenes ?? [],
          aspectRatio: workingSpec.meta.aspectRatio,
          style: workingSpec.meta.style,
          imageTier: 'value',
          novelProjectId: pid,
        },
        (done, total) => {
          store.setStageStatus(pid, 'keyframe_image', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('keyframe_image', done / total);
          callbacks?.onShotProgress?.(done, total);
        },
      ),
    ),
  );
  if (!result) return null;
  const spec = { ...workingSpec, shots: result.shots };
  store.setSceneSpec(pid, spec);
  store.setStageStatus(pid, 'keyframe_image', 'completed', { progress: 1 });
  return { spec };
}

/** 步:视频生成(video_generation) */
export async function executeVideoGen(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, videoGen, callbacks, shouldAbort, clips: preExistingClips } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('video_generation');
  store.advanceToStage(pid, 'video_generation');
  store.setStageStatus(pid, 'video_generation', 'running');
  populateStageInput(pid, 'video_generation', workingSpec);
  const alreadyDoneCount = preExistingClips.filter((c) => c.videoUrl).length;
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

  const result = await safeRunStage(pid, 'video_generation', () =>
    withStageContext(pid, 'video_generation', () =>
      runVideoGen(
        workingSpec.shots,
        { ...videoGen, novelProjectId: pid },
        options.enableI2V,
        (done, total) => {
          const totalDone = done + alreadyDoneCount;
          const totalAll = Math.max(total, workingSpec.shots.length);
          store.setStageStatus(pid, 'video_generation', 'running', {
            progress: totalDone / totalAll,
          });
          callbacks?.onStageProgress?.('video_generation', totalDone / totalAll);
          callbacks?.onShotProgress?.(totalDone, totalAll);
        },
        shouldAbort,
        (clip) => store.addClip(pid, clip),
        preExistingClips,
      ),
    ),
  );
  if (!result) return null;
  const clips = [...preExistingClips.filter((c) => c.videoUrl), ...result.clips];
  store.setStageStatus(pid, 'video_generation', 'completed', { progress: 1 });
  return { spec: workingSpec, clips };
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
      { novelProjectId: pid, clips },
      (done, total) => {
        store.setStageStatus(pid, 'audio_merge', 'running', { progress: done / total });
        callbacks?.onStageProgress?.('audio_merge', done / total);
      },
    ),
  );
  if (!mergeResult) return null;
  const spec = { ...workingSpec, shots: mergeResult.shots };
  store.setSceneSpec(pid, spec);
  // 把合并产物同步回 clips(覆盖 videoUrl 指向带音轨的文件)。
  //
  // 关键 bug 修复:
  // 1) 只对真正合并成功的 shot(mergedShotIds)更新 videoUrl。
  //    之前用 mergeResult.shots 全量建 map,失败的 shot 的 audioTrack
  //    是原 TTS URL(也不以 data: 开头),会被错误地当成"合并文件路径"
  //    写进 clip.videoUrl → 把视频 URL 替换成音频 URL。
  // 2) 必须写回 store(addClip 做 upsert)。之前只改了局部 newClips 副本,
  //    runPipeline 累积进局部 clips 变量,但单步重跑(runSingleStage/
  //    runFromStage)从 store 重建 ctx 时读到的还是旧的无音轨 clips。
  let updatedClips = clips;
  if (mergeResult.mergedShotIds.length) {
    const mergedSet = new Set(mergeResult.mergedShotIds);
    const shotToMerged = new Map(
      mergeResult.shots
        .filter((s) => mergedSet.has(s.id))
        .map((s) => [s.id, s.audioTrack]),
    );
    updatedClips = clips.map((clip) => {
      const mergedPath = shotToMerged.get(clip.shotId);
      if (mergedPath && !mergedPath.startsWith('data:')) {
        const updated: GeneratedClip = {
          ...clip,
          videoUrl: toWebviewUrl(mergedPath),
          hasAudio: true,
        };
        store.addClip(pid, updated);
        return updated;
      }
      return clip;
    });
  }
  store.setStageStatus(pid, 'audio_merge', 'completed', { progress: 1 });
  return { spec, clips: updatedClips };
}

/** 步:拼接合成(composing) */
export async function executeCompose(ctx: StageContext): Promise<StageResult | null> {
  const { pid, workingSpec, options, callbacks, clips } = ctx;
  const store = useVideoStore.getState();
  callbacks?.onStageChange?.('composing');
  store.advanceToStage(pid, 'composing');
  store.setStageStatus(pid, 'composing', 'running');

  try {
    const result = await runCompose({
      novelProjectId: pid,
      clips,
      shots: workingSpec.shots,
      hardcodeSubtitles: options.enableSubtitles,
    });
    store.setFinalVideo(pid, toWebviewUrl(result.finalVideoUrl), {
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
    });
    store.setStageStatus(pid, 'composing', 'completed', { progress: 1 });
    return { spec: workingSpec };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setStageStatus(pid, 'composing', 'error', { error: msg });
    callbacks?.onError?.(msg);
    return null;
  }
}

// --- handler 注册表 ---

/** runPipeline 处理的 stage 顺序(不含 script_slicing/storyboard/extraction,
 *  那三步在 VideoPipeline.resume 里跑)。 */
export const RUNTIME_STAGE_ORDER: VideoStage[] = [
  'character_anchor',
  'voice_assignment',
  'scene_image',
  'tts',
  'keyframe_image',
  'video_generation',
  'audio_merge',
  'composing',
];

/** stage → handler 映射。runPipeline / runSingleStage / runFromStage 共用。 */
export const STAGE_HANDLERS: Partial<Record<VideoStage, (ctx: StageContext) => Promise<StageResult | null>>> = {
  character_anchor: executeCharacterAnchor,
  voice_assignment: executeVoiceAssignment,
  scene_image: executeSceneImage,
  tts: executeTTS,
  keyframe_image: executeKeyframe,
  video_generation: executeVideoGen,
  audio_merge: executeAudioMerge,
  composing: executeCompose,
};

/** stage → 是否启用(根据 options 判断该 stage 该不该跑)。 */
export function isStageEnabled(stage: VideoStage, options: PipelineOptions, spec: SceneSpec): boolean {
  switch (stage) {
    case 'character_anchor':
      return !!options.enableCharacterAnchor && !!spec.characters?.length;
    case 'voice_assignment':
      return !!options.enableTTS && !!spec.characters?.length;
    case 'scene_image':
      return !!options.enableSceneImage && !!spec.scenes?.length;
    case 'tts':
      return !!options.enableTTS && spec.shots.some((s) => s.narration);
    case 'keyframe_image':
      return !!options.enableKeyframe;
    case 'video_generation':
      return true; // 总是跑
    case 'audio_merge':
      return !!options.enableAudioMerge && spec.shots.some((s) => s.audioTrack);
    case 'composing':
      return true; // 由 clips.length > 0 控制,在调用处判断
    default:
      return false;
  }
}

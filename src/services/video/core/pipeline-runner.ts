// pipeline-runner.ts — 14 步流水线编排器
// 输入:SceneSpec + PipelineOptions + callbacks
// 按 options 编排骨分子集。每步失败降级见文档 §10。
//
// 期 1(本次):实装步 3/6/7/9/10/12-14。步 4/8/11(音频链路)留 stub 跳过,期 3 补全。

import { useVideoStore } from '@/stores/videoStore';
import { logger } from '@/services/log';
import { pushStageContext, popStageContext } from '@/services/providers/invocation-context';
import type {
  SceneSpec,
  PipelineOptions,
  VideoStage,
  VideoProjectState,
  ShotSpec,
  GeneratedClip,
} from '@/types/video';
import type { PipelineCallbacks } from './types';
import type { StageInputSummary } from '@/types/video';

/** 把"进入 stage → 跑 fn → 退出"包成一层,自动压/弹 stage context 给 router 上报账本用。 */
async function withStageContext<T>(
  novelProjectId: string,
  stage: VideoStage,
  fn: () => Promise<T>,
): Promise<T> {
  pushStageContext({ novelProjectId, stage });
  try {
    return await fn();
  } finally {
    popStageContext();
  }
}

/**
 * 安全跑一个 stage:任何异常都会被捕获并写入 stage 的 error 字段,
 * 状态置为 'error',返回 null —— 避免单步失败拖垮整条 pipeline,
 * 同时让面板能直接显示错误。
 */
async function safeRunStage<T>(
  novelProjectId: string,
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
    useVideoStore.getState().setStageStatus(novelProjectId, stage, 'error', { error: msg });
    return null;
  }
}

function setInputSummary(
  novelProjectId: string,
  stage: VideoStage,
  summary: StageInputSummary,
): void {
  useVideoStore.getState().setStageInputSummary(novelProjectId, stage, summary);
}
import { stepVoice } from './step-voice';
import { runCharacterAnchor } from './step-character-anchor';
import { runSceneImage } from './step-scene-image';
import { runTTS } from './step-tts';
import { runKeyframe } from './step-keyframe';
import { runVideoGen, type VideoGenOptions } from './step-video-gen';
import { runAudioMerge } from './step-audio-merge';
import { runCompose } from './step-compose';

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

  // 工作副本
  let workingSpec: SceneSpec = {
    ...spec,
    characters: spec.characters?.map((c) => ({ ...c, costumeVariants: c.costumeVariants?.map((v) => ({ ...v })) })),
    scenes: spec.scenes?.map((s) => ({ ...s })),
    shots: spec.shots.map((s) => ({ ...s, characterIds: [...s.characterIds] })),
  };

  // 步 6:角色立绘
  if (!shouldAbort?.() && options.enableCharacterAnchor && workingSpec.characters?.length) {
    callbacks?.onStageChange?.('character_anchor');
    store.advanceToStage(novelProjectId, 'character_anchor');
    store.setStageStatus(novelProjectId, 'character_anchor', 'running');
    setInputSummary(novelProjectId, 'character_anchor', {
      headline: `${workingSpec.characters.length} 个角色,limit=${options.characterAnchorLimit}`,
      details: workingSpec.characters.slice(0, 10).map((c) => `${c.name} · ${c.appearance.slice(0, 40)}`),
    });

    const anchorChars = workingSpec.characters;
    const result = await safeRunStage(novelProjectId, 'character_anchor', () =>
      withStageContext(novelProjectId, 'character_anchor', () =>
        runCharacterAnchor(
          anchorChars,
          {
            style: workingSpec.meta.style,
            imageTier: 'value',
            limit: options.characterAnchorLimit,
          },
          (done, total) => {
            store.setStageStatus(novelProjectId, 'character_anchor', 'running', { progress: done / total });
            callbacks?.onStageProgress?.('character_anchor', done / total);
          },
        ),
      ),
    );
    if (result) {
      workingSpec = { ...workingSpec, characters: result.characters };
      store.setStageStatus(novelProjectId, 'character_anchor', 'completed', { progress: 1 });
    }
  } else {
    skipStage(store, novelProjectId, 'character_anchor', callbacks);
  }

  // 步 4:分配音色(在角色立绘之后,以便按角色选音色)
  if (!shouldAbort?.() && options.enableTTS && workingSpec.characters?.length) {
    callbacks?.onStageChange?.('voice_assignment');
    store.advanceToStage(novelProjectId, 'voice_assignment');
    store.setStageStatus(novelProjectId, 'voice_assignment', 'running');
    const voiceChars = workingSpec.characters;
    setInputSummary(novelProjectId, 'voice_assignment', {
      headline: `${voiceChars.length} 个角色待分配音色`,
    });

    const voiceResult = await safeRunStage(novelProjectId, 'voice_assignment', () =>
      withStageContext(novelProjectId, 'voice_assignment', () => stepVoice(voiceChars)),
    );
    if (voiceResult) {
      workingSpec = { ...workingSpec, characters: voiceResult.characters };
      store.setStageStatus(novelProjectId, 'voice_assignment', 'completed', { progress: 1 });
    }
  } else {
    skipStage(store, novelProjectId, 'voice_assignment', callbacks);
  }

  // 步 7:场景图
  if (!shouldAbort?.() && options.enableSceneImage && workingSpec.scenes?.length) {
    callbacks?.onStageChange?.('scene_image');
    store.advanceToStage(novelProjectId, 'scene_image');
    store.setStageStatus(novelProjectId, 'scene_image', 'running');
    setInputSummary(novelProjectId, 'scene_image', {
      headline: `${workingSpec.scenes.length} 个场景`,
      details: workingSpec.scenes.slice(0, 10).map((s) => `${s.name} · ${s.description.slice(0, 40)}`),
    });

    const result = await safeRunStage(novelProjectId, 'scene_image', () =>
      withStageContext(novelProjectId, 'scene_image', () =>
        runSceneImage(
          workingSpec.scenes!,
          {
            aspectRatio: workingSpec.meta.aspectRatio,
            style: workingSpec.meta.style,
            imageTier: 'value',
          },
          (done, total) => {
            store.setStageStatus(novelProjectId, 'scene_image', 'running', { progress: done / total });
            callbacks?.onStageProgress?.('scene_image', done / total);
          },
        ),
      ),
    );
    if (result) {
      workingSpec = { ...workingSpec, scenes: result.scenes };
      store.setStageStatus(novelProjectId, 'scene_image', 'completed', { progress: 1 });
    }
  } else {
    skipStage(store, novelProjectId, 'scene_image', callbacks);
  }

  // 步 8:TTS
  if (!shouldAbort?.() && options.enableTTS && workingSpec.shots.some((s) => s.narration)) {
    callbacks?.onStageChange?.('tts');
    store.advanceToStage(novelProjectId, 'tts');
    store.setStageStatus(novelProjectId, 'tts', 'running');
    const narrationShots = workingSpec.shots.filter((s) => s.narration);
    setInputSummary(novelProjectId, 'tts', {
      headline: `${narrationShots.length} 个镜头有旁白`,
      details: narrationShots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${(s.narration ?? '').slice(0, 40)}`),
    });

    const ttsResult = await safeRunStage(novelProjectId, 'tts', () =>
      withStageContext(novelProjectId, 'tts', () =>
        runTTS(
          workingSpec.shots,
          workingSpec.characters ?? [],
          { ttsTier: 'free' },
          (done, total) => {
            store.setStageStatus(novelProjectId, 'tts', 'running', { progress: done / total });
            callbacks?.onStageProgress?.('tts', done / total);
          },
        ),
      ),
    );
    if (ttsResult) {
      workingSpec = { ...workingSpec, shots: ttsResult.shots };
      store.setStageStatus(novelProjectId, 'tts', 'completed', { progress: 1 });
    }
  } else {
    skipStage(store, novelProjectId, 'tts', callbacks);
  }

  // 步 9:镜头关键帧
  if (!shouldAbort?.() && options.enableKeyframe) {
    callbacks?.onStageChange?.('keyframe_image');
    store.advanceToStage(novelProjectId, 'keyframe_image');
    store.setStageStatus(novelProjectId, 'keyframe_image', 'running');
    setInputSummary(novelProjectId, 'keyframe_image', {
      headline: `${workingSpec.shots.length} 个镜头`,
      details: workingSpec.shots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${(s.videoPrompt || '').slice(0, 40)}`),
    });

    const result = await safeRunStage(novelProjectId, 'keyframe_image', () =>
      withStageContext(novelProjectId, 'keyframe_image', () =>
        runKeyframe(
          workingSpec.shots,
          {
            characters: workingSpec.characters ?? [],
            scenes: workingSpec.scenes ?? [],
            aspectRatio: workingSpec.meta.aspectRatio,
            style: workingSpec.meta.style,
            imageTier: 'value',
          },
          (done, total) => {
            store.setStageStatus(novelProjectId, 'keyframe_image', 'running', { progress: done / total });
            callbacks?.onStageProgress?.('keyframe_image', done / total);
            callbacks?.onShotProgress?.(done, total);
          },
        ),
      ),
    );
    if (result) {
      workingSpec = { ...workingSpec, shots: result.shots };
      store.setStageStatus(novelProjectId, 'keyframe_image', 'completed', { progress: 1 });
    }
  } else {
    skipStage(store, novelProjectId, 'keyframe_image', callbacks);
  }

  // 步 10:视频生成
  let clips: GeneratedClip[] = [];
  if (!shouldAbort?.()) {
    callbacks?.onStageChange?.('video_generation');
    store.advanceToStage(novelProjectId, 'video_generation');
    store.setStageStatus(novelProjectId, 'video_generation', 'running');
    setInputSummary(novelProjectId, 'video_generation', {
      headline: `${workingSpec.shots.length} 个镜头 · ${options.enableI2V ? 'I2V' : 'T2V'} 模式`,
      details: workingSpec.shots.slice(0, 10).map((s) => `镜头 ${s.index + 1} · ${s.durationSeconds}s`),
    });

    const result = await safeRunStage(novelProjectId, 'video_generation', () =>
      withStageContext(novelProjectId, 'video_generation', () =>
        runVideoGen(
          workingSpec.shots,
          videoGen,
          options.enableI2V,
          (done, total) => {
            store.setStageStatus(novelProjectId, 'video_generation', 'running', { progress: done / total });
            callbacks?.onStageProgress?.('video_generation', done / total);
            callbacks?.onShotProgress?.(done, total);
          },
          shouldAbort,
        ),
      ),
    );
    if (result) {
      clips = result.clips;
      for (const clip of clips) {
        store.addClip(novelProjectId, clip);
      }
      store.setStageStatus(novelProjectId, 'video_generation', 'completed', { progress: 1 });
    }
  }

  // 步 11:音视合并
  if (!shouldAbort?.() && options.enableAudioMerge && workingSpec.shots.some((s) => s.audioTrack)) {
    callbacks?.onStageChange?.('audio_merge');
    store.advanceToStage(novelProjectId, 'audio_merge');
    store.setStageStatus(novelProjectId, 'audio_merge', 'running');
    const mergeShots = workingSpec.shots.filter((s) => s.audioTrack);
    setInputSummary(novelProjectId, 'audio_merge', {
      headline: `${mergeShots.length} 个镜头需合并音轨`,
    });

    const mergeResult = await safeRunStage(novelProjectId, 'audio_merge', () =>
      runAudioMerge(
        workingSpec.shots,
        { novelProjectId, clips },
        (done, total) => {
          store.setStageStatus(novelProjectId, 'audio_merge', 'running', { progress: done / total });
          callbacks?.onStageProgress?.('audio_merge', done / total);
        },
      ),
    );
    if (mergeResult) {
      workingSpec = { ...workingSpec, shots: mergeResult.shots };
      // 把合并后的产物同步回 clips(覆盖 videoUrl 指向带音轨的文件)
      if (mergeResult.mergedShotIds.length) {
        const shotToMerged = new Map(mergeResult.shots.map((s) => [s.id, s.audioTrack]));
        for (const clip of clips) {
          const mergedPath = shotToMerged.get(clip.shotId);
          if (mergedPath && !mergedPath.startsWith('data:')) {
            clip.videoUrl = mergedPath;
            clip.hasAudio = true;
          }
        }
      }
      store.setStageStatus(novelProjectId, 'audio_merge', 'completed', { progress: 1 });
    }
  } else {
    skipStage(store, novelProjectId, 'audio_merge', callbacks);
  }

  // 步 12-14:拼接 + 字幕 + 导出
  if (!shouldAbort?.() && clips.length > 0) {
    callbacks?.onStageChange?.('composing');
    store.advanceToStage(novelProjectId, 'composing');
    store.setStageStatus(novelProjectId, 'composing', 'running');

    try {
      const result = await runCompose({
        novelProjectId,
        clips,
        shots: workingSpec.shots,
        hardcodeSubtitles: options.enableSubtitles,
      });
      store.setFinalVideo(novelProjectId, result.finalVideoUrl, {
        durationSeconds: result.durationSeconds,
        sizeBytes: result.sizeBytes,
      });
      store.setStageStatus(novelProjectId, 'composing', 'completed', { progress: 1 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.setStageStatus(novelProjectId, 'composing', 'error', { error: msg });
      callbacks?.onError?.(msg);
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

// Re-export step-video-gen's options type for callers
export type { VideoGenOptions, ShotSpec };

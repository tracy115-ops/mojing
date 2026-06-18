// direct-scene-builder.ts — Direct 通道:prompt → SceneSpec
// 支持 pure / extract / multishot 三种模式。
// pure:    步 1 单镜头,无角色(走 T2V)
// extract: 步 1+2+3 单镜头,带角色(走 I2V)
// multishot: 步 1+2+3+5 多镜头切分(走完整下游)

import type {
  SceneSpec,
  ShotSpec,
  AspectRatio,
  DirectSourceMode,
} from '@/types/video';
import { stepRewrite } from './core/step-rewrite';
import { stepStoryboard } from './core/step-storyboard';
import { stepExtract } from './core/step-extract';

export interface DirectBuildContext {
  aspectRatio: AspectRatio;
  defaultShotDuration: 5 | 10;
  style?: string;
}

/**
 * Direct 通道入口:把用户手写 prompt 转成 SceneSpec。
 */
export async function buildSceneFromPrompt(
  prompt: string,
  mode: DirectSourceMode,
  ctx: DirectBuildContext,
): Promise<SceneSpec> {
  const meta: SceneSpec['meta'] = {
    style: ctx.style,
    aspectRatio: ctx.aspectRatio,
    defaultShotDuration: ctx.defaultShotDuration,
    sourceMode: mode,
    channel: 'direct',
  };

  if (mode === 'pure') {
    return {
      shots: [makePureShot(prompt, ctx)],
      meta,
    };
  }

  // extract / multishot 都要 LLM 改写 + 提取
  const rewritten = await stepRewrite(prompt);

  if (mode === 'extract') {
    // 单镜头,但带角色
    const singleShot: ShotSpec = {
      id: `shot_${Date.now()}_0`,
      index: 0,
      videoPrompt: rewritten.rewrittenPrompt,
      durationSeconds: ctx.defaultShotDuration,
      characterIds: [],
    };

    const extract = await stepExtract({
      text: prompt,
      shots: [singleShot],
    });

    return {
      characters: extract.characters,
      scenes: extract.scenes,
      props: extract.props,
      shots: extract.resolvedShots ?? [singleShot],
      meta: { ...meta, title: rewritten.title },
    };
  }

  // multishot:LLM 切镜头 + 提取
  const storyboard = await stepStoryboard(prompt, {
    aspectRatio: ctx.aspectRatio,
    defaultShotDuration: ctx.defaultShotDuration,
    style: ctx.style,
  });

  const extract = await stepExtract({
    text: prompt,
    shots: storyboard.shots,
  });

  return {
    characters: extract.characters,
    scenes: extract.scenes,
    props: extract.props,
    shots: extract.resolvedShots ?? storyboard.shots,
    meta: { ...meta, title: rewritten.title },
  };
}

function makePureShot(prompt: string, ctx: DirectBuildContext): ShotSpec {
  return {
    id: `shot_${Date.now()}_0`,
    index: 0,
    videoPrompt: prompt,
    durationSeconds: ctx.defaultShotDuration,
    characterIds: [],
  };
}

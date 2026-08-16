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
  defaultShotDuration: 3 | 5 | 10 | 15 | 18;
  targetDurationSeconds?: 5 | 15 | 30 | 60;
  style?: string;
  /** 剧情承接信息，只注入分镜规划提示词。 */
  continuityContext?: string;
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

  if (mode === 'extract') {
    const rewritten = await stepRewrite(prompt);
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

  // multishot: 优先检测用户是否已传入结构化分镜与台词
  const structuredShots = parseStructuredPromptShots(prompt, ctx);
  if (structuredShots && structuredShots.length > 0) {
    const extract = await stepExtract({
      text: prompt,
      shots: structuredShots,
    });
    return {
      characters: extract.characters,
      scenes: extract.scenes,
      props: extract.props,
      shots: extract.resolvedShots ?? structuredShots,
      meta: { ...meta, title: '自定义分镜剧本' },
    };
  }

  // 非结构化纯文本: LLM 切镜头 + 提取
  const rewritten = await stepRewrite(prompt);
  const storyboard = await stepStoryboard(prompt, {
    aspectRatio: ctx.aspectRatio,
    defaultShotDuration: ctx.defaultShotDuration,
    targetDurationSeconds: ctx.targetDurationSeconds,
    style: ctx.style,
    continuityContext: ctx.continuityContext,
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

export function parseStructuredPromptShots(prompt: string, ctx: DirectBuildContext): ShotSpec[] | null {
  const isScript = /(?:分镜\s*\d+|镜头\s*\d+|第\s*\d+\s*镜|Shot\s*\d+)/i.test(prompt);
  if (!isScript) return null;

  const blocks = prompt
    .split(/(?=(?:分镜\s*\d+|镜头\s*\d+|第\s*\d+\s*镜|Shot\s*\d+))/i)
    .map((b) => b.trim())
    .filter((b) => /^(?:分镜\s*\d+|镜头\s*\d+|第\s*\d+\s*镜|Shot\s*\d+)/i.test(b));

  if (blocks.length === 0) return null;

  return blocks.map((block, index) => {
    // 匹配类似 "女生台词：大师，我有一事相求！" 或 "猫咪台词: 竹篮打水一场空"
    const linePattern = /(?:^|[，。\s\n])([一-龥A-Za-z0-9_]{1,8})(?:台词|对白)?[:：]\s*([“"「『]?[^，。\n”"」』]{1,200}[”"」』]?)/g;
    const dialogue: { speaker: string; text: string }[] = [];
    let lm: RegExpExecArray | null;
    while ((lm = linePattern.exec(block)) !== null) {
      const speaker = lm[1].trim();
      let dialogueText = lm[2].trim().replace(/^[“"「『]/, '').replace(/[”"」』]$/, '');
      if (
        speaker &&
        dialogueText &&
        !['分镜', '镜头', '场景', '地点', '时间', '氛围', '画面', '全景', '中景', '近景', '特写'].includes(speaker)
      ) {
        dialogue.push({ speaker, text: dialogueText });
      }
    }

    if (dialogue.length === 0) {
      const quotePattern = /(?:([一-龥A-Za-z0-9_]{1,8})[:：\s]*)?[“"「『]([^”"」』]{1,200})[”"」』]/g;
      let qm: RegExpExecArray | null;
      while ((qm = quotePattern.exec(block)) !== null) {
        const speaker = qm[1]?.trim() || '未知';
        const dialogueText = qm[2].trim();
        if (dialogueText) {
          dialogue.push({ speaker, text: dialogueText });
        }
      }
    }

    const narration = dialogue[0]?.text?.trim() || undefined;

    return {
      id: `shot_${Date.now()}_${index}`,
      index,
      videoPrompt: block,
      narration,
      dialogue: dialogue.length > 0 ? dialogue : undefined,
      durationSeconds: ctx.defaultShotDuration,
      characterIds: [],
    };
  });
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

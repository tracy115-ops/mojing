// step-rewrite.ts — 步 2:AI 改写
// 把原始 prompt / 章节文本标准化为视频画面描述。
// Novel 通道继续用 storyboard-prompt.ts(它内部就包含改写),Direct 通道 pure 模式跳过此步,
// extract/multishot 模式调本模块把用户手写 prompt 标准化成英文视觉描述。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import { detectInputLanguage } from './lang-detector';

import { useSettingsStore } from '@/stores/settingsStore';

export interface RewriteResult {
  /** 标准化后的画面描述(单镜头用) */
  rewrittenPrompt: string;
  /** LLM 推测的镜头数量(用于判断 multishot) */
  detectedShotCount: number;
  /** 标题(若有) */
  title?: string;
}

/**
 * Normalize the source without changing its language or adding visual facts.
 */
export async function stepRewrite(rawPrompt: string): Promise<RewriteResult> {
  const sourceLanguage = detectInputLanguage(rawPrompt);
  const templates = useSettingsStore.getState().settings.creative.promptTemplates;
  const customSystem = useSettingsStore.getState().settings.creative.promptTemplatesEnabled
    ? templates?.rewriteEn || templates?.rewriteZh
    : undefined;
  const systemPrompt = customSystem?.trim() || [
    'You are a provider-agnostic visual planning model.',
    sourceLanguage === 'zh'
      ? 'Write all natural-language output fields in Simplified Chinese. Do not translate the source into English.'
      : 'Write all natural-language output fields in English. Do not translate the source into Chinese.',
    'Preserve every explicit event, entity, action, state, and dialogue detail.',
    'Improve clarity only where the source supports it. Do not invent identity, appearance, clothing, location, style, camera, or quality claims.',
    'Return one JSON object with rewrittenPrompt, detectedShotCount, and an optional title.',
    'The rewrittenPrompt is a concise visual description usable by a downstream planner; it is not a provider-specific parameter list.',
  ].join('\n');

  const request: LLMGenerateRequest = {
    taskType: 'translation',
    systemPrompt,
    userPrompt: rawPrompt,
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 2048,
  };

  try {
    const resp = await providerRouter.generate(request);
    const parsed = parseLLMJson<RewriteLLMOutput>(resp.content);
    if (!parsed) {
      return fallbackRewrite(rawPrompt);
    }
    return {
      rewrittenPrompt: String(parsed.rewrittenPrompt ?? '').trim() || rawPrompt,
      detectedShotCount: clampShotCount(parsed.detectedShotCount),
      title: parsed.title ? String(parsed.title).trim() : undefined,
    };
  } catch (err) {
    console.warn('stepRewrite: LLM failed, using fallback', err);
    return fallbackRewrite(rawPrompt);
  }
}

interface RewriteLLMOutput {
  rewrittenPrompt?: string;
  detectedShotCount?: number;
  title?: string;
}

function fallbackRewrite(rawPrompt: string): RewriteResult {
  return {
    rewrittenPrompt: rawPrompt,
    detectedShotCount: 1,
  };
}

function clampShotCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 20) return 20;
  return Math.floor(n);
}

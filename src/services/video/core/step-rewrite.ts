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
 * 步 2:把用户输入标准化。
 * 根据输入的语言占比识别，选择对应语言的 System Prompt 并命令大模型输出对应语言。
 */
export async function stepRewrite(rawPrompt: string): Promise<RewriteResult> {
  const lang = detectInputLanguage(rawPrompt);
  const customSystem = lang === 'zh'
    ? useSettingsStore.getState().settings.creative.promptTemplates?.rewriteZh
    : useSettingsStore.getState().settings.creative.promptTemplates?.rewriteEn;

  const systemPrompt = customSystem && customSystem.trim()
    ? customSystem
    : lang === 'zh'
      ? SYSTEM_PROMPT_ZH
      : SYSTEM_PROMPT_EN;

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

const SYSTEM_PROMPT_ZH = `你是 AI 视频提示词工程师。把用户的粗略输入标准化为视频模型可用的纯中文画面描述。

任务:
1. 必须使用 100% 纯中文！严禁包含英文单词或英汉混排。
2. 扩写成完整的中文视觉描述:场景环境 / 角色外貌服饰 / 具体动作肢体 / 镜头视角 / 光影与氛围
3. 检测输入是否是多镜头脚本
4. 单镜头:输出 60-150 字的纯中文 prompt
5. 多镜头:输出整体纯中文风格描述,并报告镜头数量

输出 JSON:
{
  "rewrittenPrompt": "纯中文画面描述",
  "detectedShotCount": <number, 1=单镜头, >1=多镜头>,
  "title": "可选的标题"
}`;

const SYSTEM_PROMPT_EN = `You are an AI video prompt engineer. Standardize the user's rough input into accurate English video prompts suitable for AI video models.

Tasks:
1. Output MUST be 100% in English! No Chinese characters.
2. Expand into a complete visual prompt: scene setting, character appearance, concrete action, camera angle/movement, lighting, and mood.
3. Detect whether the input is a multi-shot script.
4. Single shot: output 60-120 words English prompt.
5. Multi-shot: output overall English style description and report shot count.

Output JSON:
{
  "rewrittenPrompt": "English prompt",
  "detectedShotCount": <number, 1=single shot, >1=multi shot>,
  "title": "optional title"
}`;

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

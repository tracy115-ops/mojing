// step-rewrite.ts — 步 2:AI 改写
// 把原始 prompt / 章节文本标准化为视频画面描述。
// Novel 通道继续用 storyboard-prompt.ts(它内部就包含改写),Direct 通道 pure 模式跳过此步,
// extract/multishot 模式调本模块把用户手写 prompt 标准化成英文视觉描述。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';

export interface RewriteResult {
  /** 标准化后的英文画面描述(单镜头用) */
  rewrittenPrompt: string;
  /** LLM 推测的镜头数量(用于判断 multishot) */
  detectedShotCount: number;
  /** 标题(若有) */
  title?: string;
}

/**
 * 步 2:把用户输入标准化。
 * - 中文 → 翻译成英文视觉描述
 * - 口语化 → 扩写成完整画面描述
 * - 多镜头脚本 → 检测出镜头数量(实际切分在 step-storyboard)
 */
export async function stepRewrite(rawPrompt: string): Promise<RewriteResult> {
  const request: LLMGenerateRequest = {
    taskType: 'translation',
    systemPrompt: SYSTEM_PROMPT,
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

const SYSTEM_PROMPT = `你是 AI 视频提示词工程师。把用户的粗略输入标准化为视频模型可用的英文画面描述。

任务:
1. 如果输入是中文,翻译成英文
2. 扩写成完整的视觉描述:scene setting / character appearance / action / camera / lighting / mood
3. 检测输入是否是多镜头脚本(包含"镜头1"、"Scene 1"、"|"、换行分段等线索)
4. 单镜头:输出 60-120 词的英文 prompt
5. 多镜头:输出整体风格描述(各镜头细节由分镜步骤处理),并报告镜头数量

输出 JSON:
{
  "rewrittenPrompt": "英文画面描述",
  "detectedShotCount": <number, 1=单镜头, >1=多镜头>,
  "title": "可选的标题"
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

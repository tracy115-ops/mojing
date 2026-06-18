// step-storyboard.ts — 步 5:多镜头切分(Direct multishot 模式)
// Novel 通道用 chapter-slicer + storyboard-prompt 处理章节,本模块只服务 Direct multishot。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import type { ShotSpec, AspectRatio } from '@/types/video';

export interface StoryboardContext {
  aspectRatio: AspectRatio;
  defaultShotDuration: 5 | 10;
  style?: string;
}

export interface StoryboardResult {
  shots: ShotSpec[];
}

interface LLMShot {
  videoPrompt?: string;
  narration?: string;
  location?: string;
  mood?: string;
  cameraMovement?: string;
  durationSeconds?: number;
  characterIds?: string[];
  sceneId?: string;
}

/**
 * 步 5:把多镜头脚本切成 ShotSpec[]。
 * 输入是用户的原始 prompt(可能含"镜头1:..."这样的结构),输出结构化镜头数组。
 *
 * 注意:characterIds / sceneId 在这里填占位(char_xxx / scene_xxx),
 * 真正的 id 由 step-extract 提取后再回填。
 */
export async function stepStoryboard(
  rawPrompt: string,
  ctx: StoryboardContext,
): Promise<StoryboardResult> {
  const request: LLMGenerateRequest = {
    taskType: 'translation',
    systemPrompt: buildSystemPrompt(ctx),
    userPrompt: rawPrompt,
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    const parsed = parseLLMJson<LLMShot[]>(resp.content);
    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      return fallbackStoryboard(rawPrompt, ctx);
    }
    const shots = parsed.map((s, i) => normalizeShot(s, i, ctx));
    return { shots };
  } catch (err) {
    console.warn('stepStoryboard: LLM failed, using fallback', err);
    return fallbackStoryboard(rawPrompt, ctx);
  }
}

function buildSystemPrompt(ctx: StoryboardContext): string {
  return `你是 AI 视频分镜师。把用户的多镜头脚本切成结构化的镜头数组。

【输出规范】严格 JSON 数组,每个镜头字段:
- "videoPrompt": 英文 prompt,60-120 词。必须含:scene setting / character appearance / action / camera / lighting / mood
- "narration": 中文旁白,30-80 字,用于 TTS
- "location": 场景名(中/英)
- "mood": one of [intense, warm, melancholic, mysterious, hopeful, neutral]
- "cameraMovement": one of [static, dolly_in, dolly_out, pan_left, pan_right, tilt_up, tilt_down, tracking, aerial, handheld]
- "durationSeconds": ${ctx.defaultShotDuration} 或 10
- "characterIds": 字符串数组,占位 ['char_0', 'char_1'] 等(后续会回填真实 id)
- "sceneId": 占位 'scene_0' 等

【画面比例】${ctx.aspectRatio}
【风格】${ctx.style ?? 'cinematic'}

【质量要求】
- videoPrompt 必须视觉化、具体化,禁止抽象词
- 每镜头是 single continuous take,无切换`;
}

function normalizeShot(item: LLMShot, index: number, ctx: StoryboardContext): ShotSpec {
  return {
    id: `shot_${Date.now()}_${index}`,
    index,
    videoPrompt: String(item?.videoPrompt ?? '').trim(),
    narration: item?.narration ? String(item.narration).trim() : undefined,
    location: item?.location ? String(item.location) : undefined,
    mood: item?.mood,
    cameraMovement: item?.cameraMovement,
    durationSeconds: clampDuration(item?.durationSeconds, ctx.defaultShotDuration),
    characterIds: Array.isArray(item?.characterIds) ? item.characterIds!.map(String) : [],
    sceneId: item?.sceneId,
  };
}

function fallbackStoryboard(rawPrompt: string, ctx: StoryboardContext): StoryboardResult {
  return {
    shots: [
      {
        id: `shot_${Date.now()}_0`,
        index: 0,
        videoPrompt: rawPrompt,
        durationSeconds: ctx.defaultShotDuration,
        characterIds: [],
      },
    ],
  };
}

function clampDuration(v: unknown, def: 5 | 10): 5 | 10 {
  const n = Number(v);
  if (n >= 10) return 10;
  if (n >= 5) return 5;
  return def;
}

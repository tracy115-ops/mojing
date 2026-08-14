// step-storyboard.ts — 步 5:多镜头切分(Direct multishot 模式)
// Novel 通道用 chapter-slicer + storyboard-prompt 处理章节,本模块只服务 Direct multishot。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import type { ShotSpec, AspectRatio } from '@/types/video';

import { useSettingsStore } from '@/stores/settingsStore';

export interface StoryboardContext {
  aspectRatio: AspectRatio;
  defaultShotDuration: 3 | 5 | 10 | 15 | 18;
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
    systemPrompt: buildSystemPrompt(rawPrompt, ctx),
    userPrompt: rawPrompt,
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    let parsed: any = parseLLMJson<any>(resp.content);

    // 如果 LLM 返回的是对象(如 { shots: [...] } / { items: [...] } / { data: [...] }),解包出数组
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      if (Array.isArray(parsed.shots)) parsed = parsed.shots;
      else if (Array.isArray(parsed.items)) parsed = parsed.items;
      else if (Array.isArray(parsed.data)) parsed = parsed.data;
      else if (Array.isArray(parsed.storyboard)) parsed = parsed.storyboard;
      else if (Array.isArray(parsed.scenes)) parsed = parsed.scenes;
    }

    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      console.warn('stepStoryboard: LLM failed to return array, using fallback', resp.content);
      return fallbackStoryboard(rawPrompt, ctx);
    }
    const shots = (parsed as LLMShot[]).map((s, i) => normalizeShot(s, i, ctx));
    return { shots };
  } catch (err) {
    console.warn('stepStoryboard: LLM failed, using fallback', err);
    return fallbackStoryboard(rawPrompt, ctx);
  }
}

function buildSystemPrompt(rawPrompt: string, ctx: StoryboardContext): string {
  const isChinese = /[\u4e00-\u9fa5]/.test(rawPrompt);
  const customPrompt = isChinese
    ? useSettingsStore.getState().settings.creative.promptTemplates?.storyboardZh
    : useSettingsStore.getState().settings.creative.promptTemplates?.storyboardEn;

  if (customPrompt && customPrompt.trim()) {
    return `${customPrompt}\n\n【画面比例】${ctx.aspectRatio}\n【默认时长】${ctx.defaultShotDuration}秒\n【风格】${ctx.style || ''}`;
  }

  if (isChinese) {
    return `你是 AI 视频分镜师。把用户的多镜头脚本切成结构化的纯中文镜头数组。

【输出规范】严格 JSON 数组,每个镜头字段:
- "videoPrompt": 纯中文 prompt,60-150 字。必须使用纯中文！严禁使用英文！必须包含：场景环境/角色具体外貌与服饰/具体动作与肢体变化/镜头视角与运动/光影与氛围
- "narration": 中文旁白,30-80 字,用于 TTS
- "location": 中文场景名
- "mood": one of [intense, warm, melancholic, mysterious, hopeful, neutral]
- "cameraMovement": one of [static, dolly_in, dolly_out, pan_left, pan_right, tilt_up, tilt_down, tracking, aerial, handheld]
- "durationSeconds": ${ctx.defaultShotDuration} 或 10
- "characterIds": 字符串数组,占位 ['char_0', 'char_1'] 等(后续会回填真实 id)
- "sceneId": 占位 'scene_0' 等

【画面比例】${ctx.aspectRatio}
【风格】${ctx.style ?? '电影级'}

【质量要求】
- videoPrompt 必须是纯中文的视觉化具体描写，禁止英文单词，禁止抽象词
- 每镜头是单镜头推拉摇移，无多视角切换
- 【全局视觉艺术风格继承】如果用户原始 prompt 中指定了全局视觉风格（例如：80-90年代邵氏武侠电影、35mm复古胶片颗粒、暖色调、戴墨镜与僧袍的胖橘猫等）：你必须在生成的每一个分镜的 "videoPrompt" 中，用纯中文显式注入并继承这些全局风格与角色外貌关键词！`;
  }

  return `You are an AI video storyboard director. Slice the user's multi-shot script into a structured array of English shots.

[Output Specs] Strict JSON array of objects with fields:
- "videoPrompt": English prompt, 60-120 words. Must contain: scene setting, character appearance, concrete action, camera angle/movement, lighting, mood.
- "narration": narration text for TTS
- "location": location name
- "mood": one of [intense, warm, melancholic, mysterious, hopeful, neutral]
- "cameraMovement": one of [static, dolly_in, dolly_out, pan_left, pan_right, tilt_up, tilt_down, tracking, aerial, handheld]
- "durationSeconds": ${ctx.defaultShotDuration} or 10
- "characterIds": string array placeholder ['char_0', 'char_1']
- "sceneId": string placeholder 'scene_0'

[Aspect Ratio] ${ctx.aspectRatio}
[Style] ${ctx.style ?? 'cinematic'}

[Quality Standards]
- videoPrompt must be vivid, concrete, and visually descriptive.
- Inherit global visual styles and character appearance details across all shot videoPrompts.`;
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

function clampDuration(v: unknown, def: 3 | 5 | 10 | 15 | 18): 3 | 5 | 10 | 15 | 18 {
  const n = Number(v);
  if (n >= 17) return 18;
  if (n >= 13) return 15;
  if (n >= 8) return 10;
  if (n >= 4) return 5;
  if (n >= 1) return 3;
  return def;
}

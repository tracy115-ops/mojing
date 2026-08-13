// ============================================================================
// Storyboard Prompt Builder — 把 RawShot 优化成视频生成模型可用的 prompt
// ============================================================================
// 调用 LLM 把粗糙的原文段落重写成：
//   - videoPrompt：精确的画面描述（场景、人物、动作、镜头、光线）
//   - imagePrompt：分镜关键帧描述（Phase 2 用）
//   - narration：旁白文本（用于 TTS）
//   - cameraMovement：推/拉/摇/移/特写
//   - 镜头时长建议（基于动作密度）
//
// 批处理：一次调用处理多个 RawShot，降低 LLM 调用次数。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import type { StoryboardShot } from '@/types/video';
import type { RawShot } from './chapter-slicer';

const MAX_SHOTS_PER_CALL = 6;

export interface StoryboardContext {
  /** 小说标题（提供风格背景） */
  novelTitle: string;
  /** 类型：fantasy / scifi / romance 等 */
  genre: string;
  /** 风格：literary / light / suspense 等 */
  style: string;
  /** 视频规格：宽高比、镜头时长 */
  aspectRatio: '16:9' | '9:16' | '1:1';
  defaultShotDuration: 3 | 5 | 10 | 18;
}

/**
 * 把 RawShot 批量转成 StoryboardShot。
 * 内部分批调用 LLM，每批 MAX_SHOTS_PER_CALL 个镜头。
 */
export async function buildStoryboard(
  rawShots: RawShot[],
  ctx: StoryboardContext,
  onProgress?: (done: number, total: number) => void,
): Promise<StoryboardShot[]> {
  const result: StoryboardShot[] = [];
  const total = rawShots.length;

  for (let i = 0; i < rawShots.length; i += MAX_SHOTS_PER_CALL) {
    const batch = rawShots.slice(i, i + MAX_SHOTS_PER_CALL);
    const shots = await processBatch(batch, ctx);
    result.push(...shots);
    onProgress?.(Math.min(i + MAX_SHOTS_PER_CALL, total), total);
  }

  return result;
}

async function processBatch(
  batch: RawShot[],
  ctx: StoryboardContext,
): Promise<StoryboardShot[]> {
  const request: LLMGenerateRequest = {
    taskType: 'translation',
    systemPrompt: buildSystemPrompt(ctx),
    userPrompt: buildUserPrompt(batch, ctx),
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 4096,
  };

  try {
    const response = await providerRouter.generate(request);
    const parsed = parseLLMJson<unknown[]>(response.content);
    if (!parsed || !Array.isArray(parsed)) {
      throw new Error('Storyboard LLM returned non-array');
    }
    return parsed.map((item, i) => normalizeShot(item, batch[i], ctx));
  } catch (err) {
    console.warn('Storyboard: LLM failed, using fallback', err);
    return batch.map((rs) => fallbackShot(rs, ctx));
  }
}

// --- prompt builders ---

function buildSystemPrompt(ctx: StoryboardContext): string {
  return `你是影视分镜师 + AI 视频提示词工程师，把小说段落重写成 AI 视频模型（Kling / Hunyuan / MiniMax / Doubao）能直接生成的精确纯中文 prompt。

【项目背景】
- 小说标题：${ctx.novelTitle}
- 类型：${ctx.genre} / 风格：${ctx.style}
- 画面比例：${ctx.aspectRatio}
- 单镜头时长：${ctx.defaultShotDuration} 秒

【输出规范】严格 JSON 数组，每个元素对应一个镜头，字段：
- "videoPrompt": 纯中文 prompt，60-150 字。必须使用纯中文！必须包含：(1) 场景环境描写 (2) 角色具体外貌与服饰 (3) 具体动作与肢体变化 (4) 镜头视角与运动 (5) 光影与氛围。不要写 "一个视频" 之类元描述。
- "imagePrompt": 纯中文 prompt，30-80 字，描述这个镜头的关键帧画面（必须纯中文）
- "narration": 中文旁白，30-80 字，用于 TTS 配音。原文已是叙述则压缩改写；原文是对话则改成第三人称描述。
- "cameraMovement": one of [static, dolly_in, dolly_out, pan_left, pan_right, tilt_up, tilt_down, tracking, aerial, handheld]
- "durationSeconds": one of [3, 5, 10, 18] (默认 ${ctx.defaultShotDuration},动作戏或长镜头可用 10 或 18)
- "mood": one of [intense, warm, melancholic, mysterious, hopeful, neutral]

【质量要求】
- videoPrompt 必须是**纯中文的视觉化具体描写**，禁止英文单词，禁止抽象词（"美丽", "戏剧性" 不算描写）
- 角色外貌用 "身穿黄僧袍，戴黑色圆墨镜，胡须明显" 这种具体形式
- 动作用 "主角缓缓走向庭院", "伸手指向对方" 这种具体动词主导句`;
}

function buildUserPrompt(batch: RawShot[], ctx: StoryboardContext): string {
  const items = batch.map((rs, i) => `--- 镜头 ${i + 1} ---
原文（第${rs.sourceChapterNumber}章）：
${rs.rawText.slice(0, 1000)}
角色：${rs.characters.join(', ') || '未识别'}
场景：${rs.location ?? '未识别'}
氛围：${rs.mood ?? '未识别'}`).join('\n\n');

  return `请把下面 ${batch.length} 个段落分别重写成视频分镜。输出严格 JSON 数组，长度必须等于 ${batch.length}。

${items}`;
}

// --- normalizers ---

function normalizeShot(item: unknown, raw: RawShot, ctx: StoryboardContext): StoryboardShot {
  const obj = (item ?? {}) as Record<string, unknown>;
  return {
    id: raw.id,
    index: raw.index,
    sourceChapterId: raw.sourceChapterId,
    sourceText: raw.rawText,
    videoPrompt: String(obj.videoPrompt ?? '').trim() || fallbackVideoPrompt(raw),
    imagePrompt: String(obj.imagePrompt ?? '').trim() || undefined,
    narration: String(obj.narration ?? '').trim() || raw.rawText.slice(0, 80),
    durationSeconds: clampDuration(obj.durationSeconds, ctx.defaultShotDuration),
    characters: raw.characters,
    location: raw.location,
    mood: validateMood(obj.mood) ?? raw.mood,
    cameraMovement: validateCamera(obj.cameraMovement) ?? defaultCamera(raw),
    dialogue: extractDialogue(raw.rawText),
  };
}

function fallbackShot(raw: RawShot, ctx: StoryboardContext): StoryboardShot {
  return {
    id: raw.id,
    index: raw.index,
    sourceChapterId: raw.sourceChapterId,
    sourceText: raw.rawText,
    videoPrompt: fallbackVideoPrompt(raw),
    narration: raw.rawText.slice(0, 80),
    durationSeconds: ctx.defaultShotDuration,
    characters: raw.characters,
    location: raw.location,
    mood: raw.mood,
    cameraMovement: defaultCamera(raw),
    dialogue: extractDialogue(raw.rawText),
  };
}

function fallbackVideoPrompt(raw: RawShot): string {
  const location = raw.location ?? 'an indoor setting';
  const mood = raw.mood ?? 'neutral';
  const action = raw.hasAction ? 'intense action sequence with dynamic movement' : 'subtle character interaction';
  return `${location}, ${mood} atmosphere, ${action}, cinematic lighting, 24fps, shot on cinema camera, shallow depth of field`;
}

function defaultCamera(raw: RawShot): string {
  if (raw.hasAction) return 'tracking';
  if (raw.hasDialogue) return 'static';
  return 'dolly_in';
}

function clampDuration(v: unknown, def: 3 | 5 | 10 | 18): 3 | 5 | 10 | 18 {
  const n = Number(v);
  // 落到 3 / 5 / 10 / 18 四个标准档位(Agnes V2.0 num_frames 81/121/241/441)
  if (n >= 15) return 18;
  if (n >= 8) return 10;
  if (n >= 4) return 5;
  if (n >= 1) return 3;
  return def;
}

function validateMood(v: unknown): string | undefined {
  const valid = ['intense', 'warm', 'melancholic', 'mysterious', 'hopeful', 'neutral'];
  return typeof v === 'string' && valid.includes(v) ? v : undefined;
}

function validateCamera(v: unknown): string | undefined {
  const valid = ['static', 'dolly_in', 'dolly_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'tracking', 'aerial', 'handheld'];
  return typeof v === 'string' && valid.includes(v) ? v : undefined;
}

function extractDialogue(text: string): { speaker: string; text: string }[] | undefined {
  const re = /["「『"]([^"」』"]{1,200})["」』"]/g;
  const out: { speaker: string; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ speaker: '未知', text: m[1] });
  }
  return out.length > 0 ? out : undefined;
}

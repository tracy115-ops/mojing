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
import { useSettingsStore } from '@/stores/settingsStore';
import { estimateSmartShotDuration } from './core/duration-estimator';

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
  /** 上一集结尾的剧情状态；只影响本次分镜规划。 */
  continuityContext?: string;
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
    taskType: 'planning',
    systemPrompt: buildSystemPrompt(batch, ctx),
    userPrompt: buildUserPrompt(batch, ctx),
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 4096,
  };

  try {
    const response = await providerRouter.generate(request);
    let parsed: any = parseLLMJson<any>(response.content);

    // 如果 LLM 返回的是对象(如 { shots: [...] } / { items: [...] } / { data: [...] }),解包出数组
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      if (Array.isArray(parsed.shots)) parsed = parsed.shots;
      else if (Array.isArray(parsed.items)) parsed = parsed.items;
      else if (Array.isArray(parsed.data)) parsed = parsed.data;
      else if (Array.isArray(parsed.storyboard)) parsed = parsed.storyboard;
      else if (Array.isArray(parsed.scenes)) parsed = parsed.scenes;
      else if (Array.isArray(parsed.result)) parsed = parsed.result;
      else if (Array.isArray(parsed.list)) parsed = parsed.list;
      else if (Array.isArray(parsed.output)) parsed = parsed.output;
      else {
        // 如果是 {"0": {...}, "1": {...}} 这种索引对象
        const vals = Object.values(parsed).filter((v) => v && typeof v === 'object' && ('videoPrompt' in (v as any) || 'sourceText' in (v as any)));
        if (vals.length > 0) parsed = vals;
      }
    }

    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Storyboard LLM returned non-array or empty array');
    }
    return parsed.map((item, i) => {
      const fallbackRaw: RawShot = batch[i] || {
        id: `shot_${i + 1}`,
        index: i,
        sourceChapterId: batch[0]?.sourceChapterId || 'ch_1',
        sourceChapterNumber: 1,
        rawText: '',
        characters: [],
        hasDialogue: false,
        hasAction: true,
      };
      return normalizeShot(item, fallbackRaw, ctx, i);
    });
  } catch (err) {
    console.warn('Storyboard: LLM failed, using distinct fallback', err);
    return batch.map((rs, i) => fallbackShot(rs, ctx, i));
  }
}

// --- prompt builders ---

function buildSystemPrompt(batch: RawShot[], ctx: StoryboardContext): string {
  const sampleText = batch.map((b) => b.rawText).join(' ');
  const isChinese = /[\u4e00-\u9fa5]/.test(sampleText);
  const customPrompt = isChinese
    ? useSettingsStore.getState().settings.creative.promptTemplates?.storyboardZh
    : useSettingsStore.getState().settings.creative.promptTemplates?.storyboardEn;

  if (customPrompt && customPrompt.trim()) {
    return `${customPrompt}\n\n【项目背景】小说标题：${ctx.novelTitle}，类型：${ctx.genre}，风格：${ctx.style}，比例：${ctx.aspectRatio}`;
  }

  if (isChinese) {
    return `你是资深影视分镜导演 + AI 视频提示词工程师，把小说章节段落重写成 AI 视频模型（Kling / Hunyuan / MiniMax / Doubao / Agnes）能直接生成的精确纯中文分镜。

【核心原则：100% 忠实还原小说/剧本原著，严禁随意精简或篡改关键剧情】
- 必须完整展现原文中发生的核心事件、人物互动、肢体动作、道具与环境变化，严禁删减核心细节！
- 角色对白与关键台词必须 100% 忠实保留原文字句，严禁改写或遗漏！

【项目背景】
- 小说标题：${ctx.novelTitle}
- 类型：${ctx.genre} / 风格：${ctx.style}
- 画面比例：${ctx.aspectRatio}
- 单镜头时长：${ctx.defaultShotDuration} 秒

【输出规范】严格 JSON 数组，每个元素对应一个镜头，字段：
- "videoPrompt": 纯中文 prompt（80-180 字）。必须采用【工业级分秒时间轴分段描写法】以确保 AI 视频模型动作连贯稳定、不乱晃不跳帧，标准结构示例：
  “建立镜头，展示山村清晨的宁静。时间轴：[0-1]秒，摄像机缓慢推近，描绘木屋门缝透出晨光；[1-3]秒，王林从木屋中缓慢走出，伸展双臂，脸上展现出青涩与懵懂神情；[3-4]秒，王林打着哈欠，金色的晨光逐渐增强并洒满院落。总时长4秒，电影级光影，写实风格。”
  要求完整包含：(1) 场景环境与主光影 (2) 出场角色的具体外貌、服饰与神态 (3) 按秒分段的具体动作演进 (4) 镜头视角运镜与总时长风格。严禁写空洞词汇！
- "imagePrompt": 纯中文 prompt，40-80 字，描述这个镜头的关键帧核心画面。
- "narration": 用于 TTS 配音的对白/旁白文本。如果原文包含角色台词/对白，必须 100% 严格保留原版台词字句（如“大师，我有一事相求！”），严禁擅自改写或精简！无台词时保留原文描述。
- "dialogue": 角色对白列表，格式 [{"speaker": "角色名", "text": "台词内容"}]
- "cameraMovement": one of [static, dolly_in, dolly_out, pan_left, pan_right, tilt_up, tilt_down, tracking, aerial, handheld]
- "durationSeconds": one of [3, 5, 10, 18] (默认 ${ctx.defaultShotDuration})
- "mood": one of [intense, warm, melancholic, mysterious, hopeful, neutral]

【质量要求】
- videoPrompt 必须是**带 [0-X]秒 时间轴标记的纯中文具体视觉化描写**，严禁抽象词
- 角色动作必须分秒推进、平滑连贯，与原文情节严密对齐
- 【原著情节绝对尊重】保留故事原汁原味与戏剧张力！`;
  }

  return `You are a film storyboard director and AI video prompt engineer. Rewrite novel excerpts into detailed English video prompts.

[Project Context]
- Novel Title: ${ctx.novelTitle}
- Genre: ${ctx.genre} / Style: ${ctx.style}
- Aspect Ratio: ${ctx.aspectRatio}
- Default Duration: ${ctx.defaultShotDuration}s

[Output Format] Strict JSON array of objects:
- "videoPrompt": English prompt, 60-120 words. Must include scene setting, character appearance, concrete action, camera angle, lighting, and mood.
- "imagePrompt": English prompt, 30-60 words.
- "narration": narration or exact character dialogue for TTS. If dialogue exists, keep it verbatim.
- "dialogue": array of { speaker, text }
- "cameraMovement": one of [static, dolly_in, dolly_out, pan_left, pan_right, tilt_up, tilt_down, tracking, aerial, handheld]
- "durationSeconds": one of [3, 5, 10, 18]`;
}

function buildUserPrompt(batch: RawShot[], ctx: StoryboardContext): string {
  const continuity = ctx.continuityContext?.trim()
    ? `【上集承接】以下是已经发生的剧情事实，分镜必须保持角色关系、情绪、场景状态和动作后果连续：${ctx.continuityContext.trim()}\n\n`
    : '';
  const items = batch.map((rs, i) => `--- 镜头 ${i + 1} ---
原文（第${rs.sourceChapterNumber}章）：
${rs.rawText.slice(0, 1000)}
角色：${rs.characters.join(', ') || '未识别'}
场景：${rs.location ?? '未识别'}
氛围：${rs.mood ?? '未识别'}`).join('\n\n');

  return `请把下面 ${batch.length} 个段落分别重写成视频分镜。输出严格 JSON 数组，长度必须等于 ${batch.length}。

${continuity}${items}`;
}

// --- normalizers ---

function normalizeShot(item: unknown, raw: RawShot, ctx: StoryboardContext, fallbackIndex = 0): StoryboardShot {
  const obj = (item ?? {}) as Record<string, unknown>;
  const itemDialogue = Array.isArray(obj.dialogue) && obj.dialogue.length > 0 ? (obj.dialogue as { speaker: string; text: string }[]) : undefined;
  const rawDialogue = raw.rawText ? extractDialogue(raw.rawText) : undefined;
  const dialogue = itemDialogue || rawDialogue;

  let narration = '';
  if (obj.narration && String(obj.narration).trim()) {
    narration = String(obj.narration).trim();
  } else if (dialogue && dialogue.length > 0 && dialogue[0].text?.trim()) {
    narration = dialogue[0].text.trim();
  } else if (raw.rawText) {
    narration = raw.rawText.slice(0, 80);
  } else {
    narration = `镜头 ${fallbackIndex + 1}`;
  }

  const shotIndex = typeof obj.index === 'number' ? obj.index : (raw.index !== undefined ? raw.index : fallbackIndex);
  const shotId = obj.id ? String(obj.id) : (raw.id && raw.id !== 'shot_1' ? raw.id : `shot_${shotIndex + 1}`);
  const shotSourceText = String(obj.sourceText || raw.rawText || obj.videoPrompt || `镜头 ${shotIndex + 1}`).trim();
  const shotVideoPrompt = String(obj.videoPrompt || obj.sourceText || raw.rawText || '').trim() || fallbackVideoPrompt(raw, shotIndex);
  const cameraMovement = validateCamera(obj.cameraMovement) ?? defaultCamera(raw);

  const durationSeconds = estimateSmartShotDuration({
    text: shotVideoPrompt,
    narration,
    dialogue,
    cameraMovement,
    hasAction: raw.hasAction,
    hasDialogue: raw.hasDialogue,
    explicitDuration: typeof obj.durationSeconds === 'number' ? obj.durationSeconds : undefined,
    defaultShotDuration: ctx.defaultShotDuration,
  });

  return {
    id: shotId,
    index: shotIndex,
    sourceChapterId: raw.sourceChapterId || 'ch_1',
    sourceText: shotSourceText,
    videoPrompt: shotVideoPrompt,
    imagePrompt: String(obj.imagePrompt ?? '').trim() || undefined,
    narration,
    durationSeconds,
    characters: (Array.isArray(obj.characters) && obj.characters.length ? obj.characters : raw.characters) as string[],
    location: (obj.location as string) || raw.location,
    mood: validateMood(obj.mood) ?? raw.mood,
    cameraMovement,
    dialogue,
  };
}

function fallbackShot(raw: RawShot, ctx: StoryboardContext, index = 0): StoryboardShot {
  const dialogue = extractDialogue(raw.rawText);
  const narration = dialogue?.[0]?.text?.trim() || raw.rawText.slice(0, 80);
  const videoPrompt = raw.rawText && raw.rawText.trim() ? raw.rawText.trim() : fallbackVideoPrompt(raw, index);
  const cameraMovement = defaultCamera(raw);
  const durationSeconds = estimateSmartShotDuration({
    text: videoPrompt,
    narration,
    dialogue,
    cameraMovement,
    hasAction: raw.hasAction,
    hasDialogue: raw.hasDialogue,
    defaultShotDuration: ctx.defaultShotDuration,
  });

  return {
    id: raw.id || `shot_${index + 1}`,
    index: raw.index !== undefined ? raw.index : index,
    sourceChapterId: raw.sourceChapterId,
    sourceText: raw.rawText || `镜头 ${index + 1}`,
    videoPrompt,
    narration,
    durationSeconds,
    characters: raw.characters,
    location: raw.location,
    mood: raw.mood,
    cameraMovement,
    dialogue,
  };
}

function fallbackVideoPrompt(raw: RawShot, index = 0): string {
  if (raw.rawText && raw.rawText.trim()) return raw.rawText.trim();
  const location = raw.location ?? `场景 ${index + 1}`;
  const mood = raw.mood ?? '自然氛围';
  const action = raw.hasAction ? '主体生动动作，动态运镜' : '人物神态特写，环境光影流动';
  return `第 ${index + 1} 镜头：${location}，${mood}，${action}，高清电影级光影，景深虚化`;
}

function defaultCamera(raw: RawShot): string {
  if (raw.hasAction) return 'tracking';
  if (raw.hasDialogue) return 'static';
  return 'dolly_in';
}

function validateMood(v: unknown): string | undefined {
  const valid = ['intense', 'warm', 'melancholic', 'mysterious', 'hopeful', 'neutral'];
  return typeof v === 'string' && valid.includes(v) ? v : undefined;
}

function validateCamera(v: unknown): string | undefined {
  const valid = ['static', 'dolly_in', 'dolly_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'tracking', 'aerial', 'handheld'];
  return typeof v === 'string' && valid.includes(v) ? v : undefined;
}

export function extractDialogue(text: string): { speaker: string; text: string }[] | undefined {
  if (!text) return undefined;
  const out: { speaker: string; text: string }[] = [];

  // 1. 匹配类似 "女生台词：大师，我有一事相求！" 或 "猫咪台词: 竹篮打水一场空"
  const linePattern = /(?:^|[，。\s\n])([一-龥A-Za-z0-9_]{1,8})(?:台词|对白)?[:：]\s*([“"「『]?[^，。\n”"」』]{1,200}[”"」』]?)/g;
  let lm: RegExpExecArray | null;
  while ((lm = linePattern.exec(text)) !== null) {
    const speaker = lm[1].trim();
    let dialogueText = lm[2].trim().replace(/^[“"「『]/, '').replace(/[”"」』]$/, '');
    if (
      speaker &&
      dialogueText &&
      !['分镜', '镜头', '场景', '地点', '时间', '氛围', '画面', '全景', '中景', '近景', '特写'].includes(speaker)
    ) {
      out.push({ speaker, text: dialogueText });
    }
  }

  if (out.length > 0) return out;

  // 2. 匹配角色名加引号对白，如 女生：“大师，我有一事相求！” 或 「xxx」
  const quotePattern = /(?:([一-龥A-Za-z0-9_]{1,8})[:：\s]*)?[“"「『]([^”"」』]{1,200})[”"」』]/g;
  let qm: RegExpExecArray | null;
  while ((qm = quotePattern.exec(text)) !== null) {
    const speaker = qm[1]?.trim() || '未知';
    const dialogueText = qm[2].trim();
    if (dialogueText) {
      out.push({ speaker, text: dialogueText });
    }
  }

  return out.length > 0 ? out : undefined;
}

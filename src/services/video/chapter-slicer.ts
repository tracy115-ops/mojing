// ============================================================================
// Chapter Slicer — 把章节正文切成可单独生成视频的段落（"raw shots"）
// ============================================================================
// 切片启发式：
//   1. 优先按场景分隔（空行 + 地点/时间线索）
//   2. 段落字符数到达上限（默认 600-1200 字）时强制切
//   3. 对话密集区合并、动作描写区分细
//
// 输出：RawShot[] —— 尚未生成 videoPrompt，等待 storyboard-prompt.ts 优化。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import { detectInputLanguage } from './core/lang-detector';
import {
  sliceChapters,
  type ChapterInput,
  type RawShot,
  type SliceOptions,
} from './chapter-slicer-core';
export { sliceChapters } from './chapter-slicer-core';
export type { ChapterInput, RawShot, SliceOptions } from './chapter-slicer-core';
import type { ShotCharacterBinding } from '../../types/video';

/**
 * 使用 LLM 大模型进行智能语义分镜切片，确保 100% 完整覆盖原著情节与对话。
 */
export async function sliceChaptersWithLLM(
  chapters: ChapterInput[],
  opts: SliceOptions = {},
): Promise<RawShot[]> {
  const fullText = chapters.map((c) => c.content || '').join('\n\n').trim();
  if (!fullText) return [];
  const sourceLanguage = detectInputLanguage(fullText);

  const systemPrompt = [
    'You are a source-preserving shot segmentation model.',
    'Split the supplied chapters into ordered video shot segments without deleting, rewriting, or inventing source events or dialogue.',
    'Keep each sourceText as an exact contiguous excerpt from the input whenever possible. A cut may follow an action change, scene change, state change, or dialogue turn.',
    'visibleCharacters contains only entities explicitly framed in that shot. offscreenCharacters contains mentioned entities that remain outside the frame. Do not create entity names.',
    sourceLanguage === 'zh'
      ? 'Write location and mood in Simplified Chinese when they are present in the source. Do not translate source text or entity names into English.'
      : 'Write location and mood in English when they are present in the source. Do not translate source text or entity names into Chinese.',
    'Return only a JSON array. Each item must contain index, sourceChapterId, sourceChapterNumber, sourceText, visibleCharacters, offscreenCharacters, location, mood, hasDialogue, and hasAction.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    chapters,
    targetWordsPerShot: opts.targetWordsPerShot,
    minWordsPerShot: opts.minWordsPerShot,
    maxWordsPerShot: opts.maxWordsPerShot,
    isScript: opts.isScript,
  }, null, 2);

  const request: LLMGenerateRequest = {
    taskType: 'planning',
    systemPrompt,
    userPrompt,
    responseFormat: 'json',
    temperature: 0.3,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    let parsed: any = parseLLMJson<any>(resp.content);

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
        const vals = Object.values(parsed).filter((v) => v && typeof v === 'object' && ('sourceText' in (v as any) || 'videoPrompt' in (v as any) || 'text' in (v as any)));
        if (vals.length > 0) parsed = vals;
      }
    }

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((item: any, idx: number) => {
        const text = String(item.sourceText || item.rawText || item.text || item.videoPrompt || `镜头 ${idx + 1}`).trim();
        const chapter = resolveChapter(item, text, chapters);
        const hasVisibleList = Array.isArray(item.visibleCharacters) || Array.isArray(item.visibleCharacterIds);
        const visibleCharacters = Array.isArray(item.visibleCharacters)
          ? item.visibleCharacters.map(String)
          : Array.isArray(item.visibleCharacterIds)
            ? item.visibleCharacterIds.map(String)
            : Array.isArray(item.characters)
              ? item.characters.map(String)
              : [];
        const offscreenCharacters = Array.isArray(item.offscreenCharacters)
          ? item.offscreenCharacters.map(String)
          : Array.isArray(item.offscreenCharacterIds)
            ? item.offscreenCharacterIds.map(String)
            : [];
        return {
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `shot_${chapter.number}_${idx}`,
          index: idx,
          sourceChapterId: chapter.id,
          sourceChapterNumber: chapter.number,
          rawText: text,
          characters: visibleCharacters,
          offscreenCharacters,
          characterBinding: hasVisibleList ? 'explicit' as ShotCharacterBinding : 'inferred' as ShotCharacterBinding,
          location: typeof item.location === 'string' ? item.location.trim() || undefined : undefined,
          mood: typeof item.mood === 'string' ? item.mood.trim() || undefined : undefined,
          hasDialogue: typeof item.hasDialogue === 'boolean' ? item.hasDialogue : /["「『":：]/.test(text),
          hasAction: typeof item.hasAction === 'boolean' ? item.hasAction : false,
        };
      });
    }
  } catch (err) {
    console.warn('[chapter-slicer] LLM slicing failed, falling back to local heuristic', err);
  }

  // 兜底：使用无 provider 依赖的本地规则切片
  return sliceChapters(chapters, opts);
}

function resolveChapter(
  item: Record<string, unknown>,
  sourceText: string,
  chapters: ChapterInput[],
): ChapterInput {
  const explicitId = typeof item.sourceChapterId === 'string' ? item.sourceChapterId.trim() : '';
  if (explicitId) {
    const byId = chapters.find((chapter) => chapter.id === explicitId);
    if (byId) return byId;
  }
  const explicitNumber = Number(item.sourceChapterNumber);
  if (Number.isFinite(explicitNumber)) {
    const byNumber = chapters.find((chapter) => chapter.number === explicitNumber);
    if (byNumber) return byNumber;
  }
  const normalized = sourceText.replace(/\s+/g, '');
  const byExcerpt = chapters.find((chapter) => {
    const chapterText = chapter.content.replace(/\s+/g, '');
    return normalized.length >= 12 && chapterText.includes(normalized);
  });
  return byExcerpt ?? chapters[0] ?? { id: 'ch_1', number: 1, content: '' };
}

function detectCharacters(text: string): string[] {
  // 启发式：从小说对话引用或剧本对话中提取说话人
  const speakers = new Set<string>();
  // 1. "xxx说" / 「xxx」xxx 道
  const novelPatterns = [
    /["「『"]([^"」』"]{1,8}?)["」』"]\s*[说道笑道喊道问]/g,
    /^(\S{1,8})[说道笑道喊道问]/gm,
  ];
  for (const re of novelPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]?.trim();
      if (name && name.length <= 8 && !/[\s，。！？]/.test(name)) {
        speakers.add(name);
      }
    }
  }

  // 2. 剧本格式：角色名：/ 角色名: / 角色名（动作）：
  const scriptPatterns = [
    /^([一-龥A-Za-z0-9_]{1,8})(?:（[^）]+）|\([^)]+\))?[:：]/gm,
    /【([一-龥A-Za-z0-9_]{1,8})】/g,
  ];
  for (const re of scriptPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]?.trim();
      if (name && name.length <= 8 && !/[\s，。！？]/.test(name) && !['场景', '镜头', '旁白', '画面', '音乐', '音效', '时间', '地点'].includes(name)) {
        speakers.add(name);
      }
    }
  }

  return [...speakers].slice(0, 6);
}

function detectLocation(text: string): string | undefined {
  // "在 xxx" / "xxx 内" / "xxx 之外" / "地点：xxx"
  const locMatch = text.match(/(?:地点|场景)[:：]\s*([一-龥A-Za-z0-9_]{2,12})/);
  if (locMatch) return locMatch[1];

  const m = text.match(/(?:在|回到|进入|离开|来到)([一-龥A-Za-z]{2,8}?)(?:的|里|内|中|前|后|之外|之上|之下)?(?:[，。！？\s])/);
  return m?.[1];
}

function detectMood(text: string): string | undefined {
  if (/(战斗|杀|血|死亡|恐惧|愤怒|咆哮|爆炸)/.test(text)) return 'intense';
  if (/(笑|温柔|温暖|拥抱|亲吻|爱)/.test(text)) return 'warm';
  if (/(悲伤|哭泣|眼泪|失去|孤独|绝望)/.test(text)) return 'melancholic';
  if (/(神秘|阴影|悄然|诡异|黑暗)/.test(text)) return 'mysterious';
  if (/(日出|清晨|光明|希望|新生)/.test(text)) return 'hopeful';
  return undefined;
}

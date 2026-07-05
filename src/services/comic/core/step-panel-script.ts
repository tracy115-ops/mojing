// step-panel-script.ts — 漫画步 2:LLM 把主题拆成分镜脚本
//
// 输入:主题 / 粘贴文本 + 角色列表 + 期望分镜数
// 输出:ComicPanelSpec[](画面描述 + 对白 + 角色 ID + 景别)
//
// 失败兜底:LLM 返回不合规 JSON → parseLLMJson 返回 null → fallback
// 按段落切分(每段一镜),保证不阻塞流程。

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import { logger } from '@/services/log';
import type { ComicPanelSpec, ComicCharacterAnchor } from '@/types/comic';
import type { AspectRatio } from '@/types/video';

export interface PanelScriptContext {
  /** 期望分镜数 */
  panelCount: number;
  /** 画风(manga / western / watercolor / ...) */
  style: string;
  aspectRatio: AspectRatio;
}

export interface PanelScriptResult {
  panels: ComicPanelSpec[];
  /** LLM 同时产出的角色(仅当输入 characters 为空时填) */
  extractedCharacters?: ComicCharacterAnchor[];
  /** LLM 调用是否失败(失败时用 fallback) */
  degraded: boolean;
}

interface LLMPanelsResponse {
  panels?: LLMPanel[];
  /** 输入没角色时,LLM 可顺带产出角色定义 */
  characters?: LLMCharacter[];
}

interface LLMPanel {
  description?: string;
  dialogue?: string;
  characterIds?: string[];
  shotType?: string;
}

interface LLMCharacter {
  id?: string;
  name?: string;
  appearance?: string;
  personality?: string;
}

/**
 * 步 2:把主题拆成分镜。
 *
 * @param input 主题 / 粘贴文本 / 章节内容
 * @param existingCharacters 用户在创建时填的角色(可空)
 * @param ctx 画风 / 比例 / 期望镜数
 */
export async function runPanelScript(
  input: string,
  existingCharacters: ComicCharacterAnchor[],
  ctx: PanelScriptContext,
): Promise<PanelScriptResult> {
  const request: LLMGenerateRequest = {
    taskType: 'translation',
    systemPrompt: buildSystemPrompt(ctx, existingCharacters.length === 0),
    userPrompt: buildUserPrompt(input, existingCharacters, ctx),
    responseFormat: 'json',
    temperature: 0.7,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    const parsed = parseLLMJson<LLMPanelsResponse>(resp.content);
    if (!parsed || !Array.isArray(parsed.panels) || parsed.panels.length === 0) {
      void logger.warn('[comic/panel-script] LLM 返回空 panels,使用 fallback', 'comic');
      return fallbackResult(input, existingCharacters, ctx);
    }
    const panels = parsed.panels.slice(0, ctx.panelCount * 2).map((p, i) =>
      normalizePanel(p, i, existingCharacters),
    );
    const extractedCharacters =
      existingCharacters.length === 0 && Array.isArray(parsed.characters)
        ? parsed.characters
            .filter((c) => c?.name && c?.appearance)
            .map((c, idx) => normalizeExtractedCharacter(c, idx))
        : undefined;
    return { panels, extractedCharacters, degraded: false };
  } catch (err) {
    void logger.warn(
      `[comic/panel-script] LLM 调用失败,使用 fallback: ${err instanceof Error ? err.message : String(err)}`,
      'comic',
    );
    return fallbackResult(input, existingCharacters, ctx);
  }
}

// --- Prompt 构造 ---

function buildSystemPrompt(ctx: PanelScriptContext, allowExtractChars: boolean): string {
  return `你是漫画分镜师。把用户给的主题/文本拆成 ${ctx.panelCount} 个漫画分镜。

【输出规范】严格 JSON 对象,字段:
- "panels": 数组,每镜字段:
  - "description": 英文画面描述,40-80 词。必须含:scene setting / character appearance / action / composition / mood。视觉化、具体化,禁止抽象词。
  - "dialogue": 中文对白/旁白,单镜不超过 30 字(可空)
  - "characterIds": 字符串数组,引用下方角色列表的 id(如 ["char_0"]);无角色则空数组 []
  - "shotType": one of ["close-up", "medium", "wide", "establishing"]
${allowExtractChars ? `- "characters": 数组(输入没提供角色时才填,否则省略此字段),每字段:
  - "id": "char_0" / "char_1"...
  - "name": 角色名(中英文皆可)
  - "appearance": 完整外貌(gender/age/face/hair/clothing),40-80 字
  - "personality": 性格简述(可空)` : ''}

【画风】${ctx.style}
【画幅】${ctx.aspectRatio}

【质量要求】
- 每镜画面信息量足够 AI 出图(不能只写"角色出场")
- 视觉节奏起伏(近景/远景/特写交替,shotType 多样化)
- 角色动作要具体("右手举起杯子"优于"喝水")
- 对白简短自然
- description 不能含文字渲染要求(对白靠后期烧录,不要让 AI 画字)`;
}

function buildUserPrompt(
  input: string,
  characters: ComicCharacterAnchor[],
  ctx: PanelScriptContext,
): string {
  const parts: string[] = [];
  parts.push(`【主题 / 文本】\n${input.trim()}`);
  if (characters.length > 0) {
    parts.push(
      `【角色列表】(characterIds 引用这些 id)\n${characters
        .map((c) => `- ${c.id}: ${c.name} — ${c.appearance}`)
        .join('\n')}`,
    );
  }
  parts.push(`【期望分镜数】${ctx.panelCount}`);
  return parts.join('\n\n');
}

// --- 归一化 ---

function normalizePanel(
  item: LLMPanel,
  index: number,
  characters: ComicCharacterAnchor[],
): ComicPanelSpec {
  // 过滤无效 characterIds(LLM 可能瞎编 ID)
  const validIds = new Set(characters.map((c) => c.id));
  const rawIds = Array.isArray(item.characterIds) ? item.characterIds : [];
  const characterIds = rawIds.filter((id) => validIds.has(String(id))).map(String);

  const shotType = normalizeShotType(item.shotType);
  return {
    id: `panel_${Date.now().toString(36)}_${index}`,
    index,
    description: String(item?.description ?? '').trim(),
    dialogue: item?.dialogue ? String(item.dialogue).trim() : undefined,
    characterIds,
    shotType,
  };
}

function normalizeShotType(raw?: string): ComicPanelSpec['shotType'] {
  if (!raw) return 'medium';
  const s = String(raw).toLowerCase().trim();
  if (s === 'close-up' || s === 'closeup' || s === 'close') return 'close-up';
  if (s === 'medium') return 'medium';
  if (s === 'wide') return 'wide';
  if (s === 'establishing') return 'establishing';
  return 'medium';
}

function normalizeExtractedCharacter(
  c: LLMCharacter,
  idx: number,
): ComicCharacterAnchor {
  return {
    id: c.id && c.id.startsWith('char_') ? c.id : `char_${idx}`,
    name: String(c.name ?? `角色${idx + 1}`).trim(),
    appearance: String(c.appearance ?? '').trim(),
    personality: c.personality ? String(c.personality).trim() : undefined,
    firstAppearPanelIndex: 0,
  };
}

// --- Fallback(无 LLM 时按段落切) ---

function fallbackResult(
  input: string,
  existingCharacters: ComicCharacterAnchor[],
  ctx: PanelScriptContext,
): PanelScriptResult {
  const text = input.trim();
  // 按双换行 / 单换行 / 句号切
  const chunks = text
    .split(/\n\s*\n|\n|(?<=[。!!?])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
  const count = Math.min(ctx.panelCount, Math.max(1, chunks.length));
  const usedChunks = chunks.slice(0, count);
  // 不够则循环填充
  while (usedChunks.length < count) {
    usedChunks.push(usedChunks[usedChunks.length - 1] ?? text.slice(0, 80));
  }

  const panels: ComicPanelSpec[] = usedChunks.map((chunk, i) => ({
    id: `panel_fallback_${Date.now().toString(36)}_${i}`,
    index: i,
    description: `${chunk}, ${ctx.style} style, comic panel composition, clean line art, high detail, no text`,
    dialogue: undefined,
    characterIds: existingCharacters.slice(0, 2).map((c) => c.id),
    shotType: i === 0 ? 'establishing' : i % 3 === 0 ? 'close-up' : 'medium',
  }));

  return { panels, degraded: true };
}

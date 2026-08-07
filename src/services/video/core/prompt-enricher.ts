// prompt-enricher.ts — 动态 LLM 提示词增强矩阵
// 在文生图/图生视频前，自动调用配置好的 LLM 文本模型，
// 对角色立绘、场景背景、关键帧图像的提示词进行专业级的膨胀与风格优化。

import { providerRouter } from '@/services/providers';
import type { CharacterAnchor, SceneAnchor } from '@/types/video';
import { getStyleEnhancers } from './step-video-gen';

/**
 * 调配置好的 LLM 文本模型，将角色外观动态扩展为工业级高精度生图 Prompt。
 */
export async function enrichCharacterPromptWithLLM(
  c: CharacterAnchor,
  style?: string,
  costumeOverride?: string,
): Promise<string> {
  const fullText = `${c.name} ${c.appearance} ${style || ''} ${costumeOverride || ''}`;
  const styleEnhancer = getStyleEnhancers(fullText, style);

  try {
    const resp = await providerRouter.generate({
      taskType: 'prompt_optimization',
      systemPrompt: `You are an expert AI character portrait prompt engineer. Convert the given character features into a concise, detailed, high-quality English image generation prompt for a single centered character portrait.
CRITICAL MANDATE: You MUST preserve 100% of the user's specific raw description details (such as retro 80s film style, specific clothing, hair, colors, photorealistic features). Do NOT drop, modify, or dilute any specific user keywords!
Output ONLY the raw prompt text, no explanation, no markdown quotes. Must include "solo, 1person, single centered character portrait". Keep under 120 words.`,
      userPrompt: `Character Name: ${c.name}
Features: ${c.appearance}
Costume: ${costumeOverride || 'default'}
Style: ${style || 'cinematic'}`,
      temperature: 0.3,
      maxTokens: 250,
    });

    const enriched = resp.content.trim().replace(/^["']|["']$/g, '');
    if (enriched && enriched.length > 10) {
      return `${enriched}, solo, 1person, ${styleEnhancer}, high quality, no text, no watermark, no bad anatomy`;
    }
  } catch (err) {
    console.warn(`enrichCharacterPromptWithLLM: LLM fallback for ${c.name}`, err);
  }

  return defaultCharacterPrompt(c, style, costumeOverride, styleEnhancer);
}

/**
 * 调 LLM 将场景背景描述动态扩展为高清不带人像的环境空景图 Prompt。
 */
export async function enrichScenePromptWithLLM(
  s: SceneAnchor,
  style?: string,
): Promise<string> {
  try {
    const resp = await providerRouter.generate({
      taskType: 'prompt_optimization',
      systemPrompt: `You are an expert AI landscape prompt engineer. Convert the scene description into an atmospheric, highly detailed English background landscape prompt.
CRITICAL MANDATE: Strip away ALL characters, people, names (such as 'fat cat', 'girl', 'hero', 'person'), and character actions. Describe ONLY the physical architecture, nature, scenery, atmosphere, and lighting.
Output ONLY the raw prompt text, no explanation, no quotes. Must specify "empty background scenery, zero humans, no people, no characters". Keep under 100 words.`,
      userPrompt: `Scene Name: ${s.name}
Description: ${sanitizeSceneDescription(s.description)}
Style: ${style || 'cinematic'}`,
      temperature: 0.3,
      maxTokens: 250,
    });

    const enriched = resp.content.trim().replace(/^["']|["']$/g, '');
    if (enriched && enriched.length > 10) {
      return `${enriched}, empty background scenery, zero humans, no people, no characters, ${style ? `${style} style` : ''}, 8k detail, cinematic lighting, no text, no watermark`;
    }
  } catch (err) {
    console.warn(`enrichScenePromptWithLLM: LLM fallback for ${s.name}`, err);
  }

  return defaultScenePrompt(s, style);
}

function defaultCharacterPrompt(
  c: CharacterAnchor,
  style?: string,
  costumeOverride?: string,
  styleEnhancer?: string,
): string {
  const isCartoonOrAnime = /anime|2d|comic|manga|二次元|动漫|动画|手绘|卡通|插画/i.test(`${c.name} ${c.appearance} ${style || ''}`);
  const artTypeTag = isCartoonOrAnime
    ? 'high quality 2D anime character sheet, detailed anime artwork'
    : 'photorealistic portrait photography, high quality cinematic character photo, hyperrealistic detailed features';

  return [
    `solo, 1person, single character portrait of ${c.name}`,
    `character appearance and physical features: ${c.appearance}`,
    costumeOverride ? `wearing ${costumeOverride}` : '',
    'neutral pose, plain simple solid background, studio lighting',
    'full body visible from head to toe, single centered figure',
    artTypeTag,
    styleEnhancer,
    'no text, no watermark, no signature, no extra people, no bad anatomy',
  ].filter(Boolean).join(', ');
}

function sanitizeSceneDescription(desc: string): string {
  if (!desc) return '';
  return desc
    .replace(/(主角|女主角|男主角|角色|人物|人影|猫咪|猫大师|胖橘猫|女生|少年|少女|老人|他|她|他们)[在|与|和|着|了|的|中]*/g, '')
    .trim();
}

function defaultScenePrompt(s: SceneAnchor, style?: string): string {
  return [
    `environment establishing shot of ${s.name}`,
    sanitizeSceneDescription(s.description),
    'empty scene, no humans, no people, no character, background scenery only',
    'wide angle, cinematic composition, rule of thirds, atmospheric lighting',
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark, no signature, no people',
  ].filter(Boolean).join(', ');
}

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
      systemPrompt: `You are an expert AI character portrait prompt engineer specializing in Chinese and Asian novel characters.
CRITICAL MANDATE:
1. Unless explicitly requested as Western/Caucasian, characters MUST be rendered with gorgeous East Asian / Chinese aesthetic features (delicate Chinese facial features, fair porcelain skin, silky black hair, elegant almond eyes, high nose bridge, Chinese goddess beauty aesthetic).
2. Must be a SINGLE INDIVIDUAL figure in frame. Do NOT include words like "character sheet", "model sheet", "turnaround", "multiple views".
3. You MUST preserve 100% of the user's specific raw description details (such as retro 80s film style, specific clothing, hair, colors, photorealistic features). Do NOT drop, modify, or dilute any specific user keywords!
Output ONLY the raw prompt text, no explanation, no markdown quotes. Must include "solo, 1person, gorgeous East Asian Chinese beauty, single centered character portrait". Keep under 120 words.`,
      userPrompt: `Character Name: ${c.name}
Features: ${c.appearance}
Costume: ${costumeOverride || 'default'}
Style: ${style || 'cinematic'}`,
      temperature: 0.3,
      maxTokens: 250,
    });

    const enriched = resp.content.trim().replace(/^["']|["']$/g, '');
    if (enriched && enriched.length > 10) {
      return `${enriched}, solo, 1person, gorgeous East Asian Chinese beauty, delicate Chinese facial features, fair porcelain skin, ${styleEnhancer}, high quality, no text, no watermark, no bad anatomy, no character sheet, no turnaround, no multiple views`;
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
  const fullText = `${c.name} ${c.appearance} ${style || ''}`;
  const isCartoonOrAnime = /anime|2d|comic|manga|二次元|动漫|动画|手绘|卡通|插画/i.test(fullText);
  const isExplicitlyWestern = /western|caucasian|american|european|blond|blonde|blue eyes|欧美|白人|金发/i.test(fullText);
  const asianBeautyTag = !isExplicitlyWestern
    ? 'gorgeous East Asian Chinese beauty, delicate Chinese facial features, fair porcelain skin, silky black hair, elegant almond eyes'
    : '';

  const artTypeTag = isCartoonOrAnime
    ? 'high quality 2D anime single character portrait, detailed anime artwork'
    : 'photorealistic portrait photography, high quality cinematic character photo, hyperrealistic detailed features';

  return [
    `solo, 1person, single character portrait of ${c.name}`,
    asianBeautyTag,
    `character appearance and physical features: ${c.appearance}`,
    costumeOverride ? `wearing ${costumeOverride}` : '',
    'neutral pose, plain simple solid background, studio lighting',
    'full body visible from head to toe, single centered figure',
    artTypeTag,
    styleEnhancer,
    'no text, no watermark, no signature, no extra people, no bad anatomy, no character sheet, no turnaround, no multiple views, caucasian, western face',
  ].filter(Boolean).join(', ');
}

function sanitizeSceneDescription(desc: string): string {
  if (!desc) return '';
  return desc
    .replace(/(主角|女主角|男主角|角色|人物|人影|猫咪|猫大师|胖橘猫|女生|少年|少女|老人|他|她|他们)[在|与|和|着|了|的|中]*/g, '')
    .replace(/(特写|特写镜头|近景|面部特写|眼神特写|镜头推近|推镜头|特写画面)/g, '')
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

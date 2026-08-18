// prompt-enricher.ts — 动态 LLM 提示词增强矩阵
// 在文生图/图生视频前，自动调用配置好的 LLM 文本模型，
// 对角色立绘、场景背景、关键帧图像的提示词进行专业级的膨胀与风格优化。

import { providerRouter } from '@/services/providers';
import type { CharacterAnchor, SceneAnchor } from '@/types/video';
import { getStyleEnhancers } from './step-video-gen';
import { getCharacterAestheticTag } from './step-character-anchor';
import { detectInputLanguage } from './lang-detector';
import { useSettingsStore } from '@/stores/settingsStore';

export function getStyleNameZh(style?: string): string {
  if (!style) return '电影级';
  const s = style.toLowerCase();
  if (s === 'cinematic') return '电影级';
  if (s === 'anime' || s === '2d') return '2D动漫';
  if (s === 'cyberpunk') return '赛博朋克';
  if (s === 'documentary' || s === 'realistic') return '写实纪录片';
  if (s === 'wuxia') return '武侠古风';
  return style;
}

/**
 * 调配置好的 LLM 文本模型，将角色外观动态扩展为工业级高精度生图 Prompt。
 */
export async function enrichCharacterPromptWithLLM(
  c: CharacterAnchor,
  style?: string,
  costumeOverride?: string,
): Promise<string> {
  const fullText = `${c.name} ${c.appearance} ${style || ''} ${costumeOverride || ''}`;
  const lang = detectInputLanguage(fullText);
  const isChinese = lang === 'zh';
  const styleEnhancer = getStyleEnhancers(fullText, style);
  const aestheticTag = getCharacterAestheticTag(fullText);
  const styleZh = getStyleNameZh(style);

  const customSystem = isChinese
    ? useSettingsStore.getState().settings.creative.promptTemplates?.portraitZh
    : useSettingsStore.getState().settings.creative.promptTemplates?.portraitEn;

  const defaultSystemZh = `你是 AI 角色立绘提示词专家。把角色外貌描述扩展为高精度的纯中文角色立绘提示词。
【核心要求】：
1. 必须使用 100% 纯中文！严禁包含英文单词或中英混排。
2. 描述单人全身立绘，禁止出现"三视图"、"多视角"。
3. 必须 100% 完整保留用户的全部原词细节（如黄色僧袍、墨镜、胖橘猫等）。输出纯文本，不超过120字。`;

  const defaultSystemEn = `You are an expert AI character portrait prompt engineer.
CRITICAL MANDATE:
1. Output MUST be 100% in English! No Chinese characters.
2. Must be a SINGLE INDIVIDUAL figure in frame. Do NOT include words like "character sheet", "turnaround", "multiple views".
3. Preserve 100% of user raw details. Keep under 120 words.`;

  const systemPrompt = customSystem && customSystem.trim() ? customSystem : (isChinese ? defaultSystemZh : defaultSystemEn);

  try {
    const userPrompt = isChinese
      ? `角色姓名：${c.name}\n外貌描写：${c.appearance}\n变装说明：${costumeOverride || '默认服饰'}\n艺术风格：${styleZh}`
      : `Character Name: ${c.name}\nFeatures: ${c.appearance}\nCostume: ${costumeOverride || 'default'}\nStyle: ${style || 'cinematic'}`;

    const resp = await providerRouter.generate({
      taskType: 'prompt_optimization',
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      maxTokens: 250,
    });

    const enriched = resp.content.trim().replace(/^["']|["']$/g, '');
    if (enriched && enriched.length > 10) {
      if (isChinese) {
        return `【角色主体与服装造型】${c.name}：${c.appearance}${costumeOverride ? `，身穿专属服装【${costumeOverride}】` : ''}。${enriched}，单人居中全身立绘，从头到脚完整可见，纯色干净简洁背景，专业工作室光照，${aestheticTag ? `${aestheticTag}，` : ''}${styleEnhancer}，高清晰度，极致细节，无文字，无水印，无签名，无多余人物，无残缺，无三视图`;
      }
      return `[Character & Costume Subject] ${c.name}: ${c.appearance}${costumeOverride ? `, wearing ${costumeOverride}` : ''}. ${enriched}, single centered full-body character portrait, fully visible from head to toe, plain solid clean background, professional studio lighting, ${aestheticTag ? `${aestheticTag}, ` : ''}${styleEnhancer}, masterpiece quality, sharp focus, no text, no watermark, no signature, no extra people, no bad anatomy, no character sheet, no turnaround, no multiple views`;
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
  const fullText = `${s.name} ${s.description} ${style || ''}`;
  const lang = detectInputLanguage(fullText);
  const isChinese = lang === 'zh';
  const styleZh = getStyleNameZh(style);

  const customSystem = isChinese
    ? useSettingsStore.getState().settings.creative.promptTemplates?.sceneZh
    : useSettingsStore.getState().settings.creative.promptTemplates?.sceneEn;

  const defaultSystemZh = `你是 AI 场景背景提示词专家。将场景描述转为大气高精度的纯中文环境空景图提示词。
【核心要求】：
1. 必须使用 100% 纯中文！严禁包含英文单词或中英混排。
2. 剔除所有人物、角色、姓名和动作，仅描述建筑、自然、环境光影。
3. 显式包含"纯环境空景，无人物，无角色"。输出纯文本，不超过100字。`;

  const defaultSystemEn = `You are an expert AI landscape prompt engineer. Convert scene description into English background landscape prompt.
CRITICAL MANDATE: Strip away ALL characters, people, and actions. Describe ONLY physical scenery. Specify "empty background scenery, zero humans, no people". Keep under 100 words.`;

  const systemPrompt = customSystem && customSystem.trim() ? customSystem : (isChinese ? defaultSystemZh : defaultSystemEn);

  try {
    const userPrompt = isChinese
      ? `场景名称：${s.name}\n场景描写：${sanitizeSceneDescription(s.description)}\n艺术风格：${styleZh}`
      : `Scene Name: ${s.name}\nDescription: ${sanitizeSceneDescription(s.description)}\nStyle: ${style || 'cinematic'}`;

    const resp = await providerRouter.generate({
      taskType: 'prompt_optimization',
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      maxTokens: 250,
    });

    const enriched = resp.content.trim().replace(/^["']|["']$/g, '');
    if (enriched && enriched.length > 10) {
      if (isChinese) {
        return `${enriched}，纯环境空景，无人物，无角色，${styleZh}风格，8K超高清细节，电影级光照，无文字，无水印`;
      }
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
  const isChinese = detectInputLanguage(fullText) === 'zh';
  const isCartoonOrAnime = /anime|2d|comic|manga|二次元|动漫|动画|手绘|卡通|插画/i.test(fullText);
  const aestheticTag = getCharacterAestheticTag(fullText);

  if (isChinese) {
    const artTypeTag = isCartoonOrAnime
      ? '高清2D二次元单人角色立绘，精细动漫画作'
      : '写实人像摄影，高品质电影角色照，超高清精细特征';

    return [
      `【角色主体与服装】${c.name}：${c.appearance}${costumeOverride ? `，身穿专属服装【${costumeOverride}】` : ''}`,
      '单人居中全身立绘，从头到脚完整可见',
      '纯色干净简洁背景，专业工作室光照',
      aestheticTag,
      artTypeTag,
      styleEnhancer,
      '高清晰度，极致细节，无文字，无水印，无签名，无多余人物，无残缺，无三视图',
    ].filter(Boolean).join('，');
  }

  const artTypeTag = isCartoonOrAnime
    ? 'high quality 2D anime single character portrait, detailed anime artwork'
    : 'photorealistic portrait photography, high quality cinematic character photo, hyperrealistic detailed features';

  return [
    `[Character & Costume Subject] ${c.name}: ${c.appearance}${costumeOverride ? `, wearing ${costumeOverride}` : ''}`,
    'single centered full-body character portrait, fully visible from head to toe',
    'plain solid clean background, professional studio lighting',
    aestheticTag,
    artTypeTag,
    styleEnhancer,
    'masterpiece quality, sharp focus, no text, no watermark, no signature, no extra people, no bad anatomy, no character sheet, no turnaround, no multiple views',
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
  const fullText = `${s.name} ${s.description} ${style || ''}`;
  const isChinese = detectInputLanguage(fullText) === 'zh';
  const styleZh = getStyleNameZh(style);

  if (isChinese) {
    return [
      `环境空景图：${s.name}`,
      sanitizeSceneDescription(s.description),
      '纯环境空景，无人物，无角色，仅背景风光',
      style ? `${style}风格` : '',
      '高细节，无文字，无水印',
    ].filter(Boolean).join('，');
  }

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

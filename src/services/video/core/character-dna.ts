// character-dna.ts — 角色不可变 DNA 特征标记生成器
// 为每个系列角色生成结构化、高权重的不可变视觉 Token，强制锁定面部、发型、发饰、服饰与体态

import type { CharacterAnchor } from '@/types/video';

export interface CharacterDnaTokens {
  zh: string;
  en: string;
}

/**
 * 生成角色的不可变 DNA 核心词组（尊重原版，简洁明确）
 */
export function buildCharacterDnaTokens(
  character: CharacterAnchor,
  costumeDesc?: string,
): CharacterDnaTokens {
  const name = character.name.trim();
  const appearance = (character.appearance || '').trim();
  const outfit = (costumeDesc || '').trim();

  // 中文 DNA 词组
  const zhOutfit = outfit ? `，身穿【${outfit}】` : '';
  const zhTokens = `${name}（${appearance}${zhOutfit}）`;

  // 英文 DNA 词组
  const enOutfit = outfit ? `, wearing ${outfit}` : '';
  const enTokens = `${name} (${appearance}${enOutfit})`;

  return {
    zh: zhTokens,
    en: enTokens,
  };
}

/**
 * 智能自动识别角色变装/专属服装 (当 costumeVariantRefs 未手动指定时，自动从分镜提示词和正文中匹配)
 */
export function autoResolveCostumeVariant(
  character: CharacterAnchor,
  contextText: string,
): { id: string; description: string } | undefined {
  if (!character.costumeVariants || character.costumeVariants.length === 0) return undefined;
  const normalized = (contextText || '').toLowerCase().replace(/[\s·・._-]/g, '');
  if (!normalized) return undefined;

  for (const variant of character.costumeVariants) {
    if (variant.id === 'default') continue;
    const vId = (variant.id || '').toLowerCase().replace(/[\s·・._-]/g, '');
    const vDesc = (variant.description || '').toLowerCase().replace(/[\s·・._-]/g, '');
    if ((vId.length >= 2 && normalized.includes(vId)) || (vDesc.length >= 2 && normalized.includes(vDesc))) {
      return variant;
    }
  }
  return undefined;
}

/**
 * 为多个在场角色生成联合 DNA 锁定词（尊重原版，直接拼接人物原版特征）
 */
export function buildMultiCharacterDnaTokens(
  characters: CharacterAnchor[],
  costumeVariantRefs?: Record<string, string>,
  isChinese = true,
  contextText = '',
): string {
  if (!characters || characters.length === 0) {
    return isChinese ? '空景画面，无人物' : 'empty scene, no people';
  }

  const parts = characters.map((c) => {
    const explicitId = costumeVariantRefs?.[c.id];
    let variant = explicitId ? c.costumeVariants?.find((v) => v.id === explicitId) : undefined;
    if (!variant) {
      variant = autoResolveCostumeVariant(c, contextText);
    }
    const dna = buildCharacterDnaTokens(c, variant?.description);
    return isChinese ? dna.zh : dna.en;
  });

  return parts.join(isChinese ? '，' : ', ');
}

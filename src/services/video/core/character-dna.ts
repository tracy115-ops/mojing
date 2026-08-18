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
 * 智能检索当前分镜在场的角色（支持 ID / 名称 / 别名 / 正文与分镜 Prompt 语义精准比对）
 */
export function findMatchingCharacters(
  shot: { characterIds?: string[]; videoPrompt?: string; sourceText?: string; narration?: string },
  characters?: CharacterAnchor[],
): CharacterAnchor[] {
  if (!characters || characters.length === 0) return [];
  const matched = new Set<CharacterAnchor>();
  const charIds = (shot.characterIds || []).map((id) => id.trim().toLowerCase());
  const shotText = `${shot.videoPrompt || ''} ${shot.sourceText || ''} ${shot.narration || ''}`.toLowerCase();

  for (const c of characters) {
    const cId = c.id.toLowerCase();
    const cName = c.name.toLowerCase();
    const aliases = (c.aliases || []).map((a) => a.toLowerCase());

    // 1. 直接 ID / Name / Alias 匹配
    const isIdMatch = charIds.some((id) => id === cId || id === cName || aliases.includes(id));

    // 2. 文本语义中包含角色名或别名
    const isTextMatch = (cName.length >= 2 && shotText.includes(cName)) ||
      aliases.some((a) => a.length >= 2 && shotText.includes(a));

    if (isIdMatch || isTextMatch) {
      matched.add(c);
    }
  }

  // 3. 兜底：如果分镜明确有在场角色需求，但未识别到具体名字，且总角色库只有 1 个主角，自动关联该主角
  if (matched.size === 0 && characters.length === 1) {
    matched.add(characters[0]);
  }

  return Array.from(matched);
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

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
 * 智能检索当前分镜在场的角色（支持 ID / 名称 / 别名 / 视觉描述精准比对，严格防止角色溢出与幽灵人物）
 */
export function findMatchingCharacters(
  shot: { characterIds?: string[]; videoPrompt?: string; sourceText?: string; narration?: string },
  characters?: CharacterAnchor[],
): CharacterAnchor[] {
  if (!characters || characters.length === 0) return [];
  const matched = new Set<CharacterAnchor>();
  const charIds = (shot.characterIds || []).map((id) => id.trim().toLowerCase()).filter(Boolean);

  // 1. 如果分镜已明确指定了 characterIds（最高权威），严格只匹配指定的角色，绝对不误判拉入其他角色
  if (charIds.length > 0) {
    for (const c of characters) {
      const cId = c.id.toLowerCase();
      const cName = c.name.toLowerCase();
      const aliases = (c.aliases || []).map((a) => a.toLowerCase());
      if (charIds.some((id) => id === cId || id === cName || aliases.includes(id))) {
        matched.add(c);
      }
    }
    if (matched.size > 0) {
      return Array.from(matched);
    }
  }

  // 2. 如果未指定 characterIds，从实际画面视觉描述 videoPrompt 中精准检索在场角色
  const promptText = (shot.videoPrompt || '').toLowerCase();
  if (promptText) {
    for (const c of characters) {
      const cName = c.name.toLowerCase();
      const aliases = (c.aliases || []).map((a) => a.toLowerCase());
      if (
        (cName.length >= 2 && promptText.includes(cName)) ||
        aliases.some((a) => a.length >= 2 && promptText.includes(a))
      ) {
        matched.add(c);
      }
    }
    if (matched.size > 0) {
      return Array.from(matched);
    }
  }

  // 3. 检查是否为纯环境空镜头（如包含“空镜”、“风景”、“山门”、“大殿”、“云海”等无人物词汇）
  const isScenery = /(空镜|风景|远景|大远景|山门|大殿|夜空|云海|无人物|环境空景)/i.test(promptText);
  if (isScenery) {
    return [];
  }

  // 4. 兜底：如果总角色库只有 1 个主角，且非空景描述，关联该主角
  if (characters.length === 1) {
    matched.add(characters[0]);
  }

  return Array.from(matched);
}

/**
 * 为在场角色生成联合 DNA 锁定词（严格限定人物数量，杜绝多余路人/幽灵人物）
 */
export function buildMultiCharacterDnaTokens(
  characters: CharacterAnchor[],
  costumeVariantRefs?: Record<string, string>,
  isChinese = true,
  contextText = '',
): string {
  if (!characters || characters.length === 0) {
    return isChinese ? '环境空景' : 'empty landscape';
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

  if (characters.length === 1) {
    return parts[0];
  }

  if (characters.length === 2) {
    return isChinese
      ? `双人同框：[角色1: ${parts[0]}]；[角色2: ${parts[1]}]`
      : `Two characters: [Character 1: ${parts[0]}], [Character 2: ${parts[1]}]`;
  }

  return isChinese
    ? `多角色同框：${parts.map((p, i) => `[角色${i + 1}: ${p}]`).join('；')}`
    : `Group shot: ${parts.map((p, i) => `[Character ${i + 1}: ${p}]`).join(', ')}`;
}

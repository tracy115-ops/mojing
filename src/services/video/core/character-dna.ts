// character-dna.ts — 角色不可变 DNA 特征标记生成器
// 为每个系列角色生成结构化、高权重的不可变视觉 Token，强制锁定面部、发型、发饰、服饰与体态

import type { CharacterAnchor } from '@/types/video';

export interface CharacterDnaTokens {
  zh: string;
  en: string;
}

/**
 * 生成角色的不可变 DNA 核心词组
 */
export function buildCharacterDnaTokens(
  character: CharacterAnchor,
  costumeDesc?: string,
): CharacterDnaTokens {
  const name = character.name.trim();
  const appearance = (character.appearance || '').trim();
  const outfit = (costumeDesc || '').trim();

  // 中文 DNA 词组
  const zhOutfit = outfit ? `，穿着专属服饰【${outfit}】` : '';
  const zhTokens = `【核心角色锁定】${name}（外貌特征：${appearance}${zhOutfit}），100%严格保持与参考图0的角色面容五官、眼神、发型发色、服装款式细节与身材体态完全一致`;

  // 英文 DNA 词组
  const enOutfit = outfit ? `, wearing designated outfit: ${outfit}` : '';
  const enTokens = `[Character Identity Lock] ${name} (visual features: ${appearance}${enOutfit}), 100% exact facial structure, eye shape, hairstyle, clothing details, and body proportions matching Reference Image 0`;

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
 * 为多个在场角色生成联合 DNA 锁定词
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

  if (characters.length === 1) {
    const c = characters[0];
    const explicitId = costumeVariantRefs?.[c.id];
    let variant = explicitId ? c.costumeVariants?.find((v) => v.id === explicitId) : undefined;
    if (!variant) {
      variant = autoResolveCostumeVariant(c, contextText);
    }
    const dna = buildCharacterDnaTokens(c, variant?.description);
    return isChinese ? dna.zh : dna.en;
  }

  // 多角色
  const positionsZh = ['画面左侧', '画面右侧', '画面中央', '前景', '中景'];
  const positionsEn = ['left side of frame', 'right side of frame', 'center of frame', 'foreground', 'midground'];

  const parts = characters.map((c, idx) => {
    const explicitId = costumeVariantRefs?.[c.id];
    let variant = explicitId ? c.costumeVariants?.find((v) => v.id === explicitId) : undefined;
    if (!variant) {
      variant = autoResolveCostumeVariant(c, contextText);
    }
    const dna = buildCharacterDnaTokens(c, variant?.description);
    const posZh = positionsZh[idx % positionsZh.length];
    const posEn = positionsEn[idx % positionsEn.length];

    return isChinese
      ? `【角色${idx + 1}位于${posZh}】${dna.zh}`
      : `[Character ${idx + 1} located at ${posEn}] ${dna.en}`;
  });

  const isolationZh = '场景内独立多角色实体，清晰空间分隔，独立肢体动作，无身体融合，无肢体重叠，边界清晰';
  const isolationEn = 'distinct standalone character entities, clear spatial separation, independent limbs, no body fusion, no merged limbs';

  return isChinese
    ? `${parts.join('；\n')}。\n${isolationZh}`
    : `${parts.join(';\n')}.\n${isolationEn}`;
}

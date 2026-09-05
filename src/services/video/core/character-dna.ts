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

  // 动物/宠物角色防拟人化与防兽人混淆保护
  const isAnimal = /(猫|狗|小狗|小猫|橘猫|金毛|柯基|宠物|鸟|兔|狐狸|cat|dog|kitten|puppy|pet|fox|rabbit)/i.test(name) ||
    /(四足|纯动物|橘白相间|猫咪|毛茸茸的猫|cat fur|tabby)/i.test(appearance);
  const isExplicitAnthro = /(兽人|拟人|妖怪|化形|半人|人身|anthro|furry|humanoid)/i.test(`${name} ${appearance} ${outfit}`);

  let zhMorphology = '';
  let enMorphology = '';
  if (isAnimal && !isExplicitAnthro) {
    zhMorphology = '，真实自然动物形态（非人形、非兽人）';
    enMorphology = ', natural quadruped animal form (non-humanoid, non-anthropomorphic)';
  }

  // 中文 DNA 词组
  const zhOutfit = outfit ? `，身穿【${outfit}】` : '';
  const zhTokens = `${name}（${appearance}${zhMorphology}${zhOutfit}）`;

  // 英文 DNA 词组
  const enOutfit = outfit ? `, wearing ${outfit}` : '';
  const enTokens = `${name} (${appearance}${enMorphology}${enOutfit})`;

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

  // 1. 完全包含匹配 (ID 或描述直接在 contextText 中出现)
  for (const variant of character.costumeVariants) {
    if (variant.id === 'default') continue;
    const vId = (variant.id || '').toLowerCase().replace(/[\s·・._-]/g, '');
    const vDesc = (variant.description || '').toLowerCase().replace(/[\s·・._-]/g, '');
    if ((vId.length >= 2 && normalized.includes(vId)) || (vDesc.length >= 2 && normalized.includes(vDesc))) {
      return variant;
    }
  }

  // 2. 关键词重合度得分匹配（如“淡青色长裙”能命中“青裙 / 淡青 / 襦裙 / 长裙”等变装）
  let bestVariant: { id: string; description: string } | undefined;
  let maxScore = 0;

  for (const variant of character.costumeVariants) {
    if (variant.id === 'default') continue;
    const vDesc = (variant.description || '').toLowerCase();
    const vId = (variant.id || '').toLowerCase();
    const textPool = `${vDesc} ${vId}`;
    const keywords = textPool.match(/[\u4e00-\u9fa5]{2,4}|[a-z]{3,10}/g) || [];
    let score = 0;
    for (const kw of keywords) {
      if (normalized.includes(kw)) {
        score += kw.length;
      }
    }
    if (score > maxScore && score >= 2) {
      maxScore = score;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

/**
 * 智能检索当前分镜在场的角色（支持 ID / 名称 / 别名 / 视觉描述精准比对，严格防止角色溢出与幽灵人物）
 */
export function findMatchingCharacters(
  shot: { characterIds?: string[]; videoPrompt?: string; sourceText?: string; narration?: string; dialogue?: Array<{ speaker: string; text: string }> },
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

  // 2. 如果未指定 characterIds，从实际画面视觉描述、正文文本与对白中精准检索在场角色
  const fullText = [
    shot.videoPrompt || '',
    shot.sourceText || '',
    shot.narration || '',
    shot.dialogue?.map((d) => d.speaker).join(' ') || '',
  ].join(' ').toLowerCase();

  if (fullText) {
    for (const c of characters) {
      const cName = c.name.toLowerCase();
      const aliases = (c.aliases || []).map((a) => a.toLowerCase());
      if (
        (cName.length >= 2 && fullText.includes(cName)) ||
        aliases.some((a) => a.length >= 2 && fullText.includes(a))
      ) {
        matched.add(c);
      }
    }
    if (matched.size > 0) {
      return Array.from(matched);
    }
  }

  // 3. 检查是否为纯环境空镜头（如包含“空镜”、“风景”、“山门”、“大殿”、“云海”等无人物词汇）
  const isScenery = /(空镜|风景|远景|大远景|山门|大殿|夜空|云海|无人物|环境空景)/i.test(shot.videoPrompt || '');
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
 * 智能判断当前分镜是否包含群体、路人、市集、军营、围观等多人/开放环境场景
 */
export function isCrowdScene(contextText = ''): boolean {
  return /(人群|众人|大家|百姓|路人|街道|街市|市集|集市|集市上|热闹|喧闹|围观|众弟子|弟子们|同门|同窗|宾客|客官|商贾|百姓们|士兵|军队|看客|观众|走廊上的人|人山人海|人潮|百官|群臣|很多人|许多人|人来人往|大厅里的宾客|门派弟子|群像|crowd|bystanders|market|pedestrians|spectators|multitude|passersby|soldiers|army|people walking|gathering|audience)/i.test(contextText);
}

/**
 * 为在场角色生成联合 DNA 锁定词（严格限定人物数量，区分人/兽，杜绝多余路人/幽灵人物）
 */
export function buildMultiCharacterDnaTokens(
  characters: CharacterAnchor[],
  costumeVariantRefs?: Record<string, string>,
  isChinese = true,
  contextText = '',
): string {
  if (!characters || characters.length === 0) {
    return isChinese ? '环境空景，无人物' : 'empty landscape, no people';
  }

  const isAnimal = (c: CharacterAnchor) => {
    const isExplicitAnthro = /(兽人|拟人|妖怪|化形|半人|人身|anthro|furry|humanoid)/i.test(`${c.name} ${c.appearance || ''}`);
    if (isExplicitAnthro) return false;
    return /(猫|狗|小狗|小猫|橘猫|金毛|柯基|宠物|鸟|兔|狐狸|cat|dog|kitten|puppy|pet|fox|rabbit)/i.test(c.name) ||
      /(四足|纯动物|橘白相间|猫咪|毛茸茸的猫|cat fur|tabby)/i.test(c.appearance || '');
  };

  const humanChars = characters.filter((c) => !isAnimal(c));
  const animalChars = characters.filter((c) => isAnimal(c));

  const parts = characters.map((c) => {
    const explicitId = costumeVariantRefs?.[c.id] || costumeVariantRefs?.[c.name];
    let variant = explicitId ? c.costumeVariants?.find((v) => v.id === explicitId) : undefined;
    if (!variant) {
      variant = autoResolveCostumeVariant(c, contextText);
    }
    const dna = buildCharacterDnaTokens(c, variant?.description);
    return isChinese ? dna.zh : dna.en;
  });

  // 如果包含人群/大场面描写：明确前景主角与背景人群的主次关系，允许背景人群自然生成
  if (isCrowdScene(contextText)) {
    return isChinese
      ? `【前景核心主角】聚焦在场主角：${parts.map((p, i) => `[主角${i + 1}: ${p}]`).join('、')}；【背景环境与人群】背景中自然融入剧情描写的场景人群与路人氛围，主次分明`
      : `[Foreground Focus] Protagonists: ${parts.map((p, i) => `[Protagonist ${i + 1}: ${p}]`).join(', ')}; [Background Context] Natural crowd and environment as described, clear depth of field`;
  }

  // 1. 单个人类 + 动物组合 (如 1女生 + 1胖橘猫大师)
  if (humanChars.length === 1 && animalChars.length >= 1) {
    const hIndex = characters.indexOf(humanChars[0]);
    const aIndices = animalChars.map((a) => characters.indexOf(a));
    const isFemale = humanChars[0].gender === 'female' || /女|妹|姐|娘|妇|姬|雪|琳|雅|母|儿|师妹/i.test(humanChars[0].name);

    const guardZh = isFemale
      ? `【全场人类刚性数量约束】全场严格仅有1位人类女性主角【${humanChars[0].name}】，画面中绝无第二个女人、绝无多余人类、绝无人类道士或人类大师！【${animalChars.map((a) => a.name).join('、')}】严格为真实动物形态，文中提及的“大师/拂尘/打坐/僧袍”均专属归属该动物猫咪，严禁凭空生成任何人类道士或人类大师`
      : `【全场人类刚性数量约束】全场严格仅有1位人类男性主角【${humanChars[0].name}】，画面中绝无第二个男人、绝无多余人类、绝无人类道士或人类大师！【${animalChars.map((a) => a.name).join('、')}】严格为真实动物形态，文中提及的“大师/拂尘/打坐/僧袍”均专属归属该动物，严禁凭空生成任何人类道士或人类大师`;

    const guardEn = `[Rigid Human Constraint] Exactly ONE human protagonist [${humanChars[0].name}] in the entire picture, strictly NO second person, NO second woman, NO extra human, NO human master/monk! [${animalChars.map((a) => a.name).join(', ')}] is strictly a quadruped animal, whisk/robes belong solely to the animal`;

    return isChinese
      ? `${guardZh}；【单人与灵兽对戏聚焦】[人类主角: ${parts[hIndex]}] 与 [动物伙伴: ${aIndices.map((idx) => parts[idx]).join('、')}]，主次分明，无多余人物`
      : `${guardEn}; [Interaction Focus] [Sole Human: ${parts[hIndex]}] and [Animal Subject: ${aIndices.map((idx) => parts[idx]).join(', ')}], clear hierarchy, no extra person`;
  }

  // 2. 纯单人类（无动物）
  if (humanChars.length === 1 && animalChars.length === 0) {
    const hIndex = characters.indexOf(humanChars[0]);
    const isFemale = humanChars[0].gender === 'female' || /女|妹|姐|娘|妇|姬|雪|琳|雅|母|儿|师妹/i.test(humanChars[0].name);
    const guardZh = isFemale
      ? `【绝对单人镜头刚性约束】全场严格仅有【${humanChars[0].name}】这唯一1位女性主角，绝对严禁生成第二个女人、严禁任何路人或多余人物`
      : `【绝对单人镜头刚性约束】全场严格仅有【${humanChars[0].name}】这唯一1位男性主角，绝对严禁生成第二个人物、严禁任何路人或多余人物`;
    return isChinese ? `${guardZh}；[核心单人: ${parts[hIndex]}]` : `[Strict 1 Person Only] Exactly one protagonist [${humanChars[0].name}], NO other people; [Protagonist: ${parts[hIndex]}]`;
  }

  // 3. 双人同框
  if (characters.length === 2) {
    return isChinese
      ? `【双主体刚性约束】画面严格仅有2个在场主体：[主体1: ${parts[0]}] 与 [主体2: ${parts[1]}]，绝对严禁出现第三个多余人物或幽灵路人，专注呈现二者互动，主次分明`
      : `[Strict Two Subjects Only] Exactly 2 focal subjects: [Subject 1: ${parts[0]}] and [Subject 2: ${parts[1]}], strictly NO third character or extra person, clear interaction focus`;
  }

  return isChinese
    ? `多主体同框（在场核心主体）：${parts.map((p, i) => `[主体${i + 1}: ${p}]`).join('；')}，严禁无关多余幽灵人物`
    : `Group shot (present focal subjects): ${parts.map((p, i) => `[Subject ${i + 1}: ${p}]`).join(', ')}, no extra unmentioned characters`;
}

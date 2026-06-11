// ============================================================================
// Conflict Detector — Setting/narrative conflict detection
// Detects: dead-character appearances, ability/weapon inconsistencies,
// relationship contradictions, identity-reveal leaks.
// ============================================================================

import type { StoryBible, FactLock, RelationshipTriple } from '@/types/narrative';

export interface ConflictReport {
  type: 'ability_conflict' | 'weapon_inconsistency' | 'dead_character' | 'setting_violation'
      | 'relationship_conflict' | 'identity_leak';
  severity: 'critical' | 'warning' | 'info';
  description: string;
  location: string;
  suggestion: string;
}

// Element -> opposing elements for ability checking
const ELEMENT_MAP: Record<string, string[]> = {
  '火': ['冰', '水', '寒'],
  '冰': ['火', '炎', '灼'],
  '水': ['火', '炎'],
  '雷': ['地', '土'],
  '风': ['地', '土'],
  '木': ['金', '铁'],
  '光': ['暗', '影', '冥'],
  '暗': ['光', '圣', '阳'],
};

const WEAPON_MAP: Record<string, string> = {
  '剑': 'blade', '刀': 'blade', '枪': 'spear', '弓': 'bow', '箭': 'arrow',
  '杖': 'staff', '鞭': 'whip', '盾': 'shield', '匕首': 'dagger',
};

// Phrases that indicate genuine living-character presence (not flashback/memory)
const LIVING_PRESENCE_HINTS = ['走了进来', '开口道', '说道', '笑道', '看向', '伸手', '站起身', '握住', '冲着', '瞪着', '走向'];

// Phrases that mark a passage as flashback/memory/dream (so dead-character mentions don't fire)
const FLASHBACK_HINTS = ['回忆', '记忆中', '当年', '昔日', '往事', '梦中', '幻象', '幻觉', '曾经', '那年'];

export interface DetectOptions {
  factLock?: FactLock | null;
}

export class ConflictDetector {
  detectConflicts(
    chapterContent: string,
    bible: StoryBible,
    options: DetectOptions = {},
  ): ConflictReport[] {
    const conflicts: ConflictReport[] = [];
    const content = chapterContent;
    const characters = bible.characters;
    const isFlashbackHeavy = FLASHBACK_HINTS.some((h) => content.includes(h));

    // 1. Dead character appearances (suppress if whole chapter reads as flashback)
    for (const char of characters) {
      if (char.status !== 'deceased') continue;
      if (isFlashbackHeavy && !LIVING_PRESENCE_HINTS.some((h) => content.includes(h))) continue;

      const names = [char.name, ...(char.aliases || [])];
      for (const name of names) {
        if (!name || !content.includes(name)) continue;
        // Only flag if the name co-occurs with a living-presence verb
        const idx = content.indexOf(name);
        const nearby = content.slice(Math.max(0, idx - 50), Math.min(content.length, idx + 100));
        if (LIVING_PRESENCE_HINTS.some((h) => nearby.includes(h))) {
          conflicts.push({
            type: 'dead_character',
            severity: 'warning',
            description: `${char.name} 已死亡，但本章以活动状态出现`,
            location: `角色: ${char.name}`,
            suggestion: '检查是否为闪回/回忆；否则修正为活动状态或角色信息',
          });
          break;
        }
      }
    }

    // 1b. Fact-lock death list — catches deaths not yet reflected in bible
    if (options.factLock?.deathList?.length) {
      for (const deadName of options.factLock.deathList) {
        if (!deadName || !content.includes(deadName)) continue;
        if (isFlashbackHeavy && !LIVING_PRESENCE_HINTS.some((h) => content.includes(h))) continue;
        const idx = content.indexOf(deadName);
        const nearby = content.slice(Math.max(0, idx - 50), Math.min(content.length, idx + 100));
        if (LIVING_PRESENCE_HINTS.some((h) => nearby.includes(h))) {
          conflicts.push({
            type: 'dead_character',
            severity: 'critical',
            description: `${deadName} 在 Fact Lock 中已标记死亡，但本章以活动状态出现`,
            location: `角色: ${deadName}`,
            suggestion: '应保持死亡状态。如确需复活，请先在 Fact Lock 中移除该角色',
          });
        }
      }
    }

    // 2. Ability conflicts (element-based)
    for (const char of characters) {
      if (!char.description) continue;
      const charDesc = char.description + (char.personality || '');

      let charElement: string | null = null;
      for (const element of Object.keys(ELEMENT_MAP)) {
        if (charDesc.includes(element + '系') || charDesc.includes(element + '属性') || charDesc.includes(element + '法')) {
          charElement = element;
          break;
        }
      }
      if (!charElement) continue;

      const opposingElements = ELEMENT_MAP[charElement] || [];
      const charNames = [char.name, ...(char.aliases || [])];

      for (const name of charNames) {
        if (!name || !content.includes(name)) continue;
        for (const opposing of opposingElements) {
          const patterns = [`${opposing}系`, `${opposing}属性`, `${opposing}法`, `${opposing}球`, `${opposing}术`];
          for (const pattern of patterns) {
            if (!content.includes(pattern)) continue;
            const nameIndex = content.indexOf(name);
            const patternIndex = content.indexOf(pattern);
            if (Math.abs(nameIndex - patternIndex) < 200) {
              conflicts.push({
                type: 'ability_conflict',
                severity: 'critical',
                description: `${char.name} 是${charElement}系，但使用了${opposing}系能力`,
                location: `角色: ${char.name}`,
                suggestion: '确认是否有双属性设定，或修正能力描写',
              });
            }
          }
        }
      }
    }

    // 3. Weapon inconsistencies (basic, proximity-based)
    for (const char of characters) {
      if (!char.description) continue;
      const charWeapons = new Set<string>();
      for (const [keyword, type] of Object.entries(WEAPON_MAP)) {
        if (char.description.includes(keyword)) charWeapons.add(type);
      }
      if (charWeapons.size === 0) continue;

      const charNames = [char.name, ...(char.aliases || [])];
      for (const name of charNames) {
        if (!name || !content.includes(name)) continue;
        const nameIndex = content.indexOf(name);
        const nearby = content.slice(Math.max(0, nameIndex - 100), Math.min(content.length, nameIndex + 200));
        for (const [keyword, type] of Object.entries(WEAPON_MAP)) {
          if (nearby.includes(keyword) && !charWeapons.has(type)) {
            conflicts.push({
              type: 'weapon_inconsistency',
              severity: 'info',
              description: `${char.name} 在设定中使用特定武器，但章节中出现了${keyword}`,
              location: `角色: ${char.name}`,
              suggestion: '确认是否更换了武器，或在圣经中更新',
            });
          }
        }
      }
    }

    // 4. Relationship conflicts — if fact-lock has a recorded relationship between two
    //    characters, and the chapter shows them with an opposing predicate nearby.
    if (options.factLock?.relationshipGraph?.length) {
      const opposingPredicates: Record<string, string[]> = {
        '敌对': ['恋人', '深爱', '表白', '拥吻'],
        '恋人': ['仇人', '斩杀', '厮杀', '一刀'],
        '师徒': ['弑师', '背叛师门'],
        '亲子': ['弑父', '弑母'],
      };
      for (const rel of options.factLock.relationshipGraph) {
        const opposites = opposingPredicates[rel.predicate];
        if (!opposites || opposites.length === 0) continue;
        const subjectIn = content.includes(rel.subject);
        const objectIn = content.includes(rel.object);
        if (!subjectIn || !objectIn) continue;
        for (const opp of opposites) {
          if (content.includes(opp)) {
            conflicts.push({
              type: 'relationship_conflict',
              severity: 'critical',
              description: `${rel.subject} 与 ${rel.object} 在 Fact Lock 中为「${rel.predicate}」关系，但章节出现「${opp}」情节`,
              location: `关系: ${rel.subject}-${rel.object}`,
              suggestion: `检查是否为剧情转折；否则需更新 Fact Lock 中的关系状态`,
            });
            break;
          }
        }
      }
    }

    // 5. Identity leak — secret identity revealed before its scheduled chapter
    if (options.factLock?.identityLocks?.length) {
      for (const lock of options.factLock.identityLocks) {
        if (lock.revealedToReaders) continue;
        // Real name appearing in chapter text but not yet revealed to readers
        if (lock.realName && lock.realName.length >= 2 && content.includes(lock.realName)) {
          conflicts.push({
            type: 'identity_leak',
            severity: 'warning',
            description: `${lock.realName} 的真名在尚未向读者揭露前已被本章使用`,
            location: `身份: ${lock.characterId}`,
            suggestion: '使用别名/代称，或先标记为已揭露',
          });
        }
      }
    }

    return conflicts;
  }
}

export type { RelationshipTriple };

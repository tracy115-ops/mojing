// ============================================================================
// Conflict Detector — Keyword-based detection of setting/narrative conflicts
// Detects: ability conflicts, weapon inconsistencies, dead character appearances
// ============================================================================

import type { StoryBible } from '@/types/narrative';

export interface ConflictReport {
  type: 'ability_conflict' | 'weapon_inconsistency' | 'dead_character' | 'setting_violation';
  severity: 'critical' | 'warning' | 'info';
  description: string;
  location: string;
  suggestion: string;
}

// Element -> element associations for ability checking
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

// Weapon keywords
const WEAPON_MAP: Record<string, string> = {
  '剑': 'blade',
  '刀': 'blade',
  '枪': 'spear',
  '弓': 'bow',
  '箭': 'arrow',
  '杖': 'staff',
  '鞭': 'whip',
  '盾': 'shield',
  '匕首': 'dagger',
};

export class ConflictDetector {
  detectConflicts(chapterContent: string, bible: StoryBible): ConflictReport[] {
    const conflicts: ConflictReport[] = [];
    const content = chapterContent;
    const characters = bible.characters;

    // 1. Dead character appearances
    for (const char of characters) {
      if (char.status === 'deceased') {
        const names = [char.name, ...(char.aliases || [])];
        for (const name of names) {
          if (name && content.includes(name)) {
            conflicts.push({
              type: 'dead_character',
              severity: 'warning',
              description: `${char.name} 已死亡但在此章节中出现`,
              location: `角色: ${char.name}`,
              suggestion: '检查是否为回忆/幻觉/闪回场景，否则需要修正角色状态',
            });
            break;
          }
        }
      }
    }

    // 2. Ability conflicts (element-based)
    for (const char of characters) {
      if (!char.description) continue;
      const charDesc = char.description + (char.personality || '');

      // Find character's element from their description
      let charElement: string | null = null;
      for (const element of Object.keys(ELEMENT_MAP)) {
        if (charDesc.includes(element + '系') || charDesc.includes(element + '属性') || charDesc.includes(element + '法')) {
          charElement = element;
          break;
        }
      }

      if (!charElement) continue;

      // Check if the chapter shows this character using opposing elements
      const opposingElements = ELEMENT_MAP[charElement] || [];
      const charNames = [char.name, ...(char.aliases || [])];

      for (const name of charNames) {
        if (!name || !content.includes(name)) continue;

        for (const opposing of opposingElements) {
          const patterns = [`${opposing}系`, `${opposing}属性`, `${opposing}法`, `${opposing}球`, `${opposing}术`];
          for (const pattern of patterns) {
            if (content.includes(pattern)) {
              // Check if this opposing element appears near the character's name
              const nameIndex = content.indexOf(name);
              const patternIndex = content.indexOf(pattern);
              if (Math.abs(nameIndex - patternIndex) < 200) {
                conflicts.push({
                  type: 'ability_conflict',
                  severity: 'critical',
                  description: `${char.name} 是${charElement}系角色，但使用了${opposing}系能力`,
                  location: `角色: ${char.name}`,
                  suggestion: `确认角色是否有双属性设定，或修正能力描写`,
                });
              }
            }
          }
        }
      }
    }

    // 3. Weapon inconsistencies (basic)
    const weaponMentions = new Map<string, Set<string>>();
    for (const [keyword, type] of Object.entries(WEAPON_MAP)) {
      if (content.includes(keyword)) {
        if (!weaponMentions.has(type)) weaponMentions.set(type, new Set());
        weaponMentions.get(type)!.add(keyword);
      }
    }

    // If a character is described with a specific weapon in bible but uses different one
    for (const char of characters) {
      if (!char.description) continue;
      const charWeapons = new Set<string>();
      for (const [keyword, type] of Object.entries(WEAPON_MAP)) {
        if (char.description.includes(keyword)) {
          charWeapons.add(type);
        }
      }

      if (charWeapons.size === 0) continue;

      const charNames = [char.name, ...(char.aliases || [])];
      for (const name of charNames) {
        if (!name || !content.includes(name)) continue;

        // Check for weapon mentions near character name
        const nameIndex = content.indexOf(name);
        const nearbyText = content.slice(Math.max(0, nameIndex - 100), Math.min(content.length, nameIndex + 200));

        for (const [keyword, type] of Object.entries(WEAPON_MAP)) {
          if (nearbyText.includes(keyword) && !charWeapons.has(type)) {
            conflicts.push({
              type: 'weapon_inconsistency',
              severity: 'info',
              description: `${char.name} 在设定中使用特定武器，但章节中出现了${keyword}`,
              location: `角色: ${char.name}`,
              suggestion: '确认角色是否更换了武器，或在圣经中更新武器信息',
            });
          }
        }
      }
    }

    return conflicts;
  }
}

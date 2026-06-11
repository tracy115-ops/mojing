import type { PriorityTier, ContextSlot, StoryPhase, StoryPhaseState, StoryPhaseRules } from '@/types/narrative';

// --- Context Budget Allocator (V2 "Subtraction Reform") ---
// PlotPilot's onion model: T0 (critical) → T1 (compressible) → T2 (dynamic) → T3 (sacrificial)
// V2: Start with everything, then subtract from T3 → T2 → T1 until budget fits. T0 always protected.

const TOKEN_BUDGET = 32000; // Default context window for generation

const PHASE_RULES: Record<StoryPhase, StoryPhaseRules> = {
  opening: {
    allowNewSubplots: true,
    allowNewCharacters: true,
    foreshadowingPressure: 0.1,
    convergenceLevel: 0,
    dailyLifeAllowed: true,
  },
  development: {
    allowNewSubplots: true,
    allowNewCharacters: true,
    foreshadowingPressure: 0.3,
    convergenceLevel: 0.2,
    dailyLifeAllowed: true,
  },
  convergence: {
    allowNewSubplots: false,
    allowNewCharacters: false,
    foreshadowingPressure: 0.7,
    convergenceLevel: 0.6,
    dailyLifeAllowed: false,
  },
  finale: {
    allowNewSubplots: false,
    allowNewCharacters: false,
    foreshadowingPressure: 1.0,
    convergenceLevel: 1.0,
    dailyLifeAllowed: false,
  },
};

export class ContextBudgetAllocator {
  private slots: Map<string, ContextSlot> = new Map();
  private totalBudget: number;

  constructor(totalBudget = TOKEN_BUDGET) {
    this.totalBudget = totalBudget;
  }

  // --- Slot Registration ---

  registerSlot(slot: ContextSlot): void {
    this.slots.set(slot.name, slot);
  }

  // --- T0: Critical (always protected) ---

  registerStoryAnchor(content: string): void {
    this.registerSlot({
      name: 'STORY_ANCHOR',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 300,
      minTokens: 50,
      priority: 125,
    });
  }

  registerCharacterAnchors(content: string): void {
    this.registerSlot({
      name: 'CHARACTER_ANCHORS',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 500,
      minTokens: 100,
      priority: 120,
    });
  }

  registerFactLock(content: string): void {
    this.registerSlot({
      name: 'FACT_LOCK',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 800,
      minTokens: 100,
      priority: 130,
    });
  }

  registerBeatLock(content: string): void {
    this.registerSlot({
      name: 'BEAT_LOCK',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 600,
      minTokens: 50,
      priority: 118,
    });
  }

  registerClueLock(content: string): void {
    this.registerSlot({
      name: 'CLUE_LOCK',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 400,
      minTokens: 50,
      priority: 115,
    });
  }

  registerActiveForeshadowing(content: string): void {
    this.registerSlot({
      name: 'ACTIVE_FORESHADOWING',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 400,
      minTokens: 50,
      priority: 110,
    });
  }

  // --- T0: Previously On (PlotPilot's top priority after anchor) ---

  registerPreviouslyOn(summary: string): void {
    this.registerSlot({
      name: 'PREVIOUSLY_ON',
      tier: 'T0',
      content: `【上一章回顾】\n${summary}`,
      estimatedTokens: this.estimateTokens(summary),
      maxTokens: 500,
      minTokens: 50,
      priority: 107,
    });
  }

  // --- T0: Narrative debts due within next few chapters ---

  registerDebtDue(debtsText: string): void {
    this.registerSlot({
      name: 'DEBT_DUE',
      tier: 'T0',
      content: debtsText,
      estimatedTokens: this.estimateTokens(debtsText),
      maxTokens: 600,
      minTokens: 0,
      priority: 108,
    });
  }

  // --- T0: Character scars and active motivations ---

  registerScarsAndMotivations(text: string): void {
    this.registerSlot({
      name: 'SCARS_AND_MOTIVATIONS',
      tier: 'T0',
      content: text,
      estimatedTokens: this.estimateTokens(text),
      maxTokens: 500,
      minTokens: 0,
      priority: 118,
    });
  }

  // --- T0: Active character states from aftermath ---

  registerCharacterStates(text: string): void {
    this.registerSlot({
      name: 'CHARACTER_STATES',
      tier: 'T0',
      content: text,
      estimatedTokens: this.estimateTokens(text),
      maxTokens: 600,
      minTokens: 0,
      priority: 112,
    });
  }

  // --- T0: Recent relationship changes ---

  registerRelationshipTriples(text: string): void {
    this.registerSlot({
      name: 'RELATIONSHIP_TRIPLES',
      tier: 'T0',
      content: text,
      estimatedTokens: this.estimateTokens(text),
      maxTokens: 500,
      minTokens: 0,
      priority: 109,
    });
  }

  // --- T0: Multi-chapter previously on ---

  registerMultiChapterRecap(text: string): void {
    this.registerSlot({
      name: 'MULTI_CHAPTER_RECAP',
      tier: 'T0',
      content: text,
      estimatedTokens: this.estimateTokens(text),
      maxTokens: 800,
      minTokens: 0,
      priority: 106,
    });
  }

  // --- T0: New fine-grained slots (V2) ---

  registerLifecycleDirective(phase: StoryPhase, chapterIndex: number, totalChapters: number): void {
    const rules = PHASE_RULES[phase];
    const progress = totalChapters > 0 ? chapterIndex / totalChapters : 0;
    const phaseLabels: Record<StoryPhase, string> = {
      opening: '开局期', development: '发展期', convergence: '收敛期', finale: '终局期',
    };

    const content = [
      `【故事阶段: ${phaseLabels[phase]} (${(progress * 100).toFixed(0)}%)】`,
      phase === 'convergence' || phase === 'finale'
        ? `禁止开新坑。伏笔闭合压力: ${(rules.foreshadowingPressure * 100).toFixed(0)}%。收敛等级: ${(rules.convergenceLevel * 100).toFixed(0)}%。`
        : `允许铺陈新支线和新角色。伏笔闭合压力: ${(rules.foreshadowingPressure * 100).toFixed(0)}%。`,
      rules.dailyLifeAllowed ? '允许日常描写。' : '禁止日常描写，保持叙事推进。',
    ].join('\n');

    this.registerSlot({
      name: 'LIFECYCLE_DIRECTIVE',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 600,
      minTokens: 50,
      priority: 135, // Higher than fact lock
    });
  }

  registerEditorBrief(style: string, genre: string): void {
    const content = `【编辑简报】风格: ${style} | 类型: ${genre} | 要求: 文笔流畅、对话自然、情节紧凑、每段推进。`;

    this.registerSlot({
      name: 'EDITOR_BRIEF',
      tier: 'T0',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 800,
      minTokens: 50,
      priority: 100,
    });
  }

  // --- T1 slots ---

  registerChapterOutline(outline: string): void {
    this.registerSlot({
      name: 'CHAPTER_OUTLINE',
      tier: 'T1',
      content: outline,
      estimatedTokens: this.estimateTokens(outline),
      maxTokens: 300,
      minTokens: 50,
      priority: 90,
    });
  }

  registerActSummary(summary: string): void {
    this.registerSlot({
      name: 'ACT_SUMMARY',
      tier: 'T1',
      content: summary,
      estimatedTokens: this.estimateTokens(summary),
      maxTokens: 500,
      minTokens: 100,
      priority: 85,
    });
  }

  // --- T2 slots ---

  registerPreviousChapter(content: string): void {
    this.registerSlot({
      name: 'PREVIOUS_CHAPTER',
      tier: 'T2',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 2000,
      minTokens: 200,
      priority: 70,
    });
  }

  // --- T3 slots ---

  registerVectorRecall(content: string): void {
    this.registerSlot({
      name: 'VECTOR_RECALL',
      tier: 'T3',
      content,
      estimatedTokens: this.estimateTokens(content),
      maxTokens: 1000,
      minTokens: 0,
      priority: 50,
    });
  }

  // --- Character Scheduling (V2) ---

  /**
   * Schedule character anchors based on relevance.
   * Priority: outline mention > recent appearance > importance > activity score.
   */
  scheduleCharacterAnchors(
    characters: { name: string; description: string; importance: string }[],
    outlineCharacterNames: string[],
    recentChapterCharacterNames: string[][],
    maxSlots = 7,
  ): void {
    if (characters.length === 0) return;

    const scored = characters.map((ch) => {
      let score = 0;
      // Outline mention = highest
      if (outlineCharacterNames.some((n) => ch.name.includes(n) || n.includes(ch.name))) score += 100;
      // Recent appearance
      const recentFlat = recentChapterCharacterNames.flat();
      const recentCount = recentFlat.filter((n) => ch.name.includes(n) || n.includes(ch.name)).length;
      score += Math.min(recentCount * 20, 60);
      // Importance
      if (ch.importance === 'protagonist') score += 50;
      else if (ch.importance === 'major') score += 30;
      else if (ch.importance === 'supporting') score += 10;
      return { ...ch, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, maxSlots);

    const content = selected
      .map((ch) => `- ${ch.name}: ${ch.description.slice(0, 80)}`)
      .join('\n');

    this.registerCharacterAnchors(content);
  }

  // --- Allocate (V2 Subtraction Reform) ---

  /**
   * Subtraction-based allocation: start with all slots, then remove lowest-priority
   * from T3 → T2 → T1 until budget fits. T0 is always protected.
   */
  allocate(): { prompt: string; usedTokens: number; compressionApplied: boolean } {
    const allSlots = Array.from(this.slots.values());

    // Step 1: Separate T0 (always included) from T1-T3
    const t0Slots = allSlots.filter((s) => s.tier === 'T0');
    const compressibleSlots = allSlots.filter((s) => s.tier !== 'T0');

    // T0 slots: truncate to maxTokens but always included
    const t0Allocated = t0Slots
      .sort((a, b) => b.priority - a.priority)
      .map((slot) => ({
        ...slot,
        content: this.truncateContent(slot.content, slot.maxTokens ?? Infinity),
      }));

    const t0Tokens = t0Allocated.reduce((s, slot) => s + this.estimateTokens(slot.content), 0);
    let remainingBudget = this.totalBudget - t0Tokens;

    // Step 2: Sort compressible slots by priority (descending)
    const sorted = compressibleSlots.sort((a, b) => {
      const tierOrder: Record<PriorityTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
      const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
      if (tierDiff !== 0) return tierDiff; // T1 before T2 before T3
      return b.priority - a.priority;
    });

    const allocated: ContextSlot[] = [...t0Allocated];
    let compressionApplied = false;

    for (const slot of sorted) {
      if (remainingBudget <= 0) {
        compressionApplied = true;
        continue;
      }

      const slotTokens = this.estimateTokens(slot.content);

      if (slotTokens <= remainingBudget) {
        // Fits entirely
        allocated.push(slot);
        remainingBudget -= slotTokens;
      } else if (remainingBudget >= (slot.minTokens ?? 0)) {
        // Partially fits — truncate
        const truncated = this.truncateContent(slot.content, remainingBudget);
        allocated.push({ ...slot, content: truncated, estimatedTokens: remainingBudget });
        remainingBudget = 0;
        compressionApplied = true;
      } else {
        // Doesn't fit at all
        compressionApplied = true;
      }
    }

    const prompt = allocated.map((s) => s.content).join('\n\n');
    return {
      prompt,
      usedTokens: this.totalBudget - remainingBudget,
      compressionApplied,
    };
  }

  // --- Story Phase Management (Convergence Hourglass) ---

  static computeStoryPhase(currentChapter: number, totalChapters: number): StoryPhaseState {
    const progress = totalChapters > 0 ? currentChapter / totalChapters : 0;
    let phase: StoryPhase;

    if (progress < 0.25) phase = 'opening';
    else if (progress < 0.75) phase = 'development';
    else if (progress < 0.90) phase = 'convergence';
    else phase = 'finale';

    return {
      novelId: '',
      currentPhase: phase,
      progress,
      totalChapters,
      currentChapter,
      behaviorRules: PHASE_RULES[phase],
    };
  }

  static buildPhaseDirective(state: StoryPhaseState): string {
    const { currentPhase, behaviorRules: rules } = state;
    const phaseLabels: Record<StoryPhase, string> = {
      opening: '开局期',
      development: '发展期',
      convergence: '收敛期',
      finale: '终局期',
    };

    return [
      `【故事阶段: ${phaseLabels[currentPhase]} (${(state.progress * 100).toFixed(0)}%)】`,
      currentPhase === 'convergence' || currentPhase === 'finale'
        ? `⚠️ 禁止开新坑。伏笔闭合压力: ${(rules.foreshadowingPressure * 100).toFixed(0)}%。收敛等级: ${(rules.convergenceLevel * 100).toFixed(0)}%。`
        : `✅ 允许铺陈新支线和新角色。伏笔闭合压力: ${(rules.foreshadowingPressure * 100).toFixed(0)}%。`,
      rules.dailyLifeAllowed ? '✅ 允许日常描写。' : '⚠️ 禁止日常描写，保持叙事推进。',
    ].join('\n');
  }

  // --- Helpers ---

  private estimateTokens(text: string): number {
    const chineseChars = (text.match(/[一-鿿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.3);
  }

  private truncateContent(content: string, maxTokens: number): string {
    const currentTokens = this.estimateTokens(content);
    if (currentTokens <= maxTokens) return content;

    const ratio = maxTokens / currentTokens;
    const targetLength = Math.floor(content.length * ratio);
    return content.slice(0, targetLength) + '...[截断]';
  }
}

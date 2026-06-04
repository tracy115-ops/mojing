import type { PriorityTier, ContextSlot, StoryPhase, StoryPhaseState, StoryPhaseRules } from '@/types/narrative';

// --- Context Budget Allocator ---
// PlotPilot's onion model: T0 (critical) → T1 (compressible) → T2 (dynamic) → T3 (sacrificial)
// When token budget is tight, squeeze from T3 → T2 → T1, T0 is always protected.

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

  // --- Pre-built T0 slots (from PlotPilot's ContextAssembler) ---

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
      priority: 130, // Highest priority — absolute facts
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

  // --- Allocate ---

  allocate(): { prompt: string; usedTokens: number; compressionApplied: boolean } {
    const tiers: PriorityTier[] = ['T0', 'T1', 'T2', 'T3'];
    let remainingBudget = this.totalBudget;
    let compressionApplied = false;

    // Sort slots: by tier (T0 first), then by priority (higher first)
    const sortedSlots = Array.from(this.slots.values()).sort((a, b) => {
      const tierOrder = { T0: 0, T1: 1, T2: 2, T3: 3 };
      const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return b.priority - a.priority;
    });

    const allocated: ContextSlot[] = [];

    for (const slot of sortedSlots) {
      if (slot.tier === 'T0') {
        // T0 is mandatory — truncate to maxTokens if needed
        const truncated = this.truncateContent(slot.content, slot.maxTokens ?? Infinity);
        allocated.push({ ...slot, content: truncated });
        remainingBudget -= this.estimateTokens(truncated);
      } else {
        // T1-T3: fit into remaining budget
        const available = Math.max(0, remainingBudget);
        if (available <= 0) {
          // No budget left — drop this slot entirely
          compressionApplied = true;
          continue;
        }

        if (slot.estimatedTokens <= available) {
          allocated.push(slot);
          remainingBudget -= slot.estimatedTokens;
        } else if (available >= slot.minTokens) {
          // Compress to fit
          const truncated = this.truncateContent(slot.content, available);
          allocated.push({ ...slot, content: truncated, estimatedTokens: available });
          remainingBudget = 0;
          compressionApplied = true;
        } else {
          compressionApplied = true;
        }
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
    // Rough estimate: ~1.5 tokens per Chinese character, ~0.75 tokens per English word
    const chineseChars = (text.match(/[一-鿿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars * 1.5 + otherChars * 0.3);
  }

  private truncateContent(content: string, maxTokens: number): string {
    const currentTokens = this.estimateTokens(content);
    if (currentTokens <= maxTokens) return content;

    // Rough truncation by character ratio
    const ratio = maxTokens / currentTokens;
    const targetLength = Math.floor(content.length * ratio);
    return content.slice(0, targetLength) + '...[截断]';
  }
}

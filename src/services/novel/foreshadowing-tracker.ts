import type { Foreshadowing, ForeshadowingStatus } from '@/types/narrative';
import type { StoryPhaseState } from '@/types/narrative';

// --- Foreshadowing Tracker (V9 Reform) ---
// PlotPilot V9: "gentle reminder" not "force closure"
// Budget: MAX_NEW_PER_CHAPTER = 2, MAX_TOTAL_PENDING = 15
// Auto-abandon foreshadows older than 30 chapters (run every 10 chapters)
// Inject top-3 due as [MUST_RESOLVE] blocks into context

const MAX_NEW_PER_CHAPTER = 2;
const MAX_TOTAL_PENDING = 15;
const AUTO_ABANDON_AGE = 30;
const AUTO_ABANDON_CHECK_INTERVAL = 10;

export class ForeshadowingTracker {
  private items: Foreshadowing[] = [];

  plant(item: Omit<Foreshadowing, 'id' | 'status'>): Foreshadowing {
    const foreshadowing: Foreshadowing = {
      ...item,
      id: `fs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'planted',
    };
    this.items.push(foreshadowing);
    return foreshadowing;
  }

  /**
   * Plant new foreshadowings with budget enforcement.
   * Returns actually planted items (may be fewer than input if budget exceeded).
   */
  plantWithBudget(
    items: Array<Omit<Foreshadowing, 'id' | 'status'>>,
    currentChapter: number,
  ): { planted: Foreshadowing[]; rejected: number } {
    // First, run auto-abandon check
    this.autoAbandonOld(currentChapter);

    const currentPending = this.getPlanted().length;
    const slotsAvailable = Math.max(0, MAX_TOTAL_PENDING - currentPending);
    const toPlant = items.slice(0, Math.min(MAX_NEW_PER_CHAPTER, slotsAvailable));

    const planted: Foreshadowing[] = [];
    for (const item of toPlant) {
      planted.push(this.plant(item));
    }

    return {
      planted,
      rejected: items.length - toPlant.length,
    };
  }

  resolve(foreshadowingId: string, resolvedInChapter: number): Foreshadowing | undefined {
    const item = this.items.find((f) => f.id === foreshadowingId);
    if (!item || item.status !== 'planted') return undefined;

    item.status = 'resolved';
    item.resolvedInChapter = resolvedInChapter;
    return item;
  }

  resolveByDescription(description: string, resolvedInChapter: number): Foreshadowing | undefined {
    const desc = description.trim().toLowerCase();
    // Try exact match first
    let item = this.items.find((f) => f.status === 'planted' && f.description.trim().toLowerCase() === desc);
    // Fallback: partial match (one contains the other)
    if (!item) {
      item = this.items.find((f) =>
        f.status === 'planted' &&
        (f.description.trim().toLowerCase().includes(desc) || desc.includes(f.description.trim().toLowerCase())),
      );
    }
    // Fallback: keyword overlap (>60% of words match)
    if (!item && desc.length > 4) {
      const descWords = desc.split(/\s+/);
      item = this.items.find((f) => {
        if (f.status !== 'planted') return false;
        const fWords = f.description.trim().toLowerCase().split(/\s+/);
        const overlap = descWords.filter((w) => fWords.some((fw) => fw.includes(w) || w.includes(fw)));
        return overlap.length / Math.max(descWords.length, 1) > 0.6;
      });
    }
    if (item) {
      item.status = 'resolved';
      item.resolvedInChapter = resolvedInChapter;
    }
    return item;
  }

  abandon(foreshadowingId: string): void {
    const item = this.items.find((f) => f.id === foreshadowingId);
    if (item) item.status = 'abandoned';
  }

  /**
   * V9 Reform: auto-abandon foreshadows older than AUTO_ABANDON_AGE chapters.
   * Rationale: "In Dream of the Red Chamber, dozens of foreshadows are never resolved — that's not 'unpaid debt', that's 'literature'."
   * Runs every AUTO_ABANDON_CHECK_INTERVAL chapters.
   */
  autoAbandonOld(currentChapter: number): number {
    if (currentChapter % AUTO_ABANDON_CHECK_INTERVAL !== 0) return 0;

    let abandoned = 0;
    for (const f of this.items) {
      if (f.status !== 'planted') continue;
      const age = currentChapter - f.plantedInChapter;
      if (age > AUTO_ABANDON_AGE) {
        f.status = 'abandoned';
        f.narrativeWeight = 1; // Downgrade importance
        abandoned++;
      }
    }
    return abandoned;
  }

  getPlanted(): Foreshadowing[] {
    return this.items.filter((f) => f.status === 'planted');
  }

  getReadyToResolve(currentChapter: number): Foreshadowing[] {
    return this.items.filter(
      (f) =>
        f.status === 'planted' &&
        f.suggestedResolveChapter !== undefined &&
        f.suggestedResolveChapter <= currentChapter,
    );
  }

  getOverdue(currentChapter: number, tolerance = 5): Foreshadowing[] {
    return this.items.filter(
      (f) =>
        f.status === 'planted' &&
        f.suggestedResolveChapter !== undefined &&
        f.suggestedResolveChapter + tolerance <= currentChapter,
    );
  }

  /**
   * Get the top N foreshadowings that are due within the next few chapters.
   * These are injected as [MUST_RESOLVE] blocks into the generation context.
   */
  getTopDue(currentChapter: number, lookAhead = 2, limit = 3): Foreshadowing[] {
    const planted = this.getPlanted();
    const due = planted.filter((f) => {
      if (!f.suggestedResolveChapter) return false;
      const remaining = f.suggestedResolveChapter - currentChapter;
      return remaining <= lookAhead;
    });

    return due
      .sort((a, b) => {
        const urgencyWeight = { critical: 4, high: 3, medium: 2, low: 1 };
        const diff = (urgencyWeight[b.urgency] ?? 0) - (urgencyWeight[a.urgency] ?? 0);
        if (diff !== 0) return diff;
        return (a.suggestedResolveChapter ?? 999) - (b.suggestedResolveChapter ?? 999);
      })
      .slice(0, limit);
  }

  // Build urgency-ordered text for context injection
  buildForeshadowingContext(currentChapter: number, phaseState: StoryPhaseState): string {
    const planted = this.getPlanted();
    if (planted.length === 0) return '';

    const lines: string[] = ['【伏笔台账】'];

    // Inject top-3 due foreshadows as [MUST_RESOLVE] blocks
    const topDue = this.getTopDue(currentChapter, 2, 3);
    if (topDue.length > 0) {
      lines.push('\n[MUST_RESOLVE] 以下伏笔必须在近期闭合，本章优先处理：');
      for (const f of topDue) {
        lines.push(`  ❗ [Ch${f.plantedInChapter}] ${f.description}（建议第${f.suggestedResolveChapter}章闭合）`);
      }
    }

    // Sort by urgency and phase pressure
    const sorted = [...planted].sort((a, b) => {
      const urgencyWeight = { critical: 4, high: 3, medium: 2, low: 1 };
      const diff = (urgencyWeight[b.urgency] ?? 0) - (urgencyWeight[a.urgency] ?? 0);
      if (diff !== 0) return diff;
      return b.narrativeWeight - a.narrativeWeight;
    });

    for (const f of sorted) {
      const overdue = f.suggestedResolveChapter && f.suggestedResolveChapter <= currentChapter;
      const marker = overdue ? '⚠️到期' : '📌';
      const resolveHint = f.suggestedResolveChapter ? `（建议第${f.suggestedResolveChapter}章闭合）` : '';
      lines.push(`  ${marker} [Ch${f.plantedInChapter}] ${f.description} ${resolveHint}`);
    }

    // Budget warning
    if (planted.length > MAX_TOTAL_PENDING * 0.8) {
      lines.push(`\n⚠️ 伏笔预算: ${planted.length}/${MAX_TOTAL_PENDING}，接近上限，禁止埋设新伏笔`);
    }

    // Phase-specific pressure directive
    if (phaseState.behaviorRules.foreshadowingPressure > 0.5) {
      const overdueItems = this.getOverdue(currentChapter);
      if (overdueItems.length > 0) {
        lines.push(`\n⚠️ 叙事压力: ${overdueItems.length}条伏笔已到期，当前阶段要求优先闭合！`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get budget status for context injection.
   */
  getBudgetStatus(): { pending: number; maxPending: number; newPerChapter: number } {
    return {
      pending: this.getPlanted().length,
      maxPending: MAX_TOTAL_PENDING,
      newPerChapter: MAX_NEW_PER_CHAPTER,
    };
  }

  // Serialize
  serialize(): Foreshadowing[] {
    return this.items;
  }

  static deserialize(items: Foreshadowing[]): ForeshadowingTracker {
    const tracker = new ForeshadowingTracker();
    tracker.items = items;
    return tracker;
  }
}

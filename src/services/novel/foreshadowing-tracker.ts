import type { Foreshadowing, ForeshadowingStatus } from '@/types/narrative';
import type { StoryPhaseState } from '@/types/narrative';

// --- Foreshadowing Tracker ---
// PlotPilot's foreshadowing lifecycle: PLANTED → RESOLVED (or ABANDONED)
// Convergence hourglass forces unresolved foreshadowings to surface

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

  resolve(foreshadowingId: string, resolvedInChapter: number): Foreshadowing | undefined {
    const item = this.items.find((f) => f.id === foreshadowingId);
    if (!item || item.status !== 'planted') return undefined;

    item.status = 'resolved';
    item.resolvedInChapter = resolvedInChapter;
    return item;
  }

  abandon(foreshadowingId: string): void {
    const item = this.items.find((f) => f.id === foreshadowingId);
    if (item) item.status = 'abandoned';
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

  // Build urgency-ordered text for context injection
  buildForeshadowingContext(currentChapter: number, phaseState: StoryPhaseState): string {
    const planted = this.getPlanted();
    if (planted.length === 0) return '';

    const lines: string[] = ['【伏笔台账】'];

    // Sort by urgency and phase pressure
    const sorted = [...planted].sort((a, b) => {
      // In convergence/finale: higher urgency first
      const urgencyWeight = phaseState.currentPhase === 'convergence' || phaseState.currentPhase === 'finale'
        ? { critical: 4, high: 3, medium: 2, low: 1 }
        : { critical: 4, high: 3, medium: 2, low: 1 };

      const diff = (urgencyWeight[b.urgency] ?? 0) - (urgencyWeight[a.urgency] ?? 0);
      if (diff !== 0) return diff;

      // Then by narrative weight
      return b.narrativeWeight - a.narrativeWeight;
    });

    for (const f of sorted) {
      const overdue = f.suggestedResolveChapter && f.suggestedResolveChapter <= currentChapter;
      const marker = overdue ? '⚠️到期' : '📌';
      const resolveHint = f.suggestedResolveChapter ? `（建议第${f.suggestedResolveChapter}章闭合）` : '';
      lines.push(`  ${marker} [Ch${f.plantedInChapter}] ${f.description} ${resolveHint}`);
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

// ============================================================================
// Narrative Governance Engine
// Inspired by PlotPilot's NarrativeGovernanceService + NarrativePlanContract
// Provides: narrative contracts, chapter budgets, early-payoff detection, promise tracking
// ============================================================================

import type {
  StoryPhase,
  StoryPhaseState,
  Foreshadowing,
  NarrativeDebt,
  BibleCharacter,
} from '@/types/narrative';
import { NarrativeRepository } from './narrative-repository';

// --- Narrative Contract ---

export interface NarrativeContract {
  novelId: string;
  /** 标题承诺 — 小说标题暗示的核心悬念/主题 */
  titlePromise: string;
  /** 核心问题 — 读者期待被回答的根本问题 */
  coreQuestion: string;
  /** 主题锚点 — 不可偏离的核心主题 */
  themeAnchors: string[];
  /** 禁止暴露的真相（早期暴露检测用） */
  forbiddenReveals: ForbiddenReveal[];
  /** 每章预算约束 */
  chapterBudget: ChapterBudget;
  /** 合同版本（每次修改递增） */
  version: number;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

export interface ForbiddenReveal {
  id: string;
  description: string;
  earliestChapter: number;    // 最早可以在第几章揭露
  revealedInChapter?: number; // 如果已经揭露
  status: 'forbidden' | 'allowed' | 'revealed';
}

export interface ChapterBudget {
  /** 每章最大新增支线数 */
  maxNewSubplots: number;
  /** 每章最大新增角色数 */
  maxNewCharacters: number;
  /** 每章最大新植伏笔数 */
  maxNewForeshadowing: number;
  /** 收敛阶段必须闭合的伏笔数 */
  minForeshadowingClosure: number;
  /** 每章最大叙事债务 */
  maxNarrativeDebt: number;
}

export interface GovernanceReport {
  novelId: string;
  chapterNumber: number;
  /** Promise 命中率 */
  promiseHitRate: number;
  /** 预算是否超支 */
  budgetOverrun: BudgetOverrun | null;
  /** 早期暴露检测 */
  prematureReveals: string[];
  /** 叙事债务警告 */
  debtWarnings: DebtWarning[];
  /** 治理建议 */
  suggestions: string[];
  /** 综合评分 0-100 */
  governanceScore: number;
}

export interface BudgetOverrun {
  dimension: string;
  budget: number;
  actual: number;
  overBy: number;
}

export interface DebtWarning {
  debt: NarrativeDebt;
  reason: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
}

// --- Governance Engine ---

export class GovernanceEngine {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  // --- Contract Management ---

  loadContract(): NarrativeContract | null {
    try {
      const raw = localStorage.getItem(`mojing-governance:${this.repo['novelId']}:contract`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  saveContract(contract: NarrativeContract): void {
    localStorage.setItem(
      `mojing-governance:${contract.novelId}:contract`,
      JSON.stringify({ ...contract, updatedAt: new Date().toISOString() }),
    );
  }

  createDefaultContract(novelId: string, title: string): NarrativeContract {
    return {
      novelId,
      titlePromise: `《${title}》暗示的核心主题或悬念`,
      coreQuestion: '这个故事要回答什么根本问题？',
      themeAnchors: ['成长', '抉择'],
      forbiddenReveals: [],
      chapterBudget: {
        maxNewSubplots: 1,
        maxNewCharacters: 2,
        maxNewForeshadowing: 2,
        minForeshadowingClosure: 0,
        maxNarrativeDebt: 3,
      },
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // --- Chapter Budget Validation ---

  /**
   * Check if the current chapter is within budget for new narrative elements.
   * Returns violations if any budget is exceeded.
   */
  validateChapterBudget(params: {
    chapterNumber: number;
    storyPhase: StoryPhase;
    newSubplots: number;
    newCharacters: number;
    newForeshadowing: number;
    closedForeshadowing: number;
    openDebts: number;
  }): BudgetOverrun[] {
    const contract = this.loadContract();
    if (!contract) return [];

    const budget = this.adjustBudgetForPhase(contract.chapterBudget, params.storyPhase);
    const overruns: BudgetOverrun[] = [];

    if (params.newSubplots > budget.maxNewSubplots) {
      overruns.push({
        dimension: 'newSubplots',
        budget: budget.maxNewSubplots,
        actual: params.newSubplots,
        overBy: params.newSubplots - budget.maxNewSubplots,
      });
    }

    if (params.newCharacters > budget.maxNewCharacters) {
      overruns.push({
        dimension: 'newCharacters',
        budget: budget.maxNewCharacters,
        actual: params.newCharacters,
        overBy: params.newCharacters - budget.maxNewCharacters,
      });
    }

    if (params.newForeshadowing > budget.maxNewForeshadowing) {
      overruns.push({
        dimension: 'newForeshadowing',
        budget: budget.maxNewForeshadowing,
        actual: params.newForeshadowing,
        overBy: params.newForeshadowing - budget.maxNewForeshadowing,
      });
    }

    if (params.closedForeshadowing < budget.minForeshadowingClosure) {
      overruns.push({
        dimension: 'foreshadowingClosure',
        budget: budget.minForeshadowingClosure,
        actual: params.closedForeshadowing,
        overBy: budget.minForeshadowingClosure - params.closedForeshadowing,
      });
    }

    if (params.openDebts > budget.maxNarrativeDebt) {
      overruns.push({
        dimension: 'narrativeDebt',
        budget: budget.maxNarrativeDebt,
        actual: params.openDebts,
        overBy: params.openDebts - budget.maxNarrativeDebt,
      });
    }

    return overruns;
  }

  /**
   * Adjust budget based on story phase (PlotPilot's convergence hourglass).
   */
  private adjustBudgetForPhase(budget: ChapterBudget, phase: StoryPhase): ChapterBudget {
    switch (phase) {
      case 'opening':
        return {
          ...budget,
          maxNewSubplots: budget.maxNewSubplots + 1,
          maxNewCharacters: budget.maxNewCharacters + 2,
          maxNewForeshadowing: budget.maxNewForeshadowing + 1,
          minForeshadowingClosure: 0,
        };
      case 'development':
        return budget;
      case 'convergence':
        return {
          ...budget,
          maxNewSubplots: 0,
          maxNewCharacters: 0,
          maxNewForeshadowing: 0,
          minForeshadowingClosure: Math.max(1, budget.minForeshadowingClosure),
          maxNarrativeDebt: Math.max(1, budget.maxNarrativeDebt - 1),
        };
      case 'finale':
        return {
          ...budget,
          maxNewSubplots: 0,
          maxNewCharacters: 0,
          maxNewForeshadowing: 0,
          minForeshadowingClosure: Math.max(2, budget.minForeshadowingClosure + 1),
          maxNarrativeDebt: 0,
        };
    }
  }

  // --- Early Reveal Detection ---

  /**
   * Check if chapter content contains premature reveals.
   * Returns list of forbidden reveals that appear too early.
   */
  detectPrematureReveals(chapterNumber: number, chapterContent: string): string[] {
    const contract = this.loadContract();
    if (!contract) return [];

    const violations: string[] = [];

    for (const reveal of contract.forbiddenReveals) {
      if (reveal.status === 'revealed') continue;
      if (chapterNumber >= reveal.earliestChapter) {
        reveal.status = 'allowed'; // Chapter is allowed to reveal now
        continue;
      }

      // Simple keyword matching for forbidden reveals
      const keywords = reveal.description.split(/[，,、\s]+/).filter((w) => w.length >= 2);
      const matched = keywords.some((kw) => chapterContent.includes(kw));

      if (matched) {
        violations.push(
          `⚠️ 早期暴露: 「${reveal.description}」计划在第${reveal.earliestChapter}章揭露，但第${chapterNumber}章已出现相关内容`,
        );
      }
    }

    if (violations.length > 0) {
      this.saveContract(contract);
    }

    return violations;
  }

  // --- Debt Analysis ---

  /**
   * Analyze narrative debts and produce warnings.
   */
  analyzeDebts(
    debts: NarrativeDebt[],
    currentChapter: number,
    totalChapters: number,
  ): DebtWarning[] {
    const warnings: DebtWarning[] = [];
    const progress = currentChapter / totalChapters;

    for (const debt of debts) {
      if (debt.status !== 'open') continue;

      const chapterAge = currentChapter - debt.plantedInChapter;
      const chaptersRemaining = debt.suggestedResolveBy - currentChapter;

      // Critical: overdue
      if (chaptersRemaining < 0) {
        warnings.push({
          debt,
          reason: `叙事债务已逾期 ${-chaptersRemaining} 章`,
          urgency: 'critical',
        });
        continue;
      }

      // High: approaching deadline
      if (chaptersRemaining <= 3) {
        warnings.push({
          debt,
          reason: `叙事债务将在 ${chaptersRemaining} 章内到期`,
          urgency: 'high',
        });
        continue;
      }

      // Medium: old debt in convergence phase
      if (progress > 0.75 && chapterAge > 5) {
        warnings.push({
          debt,
          reason: `收敛阶段仍存在未解决的叙事债务（已存在 ${chapterAge} 章）`,
          urgency: 'medium',
        });
        continue;
      }

      // Low: very old debt
      if (chapterAge > 10) {
        warnings.push({
          debt,
          reason: `叙事债务已存在 ${chapterAge} 章，考虑解决或放弃`,
          urgency: 'low',
        });
      }
    }

    return warnings;
  }

  // --- Full Governance Report ---

  /**
   * Generate a complete governance report for a chapter.
   */
  generateReport(params: {
    chapterNumber: number;
    totalChapters: number;
    storyPhase: StoryPhase;
    chapterContent: string;
    foreshadowing: Foreshadowing[];
    debts: NarrativeDebt[];
    newSubplots?: number;
    newCharacters?: number;
    newForeshadowing?: number;
  }): GovernanceReport {
    const contract = this.loadContract();
    const suggestions: string[] = [];

    // 1. Budget validation
    const overruns = this.validateChapterBudget({
      chapterNumber: params.chapterNumber,
      storyPhase: params.storyPhase,
      newSubplots: params.newSubplots ?? 0,
      newCharacters: params.newCharacters ?? 0,
      newForeshadowing: params.newForeshadowing ?? 0,
      closedForeshadowing: params.foreshadowing.filter(
        (f) => f.status === 'resolved' && f.resolvedInChapter === params.chapterNumber,
      ).length,
      openDebts: params.debts.filter((d) => d.status === 'open').length,
    });

    for (const overrun of overruns) {
      suggestions.push(`预算超支: ${overrun.dimension} 超出 ${overrun.overBy} 个配额`);
    }

    // 2. Early reveal detection
    const prematureReveals = this.detectPrematureReveals(
      params.chapterNumber,
      params.chapterContent,
    );
    suggestions.push(...prematureReveals);

    // 3. Debt warnings
    const debtWarnings = this.analyzeDebts(
      params.debts,
      params.chapterNumber,
      params.totalChapters,
    );
    for (const w of debtWarnings) {
      if (w.urgency === 'critical' || w.urgency === 'high') {
        suggestions.push(w.reason);
      }
    }

    // 4. Promise tracking
    const plantedForeshadowing = params.foreshadowing.filter((f) => f.status === 'planted');
    const resolvedForeshadowing = params.foreshadowing.filter((f) => f.status === 'resolved');
    const promiseHitRate = params.foreshadowing.length > 0
      ? resolvedForeshadowing.length / params.foreshadowing.length
      : 1;

    // 5. Phase-appropriate suggestions
    if (params.storyPhase === 'convergence' && plantedForeshadowing.length > 3) {
      suggestions.push(`收敛阶段仍有 ${plantedForeshadowing.length} 条未闭合伏笔，需要加速闭合`);
    }
    if (params.storyPhase === 'finale' && plantedForeshadowing.length > 0) {
      suggestions.push(`终章阶段仍有 ${plantedForeshadowing.length} 条未闭合伏笔！必须在本阶段全部解决`);
    }

    // 6. Compute governance score
    let score = 100;
    score -= overruns.length * 15; // each budget overrun
    score -= prematureReveals.length * 20; // each premature reveal
    score -= debtWarnings.filter((w) => w.urgency === 'critical').length * 10;
    score -= debtWarnings.filter((w) => w.urgency === 'high').length * 5;
    if (promiseHitRate < 0.5 && params.chapterNumber > params.totalChapters * 0.5) {
      score -= 10; // low promise hit rate in second half
    }
    const governanceScore = Math.max(0, Math.min(100, score));

    return {
      novelId: this.repo['novelId'],
      chapterNumber: params.chapterNumber,
      promiseHitRate: Math.round(promiseHitRate * 100) / 100,
      budgetOverrun: overruns[0] ?? null,
      prematureReveals,
      debtWarnings,
      suggestions: suggestions.length > 0 ? suggestions : ['叙事治理状态良好 ✓'],
      governanceScore,
    };
  }
}

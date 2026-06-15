import { GovernanceEngine, type GovernanceReport } from './governance-engine';
import { VoiceFingerprintService } from './voice-fingerprint';
import type { VoiceDriftReport } from '@/types/narrative';
import { TensionScoringService } from './tension-scorer';
import type { TensionPoint } from '@/types/narrative';
import { EvolutionEngine, type ContinuityViolation } from './evolution-engine';
import { AntiAIAuditor, type AuditReport } from './cliche-scanner';
import { ConflictDetector, type ConflictReport } from './conflict-detector';
import { NarrativeRepository } from './narrative-repository';
import { ContextBudgetAllocator } from './context-budget';
import { MemoryEngine } from './memory-engine';
import { getTemplate } from './prompt-templates';
import { providerRouter } from '@/services/providers';
import type { LLMGenerateRequest } from '@/types/providers';

export interface QualityIssue {
  severity: 'info' | 'warning' | 'critical';
  description: string;
  autoFixed?: boolean;
}

export interface QualityDimensionReport {
  dimension: 'governance' | 'voice' | 'tension' | 'continuity' | 'antiAI';
  score: number;
  issues: QualityIssue[];
  autoCorrected: boolean;
  directive?: string;
}

export interface QualityGateResult {
  overallScore: number;
  dimensions: QualityDimensionReport[];
  directives: string[];
  escalatedWarnings: string[];
  chapterNumber: number;
  timestamp: string;
}

export interface RewriteResult {
  rewrittenContent: string;
  attempts: number;
  finalScore: number;
  improved: boolean;
  /** Still below threshold after exhausting retries — engine should pause for human review */
  needsHumanIntervention: boolean;
  unresolvedIssues: string[];
}

const STORAGE_KEY_PREFIX = 'mojing-quality-gate:directives:';
const REWRITE_THRESHOLD = 60;
const HUMAN_INTERVENTION_THRESHOLD = 40;
const MAX_REWRITE_ATTEMPTS = 2;

export class QualityGateService {
  private novelId: string;
  private repo: NarrativeRepository;
  private governance: GovernanceEngine;
  private voice: VoiceFingerprintService;
  private tension: TensionScoringService;
  private evolution: EvolutionEngine;
  private antiAI: AntiAIAuditor;
  private conflictDetector: ConflictDetector;
  private memory: MemoryEngine;
  private pendingDirectives: string[] = [];

  constructor(novelId: string) {
    this.novelId = novelId;
    this.repo = new NarrativeRepository(novelId);
    this.governance = new GovernanceEngine(novelId);
    this.voice = new VoiceFingerprintService(novelId);
    this.tension = new TensionScoringService(novelId);
    this.evolution = new EvolutionEngine(novelId);
    this.antiAI = new AntiAIAuditor(novelId);
    this.conflictDetector = new ConflictDetector();
    this.memory = new MemoryEngine(novelId);
    this.loadDirectives();
  }

  async evaluateChapter(chapterNumber: number, content: string): Promise<QualityGateResult> {
    const dimensions: QualityDimensionReport[] = [];
    const directives: string[] = [];
    const escalatedWarnings: string[] = [];

    // 1. Governance
    const gov = this.checkGovernance(chapterNumber, content);
    dimensions.push(gov);
    if (gov.directive) directives.push(gov.directive);
    if (gov.issues.some((i) => i.severity === 'critical' && !i.autoFixed)) {
      escalatedWarnings.push(...gov.issues.filter((i) => i.severity === 'critical' && !i.autoFixed).map((i) => `[治理] ${i.description}`));
    }

    // 2. Voice drift
    const voice = this.checkVoiceDrift(chapterNumber, content);
    dimensions.push(voice);
    if (voice.directive) directives.push(voice.directive);

    // 3. Tension
    const tension = this.checkTension(chapterNumber);
    dimensions.push(tension);
    if (tension.directive) directives.push(tension.directive);

    // 4. Continuity
    const cont = this.checkContinuity(chapterNumber, content);
    dimensions.push(cont);
    if (cont.directive) directives.push(cont.directive);
    if (cont.issues.some((i) => i.severity === 'critical' && !i.autoFixed)) {
      escalatedWarnings.push(...cont.issues.filter((i) => i.severity === 'critical' && !i.autoFixed).map((i) => `[连续性] ${i.description}`));
    }

    // 5. Anti-AI
    const antiAI = await this.checkAntiAI(chapterNumber, content);
    dimensions.push(antiAI);
    if (antiAI.directive) directives.push(antiAI.directive);

    const overallScore = Math.round(
      dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length,
    );

    this.pendingDirectives = [...this.pendingDirectives, ...directives];
    this.saveDirectives();

    return {
      overallScore,
      dimensions,
      directives,
      escalatedWarnings,
      chapterNumber,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check if quality gate result warrants a targeted rewrite.
   * Only triggers rewrite when score is genuinely low or has severe unfixed issues.
   * High scores with minor critical issues are allowed through with directives only.
   */
  needsRewrite(result: QualityGateResult): boolean {
    if (result.overallScore < REWRITE_THRESHOLD) return true;
    // Only rewrite if multiple dimensions are critically failing
    const criticalDims = result.dimensions.filter(
      (d) => d.score < 40 && d.issues.some((i) => i.severity === 'critical' && !i.autoFixed),
    );
    return criticalDims.length >= 2;
  }

  /**
   * Perform targeted rewrite of the chapter content.
   * Only rewrites problematic parts, preserves good content.
   */
  async rewriteChapter(
    chapterNumber: number,
    content: string,
    gateResult: QualityGateResult,
  ): Promise<string> {
    const allIssues = gateResult.dimensions
      .flatMap((d) => d.issues.map((i) => `[${d.dimension}][${i.severity}] ${i.description}`));

    const allDirectives = gateResult.directives;
    const factLockText = this.memory.buildFactLockText();

    const template = getTemplate('chapter-rewrite')!;
    const request: LLMGenerateRequest = {
      taskType: 'rewrite',
      systemPrompt: template.buildSystem({
        issues: allIssues.join('\n'),
        directives: allDirectives.join('\n'),
        factLock: factLockText || '无',
        originalContent: '',
      }),
      userPrompt: template.buildUser({
        issues: '',
        directives: '',
        factLock: '',
        originalContent: content,
      }),
      temperature: 0.7,
      maxTokens: Math.max(4096, Math.ceil(content.length * 1.2)),
    };

    const response = await providerRouter.generate(request);
    const rewritten = response.content.trim();

    if (!rewritten || rewritten.length < content.length * 0.5) {
      return content;
    }

    return rewritten;
  }

  /**
   * Evaluate once → rewrite once if needed → trust the result.
   * PlotPilot approach: don't loop, one targeted fix is enough.
   * Only pause for human intervention if original score was catastrophically low.
   */
  async evaluateAndRewrite(
    chapterNumber: number,
    content: string,
    onAttempt?: (attempt: number, score: number, rewritten: boolean) => void,
  ): Promise<RewriteResult> {
    let currentContent = content;
    let currentResult = await this.evaluateChapter(chapterNumber, content);
    let attempts = 0;
    let bestContent = content;
    let bestScore = currentResult.overallScore;

    // Iteratively rewrite while quality is below threshold and attempts remain.
    // After each rewrite, re-evaluate and keep the best-scoring version
    // (rewrite can introduce new problems — never accept a regression).
    while (this.needsRewrite(currentResult) && attempts < MAX_REWRITE_ATTEMPTS) {
      attempts += 1;
      onAttempt?.(attempts, currentResult.overallScore, false);

      try {
        const rewritten = await this.rewriteChapter(chapterNumber, currentContent, currentResult);
        if (rewritten.length < currentContent.length * 0.5) {
          // Rewrite produced garbage; abort the loop.
          break;
        }
        currentContent = rewritten;

        // Re-evaluate the rewritten version
        const postScore = await this.evaluateChapter(chapterNumber, currentContent);
        onAttempt?.(attempts, postScore.overallScore, true);

        if (postScore.overallScore > bestScore) {
          bestContent = currentContent;
          bestScore = postScore.overallScore;
          currentResult = postScore;
        } else {
          // Rewrite didn't improve; revert and stop to avoid wasting more attempts.
          currentContent = bestContent;
          break;
        }
      } catch (err) {
        console.warn('QualityGate: rewrite attempt failed', err);
        break;
      }
    }

    const needsHuman = bestScore < HUMAN_INTERVENTION_THRESHOLD;
    const unresolvedIssues = needsHuman
      ? currentResult.dimensions
          .flatMap((d) => d.issues
            .filter((i) => i.severity === 'critical' || i.severity === 'warning')
            .map((i) => `[${d.dimension}] ${i.description}`))
      : [];

    return {
      rewrittenContent: bestContent,
      attempts,
      finalScore: bestScore,
      improved: bestContent !== content,
      needsHumanIntervention: needsHuman,
      unresolvedIssues,
    };
  }

  getPendingDirectives(): string[] {
    return [...this.pendingDirectives];
  }

  clearDirectives(): void {
    this.pendingDirectives = [];
    this.saveDirectives();
  }

  saveDirectives(): void {
    try {
      localStorage.setItem(
        `${STORAGE_KEY_PREFIX}${this.novelId}`,
        JSON.stringify(this.pendingDirectives),
      );
    } catch { /* ignore */ }
  }

  loadDirectives(): void {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${this.novelId}`);
      this.pendingDirectives = raw ? JSON.parse(raw) : [];
    } catch {
      this.pendingDirectives = [];
    }
  }

  // --- Dimension checks ---

  private checkGovernance(chapterNumber: number, content: string): QualityDimensionReport {
    const issues: QualityIssue[] = [];
    let score = 100;
    let directive: string | undefined;

    try {
      const foreshadowing = this.repo.loadForeshadowing();
      const debts = this.repo.loadNarrativeDebts();
      const totalChapters = Math.max(chapterNumber, 1);
      const phaseState = ContextBudgetAllocator.computeStoryPhase(chapterNumber, totalChapters);

      const report: GovernanceReport = this.governance.generateReport({
        chapterNumber,
        totalChapters,
        storyPhase: phaseState.currentPhase,
        chapterContent: content,
        foreshadowing,
        debts,
      });

      score = report.governanceScore;

      if (report.governanceScore < 70) {
        issues.push({ severity: 'critical', description: `治理分数过低: ${report.governanceScore}/100` });
      }
      if (report.budgetOverrun) {
        issues.push({ severity: 'warning', description: `预算超限: ${report.budgetOverrun.dimension} (预算${report.budgetOverrun.budget}, 实际${report.budgetOverrun.actual})` });
      }
      for (const s of report.suggestions) {
        issues.push({ severity: 'info', description: s });
      }

      if (report.governanceScore < 70 || report.budgetOverrun) {
        const contract = this.governance.loadContract();
        if (contract) {
          const b = contract.chapterBudget;
          directive = [
            '【叙事治理纠正指令】',
            `故事治理分数降至${report.governanceScore}/100，必须在下一章遵守以下约束：`,
            `- 每章新增子线不超过 ${b.maxNewSubplots} 条`,
            `- 每章新增角色不超过 ${b.maxNewCharacters} 个`,
            `- 每章新增伏笔不超过 ${b.maxNewForeshadowing} 个`,
            `- 必须推进至少 ${b.minForeshadowingClosure} 个已有伏笔的收束`,
            report.suggestions.length > 0 ? `- 额外建议: ${report.suggestions.slice(0, 3).join('; ')}` : '',
          ].filter(Boolean).join('\n');
        }
      }
    } catch (err) {
      console.warn('QualityGate: governance check failed', err);
    }

    return {
      dimension: 'governance',
      score,
      issues,
      autoCorrected: !!directive,
      directive,
    };
  }

  private checkVoiceDrift(chapterNumber: number, content: string): QualityDimensionReport {
    const issues: QualityIssue[] = [];
    let score = 100;
    let directive: string | undefined;

    try {
      const history: VoiceDriftReport[] = this.voice.loadDriftHistory();
      const latest = history.length > 0 ? history[history.length - 1] : null;

      if (latest) {
        score = Math.round(latest.similarity * 100);

        if (latest.driftDetected) {
          issues.push({
            severity: latest.similarity < 0.6 ? 'critical' : 'warning',
            description: `文风漂移: 相似度${(latest.similarity * 100).toFixed(0)}%`,
          });
        }

        if (latest.similarity < 0.7) {
          const styleConstraint = this.voice.buildStyleConstraint(null);
          const fingerprint = this.voice.getFingerprint();
          if (fingerprint) {
            const constraint = this.voice.buildStyleConstraint(fingerprint);
            const parts: string[] = ['【文风纠正指令】检测到文风漂移，下一章必须遵守：'];
            if (constraint.directives.length > 0) {
              parts.push(...constraint.directives.map((d) => `- ${d}`));
            }
            if (constraint.bannedPatterns.length > 0) {
              parts.push('禁止使用以下模式:');
              parts.push(...constraint.bannedPatterns.slice(0, 5).map((p) => `- "${p}"`));
            }
            if (constraint.requiredPatterns.length > 0) {
              parts.push('必须包含以下特征:');
              parts.push(...constraint.requiredPatterns.slice(0, 5).map((p) => `- ${p}`));
            }
            directive = parts.join('\n');
          } else if (styleConstraint.directives.length > 0) {
            directive = `【文风纠正指令】${styleConstraint.directives.join('; ')}`;
          }
        }
      }
    } catch (err) {
      console.warn('QualityGate: voice drift check failed', err);
    }

    return {
      dimension: 'voice',
      score,
      issues,
      autoCorrected: !!directive,
      directive,
    };
  }

  private checkTension(chapterNumber: number): QualityDimensionReport {
    const issues: QualityIssue[] = [];
    let score = 100;
    let directive: string | undefined;

    try {
      const history: TensionPoint[] = this.tension.getTensionHistory();

      if (history.length >= 3) {
        const last3 = history.slice(-3);
        const avgRecent = last3.reduce((s, p) => s + p.score, 0) / 3;
        score = Math.round((avgRecent / 10) * 100);

        if (last3.every((p) => p.score < 3)) {
          issues.push({
            severity: 'warning',
            description: `连续${last3.length}章张力过低(平均${avgRecent.toFixed(1)}/10)`,
          });
          directive = [
            '【张力提升指令】',
            `最近${last3.length}章叙事张力持续偏低(平均${avgRecent.toFixed(1)}/10)，下一章必须：`,
            '- 引入新的冲突或矛盾',
            '- 制造意外转折或揭示',
            '- 增加角色间的对抗或压力',
            '- 在章节末尾设置悬念钩子',
          ].join('\n');
        }
      } else if (history.length > 0) {
        const latest = history[history.length - 1];
        score = Math.round((latest.score / 10) * 100);
        if (latest.score < 3) {
          issues.push({ severity: 'info', description: `张力偏低(${latest.score}/10)` });
        }
      }
    } catch (err) {
      console.warn('QualityGate: tension check failed', err);
    }

    return {
      dimension: 'tension',
      score,
      issues,
      autoCorrected: !!directive,
      directive,
    };
  }

  private checkContinuity(chapterNumber: number, content: string): QualityDimensionReport {
    const issues: QualityIssue[] = [];
    let score = 100;
    let directive: string | undefined;

    try {
      const violations: ContinuityViolation[] = this.evolution.getViolations(chapterNumber);
      const bible = this.repo.loadBible();
      const conflicts: ConflictReport[] = this.conflictDetector.detectConflicts(content, bible, {
        factLock: this.memory.serialize().factLock,
      });

      const allIssues = [
        ...violations.map((v) => ({ severity: v.severity as 'warning' | 'error' | 'critical', desc: v.description })),
        ...conflicts.map((c) => ({ severity: c.severity as 'critical' | 'warning' | 'info', desc: `${c.type}: ${c.description}` })),
      ];

      const criticalCount = allIssues.filter((i) => i.severity === 'critical').length;
      const warningCount = allIssues.filter((i) => i.severity === 'warning' || i.severity === 'error').length;

      score = Math.max(0, 100 - criticalCount * 20 - warningCount * 5);

      for (const issue of allIssues) {
        issues.push({ severity: issue.severity === 'error' ? 'warning' : issue.severity, description: issue.desc });
      }

      if (allIssues.length > 0) {
        const facts = allIssues
          .filter((i) => i.severity === 'critical' || i.severity === 'warning' || i.severity === 'error')
          .slice(0, 5)
          .map((i) => `- 必须遵守: ${i.desc}`);

        if (facts.length > 0) {
          directive = [
            '【连续性纠正指令】',
            '以下连续性事实在后续章节中必须严格保持一致，不得矛盾：',
            ...facts,
          ].join('\n');
          for (const issue of issues) {
            if (issue.severity === 'critical') issue.autoFixed = true;
          }
        }
      }
    } catch (err) {
      console.warn('QualityGate: continuity check failed', err);
    }

    return {
      dimension: 'continuity',
      score,
      issues,
      autoCorrected: !!directive,
      directive,
    };
  }

  private async checkAntiAI(chapterNumber: number, content: string): Promise<QualityDimensionReport> {
    const issues: QualityIssue[] = [];
    let score = 100;
    let directive: string | undefined;

    try {
      const report: AuditReport = this.antiAI.auditChapter(content, chapterNumber);
      score = report.score;

      if (report.severity === 'severe' || report.score < 40) {
        issues.push({
          severity: 'critical',
          description: `AI痕迹过重(${report.score}/100): ${report.criticalCount}个严重俗套`,
        });
      } else if (report.severity === 'moderate') {
        issues.push({
          severity: 'warning',
          description: `AI痕迹较明显(${report.score}/100): ${report.warningCount}个俗套模式`,
        });
      }

      if (report.severity === 'severe' || report.score < 40) {
        const topHits = report.hits
          .filter((h) => h.severity === 'critical' || h.severity === 'warning')
          .slice(0, 8)
          .map((h) => `- 避免使用: "${h.label}" (${h.severity})`);

        directive = [
          '【反AI俗套纠正指令】',
          `AI痕迹得分${report.score}/100，下一章必须：`,
          '- 使用更具体、独特的描写方式，避免泛泛而谈',
          '- 用具体细节代替抽象形容词',
          '- 对话要有个人特色，避免说教式总结',
          '- 减少排比、对仗等AI常见修辞',
          ...topHits,
        ].join('\n');
      }
    } catch (err) {
      console.warn('QualityGate: anti-AI check failed', err);
    }

    return {
      dimension: 'antiAI',
      score,
      issues,
      autoCorrected: !!directive,
      directive,
    };
  }
}

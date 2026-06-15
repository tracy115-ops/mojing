// ============================================================================
// Cliche Scanner + Anti-AI Auditor — Post-generation quality detection
// Inspired by PlotPilot's ClicheScanner + AntiAIAuditor
// ============================================================================

import { NarrativeRepository } from './narrative-repository';

// ============================================================================
// Cliche Patterns — 35+ regex rules for AI-generated writing detection
// ============================================================================

interface ClichePattern {
  id: string;
  pattern: RegExp;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  suggestion: string;
}

const CLICHE_PATTERNS: ClichePattern[] = [
  // --- Critical: strong AI indicators (PlotPilot's 35+ patterns) ---
  { id: 'c01', pattern: /不由得/g, label: '不由得', severity: 'critical', suggestion: '用具体动作或内心独白替代' },
  { id: 'c02', pattern: /心中一动/g, label: '心中一动', severity: 'critical', suggestion: '展示角色的具体反应' },
  { id: 'c03', pattern: /缓缓开口/g, label: '缓缓开口', severity: 'critical', suggestion: '用更具体的说话方式替代' },
  { id: 'c04', pattern: /一种难以言喻的/g, label: '难以言喻', severity: 'critical', suggestion: '用具体的感受描述替代' },
  { id: 'c05', pattern: /仿佛在诉说着/g, label: '仿佛在诉说', severity: 'critical', suggestion: '删除拟人化修辞或用更自然的表达' },
  { id: 'c06', pattern: /不禁倒吸一口凉气/g, label: '倒吸凉气', severity: 'critical', suggestion: '用更真实的惊讶反应替代' },
  { id: 'c07', pattern: /空气.{0,2}(突然|似乎|仿佛)凝固/g, label: '空气凝固', severity: 'critical', suggestion: '用环境细节暗示紧张气氛' },
  { id: 'c08', pattern: /眼中闪过一丝.{1,6}/g, label: '眼中闪过', severity: 'critical', suggestion: '用具体面部表情或行为展示情绪' },
  { id: 'c09', pattern: /嘴角微微上扬/g, label: '嘴角上扬', severity: 'critical', suggestion: '直接写"笑了"或用更自然的表达' },
  { id: 'c10', pattern: /深深地看了.{1,10}一眼/g, label: '深深看了一眼', severity: 'critical', suggestion: '用注视、瞪视等更具体的眼神描写' },
  { id: 'c11', pattern: /时间.{0,2}仿佛.{0,2}静止/g, label: '时间静止', severity: 'critical', suggestion: '用感官冻结的细节展示紧张瞬间' },
  { id: 'c12', pattern: /一股强大的.{0,6}(力量|气息|能量)/g, label: '一股强大的…', severity: 'critical', suggestion: '用具体的感官体验描述力量' },
  { id: 'c13', pattern: /指尖.{0,2}(泛白|发白|颤抖)/g, label: '指尖泛白', severity: 'critical', suggestion: '用更有新意的身体紧张描写' },
  { id: 'c14', pattern: /一丝.{0,2}(笑意|寒意|暖意|凉意|不安)/g, label: '一丝系列', severity: 'critical', suggestion: '删除"一丝"，直接写具体感受' },
  { id: 'c15', pattern: /带着.{0,4}口吻/g, label: '带着XX口吻', severity: 'critical', suggestion: '通过对话内容展示语气' },
  { id: 'c16', pattern: /不容置疑/g, label: '不容置疑', severity: 'critical', suggestion: '通过行动展示权威' },
  { id: 'c17', pattern: /声音变得冰冷/g, label: '声音变得冰冷', severity: 'critical', suggestion: '通过对话内容和具体描写展示冷淡' },
  { id: 'c18', pattern: /心湖.{0,2}(涟漪|波澜|震荡)/g, label: '心湖涟漪', severity: 'critical', suggestion: '用真实的内心活动替代比喻' },
  { id: 'c19', pattern: /投入心湖/g, label: '投入心湖', severity: 'critical', suggestion: '用更自然的心理描写' },
  { id: 'c20', pattern: /呼吸一滞/g, label: '呼吸一滞', severity: 'critical', suggestion: '用更具体的生理反应' },
  { id: 'c21', pattern: /四肢百骸/g, label: '四肢百骸', severity: 'critical', suggestion: '用更精准的身体部位描写' },
  { id: 'c22', pattern: /生理性.{0,2}(泪水|反应)/g, label: '生理性泪水', severity: 'critical', suggestion: '不需要用"生理性"来解释流泪' },
  { id: 'c23', pattern: /感到(愤怒|悲伤|恐惧|绝望)/g, label: '感到XX', severity: 'critical', suggestion: '用行为展示而非直接陈述情绪' },
  { id: 'c24', pattern: /不是.{1,8}而是/g, label: '不是…而是', severity: 'critical', suggestion: '直接说是什么，不需要先否定' },
  { id: 'c25', pattern: /(.{3,})\s*——\s*\1/g, label: '重复破折号结构', severity: 'critical', suggestion: '避免在破折号前后重复相同内容' },

  // --- Warning: mild AI flavor ---
  { id: 'w01', pattern: /声音.{0,2}(微微|有些|不禁)颤抖/g, label: '声音颤抖', severity: 'warning', suggestion: '用更具体的语音变化展示紧张' },
  { id: 'w02', pattern: /仿佛整个世界/g, label: '仿佛整个世界', severity: 'warning', suggestion: '减少夸张，聚焦角色即时感受' },
  { id: 'w03', pattern: /一道.{0,4}光芒/g, label: '一道光芒', severity: 'warning', suggestion: '用更具体的光线描述替代' },
  { id: 'w04', pattern: /心中暗自/g, label: '心中暗自', severity: 'warning', suggestion: '直接展示内心活动，不需要"心中暗自"标记' },
  { id: 'w05', pattern: /嘴角.{0,3}(勾起|浮现|露出一丝).{0,4}(笑|弧度)/g, label: '嘴角笑意', severity: 'warning', suggestion: '简化为直接描写笑容' },
  { id: 'w06', pattern: /不禁(感到|觉得|想)/g, label: '不禁感到', severity: 'warning', suggestion: '直接陈述感受，删除"不禁"' },
  { id: 'w07', pattern: /微微一.{1,2}/g, label: '微微一X', severity: 'warning', suggestion: '用更明确的动作描写替代模糊的"微微"' },
  { id: 'w08', pattern: /默默的?地?[点了叹了走站坐].{0,3}/g, label: '默默X了', severity: 'warning', suggestion: '描述具体动作，删除"默默"' },
  { id: 'w09', pattern: /似乎在.{2,8}着/g, label: '似乎在…着', severity: 'warning', suggestion: '确认描写或删除模糊词"似乎"' },
  { id: 'w10', pattern: /不由自主地/g, label: '不由自主', severity: 'warning', suggestion: '用具体反应替代这个模糊词' },
  { id: 'w11', pattern: /仿佛.{1,8}一般/g, label: '仿佛…一般', severity: 'warning', suggestion: '简化比喻或用更新鲜的意象' },
  { id: 'w12', pattern: /浑身.{0,2}(一震|一颤|一僵)/g, label: '浑身一震', severity: 'warning', suggestion: '用更具体的身体反应替代' },

  // --- Info: minor patterns ---
  { id: 'i01', pattern: /心头一(紧|震|动|颤|暖)/g, label: '心头一X', severity: 'info', suggestion: '可用但不宜频繁出现' },
  { id: 'i02', pattern: /目光.{0,2}(变得|显得).{0,4}(坚定|柔和|复杂|深邃)/g, label: '目光变得…', severity: 'info', suggestion: '用具体的眼神行为替代抽象描述' },
  { id: 'i03', pattern: /语气.{0,2}(变得|显得).{0,4}(冰冷|温柔|坚定|低沉)/g, label: '语气变得…', severity: 'info', suggestion: '通过对话内容展示而非描述语气' },
  { id: 'i04', pattern: /眼神中.{0,4}(闪过|透出|带着).{0,6}(一丝|几分)/g, label: '眼神中闪过', severity: 'info', suggestion: '通过行为暗示情绪' },
  { id: 'i05', pattern: /下意识地/g, label: '下意识', severity: 'info', suggestion: '偶尔使用可以，不要频繁' },
  { id: 'i06', pattern: /忍不住.{1,4}(了|起来)/g, label: '忍不住', severity: 'info', suggestion: '直接展示动作或情感' },
  { id: 'i07', pattern: /不知不觉.{0,4}(中|间|地)/g, label: '不知不觉', severity: 'info', suggestion: '删除，直接描述状态变化' },
  { id: 'i08', pattern: /像是.{1,8}一样/g, label: '像是…一样', severity: 'info', suggestion: '简化比喻或寻找新鲜意象' },
  { id: 'i09', pattern: /片刻之后/g, label: '片刻之后', severity: 'info', suggestion: '用更具体的时间标记或动作过渡' },
  { id: 'i10', pattern: /终于.{1,4}(了|起来)/g, label: '终于X了', severity: 'info', suggestion: '避免过多使用"终于"强调结果' },
  { id: 'i11', pattern: /面色.{0,2}(一|变得).{0,4}(苍白|铁青|潮红)/g, label: '面色变化', severity: 'info', suggestion: '可以通过行为间接展示面色变化' },
];

// --- Severity weights ---
const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 3.0,
  warning: 1.0,
  info: 0.3,
};

// --- Types ---

export interface PatternHit {
  id: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  count: number;
  positions: number[];
  suggestion: string;
}

export type AuditSeverity = 'pure' | 'mild' | 'moderate' | 'severe';

export interface AuditReport {
  chapterNumber: number;
  score: number;           // 0-100, higher = less AI-flavored
  severity: AuditSeverity;
  hits: PatternHit[];
  totalHits: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  rawScore: number;        // weighted sum before normalization
}

// ============================================================================
// ClicheScanner — Pure regex-based pattern matching
// ============================================================================

export class ClicheScanner {
  /**
   * Scan chapter content for AI cliche patterns.
   */
  static scan(content: string): PatternHit[] {
    const hits: PatternHit[] = [];

    for (const pattern of CLICHE_PATTERNS) {
      const matches = [...content.matchAll(new RegExp(pattern.pattern.source, 'g'))];
      if (matches.length === 0) continue;

      hits.push({
        id: pattern.id,
        label: pattern.label,
        severity: pattern.severity,
        count: matches.length,
        positions: matches.map((m) => m.index ?? 0),
        suggestion: pattern.suggestion,
      });
    }

    return hits;
  }

  /**
   * Get all registered patterns (for UI display).
   */
  static getPatterns(): ClichePattern[] {
    return CLICHE_PATTERNS;
  }

  /**
   * Get pattern by ID.
   */
  static getPattern(id: string): ClichePattern | undefined {
    return CLICHE_PATTERNS.find((p) => p.id === id);
  }
}

// ============================================================================
// AntiAIAuditor — Score-based audit with history tracking
// ============================================================================

export class AntiAIAuditor {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  /**
   * Audit a chapter for AI-generated writing patterns.
   * Returns a report with score, severity, and individual pattern hits.
   */
  auditChapter(content: string, chapterNumber: number): AuditReport {
    const hits = ClicheScanner.scan(content);

    // Calculate weighted score
    let rawScore = 0;
    let criticalCount = 0;
    let warningCount = 0;
    let infoCount = 0;

    for (const hit of hits) {
      const weight = SEVERITY_WEIGHTS[hit.severity] ?? 1;
      rawScore += hit.count * weight;

      switch (hit.severity) {
        case 'critical': criticalCount += hit.count; break;
        case 'warning': warningCount += hit.count; break;
        case 'info': infoCount += hit.count; break;
      }
    }

    // Normalize to 0-100 score (100 = no AI patterns detected)
    // Strict curve: 1+ per thousand starts penalizing, 3+ per thousand is severe.
    // Previous curve tolerated 2 per thousand which let heavy AI tone slip through.
    const contentLength = Math.max(1, content.length);
    const perThousand = rawScore / (contentLength / 1000);
    const score = Math.max(0, Math.round(
      perThousand <= 1 ? 100 - perThousand * 8       // 0→100, 1→92
      : perThousand <= 3 ? 92 - (perThousand - 1) * 12  // 1→92, 3→68
      : 68 - (perThousand - 3) * 15                      // 3→68, drops fast
    ));

    // Determine severity
    let severity: AuditSeverity;
    if (score >= 80) severity = 'pure';
    else if (score >= 60) severity = 'mild';
    else if (score >= 40) severity = 'moderate';
    else severity = 'severe';

    const report: AuditReport = {
      chapterNumber,
      score,
      severity,
      hits,
      totalHits: hits.reduce((s, h) => s + h.count, 0),
      criticalCount,
      warningCount,
      infoCount,
      rawScore,
    };

    // Persist to history
    this.saveReport(report);

    return report;
  }

  /**
   * Get audit history for trend visualization.
   */
  getAuditHistory(): AuditReport[] {
    try {
      const raw = localStorage.getItem(`mojing-narrative:${this.repo['novelId']}:audit-history`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * Get the latest audit report for a specific chapter.
   */
  getLatestReport(chapterNumber: number): AuditReport | null {
    const history = this.getAuditHistory();
    return history.filter((r) => r.chapterNumber === chapterNumber).pop() ?? null;
  }

  /**
   * Get overall AI-flavor trend across chapters.
   */
  getAuditTrend(): { avgScore: number; trend: 'improving' | 'degrading' | 'stable'; chapterScores: { chapter: number; score: number }[] } {
    const history = this.getAuditHistory();
    if (history.length === 0) {
      return { avgScore: 100, trend: 'stable', chapterScores: [] };
    }

    const chapterScores = history.map((r) => ({ chapter: r.chapterNumber, score: r.score }));
    const avgScore = Math.round(chapterScores.reduce((s, c) => s + c.score, 0) / chapterScores.length);

    let trend: 'improving' | 'degrading' | 'stable' = 'stable';
    if (chapterScores.length >= 3) {
      const recent = chapterScores.slice(-3);
      const diffs = recent.slice(1).map((r, i) => r.score - recent[i].score);
      const avgDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      if (avgDiff > 3) trend = 'improving';
      else if (avgDiff < -3) trend = 'degrading';
    }

    return { avgScore, trend, chapterScores };
  }

  private saveReport(report: AuditReport): void {
    const history = this.getAuditHistory();
    history.push(report);
    // Keep last 100 reports
    while (history.length > 100) history.shift();
    try {
      localStorage.setItem(
        `mojing-narrative:${this.repo['novelId']}:audit-history`,
        JSON.stringify(history),
      );
    } catch { /* ignore */ }
  }
}

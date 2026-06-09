// ============================================================================
// Tension Scoring Service — Multi-dimensional narrative tension analysis
// Inspired by PlotPilot's TensionScoringService (plot/emotional/pacing 40/30/30)
// ============================================================================

import type {
  TensionPoint,
  TensionDimensions,
  VoiceFingerprint,
  VoiceDriftReport,
} from '@/types/narrative';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { NarrativeRepository } from './narrative-repository';

/**
 * Tension scoring weights (PlotPilot's formula):
 *   plot 40%, emotional 30%, pacing 30%
 */
const WEIGHTS = { plot: 0.4, emotional: 0.3, pacing: 0.3 } as const;

export class TensionScoringService {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  /**
   * Score a chapter's tension across 3 dimensions using LLM.
   * Returns normalized 0-10 scores per dimension plus composite.
   */
  async scoreChapter(
    chapterContent: string,
    chapterNumber: number,
    prevTensionScore: number = 5,
  ): Promise<TensionPoint> {
    const request: LLMGenerateRequest = {
      taskType: 'analysis',
      systemPrompt: `你是一个专业的叙事张力分析引擎。请从三个维度评估以下章节的叙事张力，每个维度打 0-10 分。

评分维度：
1. **plot（情节张力）**: 冲突强度、悬念密度、信息不对称程度
2. **emotional（情感张力）**: 角色情感波动、读者共情强度
3. **pacing（节奏张力）**: 场景切换频率、叙事节奏、信息密度

评分规则：
- 0-2: 极低（日常、铺陈）
- 3-4: 低（平缓推进）
- 5-6: 中等（正常推进）
- 7-8: 高（冲突激化、悬念强）
- 9-10: 极高（高潮、转折、生死攸关）

上一章综合张力: ${prevTensionScore.toFixed(1)}/10

输出严格JSON：
{
  "plot": 数字(0-10),
  "emotional": 数字(0-10),
  "pacing": 数字(0-10),
  "comment": "一句话评价张力走势"
}`,
      userPrompt: `第${chapterNumber}章正文：\n\n${chapterContent.slice(0, 24000)}`,
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 256,
    };

    try {
      const response = await providerRouter.generate(request);
      const data = JSON.parse(response.content);

      const dimensions: TensionDimensions = {
        plot: clamp01(data.plot),
        character: clamp01(data.emotional),
        emotional: clamp01(data.emotional),
        mystery: 0,
        action: clamp01(data.plot),
      };

      // Also compute PlotPilot-style 3-axis dimensions
      const plotScore = clamp01(data.plot);
      const emotionalScore = clamp01(data.emotional);
      const pacingScore = clamp01(data.pacing);
      const composite = plotScore * WEIGHTS.plot + emotionalScore * WEIGHTS.emotional + pacingScore * WEIGHTS.pacing;

      const point: TensionPoint = {
        chapter: chapterNumber,
        score: Math.round(composite * 10) / 10,
        dimensions,
      };

      // Persist
      this.repo.addTensionPoint(point);

      return point;
    } catch (err) {
      console.warn('TensionScoringService: scoring failed, using fallback', err);
      const fallback: TensionPoint = {
        chapter: chapterNumber,
        score: prevTensionScore,
        dimensions: {
          plot: prevTensionScore,
          character: prevTensionScore,
          emotional: prevTensionScore,
          mystery: 0,
          action: prevTensionScore,
        },
      };
      this.repo.addTensionPoint(fallback);
      return fallback;
    }
  }

  /**
   * Get all tension points for this novel (for UI chart).
   */
  getTensionHistory(): TensionPoint[] {
    return this.repo.loadTensionPoints();
  }

  /**
   * Compute tension trend: rising, falling, stable, volatile.
   */
  getTensionTrend(): TensionTrend {
    const points = this.getTensionHistory();
    if (points.length < 2) return 'stable';

    const recent = points.slice(-5);
    const diffs = recent.slice(1).map((p, i) => p.score - recent[i].score);
    const avgDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;

    if (avgDiff > 0.5) return 'rising';
    if (avgDiff < -0.5) return 'falling';
    const variance = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;
    if (variance > 2) return 'volatile';
    return 'stable';
  }

  /**
   * Detect voice drift by comparing chapter style against a baseline fingerprint.
   */
  async detectVoiceDrift(
    chapterContent: string,
    chapterNumber: number,
  ): Promise<VoiceDriftReport> {
    let fingerprint = this.repo.loadVoiceFingerprint();

    // Build fingerprint from first chapters if not yet established
    if (!fingerprint) {
      fingerprint = await this.buildVoiceFingerprint(chapterContent, chapterNumber);
      this.repo.saveVoiceFingerprint(fingerprint);
      return {
        chapter: chapterNumber,
        similarity: 1.0,
        driftDetected: false,
      };
    }

    const request: LLMGenerateRequest = {
      taskType: 'analysis',
      systemPrompt: `你是一个文风一致性检测引擎。

参考文风特征：
- 平均句长: ${fingerprint.features.avgSentenceLength}字
- 对话占比: ${(fingerprint.features.dialogueRatio * 100).toFixed(0)}%
- 描写占比: ${(fingerprint.features.descriptionRatio * 100).toFixed(0)}%
- 词汇水平: ${fingerprint.features.vocabularyLevel}/10
- 情感基调: ${fingerprint.features.emotionalTone}
- 句式特征: ${fingerprint.features.syntacticPatterns.join('、')}

请比较当前章节与参考文风的相似度。输出JSON：
{
  "similarity": 0.0到1.0之间的数字（1.0=完全一致），
  "driftDetected": true/false（相似度<0.6为漂移），
  "suggestedFix": "如果漂移，给出修复建议"
}`,
      userPrompt: chapterContent.slice(0, 12000),
      responseFormat: 'json',
      temperature: 0.15,
      maxTokens: 256,
    };

    try {
      const response = await providerRouter.generate(request);
      const data = JSON.parse(response.content);
      return {
        chapter: chapterNumber,
        similarity: clamp(data.similarity, 0, 1),
        driftDetected: data.driftDetected ?? data.similarity < 0.6,
        suggestedFix: data.suggestedFix,
      };
    } catch {
      return {
        chapter: chapterNumber,
        similarity: 0.8,
        driftDetected: false,
      };
    }
  }

  /**
   * Build a voice fingerprint from chapter content.
   */
  async buildVoiceFingerprint(
    content: string,
    chapterNumber: number,
  ): Promise<VoiceFingerprint> {
    // Fast local analysis (no LLM needed for basic stats)
    const sentences = content.split(/[。！？；\n]+/).filter(Boolean);
    const avgSentenceLength = sentences.length > 0
      ? sentences.reduce((s, t) => s + t.length, 0) / sentences.length
      : 20;

    const dialogueMatches = content.match(/[""「」『』].*?[""「」『』]/g) ?? [];
    const dialogueRatio = dialogueMatches.length / Math.max(1, sentences.length);

    const descriptionPatterns = (content.match(/[的是了着过在]/g) ?? []).length;
    const descriptionRatio = Math.min(0.5, descriptionPatterns / content.length * 5);

    return {
      novelId: '', // Will be set by caller
      features: {
        avgSentenceLength: Math.round(avgSentenceLength),
        dialogueRatio: Math.round(dialogueRatio * 100) / 100,
        descriptionRatio: Math.round(descriptionRatio * 100) / 100,
        vocabularyLevel: 7,
        emotionalTone: 'balanced',
        syntacticPatterns: ['长句为主', '对话密集'],
      },
      referenceChapters: [chapterNumber],
    };
  }
}

// --- Helpers ---

function clamp01(value: unknown): number {
  const n = Number(value) || 0;
  return Math.round(Math.min(10, Math.max(0, n)) * 10) / 10;
}

function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value) || 0;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

export type TensionTrend = 'rising' | 'falling' | 'stable' | 'volatile';

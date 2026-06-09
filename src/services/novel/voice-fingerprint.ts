// ============================================================================
// Voice Fingerprint Service — Style consistency & drift detection
// Inspired by PlotPilot's VoiceFingerprintService + VoiceDriftService
// ============================================================================

import type { VoiceFingerprint, VoiceDriftReport } from '@/types/narrative';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { NarrativeRepository } from './narrative-repository';

export interface VoiceAnalysisResult {
  fingerprint: VoiceFingerprint;
  driftReport: VoiceDriftReport | null;
}

export interface StyleConstraint {
  directives: string[];
  bannedPatterns: string[];
  requiredPatterns: string[];
}

const STORAGE_SUFFIX_HISTORY = 'voice-history';

export class VoiceFingerprintService {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  /**
   * Compute voice fingerprint from chapter content using local heuristics
   * supplemented by optional LLM analysis.
   */
  async computeFingerprint(chapterContent: string, chapterNumber: number): Promise<VoiceFingerprint> {
    // --- Fast local analysis (no LLM) ---
    const sentences = chapterContent.split(/[。！？；\n]+/).filter((s) => s.trim().length > 2);
    const avgSentenceLength = sentences.length > 0
      ? sentences.reduce((s, t) => s + t.length, 0) / sentences.length
      : 20;

    const dialogueMatches = chapterContent.match(/[""「」『』].*?[""「」『』]/g) ?? [];
    const dialogueRatio = Math.min(0.8, dialogueMatches.length / Math.max(1, sentences.length));

    // Description particles ratio
    const descParticles = (chapterContent.match(/[的是了着过在]/g) ?? []).length;
    const descriptionRatio = Math.min(0.5, descParticles / Math.max(1, chapterContent.length) * 5);

    // Unique word ratio (vocabulary richness)
    const chars = chapterContent.replace(/[^一-鿿]/g, '');
    const uniqueChars = new Set(chars).size;
    const vocabularyLevel = Math.min(10, Math.round((uniqueChars / Math.max(1, chars.length)) * 30));

    // Emotional tone detection via keyword ratios
    const emotionalTone = this.detectEmotionalTone(chapterContent);

    // Syntactic pattern detection
    const syntacticPatterns = this.detectSyntacticPatterns(chapterContent, sentences);

    const fingerprint: VoiceFingerprint = {
      novelId: this.repo['novelId'],
      features: {
        avgSentenceLength: Math.round(avgSentenceLength),
        dialogueRatio: Math.round(dialogueRatio * 100) / 100,
        descriptionRatio: Math.round(descriptionRatio * 100) / 100,
        vocabularyLevel,
        emotionalTone,
        syntacticPatterns,
      },
      referenceChapters: [chapterNumber],
    };

    return fingerprint;
  }

  /**
   * Detect voice drift between current chapter and baseline fingerprint.
   * Uses LLM for nuanced comparison.
   */
  async detectDrift(
    chapterContent: string,
    chapterNumber: number,
  ): Promise<VoiceDriftReport> {
    let baseline = this.repo.loadVoiceFingerprint();

    // If no baseline, establish one from current chapter
    if (!baseline) {
      baseline = await this.computeFingerprint(chapterContent, chapterNumber);
      baseline.novelId = this.repo['novelId'];
      this.repo.saveVoiceFingerprint(baseline);
      return {
        chapter: chapterNumber,
        similarity: 1.0,
        driftDetected: false,
      };
    }

    // Quick local check first
    const localSimilarity = this.computeLocalSimilarity(chapterContent, baseline);
    if (localSimilarity > 0.8) {
      return {
        chapter: chapterNumber,
        similarity: localSimilarity,
        driftDetected: false,
      };
    }

    // Detailed LLM analysis for borderline cases
    try {
      const request: LLMGenerateRequest = {
        taskType: 'analysis',
        systemPrompt: `你是一个文风一致性检测引擎。

参考文风特征：
- 平均句长: ${baseline.features.avgSentenceLength}字
- 对话占比: ${(baseline.features.dialogueRatio * 100).toFixed(0)}%
- 描写占比: ${(baseline.features.descriptionRatio * 100).toFixed(0)}%
- 词汇水平: ${baseline.features.vocabularyLevel}/10
- 情感基调: ${baseline.features.emotionalTone}
- 句式特征: ${baseline.features.syntacticPatterns.join('、')}

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
        similarity: localSimilarity,
        driftDetected: localSimilarity < 0.6,
        suggestedFix: localSimilarity < 0.6 ? '文风与基准偏差较大，建议检查句式和用词一致性' : undefined,
      };
    }
  }

  /**
   * Build style constraint directives for prompt injection.
   */
  buildStyleConstraint(fingerprint: VoiceFingerprint | null): StyleConstraint {
    if (!fingerprint) {
      return { directives: [], bannedPatterns: [], requiredPatterns: [] };
    }

    const directives: string[] = [];
    const bannedPatterns: string[] = [];
    const requiredPatterns: string[] = [];

    // Sentence length enforcement
    if (fingerprint.features.avgSentenceLength > 25) {
      directives.push('使用较长的句式，平均句长25字以上，多用从句和修饰语');
      requiredPatterns.push('复合长句');
    } else if (fingerprint.features.avgSentenceLength < 12) {
      directives.push('使用短促有力的句式，平均句长12字以内，多断句');
      requiredPatterns.push('短句');
    }

    // Dialogue ratio enforcement
    if (fingerprint.features.dialogueRatio > 0.4) {
      directives.push(`对话密度 ${(fingerprint.features.dialogueRatio * 100).toFixed(0)}%，保持高频对话节奏`);
      requiredPatterns.push('密集对话');
    } else if (fingerprint.features.dialogueRatio < 0.15) {
      directives.push('对话稀少，以叙述和描写为主');
      bannedPatterns.push('大段连续对话');
    }

    // Emotional tone alignment
    directives.push(`情感基调应保持"${fingerprint.features.emotionalTone}"`);

    // Vocabulary level
    if (fingerprint.features.vocabularyLevel > 7) {
      directives.push('用词考究，多用生僻字和文言表达');
    } else if (fingerprint.features.vocabularyLevel < 4) {
      bannedPatterns.push('文言表达', '生僻字', '复杂成语');
      directives.push('用词通俗直白，贴近口语');
    }

    return { directives, bannedPatterns, requiredPatterns };
  }

  /**
   * Save drift report to history for trend tracking.
   */
  saveDriftReport(report: VoiceDriftReport): void {
    const history = this.loadDriftHistory();
    history.push(report);
    // Keep last 50 entries
    while (history.length > 50) history.shift();
    try {
      localStorage.setItem(
        `mojing-narrative:${this.repo['novelId']}:${STORAGE_SUFFIX_HISTORY}`,
        JSON.stringify(history),
      );
    } catch { /* ignore */ }
  }

  loadDriftHistory(): VoiceDriftReport[] {
    try {
      const raw = localStorage.getItem(`mojing-narrative:${this.repo['novelId']}:${STORAGE_SUFFIX_HISTORY}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  // --- Private helpers ---

  private computeLocalSimilarity(content: string, baseline: VoiceFingerprint): number {
    const sentences = content.split(/[。！？；\n]+/).filter((s) => s.trim().length > 2);
    const avgLen = sentences.length > 0
      ? sentences.reduce((s, t) => s + t.length, 0) / sentences.length
      : 20;

    const dialogueMatches = content.match(/[""「」『』].*?[""「」『』]/g) ?? [];
    const dialogueRatio = Math.min(0.8, dialogueMatches.length / Math.max(1, sentences.length));

    // Compare dimensions
    const lenDiff = 1 - Math.abs(avgLen - baseline.features.avgSentenceLength) / Math.max(avgLen, baseline.features.avgSentenceLength);
    const diaDiff = 1 - Math.abs(dialogueRatio - baseline.features.dialogueRatio) / 0.5;

    return Math.max(0, Math.min(1, (lenDiff * 0.5 + diaDiff * 0.5)));
  }

  private detectEmotionalTone(content: string): string {
    const tones: Record<string, RegExp> = {
      '热血激昂': /[战搏杀冲怒吼咆哮烈焰爆裂震撼]/g,
      '温馨柔和': /[微笑温柔暖阳微风抚慰轻轻柔柔]/g,
      '阴暗压抑': /[黑暗阴沉沉重压抑窒息绝望深渊]/g,
      '悬疑紧张': /[谜线索真相隐藏秘密危险未知]/g,
      '悲伤凄美': /[泪哭泣悲伤离别凋零消逝凄凉]/g,
      '诙谐幽默': /[笑哈哈有趣滑稽调侃逗乐搞怪]/g,
    };

    let maxCount = 0;
    let maxTone = 'balanced';
    for (const [tone, regex] of Object.entries(tones)) {
      const count = (content.match(regex) ?? []).length;
      if (count > maxCount) {
        maxCount = count;
        maxTone = tone;
      }
    }

    return maxCount > 5 ? maxTone : 'balanced';
  }

  private detectSyntacticPatterns(content: string, sentences: string[]): string[] {
    const patterns: string[] = [];

    // Check for dialogue-heavy style
    const dialogueCount = (content.match(/[""「」『』]/g) ?? []).length;
    if (dialogueCount > sentences.length * 0.6) {
      patterns.push('对话密集');
    }

    // Check for long/short sentence preference
    if (sentences.length > 0) {
      const avgLen = sentences.reduce((s, t) => s + t.length, 0) / sentences.length;
      if (avgLen > 25) patterns.push('长句为主');
      else if (avgLen < 12) patterns.push('短句为主');
      else patterns.push('长短交替');
    }

    // Check for metaphor usage
    const metaphorCount = (content.match(/像|如|似|仿佛|宛如|犹如/g) ?? []).length;
    if (metaphorCount > 10) patterns.push('比喻丰富');

    // Check for action-heavy
    const actionVerbs = (content.match(/[打踢砍刺冲跑跳闪躲翻]/g) ?? []).length;
    if (actionVerbs > 30) patterns.push('动作描写丰富');

    return patterns.length > 0 ? patterns : ['叙事为主'];
  }
}

function clamp(value: unknown, min: number, max: number): number {
  const n = Number(value) || 0;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

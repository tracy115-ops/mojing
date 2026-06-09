// ============================================================================
// Chapter Reviewer — Multi-dimension chapter quality review via LLM
// 5 dimensions: character consistency, timeline, plot coherence, foreshadowing, voice
// ============================================================================

import { NarrativeRepository } from './narrative-repository';
import { providerRouter } from '@/services/providers';
import type { LLMGenerateRequest } from '@/types/providers';

export interface DimensionScore {
  name: string;
  score: number; // 0-100
  issues: string[];
}

export interface ChapterReviewReport {
  novelId: string;
  chapter: number;
  overallScore: number;
  dimensions: DimensionScore[];
  summary: string;
  suggestions: string[];
  timestamp: string;
}

export class ChapterReviewer {
  private repo: NarrativeRepository;

  constructor(private novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  async reviewChapter(chapterIndex: number, chapterContent: string): Promise<ChapterReviewReport | null> {
    const bible = this.repo.loadBible();
    const triples = this.repo.loadTriples();
    const foreshadowing = this.repo.loadForeshadowing();
    const truncated = chapterContent.slice(0, 6000);

    const characterList = bible.characters.map((c) =>
      `${c.name}(${c.status}, ${c.importance}): ${c.description?.slice(0, 80)}`
    ).join('\n');

    const activeForeshadowing = foreshadowing
      .filter((f) => f.status === 'planted')
      .map((f) => f.description)
      .slice(0, 10)
      .join('; ');

    const prompt = `你是一位资深小说编辑。请对以下章节内容进行多维度审阅。

角色列表：
${characterList}

活跃伏笔：${activeForeshadowing || '无'}

已知关系：${triples.slice(0, 15).map((t) => `${t.subject}→${t.predicate}→${t.object}`).join('; ') || '无'}

章节内容：
${truncated}

请从以下5个维度评分（0-100），并指出具体问题：

1. character_consistency: 角色一致性（性格、外貌、能力是否符合设定）
2. timeline_consistency: 时间线一致性（事件顺序、场景转换是否合理）
3. plot_coherence: 剧情连贯性（与主线/支线的衔接、逻辑是否自洽）
4. foreshadowing_usage: 伏笔运用（是否合理推进已有伏笔、是否有新伏笔）
5. voice_quality: 文风质量（叙述风格是否统一、是否有AI痕迹）

输出JSON：
{
  "dimensions": [
    { "name": "character_consistency", "score": N, "issues": ["..."] },
    { "name": "timeline_consistency", "score": N, "issues": ["..."] },
    { "name": "plot_coherence", "score": N, "issues": ["..."] },
    { "name": "foreshadowing_usage", "score": N, "issues": ["..."] },
    { "name": "voice_quality", "score": N, "issues": ["..."] }
  ],
  "summary": "...",
  "suggestions": ["...", "..."]
}`;

    try {
      const request: LLMGenerateRequest = {
        taskType: 'review',
        systemPrompt: '你是一位资深小说编辑，擅长多维度审阅章节质量。',
        userPrompt: prompt,
        temperature: 0.3,
        maxTokens: 2000,
      };

      const response = await providerRouter.generate(request);
      const raw = response.content;

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const dimensions: DimensionScore[] = parsed.dimensions.map((d: any) => ({
        name: d.name,
        score: Math.max(0, Math.min(100, d.score ?? 50)),
        issues: d.issues ?? [],
      }));

      const overallScore = Math.round(
        dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length
      );

      const report: ChapterReviewReport = {
        novelId: this.novelId,
        chapter: chapterIndex,
        overallScore,
        dimensions,
        summary: parsed.summary ?? '',
        suggestions: parsed.suggestions ?? [],
        timestamp: new Date().toISOString(),
      };

      this.saveReview(report);
      return report;
    } catch {
      return null;
    }
  }

  saveReview(report: ChapterReviewReport): void {
    const history = this.loadHistory();
    const existing = history.findIndex((h) => h.chapter === report.chapter);
    if (existing >= 0) {
      history[existing] = report;
    } else {
      history.push(report);
    }
    this.repo.saveCustomData('chapter-reviews', history);
  }

  loadHistory(): ChapterReviewReport[] {
    return this.repo.loadCustomData<ChapterReviewReport[]>('chapter-reviews', []);
  }

  getLatestReview(): ChapterReviewReport | null {
    const history = this.loadHistory();
    return history.length > 0 ? history[history.length - 1] : null;
  }
}

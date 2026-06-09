// ============================================================================
// Chapter Summarizer — Auto-summarize chapter content for context assembly
// Used by autopilot engine for continuity and context budget management
// ============================================================================

import { NarrativeRepository } from './narrative-repository';
import { providerRouter } from '@/services/providers';
import type { LLMGenerateRequest } from '@/types/providers';

export interface ChapterSummary {
  chapterIndex: number;
  summary: string;
  keyEvents: string[];
  characterAppearances: string[];
  toneShift: string;
  wordCount: number;
  timestamp: string;
}

export class ChapterSummarizer {
  private repo: NarrativeRepository;

  constructor(private novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  async summarize(chapterIndex: number, chapterContent: string): Promise<ChapterSummary | null> {
    const truncated = chapterContent.slice(0, 6000);

    const request: LLMGenerateRequest = {
      taskType: 'extraction',
      systemPrompt: '你是一位专业小说编辑，擅长提炼章节要点。请提取章节的核心信息。',
      userPrompt: `请分析以下章节内容，提取摘要信息。

章节内容：
${truncated}

输出JSON：
{
  "summary": "50-100字的章节摘要",
  "keyEvents": ["关键事件1", "关键事件2", ...],
  "characterAppearances": ["出场角色1", "出场角色2", ...],
  "toneShift": "本章情感基调（如：紧张→释然、平静→震撼）"
}`,
      temperature: 0.2,
      maxTokens: 1000,
    };

    try {
      const response = await providerRouter.generate(request);
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const result: ChapterSummary = {
        chapterIndex,
        summary: parsed.summary ?? '',
        keyEvents: parsed.keyEvents ?? [],
        characterAppearances: parsed.characterAppearances ?? [],
        toneShift: parsed.toneShift ?? '',
        wordCount: chapterContent.length,
        timestamp: new Date().toISOString(),
      };

      this.saveSummary(result);
      return result;
    } catch {
      return null;
    }
  }

  // Fast local summarization (no LLM, just truncation + keyword extraction)
  summarizeLocal(chapterIndex: number, chapterContent: string): ChapterSummary {
    const summary = chapterContent.slice(0, 200).replace(/\n/g, ' ') + '...';
    const result: ChapterSummary = {
      chapterIndex,
      summary,
      keyEvents: [],
      characterAppearances: [],
      toneShift: '',
      wordCount: chapterContent.length,
      timestamp: new Date().toISOString(),
    };
    this.saveSummary(result);
    return result;
  }

  saveSummary(summary: ChapterSummary): void {
    const history = this.loadHistory();
    const idx = history.findIndex((h) => h.chapterIndex === summary.chapterIndex);
    if (idx >= 0) history[idx] = summary;
    else history.push(summary);
    this.repo.saveCustomData('chapter-summaries', history);
  }

  loadHistory(): ChapterSummary[] {
    return this.repo.loadCustomData<ChapterSummary[]>('chapter-summaries', []);
  }

  getSummary(chapterIndex: number): ChapterSummary | null {
    return this.loadHistory().find((h) => h.chapterIndex === chapterIndex) ?? null;
  }

  // Build context string for a chapter from previous summaries
  buildContextUpTo(chapterIndex: number, maxSummaries: number = 3): string {
    const history = this.loadHistory()
      .filter((h) => h.chapterIndex < chapterIndex)
      .sort((a, b) => b.chapterIndex - a.chapterIndex)
      .slice(0, maxSummaries);

    if (history.length === 0) return '';

    return history
      .map((h) => `第${h.chapterIndex + 1}章: ${h.summary}`)
      .join('\n');
  }
}

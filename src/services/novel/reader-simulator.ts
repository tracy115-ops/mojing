// ============================================================================
// Reader Simulator — Three-reader simulation for chapter quality review
// Hardcore (deep fan), Casual (thrill-seeker), Nitpicker (prose quality)
// ============================================================================

import { NarrativeRepository } from './narrative-repository';
import { providerRouter } from '@/services/providers';
import type { LLMGenerateRequest } from '@/types/providers';

export interface ReaderPersona {
  id: 'hardcore' | 'casual' | 'nitpicker';
  name: string;
  description: string;
}

export interface ReaderScore {
  persona: ReaderPersona;
  suspenseRetention: number; // 0-10
  thrillLevel: number;
  churnRisk: number; // 0-10 (lower is better)
  emotionalResonance: number;
  highlights: string[];
  painPoints: string[];
  suggestions: string[];
  overallComment: string;
}

export interface ReaderSimulationResult {
  novelId: string;
  chapter: number;
  scores: ReaderScore[];
  averageScore: number;
  timestamp: string;
}

export const READER_PERSONAS: ReaderPersona[] = [
  {
    id: 'hardcore',
    name: '硬核读者',
    description: '深度粉丝，关注情节逻辑和伏笔，对漏洞零容忍',
  },
  {
    id: 'casual',
    name: '休闲读者',
    description: '追求刺激和爽感，耐心低，容易因无聊而弃书',
  },
  {
    id: 'nitpicker',
    name: '挑刺读者',
    description: '关注文笔质量、对话自然度、AI痕迹检测',
  },
];

const PERSONA_EN: Record<string, ReaderPersona> = {
  hardcore: {
    id: 'hardcore',
    name: 'Hardcore Reader',
    description: 'Deep fan who tracks plot logic, foreshadowing, and has zero tolerance for plot holes',
  },
  casual: {
    id: 'casual',
    name: 'Casual Reader',
    description: 'Thrill-seeker with low patience, easily drops books when bored',
  },
  nitpicker: {
    id: 'nitpicker',
    name: 'Nitpicker',
    description: 'Focuses on prose quality, dialogue naturalness, and AI-pattern detection',
  },
};

export class ReaderSimulator {
  private repo: NarrativeRepository;

  constructor(private novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  async simulate(chapterIndex: number, chapterContent: string): Promise<ReaderSimulationResult | null> {
    const truncated = chapterContent.slice(0, 6000);

    const prompt = `你是一位小说质量评审专家。请分别以三种读者视角，对以下章节内容进行评分。

三种读者人设：
1. 硬核读者：深度粉丝，关注情节逻辑和伏笔，对漏洞零容忍
2. 休闲读者：追求刺激和爽感，耐心低，容易因无聊而弃书
3. 挑刺读者：关注文笔质量、对话自然度、AI痕迹检测

对每种读者，请评估4个维度（0-10分）：
- suspense_retention: 悬念保留度（是否让人想继续读）
- thrill_level: 刺激程度（情节是否引人入胜）
- churn_risk: 流失风险（0=不会走，10=立刻弃书）
- emotional_resonance: 情感共鸣（是否被打动）

同时提供：highlights(亮点), pain_points(痛点), suggestions(建议), overall_comment(总评)

章节内容：
${truncated}

输出JSON：
{
  "scores": [
    {
      "persona": "hardcore",
      "suspense_retention": N,
      "thrill_level": N,
      "churn_risk": N,
      "emotional_resonance": N,
      "highlights": ["...", "..."],
      "pain_points": ["...", "..."],
      "suggestions": ["...", "..."],
      "overall_comment": "..."
    },
    { "persona": "casual", ... },
    { "persona": "nitpicker", ... }
  ]
}`;

    try {
      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt: '你是一位专业的小说评审专家，擅长从不同读者视角分析章节质量。',
        userPrompt: prompt,
        temperature: 0.3,
        maxTokens: 2000,
      };

      const response = await providerRouter.generate(request);
      const raw = response.content;

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const scores: ReaderScore[] = parsed.scores.map((s: any) => ({
        persona: READER_PERSONAS.find((p) => p.id === s.persona) ?? READER_PERSONAS[0],
        suspenseRetention: s.suspense_retention ?? 5,
        thrillLevel: s.thrill_level ?? 5,
        churnRisk: s.churn_risk ?? 5,
        emotionalResonance: s.emotional_resonance ?? 5,
        highlights: s.highlights ?? [],
        painPoints: s.pain_points ?? [],
        suggestions: s.suggestions ?? [],
        overallComment: s.overall_comment ?? '',
      }));

      const avg = scores.reduce((sum, s) => {
        return sum + (s.suspenseRetention + s.thrillLevel + (10 - s.churnRisk) + s.emotionalResonance) / 4;
      }, 0) / scores.length;

      const result: ReaderSimulationResult = {
        novelId: this.novelId,
        chapter: chapterIndex,
        scores,
        averageScore: Math.round(avg * 10) / 10,
        timestamp: new Date().toISOString(),
      };

      this.saveSimulation(result);
      return result;
    } catch {
      return null;
    }
  }

  saveSimulation(result: ReaderSimulationResult): void {
    const history = this.loadHistory();
    const existing = history.findIndex((h) => h.chapter === result.chapter);
    if (existing >= 0) {
      history[existing] = result;
    } else {
      history.push(result);
    }
    this.repo.saveCustomData('reader-simulations', history);
  }

  loadHistory(): ReaderSimulationResult[] {
    return this.repo.loadCustomData<ReaderSimulationResult[]>('reader-simulations', []);
  }

  getLatestSimulation(): ReaderSimulationResult | null {
    const history = this.loadHistory();
    return history.length > 0 ? history[history.length - 1] : null;
  }
}

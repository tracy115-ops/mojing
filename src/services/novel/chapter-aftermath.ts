import type {
  ChapterAftermathResult,
  CharacterState,
  RelationshipTriple,
  Foreshadowing,
  NarrativeDebt,
} from '@/types/narrative';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';

// --- Chapter Aftermath Pipeline ---
// PlotPilot's key insight: ONE LLM call extracts ALL dimensions after a chapter is generated.
// Summary + key events + character states + triples + foreshadowing + narrative debt + tension.

export class ChapterAftermathPipeline {
  async process(
    novelId: string,
    chapterNumber: number,
    chapterContent: string,
    existingForeshadowing: Foreshadowing[],
  ): Promise<ChapterAftermathResult> {
    const activeForeshadowing = existingForeshadowing
      .filter((f) => f.status === 'planted')
      .map((f) => `[Ch${f.plantedInChapter}] ${f.description}`)
      .join('\n');

    const request: LLMGenerateRequest = {
      taskType: 'extraction',
      systemPrompt: `你是一个叙事分析引擎。从章节正文中一次性提取以下所有维度。输出严格JSON。

提取维度：
1. summary: 章节摘要（≤200字）
2. keyEvents: 关键事件列表（3-8条）
3. characterStates: 角色当前状态（情感、位置、知识变化）
4. triples: 人物/地点/事件之间的三元组关系
5. foreshadowing: 伏笔动态（新埋/已闭合/检测到即将闭合）
6. narrativeDebts: 叙事债务（承诺但未兑现的情节）
7. tensionScore: 紧张度评分（0-10）
8. styleScore: 文风一致性（0-1）

当前活跃伏笔（用于检测闭合）：
${activeForeshadowing || '无'}`,
      userPrompt: `小说ID: ${novelId}\n章节号: ${chapterNumber}\n\n${chapterContent}`,
      responseFormat: 'json',
      temperature: 0.1,
      maxTokens: 4096,
    };

    try {
      const response = await providerRouter.generate(request);
      const data = JSON.parse(response.content);

      return {
        novelId,
        chapterNumber,
        summary: data.summary ?? '',
        keyEvents: data.keyEvents ?? [],
        characterStates: (data.characterStates ?? []).map(normalizeCharacterState),
        triples: (data.triples ?? []).map(normalizeTriple),
        foreshadowings: {
          planted: (data.foreshadowing?.planted ?? []).map(normalizeForeshadowing),
          resolved: (data.foreshadowing?.resolved ?? []).map(normalizeForeshadowing),
          detected: (data.foreshadowing?.detected ?? []).map(normalizeForeshadowing),
        },
        narrativeDebts: (data.narrativeDebts ?? []).map(normalizeDebt),
        tensionScore: data.tensionScore ?? 5,
        styleScore: data.styleScore ?? 0.8,
        wordCount: chapterContent.length,
      };
    } catch (err) {
      console.warn('ChapterAftermathPipeline: extraction failed, using fallback', err);
      return {
        novelId,
        chapterNumber,
        summary: chapterContent.slice(0, 200),
        keyEvents: [],
        characterStates: [],
        triples: [],
        foreshadowings: { planted: [], resolved: [], detected: [] },
        narrativeDebts: [],
        tensionScore: 5,
        styleScore: 0.8,
        wordCount: chapterContent.length,
      };
    }
  }
}

// --- Normalizers ---

function normalizeCharacterState(raw: Record<string, unknown>): CharacterState {
  return {
    characterId: String(raw.characterId ?? raw.name ?? ''),
    novelId: String(raw.novelId ?? ''),
    chapter: Number(raw.chapter ?? 0),
    physicalState: String(raw.physicalState ?? ''),
    emotionalState: String(raw.emotionalState ?? ''),
    location: String(raw.location ?? ''),
    knowledge: Array.isArray(raw.knowledge) ? raw.knowledge.map(String) : [],
    motivations: Array.isArray(raw.motivations) ? raw.motivations.map(String) : [],
    recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents.map(String) : [],
  };
}

function normalizeTriple(raw: Record<string, unknown>): RelationshipTriple {
  return {
    subject: String(raw.subject ?? ''),
    predicate: String(raw.predicate ?? ''),
    object: String(raw.object ?? ''),
    sinceChapter: Number(raw.sinceChapter ?? 0),
    source: (raw.source === 'bible' ? 'bible' : 'extracted') as RelationshipTriple['source'],
  };
}

function normalizeForeshadowing(raw: Record<string, unknown>): Foreshadowing {
  return {
    id: String(raw.id ?? `fs_${Date.now()}`),
    novelId: String(raw.novelId ?? ''),
    description: String(raw.description ?? ''),
    plantedInChapter: Number(raw.plantedInChapter ?? 0),
    suggestedResolveChapter: raw.suggestedResolveChapter ? Number(raw.suggestedResolveChapter) : undefined,
    resolvedInChapter: raw.resolvedInChapter ? Number(raw.resolvedInChapter) : undefined,
    status: (raw.status as Foreshadowing['status']) ?? 'planted',
    relatedCharacters: Array.isArray(raw.relatedCharacters) ? raw.relatedCharacters.map(String) : [],
    urgency: (raw.urgency as Foreshadowing['urgency']) ?? 'medium',
    narrativeWeight: Number(raw.narrativeWeight ?? 5),
  };
}

function normalizeDebt(raw: Record<string, unknown>): NarrativeDebt {
  return {
    id: String(raw.id ?? `debt_${Date.now()}`),
    novelId: String(raw.novelId ?? ''),
    type: (raw.type as NarrativeDebt['type']) ?? 'other',
    description: String(raw.description ?? ''),
    plantedInChapter: Number(raw.plantedInChapter ?? 0),
    suggestedResolveBy: Number(raw.suggestedResolveBy ?? 0),
    priority: Number(raw.priority ?? 5),
    status: (raw.status as NarrativeDebt['status']) ?? 'open',
  };
}

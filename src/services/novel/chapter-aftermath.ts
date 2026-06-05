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

提取维度与格式要求：
1. "summary": 章节摘要（≤200字，字符串）
2. "keyEvents": 关键事件列表（3-8条，字符串数组）
3. "characterStates": 角色当前状态数组，每个元素含 "name", "physicalState", "emotionalState", "location"
4. "triples": 人物关系三元组数组，每个元素必须含：
   - "subject": 角色名（如"李明"）
   - "predicate": 关系类型（如"师徒"、"敌对"、"恋人"、"朋友"、"盟友"、"上下级"）
   - "object": 对方角色名
   - "sinceChapter": 确立章节号（整数）
5. "foreshadowing": 伏笔动态，含三个子数组 "planted", "resolved", "detected"，每个元素含 "description", "plantedInChapter", "urgency"(low/medium/high/critical)
6. "narrativeDebts": 叙事债务数组，每个含 "description", "plantedInChapter", "priority"(0-10)
7. "tensionScore": 紧张度（0-10，数字）
8. "styleScore": 文风一致性（0-1，数字）

当前活跃伏笔（用于检测闭合）：
${activeForeshadowing || '无'}

重要：triples必须包含本章中出现的所有人物关系，即使是已有的关系也要列出。`,
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
    subject: String(raw.subject ?? raw.from ?? raw.source ?? raw.character ?? ''),
    predicate: String(raw.predicate ?? raw.relation ?? raw.relationship ?? raw.type ?? ''),
    object: String(raw.object ?? raw.to ?? raw.target ?? ''),
    sinceChapter: Number(raw.sinceChapter ?? raw.chapter ?? 0),
    source: 'extracted' as const,
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

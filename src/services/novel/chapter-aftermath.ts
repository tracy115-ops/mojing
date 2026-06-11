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
      .map((f) => `[Ch${f.plantedInChapter}] ${f.description}${f.suggestedResolveChapter ? `(建议第${f.suggestedResolveChapter}章闭合)` : ''}`)
      .join('\n');

    const request: LLMGenerateRequest = {
      taskType: 'extraction',
      systemPrompt: `你是一个叙事分析引擎。从章节正文中一次性提取以下所有维度。输出严格JSON对象。

提取维度与格式要求：
1. "summary": 章节摘要（200-500字，字符串）
2. "keyEvents": 关键事件列表（3-8条，字符串数组）
3. "characterStates": 角色当前状态数组，每个元素含 "name", "physicalState", "emotionalState", "location"
4. "triples": 人物关系三元组数组（最多8条），每个元素含：
   - "subject": 角色名
   - "predicate": 关系类型（师徒/敌对/恋人/朋友/盟友/上下级/亲子等）
   - "object": 对方角色名
   - "sinceChapter": 确立章节号（整数）
5. "foreshadowing": 伏笔动态，含三个子数组：
   - "planted": 本章新埋设的伏笔（最多2条），每个含 "description", "plantedInChapter", "urgency", "suggestedResolveChapter"
   - "resolved": 本章闭合的伏笔（最多5条），必须匹配已有的活跃伏笔描述，每个含 "description", "resolvedInChapter"
   - "detected": 检测到的隐性伏笔（最多3条）
6. "consumedForeshadows": 本章消费/推进的伏笔（模糊匹配），每个含 "description", "progressDescription"
7. "narrativeDebts": 叙事债务数组（最多3条），每个含 "description", "plantedInChapter", "priority", "suggestedResolveBy", "type"(foreshadowing/causal_chain/storyline/character_arc/other)
8. "causalEdges": 因果链数组（最多3条），每个含 "sourceEvent", "causalType"(causes/motivates/triggers/prevents/resolves), "targetEvent", "strength"(0-1)
9. "characterMutations": 角色变化数组（最多3条），每个含 "characterName", "type"(scar/motivation/emotional_arc), "description", "intensity"(1-10)
10. "storylineProgress": 故事线推进数组（最多5条），每个含 "storylineDescription", "arcLabel"(≤16字), "progressType"(advanced/stalled/introduced/concluded)
11. "dialogues": 关键对话数组（最多10条），每个含 "speaker", "content", "context"
12. "timelineEvents": 时间线事件数组（最多5条），每个含 "event", "timeMarker"
13. "tensionScore": 紧张度（0-10，数字）
14. "styleScore": 文风一致性（0-1，数字）

当前活跃伏笔（必须逐一检查是否在本章被消费/闭合/推进）：
${activeForeshadowing || '无'}

重要规则：
- consumedForeshadows 必须与上面列出的活跃伏笔进行模糊匹配
- triples必须包含本章中出现的所有人物关系
- planted伏笔最多2条，太多会超出预算
- narrativeDebts的suggestedResolveBy必须是合理的未来章节号`,
      userPrompt: `请同步以下章节正文（第${chapterNumber}章）：
${chapterContent}

再次强调：只输出合法JSON对象。`,
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

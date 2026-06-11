import type {
  FactLock,
  BeatLock,
  ClueLock,
  CompletedBeat,
  RevealedClue,
  RelationshipTriple,
  IdentityLock,
  TimelineAnchor,
  BibleCharacter,
} from '@/types/narrative';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from './llm-json';

// --- Memory Engine ---
// Inspired by PlotPilot's three-lock system:
// FACT_LOCK (immutable facts), BEAT_LOCK (completed events), CLUE_LOCK (revealed information)

export class MemoryEngine {
  private factLock: FactLock;
  private beatLock: BeatLock;
  private clueLock: ClueLock;

  constructor(novelId: string) {
    this.factLock = { novelId, characterWhitelist: [], deathList: [], relationshipGraph: [], identityLocks: [], timelineAnchors: [] };
    this.beatLock = { novelId, completedBeats: [] };
    this.clueLock = { novelId, revealedClues: [] };
  }

  // --- Fact Lock ---

  buildFactLockText(): string {
    const sections: string[] = ['【FACT LOCK — 绝不可违反的事实锁】'];

    if (this.factLock.characterWhitelist.length > 0) {
      sections.push(`存活角色: ${this.factLock.characterWhitelist.join(', ')}`);
    }
    if (this.factLock.deathList.length > 0) {
      sections.push(`已死亡角色（绝不可复活）: ${this.factLock.deathList.join(', ')}`);
    }
    if (this.factLock.relationshipGraph.length > 0) {
      sections.push('关系图谱:');
      for (const rel of this.factLock.relationshipGraph) {
        sections.push(`  - ${rel.subject} ${rel.predicate} ${rel.object}（第${rel.sinceChapter}章确立）`);
      }
    }
    if (this.factLock.identityLocks.length > 0) {
      sections.push('身份锁定:');
      for (const lock of this.factLock.identityLocks) {
        const revealed = lock.revealedToReaders ? `（已于第${lock.revealedInChapter}章揭露）` : '（未揭露）';
        sections.push(`  - ${lock.characterId}: 真名=${lock.realName ?? '未知'}, 别名=[${lock.aliases.join(', ')}] ${revealed}`);
      }
    }
    if (this.factLock.timelineAnchors.length > 0) {
      sections.push('时间线锚点:');
      for (const anchor of this.factLock.timelineAnchors.slice(-5)) {
        sections.push(`  - 第${anchor.chapter}章: ${anchor.inStoryTime} — ${anchor.events.join(', ')}`);
      }
    }

    return sections.join('\n');
  }

  // --- Beat Lock ---

  buildBeatLockText(): string {
    if (this.beatLock.completedBeats.length === 0) return '';

    const sections: string[] = ['【BEAT LOCK — 已完成的剧情节拍（不可重复）】'];
    const recentBeats = this.beatLock.completedBeats.slice(-30);

    for (const beat of recentBeats) {
      sections.push(`  [Ch${beat.chapter}] ${beat.summary} (${beat.charactersInvolved.join(', ')})`);
    }

    return sections.join('\n');
  }

  // --- Clue Lock ---

  buildClueLockText(): string {
    const validClues = this.clueLock.revealedClues.filter((c) => c.isValid);
    if (validClues.length === 0) return '';

    const sections: string[] = ['【CLUE LOCK — 已揭露线索（不可矛盾）】'];
    for (const clue of validClues.slice(-20)) {
      sections.push(`  [Ch${clue.revealedAtChapter}] [${clue.category}] ${clue.content}`);
    }

    return sections.join('\n');
  }

  // --- Update from Bible ---

  syncFromBible(characters: BibleCharacter[]): void {
    this.factLock.characterWhitelist = characters
      .filter((c) => c.status === 'active')
      .map((c) => c.name);
    this.factLock.deathList = characters
      .filter((c) => c.status === 'deceased')
      .map((c) => c.name);

    this.factLock.identityLocks = characters.map((c) => ({
      characterId: c.id,
      realName: c.name,
      aliases: c.aliases,
      secretIdentity: undefined,
      revealedToReaders: true,
      revealedInChapter: c.firstAppearChapter,
    }));

    this.factLock.relationshipGraph = characters.flatMap((c) =>
      c.relationships.map((r) => ({
        subject: c.name,
        predicate: r.type,
        object: r.targetCharacterId,
        sinceChapter: r.sinceChapter,
        source: 'bible' as const,
      })),
    );
  }

  // --- LLM-driven update from chapter content ---
  // PlotPilot's key insight: all state extraction done by LLM, not rules

  async updateFromChapter(chapterNumber: number, chapterContent: string): Promise<void> {
    const request: LLMGenerateRequest = {
      taskType: 'extraction',
      systemPrompt: `你是一个精密的叙事状态追踪引擎。从章节正文中精确提取以下增量信息：
1. completed_beats: 本章新完成的剧情事件（之前没发生过的）
2. revealed_clues: 本章向读者/主角揭露的信息或真相
3. timeline_anchor: 故事内时间点和关键事件

输出严格JSON格式：
{
  "completed_beats": [{"beatId": "chN-事件简称", "summary": "一句话概括", "charactersInvolved": ["角色名"]}],
  "revealed_clues": [{"clueId": "clue-N-描述", "content": "线索内容", "category": "truth|relationship|identity|ability|other", "isValid": true}],
  "timeline_anchor": {"inStoryTime": "故事内时间", "events": ["关键事件1", "关键事件2"]}
}`,
      userPrompt: `章节号: ${chapterNumber}\n\n${chapterContent}`,
      responseFormat: 'json',
      temperature: 0.1,
      maxTokens: 2048,
    };

    try {
      const response = await providerRouter.generate(request);
      const data = parseLLMJson<Record<string, any>>(response.content);
      if (!data) return;

      // Merge extracted beats (validate each entry)
      if (Array.isArray(data.completed_beats)) {
        for (const beat of data.completed_beats) {
          if (typeof beat.beatId !== 'string' || typeof beat.summary !== 'string') continue;
          if (!this.beatLock.completedBeats.some((b) => b.beatId === beat.beatId)) {
            this.beatLock.completedBeats.push({
              beatId: beat.beatId,
              summary: beat.summary,
              chapter: chapterNumber,
              charactersInvolved: Array.isArray(beat.charactersInvolved) ? beat.charactersInvolved : [],
            });
          }
        }
      }

      // Merge extracted clues (validate each entry)
      if (Array.isArray(data.revealed_clues)) {
        const validCategories = new Set(['truth', 'relationship', 'identity', 'ability', 'other']);
        for (const clue of data.revealed_clues) {
          if (typeof clue.clueId !== 'string' || typeof clue.content !== 'string') continue;
          if (!this.clueLock.revealedClues.some((c) => c.clueId === clue.clueId)) {
            const category = typeof clue.category === 'string' && validCategories.has(clue.category)
              ? clue.category : 'other';
            this.clueLock.revealedClues.push({
              clueId: clue.clueId,
              content: clue.content,
              revealedAtChapter: chapterNumber,
              category,
              isValid: clue.isValid !== false,
            });
          }
        }
      }

      // Update timeline anchor
      if (data.timeline_anchor && typeof data.timeline_anchor === 'object') {
        const anchor = data.timeline_anchor as Record<string, unknown>;
        this.factLock.timelineAnchors.push({
          chapter: chapterNumber,
          inStoryTime: typeof anchor.inStoryTime === 'string' ? anchor.inStoryTime : '',
          events: Array.isArray(anchor.events) ? anchor.events : [],
        });
      }
    } catch (err) {
      console.warn('MemoryEngine: LLM extraction failed, skipping update', err);
    }
  }

  // --- External data merging ---

  mergeTriples(triples: RelationshipTriple[]): void {
    const existing = new Set(this.factLock.relationshipGraph.map((t) => `${t.subject}|${t.predicate}|${t.object}`));
    for (const triple of triples) {
      if (!existing.has(`${triple.subject}|${triple.predicate}|${triple.object}`)) {
        this.factLock.relationshipGraph.push(triple);
      }
    }
  }

  // --- Serialize / Deserialize ---

  serialize(): { factLock: FactLock; beatLock: BeatLock; clueLock: ClueLock } {
    return {
      factLock: this.factLock,
      beatLock: this.beatLock,
      clueLock: this.clueLock,
    };
  }

  static deserialize(data: { factLock: FactLock; beatLock: BeatLock; clueLock: ClueLock }, novelId: string): MemoryEngine {
    const engine = new MemoryEngine(novelId);
    engine.factLock = data.factLock;
    engine.beatLock = data.beatLock;
    engine.clueLock = data.clueLock;
    return engine;
  }
}

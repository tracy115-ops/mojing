// ============================================================================
// Narrative Evolution Engine
// Inspired by PlotPilot's EvolutionEngine + EvolutionGateService
//
// Tracks state changes across chapters (character states, relationships,
// knowledge reveals, prop transfers) and provides continuity validation.
// ============================================================================

import type {
  CharacterState,
  RelationshipTriple,
  Foreshadowing,
  ForeshadowingStatus,
} from '@/types/narrative';
import { NarrativeRepository } from './narrative-repository';

// --- Evolution Event ---

export type EvolutionEventType =
  | 'character_death'
  | 'character_revival'      // should be caught as contradiction!
  | 'relationship_change'
  | 'location_change'
  | 'knowledge_reveal'
  | 'power_change'
  | 'identity_reveal'
  | 'prop_transfer'
  | 'status_change';

export interface EvolutionEvent {
  id: string;
  novelId: string;
  chapterNumber: number;
  eventType: EvolutionEventType;
  description: string;
  entityId: string;          // character/prop/location ID
  entityType: 'character' | 'prop' | 'location' | 'knowledge';
  beforeState?: string;
  afterState?: string;
  confidence: number;        // 0-1, how confident the extraction was
  timestamp: string;
}

// --- State Snapshot ---

export interface StateSnapshot {
  chapterNumber: number;
  timestamp: string;
  characterStates: Map<string, string>;      // characterId → state summary
  relationships: Map<string, string>;        // "subject|object" → predicate
  knownFacts: Set<string>;                   // revealed fact IDs
  propHolders: Map<string, string>;          // propId → holderId
}

// --- Continuity Check ---

export interface ContinuityViolation {
  type: 'contradiction' | 'impossible_action' | 'forgotten_fact' | 'timeline_error';
  severity: 'warning' | 'error' | 'critical';
  description: string;
  chapterNumber: number;
  entityId?: string;
  evidence?: string;
}

// --- Evolution Engine ---

export class EvolutionEngine {
  private repo: NarrativeRepository;
  private events: EvolutionEvent[] = [];
  private snapshots: Map<number, StateSnapshot> = new Map();

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
    this.loadPersistedData();
  }

  // --- Event Recording ---

  /**
   * Record an evolution event and validate against current state.
   */
  recordEvent(event: Omit<EvolutionEvent, 'id' | 'timestamp'>): {
    event: EvolutionEvent;
    violations: ContinuityViolation[];
  } {
    const fullEvent: EvolutionEvent = {
      ...event,
      id: `evo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };

    // Validate against current state
    const violations = this.validateEvent(fullEvent);

    // Record the event
    this.events.push(fullEvent);

    // Update snapshot for this chapter
    this.updateSnapshot(fullEvent);

    // Persist
    this.persistEvents();

    return { event: fullEvent, violations };
  }

  /**
   * Batch record events from chapter aftermath.
   */
  recordChapterEvents(
    chapterNumber: number,
    characterStates: CharacterState[],
    tripleChanges: RelationshipTriple[],
    foreshadowingChanges: { resolved: Foreshadowing[] },
  ): ContinuityViolation[] {
    const allViolations: ContinuityViolation[] = [];

    // Record character state changes
    for (const state of characterStates) {
      const prevState = this.getCharacterState(state.characterId);

      if (state.physicalState.includes('死亡') || state.physicalState.includes('dead')) {
        const { violations } = this.recordEvent({
          novelId: this.repo['novelId'],
          chapterNumber,
          eventType: 'character_death',
          description: `${state.characterId} 死亡: ${state.physicalState}`,
          entityId: state.characterId,
          entityType: 'character',
          beforeState: prevState ?? 'alive',
          afterState: 'deceased',
          confidence: 0.9,
        });
        allViolations.push(...violations);
      }

      if (state.emotionalState && prevState !== state.emotionalState) {
        this.recordEvent({
          novelId: this.repo['novelId'],
          chapterNumber,
          eventType: 'status_change',
          description: `${state.characterId} 情感状态变化: ${prevState} → ${state.emotionalState}`,
          entityId: state.characterId,
          entityType: 'character',
          beforeState: prevState,
          afterState: state.emotionalState,
          confidence: 0.7,
        });
      }

      // Update character state map
      this.setCharacterState(state.characterId, state.physicalState);
    }

    // Record relationship changes
    for (const triple of tripleChanges) {
      this.recordEvent({
        novelId: this.repo['novelId'],
        chapterNumber,
        eventType: 'relationship_change',
        description: `${triple.subject} —[${triple.predicate}]→ ${triple.object}`,
        entityId: `${triple.subject}|${triple.object}`,
        entityType: 'character',
        confidence: 0.8,
      });
    }

    // Record foreshadowing resolutions
    for (const resolved of foreshadowingChanges.resolved) {
      this.recordEvent({
        novelId: this.repo['novelId'],
        chapterNumber,
        eventType: 'knowledge_reveal',
        description: `伏笔闭合: ${resolved.description}`,
        entityId: resolved.id,
        entityType: 'knowledge',
        confidence: 0.9,
      });
    }

    return allViolations;
  }

  // --- Validation ---

  /**
   * Validate an event against accumulated state (Evolution Gate).
   */
  private validateEvent(event: EvolutionEvent): ContinuityViolation[] {
    const violations: ContinuityViolation[] = [];

    // Rule: Dead characters can't act
    if (event.entityType === 'character') {
      const deathEvent = this.events.find(
        (e) =>
          e.entityId === event.entityId &&
          e.eventType === 'character_death',
      );

      if (deathEvent && event.eventType !== 'character_revival') {
        // Character is dead but a new event involves them in an active way
        if (event.confidence > 0.7) {
          violations.push({
            type: 'impossible_action',
            severity: 'critical',
            description: `${event.entityId} 已在第${deathEvent.chapterNumber}章死亡，但第${event.chapterNumber}章仍有动作`,
            chapterNumber: event.chapterNumber,
            entityId: event.entityId,
            evidence: deathEvent.description,
          });
        }
      }

      // Rule: Character revival is a contradiction
      if (event.eventType === 'character_revival') {
        violations.push({
          type: 'contradiction',
          severity: 'error',
          description: `${event.entityId} 试图复活，但无复活机制设定`,
          chapterNumber: event.chapterNumber,
          entityId: event.entityId,
        });
      }
    }

    // Rule: Identity reveal should happen only once
    if (event.eventType === 'identity_reveal') {
      const prevReveal = this.events.find(
        (e) =>
          e.entityId === event.entityId &&
          e.eventType === 'identity_reveal',
      );
      if (prevReveal) {
        violations.push({
          type: 'forgotten_fact',
          severity: 'warning',
          description: `${event.entityId} 的身份已在第${prevReveal.chapterNumber}章揭露，不应再次作为新发现`,
          chapterNumber: event.chapterNumber,
          entityId: event.entityId,
        });
      }
    }

    return violations;
  }

  // --- State Queries ---

  /**
   * Run a preflight check before generating a new chapter.
   * Returns warnings about state that the generation should be aware of.
   */
  preflightCheck(chapterNumber: number): {
    deadCharacters: string[];
    activeRelationships: Map<string, string>;
    unresolvedForeshadowing: number;
    recentEvents: EvolutionEvent[];
    warnings: string[];
  } {
    const deadCharacters = this.events
      .filter((e) => e.eventType === 'character_death')
      .map((e) => e.entityId);

    const activeRelationships = new Map<string, string>();
    for (const e of this.events.filter((e) => e.eventType === 'relationship_change')) {
      activeRelationships.set(e.entityId, e.description);
    }

    const foreshadowing = this.repo.loadForeshadowing();
    const unresolved = foreshadowing.filter((f) => f.status === 'planted').length;

    const recentEvents = this.events
      .filter((e) => Math.abs(e.chapterNumber - chapterNumber) <= 3)
      .slice(-10);

    const warnings: string[] = [];

    // Warn about dead characters that might be referenced
    if (deadCharacters.length > 0) {
      warnings.push(`已死亡角色: ${deadCharacters.join(', ')} — 不可作为行动主体`);
    }

    // Warn about overdue foreshadowing
    const overdue = foreshadowing.filter(
      (f) => f.status === 'planted' && f.suggestedResolveChapter && f.suggestedResolveChapter < chapterNumber,
    );
    if (overdue.length > 0) {
      warnings.push(`${overdue.length} 条伏笔已过期，需要优先闭合`);
    }

    return {
      deadCharacters,
      activeRelationships,
      unresolvedForeshadowing: unresolved,
      recentEvents,
      warnings,
    };
  }

  /**
   * Build a continuity context string for injection into the generation prompt.
   */
  buildContinuityContext(chapterNumber: number): string {
    const check = this.preflightCheck(chapterNumber);
    if (check.deadCharacters.length === 0 && check.warnings.length === 0 && check.recentEvents.length === 0) {
      return '';
    }

    const lines: string[] = ['【连续性门控 — 进化引擎校验】'];

    if (check.deadCharacters.length > 0) {
      lines.push(`已死亡角色（绝不可复活/行动）: ${check.deadCharacters.join(', ')}`);
    }

    if (check.recentEvents.length > 0) {
      lines.push('近3章关键变化:');
      for (const e of check.recentEvents.slice(-5)) {
        lines.push(`  [Ch${e.chapterNumber}] ${e.description}`);
      }
    }

    for (const w of check.warnings) {
      lines.push(`⚠ ${w}`);
    }

    return lines.join('\n');
  }

  // --- State Helpers ---

  private characterStates: Map<string, string> = new Map();

  private getCharacterState(characterId: string): string | undefined {
    return this.characterStates.get(characterId);
  }

  private setCharacterState(characterId: string, state: string): void {
    this.characterStates.set(characterId, state);
  }

  private updateSnapshot(event: EvolutionEvent): void {
    if (!this.snapshots.has(event.chapterNumber)) {
      this.snapshots.set(event.chapterNumber, {
        chapterNumber: event.chapterNumber,
        timestamp: event.timestamp,
        characterStates: new Map(),
        relationships: new Map(),
        knownFacts: new Set(),
        propHolders: new Map(),
      });
    }

    const snapshot = this.snapshots.get(event.chapterNumber)!;

    switch (event.entityType) {
      case 'character':
        if (event.afterState) {
          snapshot.characterStates.set(event.entityId, event.afterState);
        }
        break;
      case 'prop':
        if (event.eventType === 'prop_transfer' && event.afterState) {
          snapshot.propHolders.set(event.entityId, event.afterState);
        }
        break;
    }
  }

  // --- Persistence ---

  private loadPersistedData(): void {
    try {
      const raw = localStorage.getItem(this.eventsKey());
      if (raw) {
        this.events = JSON.parse(raw);
      }
    } catch {
      this.events = [];
    }
  }

  private persistEvents(): void {
    localStorage.setItem(this.eventsKey(), JSON.stringify(this.events));
  }

  private eventsKey(): string {
    return `mojing-narrative:${this.repo['novelId']}:evolution-events`;
  }

  // --- Queries ---

  getEvents(chapterNumber?: number): EvolutionEvent[] {
    if (chapterNumber !== undefined) {
      return this.events.filter((e) => e.chapterNumber === chapterNumber);
    }
    return this.events;
  }

  getViolations(chapterNumber?: number): ContinuityViolation[] {
    // Re-validate all events up to given chapter
    const relevant = chapterNumber !== undefined
      ? this.events.filter((e) => e.chapterNumber <= chapterNumber)
      : this.events;

    const violations: ContinuityViolation[] = [];
    for (const event of relevant) {
      violations.push(...this.validateEvent(event));
    }
    return violations;
  }

  /**
   * Get the timeline of events for UI visualization.
   */
  getTimeline(): Array<{ chapter: number; events: EvolutionEvent[] }> {
    const byChapter = new Map<number, EvolutionEvent[]>();
    for (const e of this.events) {
      const list = byChapter.get(e.chapterNumber) ?? [];
      list.push(e);
      byChapter.set(e.chapterNumber, list);
    }
    return Array.from(byChapter.entries())
      .sort(([a], [b]) => a - b)
      .map(([chapter, events]) => ({ chapter, events }));
  }
}

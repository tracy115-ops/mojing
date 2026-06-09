// ============================================================================
// Narrative Repository — Unified persistence for all novel engine state
// Uses Zustand persist under the hood; provides clean CRUD interface.
// ============================================================================

import type {
  StoryBible,
  BibleCharacter,
  BibleLocation,
  BibleWorldSetting,
  BibleStyleNote,
  BibleTimelineNote,
  Foreshadowing,
  RelationshipTriple,
  TimelineAnchor,
  CompletedBeat,
  CharacterState,
  NarrativeDebt,
  TensionPoint,
  VoiceFingerprint,
  Storyline,
  Worldbuilding,
  ChapterCast,
} from '@/types/narrative';
import type { AutopilotState, CircuitBreakerState } from '@/types/pipeline';

// --- Storage Keys ---

const STORAGE_PREFIX = 'mojing-narrative';

function key(novelId: string, suffix: string): string {
  return `${STORAGE_PREFIX}:${novelId}:${suffix}`;
}

// --- Generic helpers ---

function load<T>(storageKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save<T>(storageKey: string, data: T): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch (err) {
    console.warn(`NarrativeRepository: failed to save ${storageKey}`, err);
  }
}

// ============================================================================
// Narrative Repository
// ============================================================================

export class NarrativeRepository {
  private novelId: string;

  constructor(novelId: string) {
    this.novelId = novelId;
  }

  // --- Story Bible ---

  loadBible(): StoryBible {
    return load<StoryBible>(key(this.novelId, 'bible'), {
      novelId: this.novelId,
      characters: [],
      locations: [],
      worldSettings: [],
      styleNotes: [],
      timelineNotes: [],
    });
  }

  saveBible(bible: StoryBible): void {
    save(key(this.novelId, 'bible'), bible);
  }

  // -- Character CRUD --

  getCharacters(): BibleCharacter[] {
    return this.loadBible().characters;
  }

  getCharacter(characterId: string): BibleCharacter | undefined {
    return this.loadBible().characters.find((c) => c.id === characterId);
  }

  upsertCharacter(character: BibleCharacter): void {
    const bible = this.loadBible();
    const idx = bible.characters.findIndex((c) => c.id === character.id);
    if (idx >= 0) {
      bible.characters[idx] = character;
    } else {
      bible.characters.push(character);
    }
    this.saveBible(bible);
  }

  deleteCharacter(characterId: string): void {
    const bible = this.loadBible();
    bible.characters = bible.characters.filter((c) => c.id !== characterId);
    this.saveBible(bible);
  }

  // -- Location CRUD --

  getLocations(): BibleLocation[] {
    return this.loadBible().locations;
  }

  upsertLocation(location: BibleLocation): void {
    const bible = this.loadBible();
    const idx = bible.locations.findIndex((l) => l.id === location.id);
    if (idx >= 0) {
      bible.locations[idx] = location;
    } else {
      bible.locations.push(location);
    }
    this.saveBible(bible);
  }

  deleteLocation(locationId: string): void {
    const bible = this.loadBible();
    bible.locations = bible.locations.filter((l) => l.id !== locationId);
    this.saveBible(bible);
  }

  // -- World Setting CRUD --

  getWorldSettings(): BibleWorldSetting[] {
    return this.loadBible().worldSettings;
  }

  upsertWorldSetting(setting: BibleWorldSetting): void {
    const bible = this.loadBible();
    const idx = bible.worldSettings.findIndex((s) => s.id === setting.id);
    if (idx >= 0) {
      bible.worldSettings[idx] = setting;
    } else {
      bible.worldSettings.push(setting);
    }
    this.saveBible(bible);
  }

  deleteWorldSetting(settingId: string): void {
    const bible = this.loadBible();
    bible.worldSettings = bible.worldSettings.filter((s) => s.id !== settingId);
    this.saveBible(bible);
  }

  // -- Style Notes --

  getStyleNotes(): BibleStyleNote[] {
    return this.loadBible().styleNotes;
  }

  upsertStyleNote(note: BibleStyleNote): void {
    const bible = this.loadBible();
    const idx = bible.styleNotes.findIndex((n) => n.id === note.id);
    if (idx >= 0) {
      bible.styleNotes[idx] = note;
    } else {
      bible.styleNotes.push(note);
    }
    this.saveBible(bible);
  }

  deleteStyleNote(noteId: string): void {
    const bible = this.loadBible();
    bible.styleNotes = bible.styleNotes.filter((n) => n.id !== noteId);
    this.saveBible(bible);
  }

  // --- Foreshadowing ---

  loadForeshadowing(): Foreshadowing[] {
    return load<Foreshadowing[]>(key(this.novelId, 'foreshadowing'), []);
  }

  saveForeshadowing(items: Foreshadowing[]): void {
    save(key(this.novelId, 'foreshadowing'), items);
  }

  // --- Triples (Knowledge Graph) ---

  loadTriples(): RelationshipTriple[] {
    return load<RelationshipTriple[]>(key(this.novelId, 'triples'), []);
  }

  saveTriples(triples: RelationshipTriple[]): void {
    save(key(this.novelId, 'triples'), triples);
  }

  addTriples(newTriples: RelationshipTriple[]): void {
    const existing = this.loadTriples();
    const keys = new Set(existing.map((t) => `${t.subject}|${t.predicate}|${t.object}`));
    for (const t of newTriples) {
      if (!keys.has(`${t.subject}|${t.predicate}|${t.object}`)) {
        existing.push(t);
        keys.add(`${t.subject}|${t.predicate}|${t.object}`);
      }
    }
    this.saveTriples(existing);
  }

  // --- Completed Beats ---

  loadCompletedBeats(): CompletedBeat[] {
    return load<CompletedBeat[]>(key(this.novelId, 'beats'), []);
  }

  saveCompletedBeats(beats: CompletedBeat[]): void {
    save(key(this.novelId, 'beats'), beats);
  }

  // --- Timeline Anchors ---

  loadTimelineAnchors(): TimelineAnchor[] {
    return load<TimelineAnchor[]>(key(this.novelId, 'timeline'), []);
  }

  saveTimelineAnchors(anchors: TimelineAnchor[]): void {
    save(key(this.novelId, 'timeline'), anchors);
  }

  // --- Character States ---

  loadCharacterStates(): CharacterState[] {
    return load<CharacterState[]>(key(this.novelId, 'char-states'), []);
  }

  saveCharacterStates(states: CharacterState[]): void {
    save(key(this.novelId, 'char-states'), states);
  }

  // --- Narrative Debts ---

  loadNarrativeDebts(): NarrativeDebt[] {
    return load<NarrativeDebt[]>(key(this.novelId, 'debts'), []);
  }

  saveNarrativeDebts(debts: NarrativeDebt[]): void {
    save(key(this.novelId, 'debts'), debts);
  }

  // --- Tension Points ---

  loadTensionPoints(): TensionPoint[] {
    return load<TensionPoint[]>(key(this.novelId, 'tension'), []);
  }

  saveTensionPoints(points: TensionPoint[]): void {
    save(key(this.novelId, 'tension'), points);
  }

  addTensionPoint(point: TensionPoint): void {
    const points = this.loadTensionPoints();
    points.push(point);
    this.saveTensionPoints(points);
  }

  // --- Voice Fingerprint ---

  loadVoiceFingerprint(): VoiceFingerprint | null {
    return load<VoiceFingerprint | null>(key(this.novelId, 'voice'), null);
  }

  saveVoiceFingerprint(fp: VoiceFingerprint): void {
    save(key(this.novelId, 'voice'), fp);
  }

  // --- Autopilot Checkpoint ---

  loadCheckpoint(): AutopilotCheckpoint | null {
    return load<AutopilotCheckpoint | null>(key(this.novelId, 'checkpoint'), null);
  }

  saveCheckpoint(checkpoint: AutopilotCheckpoint): void {
    save(key(this.novelId, 'checkpoint'), checkpoint);
  }

  clearCheckpoint(): void {
    localStorage.removeItem(key(this.novelId, 'checkpoint'));
  }

  // --- Storylines ---

  loadStorylines(): Storyline[] {
    return load<Storyline[]>(key(this.novelId, 'storylines'), []);
  }

  saveStorylines(lines: Storyline[]): void {
    save(key(this.novelId, 'storylines'), lines);
  }

  upsertStoryline(line: Storyline): void {
    const lines = this.loadStorylines();
    const idx = lines.findIndex((l) => l.id === line.id);
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    this.saveStorylines(lines);
  }

  deleteStoryline(id: string): void {
    this.saveStorylines(this.loadStorylines().filter((l) => l.id !== id));
  }

  // --- Worldbuilding ---

  loadWorldbuilding(): Worldbuilding {
    return load<Worldbuilding>(key(this.novelId, 'worldbuilding'), {
      novelId: this.novelId,
      dimensions: {
        coreRules: { title: '', fields: {} },
        geography: { title: '', fields: {} },
        society: { title: '', fields: {} },
        culture: { title: '', fields: {} },
        dailyLife: { title: '', fields: {} },
      },
    });
  }

  saveWorldbuilding(wb: Worldbuilding): void {
    save(key(this.novelId, 'worldbuilding'), wb);
  }

  // --- Chapter Cast ---

  loadChapterCasts(): ChapterCast[] {
    return load<ChapterCast[]>(key(this.novelId, 'casts'), []);
  }

  saveChapterCasts(casts: ChapterCast[]): void {
    save(key(this.novelId, 'casts'), casts);
  }

  getChapterCast(chapterIndex: number): ChapterCast | undefined {
    return this.loadChapterCasts().find((c) => c.chapterIndex === chapterIndex);
  }

  upsertChapterCast(cast: ChapterCast): void {
    const casts = this.loadChapterCasts();
    const idx = casts.findIndex((c) => c.chapterIndex === cast.chapterIndex);
    if (idx >= 0) casts[idx] = cast;
    else casts.push(cast);
    this.saveChapterCasts(casts);
  }

  // --- Full Export / Import ---

  exportAll(): NarrativeSnapshot {
    return {
      bible: this.loadBible(),
      foreshadowing: this.loadForeshadowing(),
      triples: this.loadTriples(),
      completedBeats: this.loadCompletedBeats(),
      timelineAnchors: this.loadTimelineAnchors(),
      characterStates: this.loadCharacterStates(),
      narrativeDebts: this.loadNarrativeDebts(),
      tensionPoints: this.loadTensionPoints(),
      voiceFingerprint: this.loadVoiceFingerprint(),
      checkpoint: this.loadCheckpoint(),
    };
  }

  importAll(snapshot: NarrativeSnapshot): void {
    if (snapshot.bible) this.saveBible(snapshot.bible);
    if (snapshot.foreshadowing) this.saveForeshadowing(snapshot.foreshadowing);
    if (snapshot.triples) this.saveTriples(snapshot.triples);
    if (snapshot.completedBeats) this.saveCompletedBeats(snapshot.completedBeats);
    if (snapshot.timelineAnchors) this.saveTimelineAnchors(snapshot.timelineAnchors);
    if (snapshot.characterStates) this.saveCharacterStates(snapshot.characterStates);
    if (snapshot.narrativeDebts) this.saveNarrativeDebts(snapshot.narrativeDebts);
    if (snapshot.tensionPoints) this.saveTensionPoints(snapshot.tensionPoints);
    if (snapshot.voiceFingerprint) this.saveVoiceFingerprint(snapshot.voiceFingerprint);
    if (snapshot.checkpoint) this.saveCheckpoint(snapshot.checkpoint);
  }

  // --- Generic custom data ---

  loadCustomData<T>(suffix: string, fallback: T): T {
    return load<T>(key(this.novelId, suffix), fallback);
  }

  saveCustomData<T>(suffix: string, data: T): void {
    save(key(this.novelId, suffix), data);
  }

  // --- Clear all narrative data ---

  clearAll(): void {
    const suffixes = ['bible', 'foreshadowing', 'triples', 'beats', 'timeline', 'char-states', 'debts', 'tension', 'voice', 'checkpoint', 'storylines', 'worldbuilding', 'casts'];
    for (const s of suffixes) {
      localStorage.removeItem(key(this.novelId, s));
    }
  }
}

// --- Types ---

export interface AutopilotCheckpoint {
  novelId: string;
  timestamp: string;
  autopilotState: AutopilotState;
  breakerState: CircuitBreakerState;
  memorySnapshot: {
    factLock: import('@/types/narrative').FactLock;
    beatLock: import('@/types/narrative').BeatLock;
    clueLock: import('@/types/narrative').ClueLock;
  };
  foreshadowingSnapshot: Foreshadowing[];
  chapterIndex: number;
  beatIndex: number;
}

export interface NarrativeSnapshot {
  bible?: StoryBible;
  foreshadowing?: Foreshadowing[];
  triples?: RelationshipTriple[];
  completedBeats?: CompletedBeat[];
  timelineAnchors?: TimelineAnchor[];
  characterStates?: CharacterState[];
  narrativeDebts?: NarrativeDebt[];
  tensionPoints?: TensionPoint[];
  voiceFingerprint?: VoiceFingerprint | null;
  checkpoint?: AutopilotCheckpoint | null;
}

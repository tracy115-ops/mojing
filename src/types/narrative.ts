// ============================================================================
// Narrative Engine Types — PlotPilot-inspired state machine & memory
// ============================================================================

// --- Story Bible ---

export interface StoryBible {
  novelId: string;
  characters: BibleCharacter[];
  locations: BibleLocation[];
  worldSettings: BibleWorldSetting[];
  styleNotes: BibleStyleNote[];
  timelineNotes: BibleTimelineNote[];
}

export interface BibleCharacter {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  appearance: string;
  personality: string;
  backstory: string;
  relationships: CharacterRelationship[];
  currentState: string;
  firstAppearChapter: number;
  lastUpdateChapter: number;
  importance: 'protagonist' | 'major' | 'supporting' | 'minor';
  status: 'active' | 'deceased' | 'missing' | 'retired';
}

export interface CharacterRelationship {
  targetCharacterId: string;
  type: string;         // ally, enemy, lover, mentor, family, rival
  description: string;
  sinceChapter: number;
}

export interface BibleLocation {
  id: string;
  name: string;
  description: string;
  parentLocation?: string;
  significance: string;
}

export interface BibleWorldSetting {
  id: string;
  category: string;     // magic_system, technology, social_structure, history, rules
  name: string;
  description: string;
  constraints: string[];
}

export interface BibleStyleNote {
  id: string;
  key: string;
  value: string;
  chapterRange?: [number, number];
}

export interface BibleTimelineNote {
  id: string;
  chapter: number;
  event: string;
  timestamp?: string;   // in-story time
  significance: string;
}

// --- Memory Engine: Three Locks ---

export interface FactLock {
  novelId: string;
  characterWhitelist: string[];
  deathList: string[];
  relationshipGraph: RelationshipTriple[];
  identityLocks: IdentityLock[];
  timelineAnchors: TimelineAnchor[];
}

export interface RelationshipTriple {
  subject: string;
  predicate: string;
  object: string;
  sinceChapter: number;
  source: 'bible' | 'extracted';
}

export interface IdentityLock {
  characterId: string;
  realName?: string;
  aliases: string[];
  secretIdentity?: string;
  revealedToReaders: boolean;
  revealedInChapter?: number;
}

export interface TimelineAnchor {
  chapter: number;
  inStoryTime: string;
  events: string[];
}

export interface BeatLock {
  novelId: string;
  completedBeats: CompletedBeat[];
}

export interface CompletedBeat {
  beatId: string;
  summary: string;
  chapter: number;
  charactersInvolved: string[];
}

export interface ClueLock {
  novelId: string;
  revealedClues: RevealedClue[];
}

export interface RevealedClue {
  clueId: string;
  content: string;
  revealedAtChapter: number;
  category: 'truth' | 'relationship' | 'identity' | 'ability' | 'other';
  isValid: boolean;
}

// --- Foreshadowing Registry ---

export type ForeshadowingStatus = 'planted' | 'resolved' | 'abandoned';

export interface Foreshadowing {
  id: string;
  novelId: string;
  description: string;
  plantedInChapter: number;
  suggestedResolveChapter?: number;
  resolvedInChapter?: number;
  status: ForeshadowingStatus;
  relatedCharacters: string[];
  urgency: 'low' | 'medium' | 'high' | 'critical';
  narrativeWeight: number; // 0-10
}

// --- Character State Tracking ---

export interface CharacterState {
  characterId: string;
  novelId: string;
  chapter: number;
  physicalState: string;
  emotionalState: string;
  location: string;
  knowledge: string[];         // what the character knows
  inventory?: string[];
  motivations: string[];
  recentEvents: string[];
}

// --- Narrative Debt ---

export interface NarrativeDebt {
  id: string;
  novelId: string;
  type: 'unresolved_plot' | 'promised_return' | 'mysterious_identity' | 'power_upgrade_pending' | 'other';
  description: string;
  plantedInChapter: number;
  suggestedResolveBy: number;
  priority: number;             // 0-10
  status: 'open' | 'in_progress' | 'resolved' | 'expired';
}

// --- Context Budget (Onion Model) ---

export type PriorityTier = 'T0' | 'T1' | 'T2' | 'T3';

export interface ContextSlot {
  name: string;
  tier: PriorityTier;
  content: string;
  estimatedTokens: number;
  maxTokens?: number;
  minTokens: number;
  priority: number;            // within tier, higher = more important
}

export interface BudgetAllocation {
  slots: Map<string, ContextSlot>;
  totalBudget: number;
  usedTokens: number;
  t0Reserved: number;
  t1Allocated: number;
  t2Allocated: number;
  t3Allocated: number;
  compressionApplied: boolean;
}

// --- Story Phase (Convergence Hourglass) ---

export type StoryPhase = 'opening' | 'development' | 'convergence' | 'finale';

export interface StoryPhaseState {
  novelId: string;
  currentPhase: StoryPhase;
  progress: number;            // 0.0 - 1.0
  totalChapters: number;
  currentChapter: number;
  behaviorRules: StoryPhaseRules;
}

export interface StoryPhaseRules {
  allowNewSubplots: boolean;
  allowNewCharacters: boolean;
  foreshadowingPressure: number; // 0-1, how hard to push resolving foreshadowing
  convergenceLevel: number;      // 0-1, how much to push toward ending
  dailyLifeAllowed: boolean;
}

// --- Chapter Aftermath Result ---

export interface ChapterAftermathResult {
  novelId: string;
  chapterNumber: number;
  summary: string;
  keyEvents: string[];
  characterStates: CharacterState[];
  triples: RelationshipTriple[];
  foreshadowings: {
    planted: Foreshadowing[];
    resolved: Foreshadowing[];
    detected: Foreshadowing[];
  };
  narrativeDebts: NarrativeDebt[];
  tensionScore: number;        // 0-10
  styleScore: number;          // 0-1
  wordCount: number;
}

// --- Tension Tracking ---

export interface TensionPoint {
  chapter: number;
  score: number;               // 0-10
  dimensions: TensionDimensions;
}

export interface TensionDimensions {
  plot: number;
  character: number;
  emotional: number;
  mystery: number;
  action: number;
}

// --- Voice/Style ---

export interface VoiceFingerprint {
  novelId: string;
  features: {
    avgSentenceLength: number;
    dialogueRatio: number;
    descriptionRatio: number;
    vocabularyLevel: number;
    emotionalTone: string;
    syntacticPatterns: string[];
  };
  referenceChapters: number[];
}

export interface VoiceDriftReport {
  chapter: number;
  similarity: number;          // 0-1, 1 = identical to reference
  driftDetected: boolean;
  suggestedFix?: string;
}

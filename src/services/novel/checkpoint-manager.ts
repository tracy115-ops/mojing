// ============================================================================
// Checkpoint Manager — Save/Resume autopilot state for long-running generation
// Inspired by PlotPilot's SnapshotManager + checkpoint system
// ============================================================================

import type { AutopilotState, CircuitBreakerState } from '@/types/pipeline';
import type {
  FactLock,
  BeatLock,
  ClueLock,
  Foreshadowing,
  StoryPhaseState,
} from '@/types/narrative';
import { NarrativeRepository, type AutopilotCheckpoint } from './narrative-repository';

export class CheckpointManager {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  /**
   * Save a checkpoint before each chapter generation.
   * This allows resuming from the exact state if generation is interrupted.
   */
  save(params: {
    autopilotState: AutopilotState;
    breakerState: CircuitBreakerState;
    factLock: FactLock;
    beatLock: BeatLock;
    clueLock: ClueLock;
    foreshadowing: Foreshadowing[];
    chapterIndex: number;
    beatIndex: number;
  }): void {
    const checkpoint: AutopilotCheckpoint = {
      novelId: params.autopilotState.novelId,
      timestamp: new Date().toISOString(),
      autopilotState: { ...params.autopilotState },
      breakerState: { ...params.breakerState },
      memorySnapshot: {
        factLock: structuredClone(params.factLock),
        beatLock: structuredClone(params.beatLock),
        clueLock: structuredClone(params.clueLock),
      },
      foreshadowingSnapshot: structuredClone(params.foreshadowing),
      chapterIndex: params.chapterIndex,
      beatIndex: params.beatIndex,
    };

    this.repo.saveCheckpoint(checkpoint);

    // Also persist narrative data alongside the checkpoint
    this.repo.saveForeshadowing(params.foreshadowing);
    this.repo.saveCompletedBeats(params.beatLock.completedBeats);
    this.repo.saveTriples(params.factLock.relationshipGraph);
    this.repo.saveTimelineAnchors(params.factLock.timelineAnchors);
  }

  /**
   * Check if a checkpoint exists for this novel.
   */
  hasCheckpoint(): boolean {
    return this.repo.loadCheckpoint() !== null;
  }

  /**
   * Load the last checkpoint. Returns null if none exists.
   */
  load(): AutopilotCheckpoint | null {
    return this.repo.loadCheckpoint();
  }

  /**
   * Clear the checkpoint after successful completion or manual reset.
   */
  clear(): void {
    this.repo.clearCheckpoint();
  }

  /**
   * Get a summary of the checkpoint for UI display.
   */
  getSummary(): CheckpointSummary | null {
    const cp = this.repo.loadCheckpoint();
    if (!cp) return null;

    return {
      novelId: cp.novelId,
      savedAt: cp.timestamp,
      chapterIndex: cp.chapterIndex,
      beatIndex: cp.beatIndex,
      status: cp.autopilotState.status,
      stage: cp.autopilotState.currentStage,
      progress: cp.autopilotState.progress,
      totalChapters: cp.autopilotState.targetChapterCount,
      totalBeats: cp.memorySnapshot.beatLock.completedBeats.length,
      totalForeshadowing: cp.foreshadowingSnapshot.filter((f) => f.status === 'planted').length,
      totalTriples: cp.memorySnapshot.factLock.relationshipGraph.length,
    };
  }

  /**
   * Restore engine state from checkpoint.
   * Returns null if no checkpoint exists.
   */
  restore(): RestoredState | null {
    const cp = this.repo.loadCheckpoint();
    if (!cp) return null;

    return {
      autopilotState: cp.autopilotState,
      breakerState: cp.breakerState,
      memorySnapshot: cp.memorySnapshot,
      foreshadowing: cp.foreshadowingSnapshot,
      resumeFromChapter: cp.chapterIndex,
      resumeFromBeat: cp.beatIndex,
    };
  }
}

// --- Types ---

export interface CheckpointSummary {
  novelId: string;
  savedAt: string;
  chapterIndex: number;
  beatIndex: number;
  status: string;
  stage: string;
  progress: number;
  totalChapters: number;
  totalBeats: number;
  totalForeshadowing: number;
  totalTriples: number;
}

export interface RestoredState {
  autopilotState: AutopilotState;
  breakerState: CircuitBreakerState;
  memorySnapshot: {
    factLock: FactLock;
    beatLock: BeatLock;
    clueLock: ClueLock;
  };
  foreshadowing: Foreshadowing[];
  resumeFromChapter: number;
  resumeFromBeat: number;
}

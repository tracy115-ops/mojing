import { create } from 'zustand';
import type {
  AutopilotState,
  AutopilotStatus,
  CircuitBreakerState,
} from '@/types/pipeline';
import type { StoryPhaseState, BeatFocus } from '@/types/narrative';

// --- Beat progress tracking ---

export interface BeatProgress {
  totalBeats: number;
  currentBeatIndex: number;
  currentFocus: BeatFocus | null;
  currentTargetWords: number;
  currentPhase: 'unfurl' | 'converge' | 'land' | null;
  beatWordCount: number;
  chapterWordCount: number;
}

interface AutopilotStoreState {
  // Per-novel autopilot states
  states: Record<string, AutopilotState>;
  breakers: Record<string, CircuitBreakerState>;
  storyPhases: Record<string, StoryPhaseState>;

  // Beat progress per novel
  beatProgress: Record<string, BeatProgress>;

  // Active engine instance reference (not persisted)
  activeEngineNovelId: string | null;

  // Actions
  setAutopilotState: (novelId: string, state: Partial<AutopilotState>) => void;
  setBreaker: (novelId: string, breaker: CircuitBreakerState) => void;
  setStoryPhase: (novelId: string, phase: StoryPhaseState) => void;
  setBeatProgress: (novelId: string, progress: Partial<BeatProgress>) => void;
  setActiveEngine: (novelId: string | null) => void;
  clearNovel: (novelId: string) => void;

  // Convenience selectors
  getAutopilotState: (novelId: string) => AutopilotState | undefined;
  getStatus: (novelId: string) => AutopilotStatus;
  isRunning: (novelId: string) => boolean;
}

const DEFAULT_AUTOPILOT_STATE: Omit<AutopilotState, 'novelId'> = {
  status: 'idle',
  currentStage: 'idle',
  currentChapterNumber: 0,
  currentBeatIndex: 0,
  targetChapterCount: 0,
  targetWordCount: 0,
  currentWordCount: 0,
  consecutiveFailures: 0,
  progress: 0,
};

export const useAutopilotStore = create<AutopilotStoreState>()(
  (set, get) => ({
    states: {},
    breakers: {},
    storyPhases: {},
    beatProgress: {},
    activeEngineNovelId: null,

    setAutopilotState: (novelId, updates) => {
      set((s) => ({
        states: {
          ...s.states,
          [novelId]: {
            ...(s.states[novelId] ?? { ...DEFAULT_AUTOPILOT_STATE, novelId }),
            ...updates,
          },
        },
      }));
    },

    setBreaker: (novelId, breaker) => {
      set((s) => ({
        breakers: { ...s.breakers, [novelId]: breaker },
      }));
    },

    setStoryPhase: (novelId, phase) => {
      set((s) => ({
        storyPhases: { ...s.storyPhases, [novelId]: phase },
      }));
    },

    setBeatProgress: (novelId, updates) => {
      set((s) => ({
        beatProgress: {
          ...s.beatProgress,
          [novelId]: {
            ...(s.beatProgress[novelId] ?? {
              totalBeats: 0,
              currentBeatIndex: 0,
              currentFocus: null,
              currentTargetWords: 0,
              currentPhase: null,
              beatWordCount: 0,
              chapterWordCount: 0,
            }),
            ...updates,
          },
        },
      }));
    },

    setActiveEngine: (novelId) => {
      set({ activeEngineNovelId: novelId });
    },

    clearNovel: (novelId) => {
      set((s) => {
        const { [novelId]: _, ...restStates } = s.states;
        const { [novelId]: __, ...restBreakers } = s.breakers;
        const { [novelId]: ___, ...restPhases } = s.storyPhases;
        const { [novelId]: ____, ...restBeatProgress } = s.beatProgress;
        return {
          states: restStates,
          breakers: restBreakers,
          storyPhases: restPhases,
          beatProgress: restBeatProgress,
          activeEngineNovelId: s.activeEngineNovelId === novelId ? null : s.activeEngineNovelId,
        };
      });
    },

    getAutopilotState: (novelId) => get().states[novelId],
    getStatus: (novelId) => get().states[novelId]?.status ?? 'idle',
    isRunning: (novelId) => get().states[novelId]?.status === 'running',
  }),
);

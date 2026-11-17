import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface MusicTrack {
  id: string;
  title: string;
  style: string;
  prompt?: string;
  lyrics?: string;
  audioUrl: string;
  vocalUrl?: string;
  instrumentalUrl?: string;
  durationSeconds: number;
  tags: string[];
  isInstrumental: boolean;
  createdAt: string;
}

interface MusicStoreState {
  tracks: MusicTrack[];
  currentTrackId: string | null;
  isPlaying: boolean;
  credits: number;
  addTrack: (track: MusicTrack) => void;
  removeTrack: (id: string) => void;
  setCurrentTrack: (id: string | null) => void;
  setIsPlaying: (playing: boolean) => void;
  consumeCredit: (amount?: number) => boolean;
  addCredits: (amount: number) => void;
}

export const useMusicStore = create<MusicStoreState>()(
  persist(
    (set, get) => ({
      tracks: [],
      currentTrackId: null,
      isPlaying: false,
      credits: 10, // 初始赠送 10 次 AI 音乐创作额度
      addTrack: (track) =>
        set((state) => ({
          tracks: [track, ...state.tracks],
          currentTrackId: track.id,
        })),
      removeTrack: (id) =>
        set((state) => ({
          tracks: state.tracks.filter((t) => t.id !== id),
          currentTrackId: state.currentTrackId === id ? null : state.currentTrackId,
        })),
      setCurrentTrack: (id) => set({ currentTrackId: id }),
      setIsPlaying: (playing) => set({ isPlaying: playing }),
      consumeCredit: (amount = 1) => {
        const { credits } = get();
        if (credits < amount) return false;
        set({ credits: credits - amount });
        return true;
      },
      addCredits: (amount) => set((state) => ({ credits: state.credits + amount })),
    }),
    {
      name: 'mojing-music-store',
      // Playback is transient. Never restore a playing badge without audio.
      partialize: ({ isPlaying: _isPlaying, ...state }) => state,
      merge: (persisted, current) => {
        const state = persisted as Partial<MusicStoreState>;
        const tracks = (state.tracks ?? []).filter(track => track.id !== 'demo_track_1');
        return { ...current, ...state, tracks, isPlaying: false, currentTrackId: tracks.some(track => track.id === state.currentTrackId) ? state.currentTrackId! : null };
      },
    },
  ),
);

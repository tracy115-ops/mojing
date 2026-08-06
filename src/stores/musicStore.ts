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
      tracks: [
        {
          id: 'demo_track_1',
          title: '赛博夜流 · 霓虹狂想曲',
          style: 'Cyberpunk Synthwave, Heavy Bass, 128 BPM',
          prompt: 'A high-energy cyberpunk synthwave track with heavy bassline and futuristic synth leads.',
          lyrics: '[Verse 1]\n霓虹在雨夜闪烁\n数据的河流穿梭\n[Chorus]\n在赛博的世界里无声高歌\n自由是最后的选择',
          audioUrl: 'https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c8a73361.mp3?filename=cyberpunk-2099-10701.mp3',
          durationSeconds: 142,
          tags: ['赛博朋克', '电子音乐', '燃向'],
          isInstrumental: false,
          createdAt: new Date().toISOString(),
        },
      ],
      currentTrackId: 'demo_track_1',
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
    },
  ),
);

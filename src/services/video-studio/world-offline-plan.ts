import type { WorldDocument } from '../../types/video-studio.ts';
import { worldPlaybackDuration } from './world-sequence.ts';

export interface WorldFramePlan { width: number; height: number; fps: number; frameCount: number; durationSeconds: number }
export function worldFramePlan(world: WorldDocument, longEdge: number, fps: number): WorldFramePlan {
  const [w, h] = world.aspectRatio.split(':').map(Number), durationSeconds = worldPlaybackDuration(world);
  if (![1280, 1920].includes(longEdge) || ![15, 24, 25, 30].includes(fps) || ![w, h, durationSeconds].every(Number.isFinite) || w <= 0 || h <= 0 || durationSeconds <= 0 || durationSeconds > 60) throw new Error('Invalid offline render settings');
  const even = (n: number) => Math.round(n / 2) * 2;
  const width = w >= h ? longEdge : even(longEdge * w / h), height = w >= h ? even(longEdge * h / w) : longEdge;
  return { width, height, fps, durationSeconds, frameCount: Math.ceil(Math.round(durationSeconds * fps * 1e6) / 1e6) };
}

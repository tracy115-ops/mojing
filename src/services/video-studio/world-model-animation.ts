import type { WorldAnimationPlayback } from '../../types/video-studio.ts';

export const defaultWorldAnimationPlayback = (): WorldAnimationPlayback => ({ startTime: 0, inPoint: 0, speed: 1, loop: 'repeat' });

/** Resolve against real GLB metadata; imported source ranges cannot read past the clip. */
export function worldAnimationRange(playback: WorldAnimationPlayback | undefined, duration: number) {
  const end = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const inPoint = Math.min(end, playback?.inPoint ?? 0);
  const outPoint = Math.max(inPoint, Math.min(end, playback?.outPoint ?? end));
  return { inPoint, outPoint, span: outPoint - inPoint };
}

/** Absolute sampling keeps scrubbing, camera cuts, capture and recording in sync. */
export function worldAnimationTimeAt(playback: WorldAnimationPlayback | undefined, duration: number, worldTime: number): number {
  const { inPoint, outPoint, span } = worldAnimationRange(playback, duration);
  const elapsed = Math.max(0, worldTime - (playback?.startTime ?? 0)) * (playback?.speed ?? 1);
  if (span <= 0) return inPoint;
  return playback?.loop === 'once' ? Math.min(outPoint, inPoint + elapsed) : inPoint + elapsed % span;
}

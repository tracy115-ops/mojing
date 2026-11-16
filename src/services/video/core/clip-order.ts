import type { GeneratedClip, ShotSpec } from '@/types/video';

/**
 * Align clips to the order of the shot list that owns them.
 *
 * The caller's shot list is authoritative: the timeline can intentionally
 * provide a reordered list, while the pipeline passes its canonical list.
 */
export function orderClipsByShots(clips: GeneratedClip[], shots: ShotSpec[]): GeneratedClip[] {
  const orderByShotId = new Map(shots.map((shot, index) => [shot.id, index]));

  return clips
    .map((clip, originalIndex) => ({ clip, originalIndex }))
    .sort((a, b) => {
      const aOrder = orderByShotId.get(a.clip.shotId) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = orderByShotId.get(b.clip.shotId) ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.originalIndex - b.originalIndex;
    })
    .map(({ clip }) => clip);
}

/** Merge a retry's new outputs over the valid outputs already available. */
export function mergeClipsByShotId(
  existing: GeneratedClip[],
  updates: GeneratedClip[],
  shots: ShotSpec[],
): GeneratedClip[] {
  const byShotId = new Map(existing.map((clip) => [clip.shotId, clip]));
  for (const clip of updates) byShotId.set(clip.shotId, clip);
  return orderClipsByShots([...byShotId.values()], shots);
}

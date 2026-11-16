import type { VideoTimelineState, VideoTimelineTrim } from '@/types/video';

const DEFAULT_DIALOGUE_VOLUME = 1;

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DIALOGUE_VOLUME;
  return Math.max(0, Math.min(1.5, value));
}

function normalizeTrim(value: unknown): VideoTimelineTrim {
  const trim = value && typeof value === 'object' ? value as Partial<VideoTimelineTrim> : {};
  return {
    startSeconds: finiteNonNegative(trim.startSeconds),
    endSeconds: finiteNonNegative(trim.endSeconds),
  };
}

/** Keep timeline edits valid when upstream stages add or remove shots. */
export function normalizeTimelineState(
  state: Partial<VideoTimelineState> | undefined,
  shotIds: string[],
): VideoTimelineState {
  const knownIds = [...new Set(shotIds.filter(Boolean))];
  const known = new Set(knownIds);
  const requestedOrder = Array.isArray(state?.shotOrder) ? state.shotOrder : [];
  const shotOrder = [
    ...new Set(requestedOrder.filter((id): id is string => typeof id === 'string' && known.has(id))),
    ...knownIds.filter((id) => !requestedOrder.includes(id)),
  ];
  const requestedDisabled = Array.isArray(state?.disabledShotIds) ? state.disabledShotIds : [];
  const disabledShotIds = [...new Set(
    requestedDisabled.filter((id): id is string => typeof id === 'string' && known.has(id)),
  )];
  const trims: Record<string, VideoTimelineTrim> = {};
  if (state?.trims && typeof state.trims === 'object') {
    for (const id of knownIds) {
      if (state.trims[id]) trims[id] = normalizeTrim(state.trims[id]);
    }
  }

  return {
    shotOrder,
    disabledShotIds,
    trims,
    dialogueVolume: clampVolume(state?.dialogueVolume),
  };
}

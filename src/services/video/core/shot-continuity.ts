import type { CharacterAnchor, GeneratedClip, ShotSpec } from '@/types/video';
import { isApprovedVideoClip, isShotKeyframeApproved } from './shot-production-contract.ts';

export type ContinuityHandoffIssue = 'missing_previous_clip' | 'missing_tail_frame';

export interface ContinuityFramePolicyInput {
  required: boolean;
  hasMatchingPreviousShot: boolean;
  hasPreviousTailFrame: boolean;
  supportsFirstFrame: boolean;
  requestedMode?: 'text' | 'keyframe' | 'reference';
  hasManualShotReference: boolean;
  /** The caller must opt in before a rendered tail can replace the approved keyframe. */
  temporalAuthority?: 'approved_keyframe' | 'previous_tail';
}

/** A continuous segment keeps both its scene and visible subject set. */
export function isMatchingContinuitySegment(
  previousShot: ShotSpec | undefined,
  shot: ShotSpec,
): boolean {
  return !!previousShot
    && shot.transition !== 'cut'
    && shotsShareScene(previousShot, shot)
    && shotsShareSubjects(previousShot, shot);
}

/** Resolve temporal authority without inventing continuity across an edit. */
export function resolveTemporalAuthority(
  preferred: 'approved_keyframe' | 'previous_tail',
  previousShot: ShotSpec | undefined,
  shot: ShotSpec,
  previousClip?: GeneratedClip,
): 'approved_keyframe' | 'previous_tail' {
  return preferred === 'previous_tail'
    && isMatchingContinuitySegment(previousShot, shot)
    && !shot.manualReferenceImage
    && !!previousClip?.lastFrameImage
    && isApprovedVideoClip(previousShot, previousClip)
    ? 'previous_tail'
    : 'approved_keyframe';
}

/**
 * Decide whether the rendered previous tail is the temporal authority for the
 * next clip. A human-provided whole-shot reference and an explicit subject
 * reference mode remain stronger overrides than automatic handoff.
 */
export function shouldUseRenderedTailAsFirstFrame(
  input: ContinuityFramePolicyInput,
): boolean {
  return (input.temporalAuthority ?? 'approved_keyframe') === 'previous_tail'
    && input.required
    && input.hasMatchingPreviousShot
    && input.hasPreviousTailFrame
    && input.supportsFirstFrame
    && input.requestedMode !== 'text'
    && input.requestedMode !== 'reference'
    && !input.hasManualShotReference;
}

/** Compare stable scene identity first, then tolerate harmless location formatting differences. */
export function shotsShareScene(a: ShotSpec, b: ShotSpec): boolean {
  if (b.transition === 'cut') return false;
  if (a.sceneId && b.sceneId && a.sceneId === b.sceneId) return true;

  const left = normalizeLocation(a.location);
  const right = normalizeLocation(b.location);
  return !!left && left === right;
}

/** Only carry a rendered frame across shots when their intended subjects match exactly. */
export function shotsShareSubjects(a: ShotSpec, b: ShotSpec): boolean {
  const left = normalizeSubjectIds(a.visibleCharacterIds ?? a.characterIds);
  const right = normalizeSubjectIds(b.visibleCharacterIds ?? b.characterIds);
  return left.length === right.length && left.every((id) => right.includes(id));
}

/**
 * Return the reason a sequential handoff cannot be established.
 *
 * A matching scene and subject set is an explicit continuity contract. A
 * generated keyframe alone is not enough evidence for the video handoff: the
 * previous clip's actual tail frame must exist and be readable by the next
 * request.
 */
export function getContinuityHandoffIssue(
  previousShot: ShotSpec | undefined,
  shot: ShotSpec,
  previousClip: Pick<GeneratedClip, 'videoUrl' | 'lastFrameImage'> | undefined,
): ContinuityHandoffIssue | undefined {
  if (!previousShot || !shotsShareScene(previousShot, shot) || !shotsShareSubjects(previousShot, shot)) {
    return undefined;
  }
  if (!previousClip?.videoUrl) return 'missing_previous_clip';
  if (!previousClip.lastFrameImage) return 'missing_tail_frame';
  return undefined;
}

export function getAdjacentShot(
  shots: ShotSpec[] | undefined,
  shot: ShotSpec,
  offset: -1 | 1,
): ShotSpec | undefined {
  if (!shots?.length) return undefined;
  const index = shots.findIndex((candidate) => candidate.id === shot.id);
  return index < 0 ? undefined : shots[index + offset];
}

/**
 * Prefer the nearest earlier frame from the same scene and with the same
 * visible subject set. A frame from another scene is not a safe identity
 * reference: it also carries wardrobe, lighting, props, and composition.
 */
export function getSubjectContinuityShot(
  shots: ShotSpec[] | undefined,
  shot: ShotSpec,
): ShotSpec | undefined {
  if (!shots?.length) return undefined;
  const index = shots.findIndex((candidate) => candidate.id === shot.id);
  if (index < 0) return undefined;

  const adjacent = shots[index - 1];
  if (
    adjacent
    && isShotKeyframeApproved(adjacent)
    && shotsShareScene(adjacent, shot)
    && shotsShareSubjects(adjacent, shot)
  ) {
    return adjacent;
  }

  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const candidate = shots[previousIndex];
    if (
      isShotKeyframeApproved(candidate)
      && shotsShareScene(candidate, shot)
      && shotsShareSubjects(candidate, shot)
    ) return candidate;
  }
  return undefined;
}

/** Use a repeatable per-shot seed when no character or user seed is available. */
export function getStableShotSeed(shot: Pick<ShotSpec, 'id'>): number {
  let hash = 2166136261;
  for (const char of shot.id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

/**
 * Resolve the seed for one shot without borrowing a character asset seed.
 *
 * A character seed belongs to the identity asset. A shot seed belongs to the
 * composition and motion request. Keeping those domains separate prevents a
 * series of shots featuring the same character from collapsing into the same
 * deterministic composition.
 */
export function getEffectiveShotSeed(
  shot: Pick<ShotSpec, 'id' | 'seed'>,
  requestedSeed?: number,
): number {
  if (typeof shot.seed === 'number' && Number.isFinite(shot.seed)) {
    return normalizeSeed(shot.seed);
  }
  if (typeof requestedSeed === 'number' && Number.isFinite(requestedSeed)) {
    return deriveShotSeed(requestedSeed, shot.id);
  }
  return getStableShotSeed(shot);
}

/**
 * Produce a distinct, reproducible seed for each manual candidate while
 * keeping the user's base seed as the anchor. A retry must not accidentally
 * ask the provider for the same deterministic sample again.
 */
export function getCandidateSeed(
  shot: Pick<ShotSpec, 'id' | 'seed'>,
  requestedSeed: number | undefined,
  candidateIndex: number,
): number {
  const base = getEffectiveShotSeed(shot, requestedSeed);
  const normalizedIndex = Math.max(1, Math.floor(candidateIndex));
  return (Math.abs(Math.floor(base)) + normalizedIndex * 104729) % 2147483647 || 1;
}

/** Keep the provider seed stable for the same bound subject set across shots. */
export function getStableSubjectSeed(characters: Pick<CharacterAnchor, 'id'>[]): number | undefined {
  const ids = [...new Set(characters.map((character) => character.id.trim()).filter(Boolean))].sort();
  if (!ids.length) return undefined;
  let hash = 2166136261;
  for (const char of ids.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

function normalizeLocation(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function deriveShotSeed(requestedSeed: number, shotId: string): number {
  const base = normalizeSeed(requestedSeed);
  const shotOffset = getStableShotSeed({ id: shotId });
  return (base + shotOffset) % 2147483647 || 1;
}

function normalizeSeed(value: number): number {
  return Math.abs(Math.floor(value)) % 2147483647 || 1;
}

function normalizeSubjectIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))];
}

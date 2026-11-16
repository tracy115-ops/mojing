import type { PipelineOptions } from '@/types/video';

export type VideoQualityProfile = 'draft' | 'balanced' | 'quality';

export interface ResolvedVideoQualityPolicy {
  profile: VideoQualityProfile;
  keyframeCandidatesPerShot: number;
  videoCandidatesPerShot: number;
  visualReviewRequired: boolean;
  blockOnVisualReviewUnavailable: boolean;
  continuityMode: 'approved_keyframe' | 'previous_tail';
}

export interface AssemblyQualityRequirements {
  visualReviewRequired?: boolean;
  blockOnVisualReviewUnavailable?: boolean;
}

const PROFILE_DEFAULTS: Record<VideoQualityProfile, Omit<ResolvedVideoQualityPolicy, 'profile'>> = {
  draft: {
    keyframeCandidatesPerShot: 1,
    videoCandidatesPerShot: 1,
    visualReviewRequired: false,
    blockOnVisualReviewUnavailable: false,
    continuityMode: 'approved_keyframe',
  },
  balanced: {
    keyframeCandidatesPerShot: 1,
    videoCandidatesPerShot: 2,
    visualReviewRequired: true,
    blockOnVisualReviewUnavailable: false,
    continuityMode: 'previous_tail',
  },
  quality: {
    keyframeCandidatesPerShot: 2,
    videoCandidatesPerShot: 2,
    visualReviewRequired: true,
    blockOnVisualReviewUnavailable: true,
    continuityMode: 'previous_tail',
  },
};

function boundedCandidateCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(3, Math.max(1, Math.floor(value as number)));
}

/**
 * Resolve workflow policy independently from story content, language, or
 * provider-specific request fields. Optional fields keep old projects
 * compatible while new projects default to quality-first production.
 */
export function resolveVideoQualityPolicy(
  options?: Pick<PipelineOptions, 'qualityProfile' | 'keyframeCandidatesPerShot' | 'videoCandidatesPerShot' | 'enableVisualQualityGate' | 'blockOnVisualReviewUnavailable' | 'enableKeyframe' | 'enableI2V' | 'continuityMode'>,
): ResolvedVideoQualityPolicy {
  const hasExplicitPolicy = options?.qualityProfile !== undefined
    || options?.keyframeCandidatesPerShot !== undefined
    || options?.videoCandidatesPerShot !== undefined
    || options?.enableVisualQualityGate !== undefined
    || options?.blockOnVisualReviewUnavailable !== undefined
    || options?.continuityMode !== undefined;
  const profile = options?.qualityProfile
    ?? (!hasExplicitPolicy || (options?.enableKeyframe === false && options?.enableI2V === false)
      ? 'draft'
      : 'quality');
  const defaults = PROFILE_DEFAULTS[profile];
  return {
    profile,
    keyframeCandidatesPerShot: boundedCandidateCount(options?.keyframeCandidatesPerShot, defaults.keyframeCandidatesPerShot),
    videoCandidatesPerShot: boundedCandidateCount(options?.videoCandidatesPerShot, defaults.videoCandidatesPerShot),
    visualReviewRequired: options?.enableVisualQualityGate ?? defaults.visualReviewRequired,
    blockOnVisualReviewUnavailable: options?.blockOnVisualReviewUnavailable ?? defaults.blockOnVisualReviewUnavailable,
    continuityMode: options?.continuityMode ?? defaults.continuityMode,
  };
}

/**
 * Resolve the same quality contract for every assembly entry point. Keeping
 * this beside the profile resolver prevents the overview, timeline, and
 * runtime composer from silently applying different gates.
 */
export function resolveAssemblyQualityRequirements(
  options?: Pick<PipelineOptions, 'qualityProfile' | 'enableVisualQualityGate' | 'blockOnVisualReviewUnavailable' | 'enableKeyframe' | 'enableI2V'>,
): AssemblyQualityRequirements {
  const policy = resolveVideoQualityPolicy(options);
  return {
    visualReviewRequired: policy.visualReviewRequired,
    blockOnVisualReviewUnavailable: policy.blockOnVisualReviewUnavailable,
  };
}

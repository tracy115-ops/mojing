import type {
  GeneratedClip,
  ShotSpec,
  ShotVersion,
} from '@/types/video';
import { isGeneratedVideoCurrent, isShotInputCurrent } from './shot-generation-receipt.ts';
import type { AssemblyQualityRequirements } from './quality-policy.ts';

export type ShotProductionState =
  | 'needs_prompt'
  | 'needs_binding'
  | 'needs_keyframe'
  | 'needs_keyframe_review'
  | 'needs_video'
  | 'awaiting_review'
  | 'rejected'
  | 'approved';

export interface ShotProductionReadiness {
  state: ShotProductionState;
  selectedVersion?: ShotVersion;
  videoVersion?: ShotVersion;
  hasKeyframe: boolean;
  hasVideo: boolean;
  isLocked: boolean;
  qualityFailed: boolean;
}

/**
 * Register persisted outputs that predate the version-review workflow.
 *
 * Old projects stored a keyframe directly on the shot and a video directly on
 * the clip. Those files remain useful, but they must enter the new workflow as
 * unreviewed candidates instead of silently becoming assembly inputs.
 */
export function registerPersistedShotVersions(
  shots: ShotSpec[],
  clips: GeneratedClip[],
  createdAt = new Date().toISOString(),
): ShotSpec[] {
  const clipsByShot = new Map(clips.map((clip) => [clip.shotId, clip]));

  return shots.map((shot) => {
    const clip = clipsByShot.get(shot.id);
    const history = (shot.versionHistory ?? []).map((version) => ({
      ...version,
      reviewStatus: version.reviewStatus ?? 'unreviewed' as const,
    }));
    let nextHistory = history;

    if (shot.keyframeImage && !history.some((version) => version.type === 'image' && version.url === shot.keyframeImage)) {
      nextHistory = [
        {
          id: createLegacyVersionId(shot.id, 'image', nextHistory),
          type: 'image' as const,
          url: shot.keyframeImage,
          createdAt,
          inputFingerprint: shot.keyframeInputFingerprint,
          imageReferenceAssets: shot.referenceAssets,
          imageGenerationContext: shot.keyframeGenerationContext,
          requestSnapshot: shot.generationPlan?.keyframe?.requestSnapshot,
          responseSnapshot: shot.generationPlan?.keyframe?.responseSnapshot,
          generationPlan: shot.generationPlan,
          reviewStatus: 'unreviewed' as const,
        },
        ...nextHistory,
      ];
    }

    if (clip?.videoUrl && !nextHistory.some((version) => version.type === 'video'
      && (version.url === clip.videoUrl || (clip.audioTrack && version.id === clip.shotVersionId)))) {
      nextHistory = [
        {
          id: createLegacyVersionId(shot.id, 'video', nextHistory),
          type: 'video' as const,
          url: clip.videoUrl,
          createdAt: clip.generatedAt || createdAt,
          seed: clip.seed,
          provider: clip.provider,
          model: clip.model,
          durationSeconds: clip.durationSeconds,
          importedVideo: clip.importedVideo,
          inputFingerprint: clip.inputFingerprint,
          generationContext: clip.generationContext,
          requestSnapshot: clip.requestSnapshot,
          responseSnapshot: clip.responseSnapshot,
          videoReferenceAssets: clip.videoReferenceAssets,
          videoReferenceMode: clip.videoReferenceMode,
          videoControlMode: clip.videoControlMode,
          lastFrameImage: clip.lastFrameImage,
          thumbnailUrl: clip.thumbnailUrl,
          hasAudio: clip.hasAudio,
          qualityReview: clip.qualityReview,
          visualReview: clip.visualReview,
          reviewStatus: 'unreviewed' as const,
        },
        ...nextHistory,
      ];
    }

    if (clip?.videoUrl) {
      nextHistory = nextHistory.map((version) => (
        version.type === 'video'
          && version.url === clip.videoUrl
          ? {
              ...version,
              provider: version.provider ?? clip.provider,
              model: version.model ?? clip.model,
              seed: version.seed ?? clip.seed,
              durationSeconds: version.durationSeconds ?? clip.durationSeconds,
              importedVideo: version.importedVideo ?? clip.importedVideo,
              inputFingerprint: version.inputFingerprint ?? clip.inputFingerprint,
              generationContext: version.generationContext ?? clip.generationContext,
              requestSnapshot: version.requestSnapshot ?? clip.requestSnapshot,
              responseSnapshot: version.responseSnapshot ?? clip.responseSnapshot,
              videoReferenceAssets: version.videoReferenceAssets ?? clip.videoReferenceAssets,
              videoReferenceMode: version.videoReferenceMode ?? clip.videoReferenceMode,
              videoControlMode: version.videoControlMode ?? clip.videoControlMode,
              lastFrameImage: version.lastFrameImage ?? clip.lastFrameImage,
              thumbnailUrl: version.thumbnailUrl ?? clip.thumbnailUrl,
              hasAudio: version.hasAudio ?? clip.hasAudio,
              qualityReview: version.qualityReview ?? clip.qualityReview,
              visualReview: version.visualReview ?? clip.visualReview,
            }
          : version
      ));
    }

    if (shot.keyframeImage) {
      nextHistory = nextHistory.map((version) => (
        version.type === 'image' && version.url === shot.keyframeImage
          ? {
              ...version,
              inputFingerprint: version.inputFingerprint ?? shot.keyframeInputFingerprint,
              imageReferenceAssets: version.imageReferenceAssets ?? shot.referenceAssets,
              imageGenerationContext: version.imageGenerationContext ?? shot.keyframeGenerationContext,
              generationPlan: version.generationPlan ?? shot.generationPlan,
            }
          : version
      ));
    }

    const selectedVersionId = nextHistory.some((version) => version.id === shot.selectedVersionId)
      ? shot.selectedVersionId
      : nextHistory[0]?.id;
    const lockedVersion = nextHistory.find((version) => version.id === shot.lockedVersionId);
    const lockedVersionId = lockedVersion?.type === 'video' && lockedVersion.reviewStatus === 'approved'
      ? lockedVersion.id
      : undefined;
    const historyChanged = nextHistory.length !== (shot.versionHistory?.length ?? 0)
      || nextHistory.some((version, index) => JSON.stringify(version) !== JSON.stringify(shot.versionHistory?.[index]));

    if (!historyChanged
      && selectedVersionId === shot.selectedVersionId
      && lockedVersionId === shot.lockedVersionId) {
      return shot;
    }

    return {
      ...shot,
      versionHistory: nextHistory,
      selectedVersionId,
      lockedVersionId,
    };
  });
}

function createLegacyVersionId(
  shotId: string,
  type: 'image' | 'video',
  history: ShotVersion[],
): string {
  const base = `legacy_${type}_${shotId}`;
  if (!history.some((version) => version.id === base)) return base;
  let index = 2;
  while (history.some((version) => version.id === `${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** Return the version currently selected by the shot, if it still exists. */
export function getSelectedShotVersion(shot: ShotSpec): ShotVersion | undefined {
  return shot.versionHistory?.find((version) => version.id === shot.selectedVersionId);
}

/**
 * A rendered tail may influence another shot only when it belongs to the
 * currently selected, approved, and still-current video candidate.
 */
export function isApprovedVideoClip(
  shot: ShotSpec | undefined,
  clip: GeneratedClip | undefined,
): boolean {
  if (!shot || !clip?.videoUrl) return false;
  const selected = getSelectedShotVersion(shot);
  if (!selected || selected.type !== 'video' || selected.reviewStatus !== 'approved') return false;
  const matchesSelection = clip.shotVersionId === selected.id
    || (!clip.shotVersionId && clip.videoUrl === selected.url);
  return matchesSelection && isGeneratedVideoCurrent(shot, clip);
}

/**
 * Restore the selected candidate's complete provider receipt onto the single
 * active clip slot used by the timeline. Older candidates may only have a URL;
 * those candidates intentionally lose receipt metadata and fail closed at the
 * assembly gate instead of borrowing the newest candidate's evidence.
 */
export function restoreClipFromShotVersion(
  clip: GeneratedClip,
  version: ShotVersion,
): GeneratedClip {
  if (version.type !== 'video') return clip;
  const sameOutput = !version.importedVideo && clip.videoUrl === version.url;
  const videoPlan = version.generationPlan?.video;
  return {
    ...clip,
    shotVersionId: version.id,
    importedVideo: version.importedVideo,
    keyframeImage: version.importedVideo ? undefined : clip.keyframeImage,
    videoReferenceFallbackReason: sameOutput ? clip.videoReferenceFallbackReason : undefined,
    videoUrl: version.url,
    thumbnailUrl: version.thumbnailUrl ?? (sameOutput ? clip.thumbnailUrl : undefined),
    lastFrameImage: version.lastFrameImage ?? (sameOutput ? clip.lastFrameImage : undefined),
    durationSeconds: version.durationSeconds ?? (sameOutput ? clip.durationSeconds : 0),
    seed: version.seed ?? (sameOutput ? clip.seed : undefined),
    provider: version.provider ?? clip.provider,
    model: version.model ?? clip.model,
    generatedAt: version.createdAt,
    inputFingerprint: version.inputFingerprint ?? videoPlan?.inputFingerprint ?? (sameOutput ? clip.inputFingerprint : undefined),
    generationContext: version.generationContext ?? videoPlan?.executionContext ?? (sameOutput ? clip.generationContext : undefined),
    requestSnapshot: version.requestSnapshot ?? videoPlan?.requestSnapshot ?? (sameOutput ? clip.requestSnapshot : undefined),
    responseSnapshot: version.responseSnapshot ?? videoPlan?.responseSnapshot ?? (sameOutput ? clip.responseSnapshot : undefined),
    videoReferenceAssets: version.videoReferenceAssets ?? videoPlan?.references ?? (sameOutput ? clip.videoReferenceAssets : undefined),
    videoReferenceMode: version.videoReferenceMode ?? videoPlan?.referenceMode ?? (sameOutput ? clip.videoReferenceMode : undefined),
    videoControlMode: version.videoControlMode ?? videoPlan?.controlMode ?? (sameOutput ? clip.videoControlMode : undefined),
    qualityReview: version.qualityReview ?? (sameOutput ? clip.qualityReview : undefined),
    visualReview: version.visualReview ?? (sameOutput ? clip.visualReview : undefined),
    audioTrack: undefined,
    hasAudio: version.importedVideo ? true : false,
  };
}

/** Treat missing review metadata as unreviewed for legacy projects. */
export function getShotVersionStatus(version: ShotVersion | undefined): NonNullable<ShotVersion['reviewStatus']> {
  return version?.reviewStatus ?? 'unreviewed';
}

/**
 * A video request may only use a keyframe that a human has accepted. The
 * image URL alone is not enough: a regenerated keyframe invalidates the
 * previous approval and must be reviewed again.
 */
export function isShotKeyframeApproved(shot: ShotSpec): boolean {
  if (!isShotKeyframeCurrent(shot)) return false;
  return (shot.versionHistory ?? []).some((version) => (
    version.type === 'image'
      && version.url === shot.keyframeImage
      && version.reviewStatus === 'approved'
  ));
}

export function isShotKeyframeCurrent(shot: ShotSpec): boolean {
  if (!shot.keyframeImage || !shot.keyframeInputFingerprint || !shot.keyframeGenerationContext) return false;
  return isShotInputCurrent(
    shot,
    'keyframe',
    shot.keyframeInputFingerprint,
    shot.referenceAssets ?? shot.generationPlan?.keyframe?.references ?? [],
    shot.keyframeGenerationContext,
  );
}

export function allShotsHaveApprovedKeyframes(shots: ShotSpec[]): boolean {
  return shots.length > 0 && shots.every(isShotKeyframeApproved);
}

export function getShotProductionReadiness(
  shot: ShotSpec,
  clip?: GeneratedClip,
  requireKeyframe = true,
): ShotProductionReadiness {
  const selectedVersion = getSelectedShotVersion(shot);
  const videoVersion = selectedVersion?.type === 'video'
    ? selectedVersion
    : shot.versionHistory?.find((version) => version.type === 'video');
  const hasCurrentVideo = !!clip?.videoUrl && isGeneratedVideoCurrent(shot, clip);
  const hasVideo = hasCurrentVideo && !!videoVersion?.url;
  const hasKeyframe = !!shot.keyframeImage;
  const selectedStatus = getShotVersionStatus(selectedVersion);
  const isLocked = !!shot.lockedVersionId && shot.lockedVersionId === selectedVersion?.id;
  const qualityFailed = clip?.qualityReview?.status === 'failed'
    || clip?.visualReview?.status === 'failed';

  let state: ShotProductionState;
  if (!shot.videoPrompt?.trim() && !shot.sourceText?.trim()) {
    state = 'needs_prompt';
  } else if (shot.unresolvedCharacterRefs?.some((reference) => reference.trim())) {
    state = 'needs_binding';
  } else if (requireKeyframe && !(hasCurrentVideo && clip?.importedVideo) && !hasKeyframe) {
    state = 'needs_keyframe';
  } else if (requireKeyframe && !(hasCurrentVideo && clip?.importedVideo) && !isShotKeyframeApproved(shot)) {
    state = 'needs_keyframe_review';
  } else if (!hasVideo) {
    state = 'needs_video';
  } else if (qualityFailed) {
    state = 'rejected';
  } else if (isLocked && selectedStatus === 'approved') {
    state = 'approved';
  } else if (selectedStatus === 'rejected') {
    state = 'rejected';
  } else {
    state = 'awaiting_review';
  }

  return { state, selectedVersion, videoVersion, hasKeyframe, hasVideo, isLocked, qualityFailed };
}

/** Only a human-approved selected video version can enter assembly. */
export function isShotAssemblyReady(
  shot: ShotSpec,
  clip?: GeneratedClip,
  requirements: AssemblyQualityRequirements = {},
): boolean {
  const readiness = getShotProductionReadiness(shot, clip, false);
  const selectedVideo = readiness.selectedVersion?.type === 'video' ? readiness.selectedVersion : undefined;
  const clipMatchesSelection = !!selectedVideo && !!clip?.videoUrl && (
    clip.shotVersionId === selectedVideo.id
      || (!clip.shotVersionId && clip.videoUrl === selectedVideo.url)
  );
  const inputReceiptMatches = !!selectedVideo?.inputFingerprint
    && !!clip?.inputFingerprint
    && selectedVideo.inputFingerprint === clip.inputFingerprint
    && isGeneratedVideoCurrent(shot, clip);
  const visualReviewBlocksAssembly = requirements.visualReviewRequired === true
    && (!clip?.visualReview
      || (requirements.blockOnVisualReviewUnavailable === true && clip.visualReview.status === 'unavailable'));
  return readiness.state === 'approved'
    && !!selectedVideo
    && clip?.qualityReview?.status !== 'failed'
    && (!clip?.importedVideo || !!clip.qualityReview)
    && clip?.visualReview?.status !== 'failed'
    && !visualReviewBlocksAssembly
    && clipMatchesSelection
    && inputReceiptMatches;
}

export function getAssemblyBlockers(
  shots: ShotSpec[],
  clips: GeneratedClip[],
  requirements: AssemblyQualityRequirements = {},
): Array<{ shot: ShotSpec; reason: ShotProductionState }> {
  const clipsByShot = new Map(clips.map((clip) => [clip.shotId, clip]));
  return shots
    .map((shot) => {
      const clip = clipsByShot.get(shot.id);
      const readiness = getShotProductionReadiness(shot, clip, false);
      return {
        shot,
        reason: isShotAssemblyReady(shot, clip, requirements) ? 'approved' : readiness.qualityFailed ? 'rejected' : readiness.state,
      };
    })
    .filter(({ reason }) => reason !== 'approved');
}

export function hasShotVideoCandidate(shot: ShotSpec, clip?: GeneratedClip): boolean {
  return !!clip?.videoUrl
    && isGeneratedVideoCurrent(shot, clip)
    && !!shot.versionHistory?.some((version) => version.type === 'video' && !!version.url);
}

export function allShotsHaveVideoCandidates(shots: ShotSpec[], clips: GeneratedClip[]): boolean {
  const clipsByShot = new Map(clips.map((clip) => [clip.shotId, clip]));
  return shots.length > 0 && shots.every((shot) => hasShotVideoCandidate(shot, clipsByShot.get(shot.id)));
}

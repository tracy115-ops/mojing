import { useVideoStore } from '@/stores/videoStore';
import type { GeneratedClip, SceneSpec, ShotSpec, ShotVersion } from '@/types/video';
import { isAssetAvailable, isValidVideoClip, toWebviewUrl } from '../asset-store';
import type { StageContext, StageResult } from './stage-handlers';
import { generateSingleKeyframe } from './step-keyframe';
import { generateSingleVideoClip } from './step-video-gen';
import { getShotStillPrompt } from './shot-plan-contract';
import { isApprovedVideoClip, isShotKeyframeApproved, isShotKeyframeCurrent } from './shot-production-contract';
import { fingerprintShotInputs, isGeneratedVideoCurrent } from './shot-generation-receipt';
import { getCandidateSeed, resolveTemporalAuthority, shotsShareScene, shotsShareSubjects } from './shot-continuity';
import { resolveVideoQualityPolicy } from './quality-policy';
import { evaluateKeyframeVisually, evaluateVideoClipVisually } from './visual-quality-review';
import { evaluateVideoClipQuality } from './video-quality-gate';

export function restoreLegacyShotInputs(spec: SceneSpec): SceneSpec {
  const characters = new Set((spec.characters ?? []).map((character) => character.id));
  return {
    ...spec,
    shots: spec.shots.map((shot) => {
      const visible = shot.visibleCharacterIds ?? shot.characterIds ?? [];
      // Legacy episodes stored the author's cast and shot description in
      // characterIds and videoPrompt. Unknown cast still requires validation.
      const legacyCastIsBound = !shot.unresolvedCharacterRefs?.length
        && visible.every((id) => characters.has(id));
      return {
        ...shot,
        sourceText: shot.sourceText?.trim() ? shot.sourceText : shot.videoPrompt,
        imagePrompt: shot.imagePrompt?.trim() ? shot.imagePrompt : getShotStillPrompt(shot),
        ...(shot.characterBinding !== 'explicit' && legacyCastIsBound
          ? { visibleCharacterIds: visible, characterBinding: 'explicit' as const }
          : {}),
      };
    }),
  };
}

function visualInputs(ctx: StageContext) {
  return {
    projectId: ctx.pid,
    characters: ctx.workingSpec.characters,
    scenes: ctx.workingSpec.scenes,
    signal: ctx.signal,
  };
}

function importedKeyframe(shot: ShotSpec, imageUrl: string, aspectRatio: string): ShotVersion {
  const imageGenerationContext = { provider: 'manual', model: 'imported-keyframe', aspectRatio };
  return {
    id: crypto.randomUUID(),
    type: 'image',
    url: imageUrl,
    createdAt: new Date().toISOString(),
    model: imageGenerationContext.model,
    imageGenerationContext,
    imageReferenceAssets: [],
    inputFingerprint: fingerprintShotInputs(shot, 'keyframe', [], imageGenerationContext),
  };
}

async function generateKeyframeVersion(ctx: StageContext, shot: ShotSpec, shots: ShotSpec[], attempt: number): Promise<ShotVersion> {
  const { videoGen, workingSpec } = ctx;
  const candidate = { ...shot, seed: getCandidateSeed(shot, shot.seed, attempt) };
  const output = await generateSingleKeyframe(candidate, shot.index, shots, {
    characters: workingSpec.characters ?? [],
    scenes: workingSpec.scenes ?? [],
    aspectRatio: workingSpec.meta.aspectRatio,
    style: workingSpec.meta.style,
    imageTier: 'value',
    imageEndpointId: videoGen.imageEndpointId,
    imageModel: videoGen.imageModel,
    novelProjectId: ctx.pid,
    requireCharacterReferences: ctx.options.enableCharacterAnchor,
    automatic: true,
    signal: ctx.signal,
  });
  return {
    id: crypto.randomUUID(),
    type: 'image',
    url: output.imagePath,
    createdAt: new Date().toISOString(),
    model: output.executionContext.model,
    imageGenerationContext: output.executionContext,
    imageReferenceAssets: output.referenceAssets,
    inputFingerprint: output.inputFingerprint,
    requestSnapshot: output.generationPlan.keyframe?.requestSnapshot,
    responseSnapshot: output.generationPlan.keyframe?.responseSnapshot,
    generationPlan: output.generationPlan,
  };
}

export async function makeAutomaticKeyframes(ctx: StageContext): Promise<StageResult | null> {
  const policy = resolveVideoQualityPolicy(ctx.options);
  const store = useVideoStore.getState();
  return runShotStage(ctx, 'keyframe_image', async (shot, spec) => {
    const current = isShotKeyframeCurrent(shot) && await isAssetAvailable(shot.keyframeImage);
    if (current && isShotKeyframeApproved(shot)) return;
    const existing = current ? shot.versionHistory?.find((version) =>
      version.type === 'image' && version.url === shot.keyframeImage && version.reviewStatus !== 'rejected',
    ) : undefined;
    const manual = shot.manualReferenceImage && await isAssetAvailable(shot.manualReferenceImage)
      ? shot.manualReferenceImage : undefined;
    const reusable = existing ?? (manual && !shot.versionHistory?.some((version) =>
      version.url === manual && version.reviewStatus === 'rejected',
    ) ? importedKeyframe(shot, manual, spec.meta.aspectRatio) : undefined);
    let reason = '';
    for (let attempt = 1; attempt <= policy.keyframeCandidatesPerShot; attempt++) {
      const version = (attempt === 1 && reusable) || await generateKeyframeVersion(ctx, shot, spec.shots, attempt);
      const image = new Image();
      image.src = toWebviewUrl(version.url);
      const decodes = await image.decode().then(() => image.naturalWidth > 0 && image.naturalHeight > 0, () => false);
      const review = decodes && policy.visualReviewRequired
        ? await evaluateKeyframeVisually(shot, version.url, visualInputs(ctx))
        : undefined;
      ctx.signal?.throwIfAborted();
      const visualUnavailable = !review || review.status === 'unavailable';
      const passed = decodes && (review?.status === 'passed'
        || (visualUnavailable && !policy.blockOnVisualReviewUnavailable));
      const savedVersion: ShotVersion = {
        ...version,
        visualReview: review,
        reviewStatus: passed ? 'approved' : review?.status === 'unavailable' ? 'unreviewed' : 'rejected',
        reviewNote: decodes ? (review?.error || review?.summary || '图片可读取，技术检查通过') : '图片无法读取',
        reviewedAt: review?.reviewedAt ?? new Date().toISOString(),
      };
      if (!shot.versionHistory?.some((item) => item.id === version.id)) {
        store.addShotVersion(ctx.pid, shot.id, savedVersion);
      } else {
        store.reviewShotVersion(ctx.pid, shot.id, version.id, savedVersion.reviewStatus!, savedVersion.reviewNote);
      }
      if (passed) return;
      reason = savedVersion.reviewNote || '质量检查失败';
      if (review?.status === 'unavailable') break;
    }
    throw new Error(`镜头 ${shot.index + 1} 的首帧未通过自动质检：${reason}`);
  });
}

export async function makeAutomaticClips(ctx: StageContext): Promise<StageResult | null> {
  const policy = resolveVideoQualityPolicy(ctx.options);
  const store = useVideoStore.getState();
  return runShotStage(ctx, 'video_generation', async (shot, spec, existingClip) => {
    if (isApprovedVideoClip(shot, existingClip)
      && (!policy.visualReviewRequired || existingClip?.visualReview?.status === 'passed')
      && await isAssetAvailable(existingClip?.videoUrl)) return;
    const index = spec.shots.findIndex((item) => item.id === shot.id);
    const previous = spec.shots[index - 1];
    const next = spec.shots[index + 1];
    const previousClip = previous ? store.getProject(ctx.pid)?.clips.find((clip) => clip.shotId === previous.id) : undefined;
    const temporalAuthority = resolveTemporalAuthority(policy.continuityMode, previous, shot, previousClip);
    const previousFrame = temporalAuthority === 'previous_tail' ? previousClip?.lastFrameImage : undefined;
    const requireKeyframe = ctx.options.enableI2V && ctx.options.enableKeyframe;
    const canReuse = existingClip && existingClip.visualReview?.status !== 'failed'
      && existingClip.qualityReview?.status !== 'failed' && isGeneratedVideoCurrent(shot, existingClip)
      && (!previousFrame || existingClip.videoReferenceAssets?.some((asset) =>
        asset.kind === 'previous' && asset.sentToProvider !== false && asset.imageUrl === previousFrame,
      )) && await isAssetAvailable(existingClip.videoUrl);
    let reason = '';

    for (let attempt = 1; attempt <= policy.videoCandidatesPerShot; attempt++) {
      const reusing = attempt === 1 && canReuse;
      const clip = reusing ? existingClip : await generateSingleVideoClip(shot, {
        ...ctx.videoGen,
        candidateSeed: getCandidateSeed(shot, shot.seed ?? ctx.videoGen.seed, attempt),
        novelProjectId: ctx.pid,
        characters: spec.characters,
        scenes: spec.scenes,
        allShots: spec.shots,
        requireKeyframeForI2V: requireKeyframe,
        requireContinuityHandoff: requireKeyframe,
        temporalAuthority,
        signal: ctx.signal,
      }, ctx.options.enableI2V, previousFrame);
      const quality = evaluateVideoClipQuality(shot, clip, {
        assetAvailable: isValidVideoClip(clip) && await isAssetAvailable(clip.videoUrl),
        requireI2V: ctx.options.enableI2V,
        requiredControlMode: requireKeyframe ? 'keyframe' : undefined,
        requiredTemporalAuthority: requireKeyframe ? temporalAuthority : undefined,
        requirePreviousTail: !!previousFrame,
        requireTailFrame: !!next && shotsShareScene(shot, next) && shotsShareSubjects(shot, next),
      });
      const visual = quality.status === 'failed' || !policy.visualReviewRequired ? undefined
        : await evaluateVideoClipVisually(shot, clip, visualInputs(ctx));
      ctx.signal?.throwIfAborted();
      const visualUnavailable = !visual || visual.status === 'unavailable';
      const passed = quality.status !== 'failed' && (visual?.status === 'passed'
        || (visualUnavailable && !policy.blockOnVisualReviewUnavailable));
      const versionId = crypto.randomUUID();
      reason = visual?.error || visual?.summary || quality.checks.find((check) => check.status === 'fail')?.message || quality.status;
      store.addShotVersion(ctx.pid, shot.id, {
        id: versionId,
        type: 'video',
        url: clip.videoUrl,
        createdAt: clip.generatedAt,
        provider: clip.provider,
        model: clip.model,
        seed: clip.seed,
        durationSeconds: clip.durationSeconds,
        inputFingerprint: clip.inputFingerprint,
        generationContext: clip.generationContext,
        requestSnapshot: clip.requestSnapshot,
        responseSnapshot: clip.responseSnapshot,
        videoReferenceAssets: clip.videoReferenceAssets,
        videoControlMode: clip.videoControlMode,
        videoReferenceMode: clip.videoReferenceMode,
        thumbnailUrl: clip.thumbnailUrl,
        lastFrameImage: clip.lastFrameImage,
        hasAudio: clip.hasAudio,
        qualityReview: quality,
        visualReview: visual,
        reviewStatus: passed ? 'approved' : visual?.status === 'unavailable' ? 'unreviewed' : 'rejected',
        reviewNote: reason,
        reviewedAt: visual?.reviewedAt,
      });
      store.addClip(ctx.pid, { ...clip, shotVersionId: versionId, qualityReview: quality, visualReview: visual });
      if (passed && store.lockShotVersion(ctx.pid, shot.id, versionId)) return;
      if (passed) throw new Error(`镜头 ${shot.index + 1} 的视频输入在生成期间发生变化。`);
      if (visual?.status === 'unavailable') break;
    }
    throw new Error(`镜头 ${shot.index + 1} 的视频未通过自动质检：${reason}`);
  });
}

async function runShotStage(
  ctx: StageContext,
  stage: 'keyframe_image' | 'video_generation',
  produce: (shot: ShotSpec, spec: SceneSpec, clip?: GeneratedClip) => Promise<void>,
): Promise<StageResult | null> {
  const { pid, callbacks } = ctx;
  const store = useVideoStore.getState();
  store.setSceneSpec(pid, ctx.workingSpec);
  store.advanceToStage(pid, stage);
  store.setStageStatus(pid, stage, 'running', { progress: 0, error: undefined });
  callbacks?.onStageChange?.(stage);
  const shots = ctx.workingSpec.shots;
  try {
    for (const [index, { id }] of shots.entries()) {
      ctx.signal?.throwIfAborted();
      const current = store.getProject(pid);
      const spec = current?.sceneSpec;
      const shot = spec?.shots.find((item) => item.id === id);
      if (!spec || !shot) throw new Error('生成期间分镜已被修改。');
      await produce(shot, spec, current?.clips.find((clip) => clip.shotId === id));
      ctx.signal?.throwIfAborted();
      const progress = (index + 1) / shots.length;
      store.setStageStatus(pid, stage, 'running', { progress });
      callbacks?.onShotProgress?.(index + 1, shots.length);
      callbacks?.onStageProgress?.(stage, progress);
    }
    const updated = store.getProject(pid);
    if (!updated?.sceneSpec) return null;
    store.setStageStatus(pid, stage, 'completed', { progress: 1 });
    return { spec: updated.sceneSpec, clips: updated.clips };
  } catch (error) {
    if (ctx.shouldAbort?.()) return null;
    const message = error instanceof Error ? error.message : String(error);
    store.setStageStatus(pid, stage, 'error', { error: message });
    callbacks?.onError?.(message);
    return null;
  }
}

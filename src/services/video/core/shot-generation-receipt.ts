import { fingerprintPayload } from '../../providers/generation-snapshot.ts';
import type {
  GeneratedClip,
  ImportedVideoReceipt,
  SceneSpec,
  ShotGenerationExecutionContext,
  ShotReferenceAsset,
  ShotSpec,
} from '../../../types/video.ts';

export type ShotGenerationKind = 'keyframe' | 'video';

/**
 * Fingerprint only the inputs that affect a shot generation request. Output
 * URLs and review state are intentionally excluded so a regenerated candidate
 * can be compared with the current editable shot.
 */
export function fingerprintShotInputs(
  shot: ShotSpec,
  kind: ShotGenerationKind,
  references: ShotReferenceAsset[] = [],
  execution?: ShotGenerationExecutionContext,
): string {
  const commonShotInputs = {
    id: shot.id,
    sourceText: shot.sourceText,
    startState: shot.startState,
    endState: shot.endState,
    seed: execution?.seed ?? shot.seed,
    characterIds: shot.characterIds,
    visibleCharacterIds: shot.visibleCharacterIds,
    offscreenCharacterIds: shot.offscreenCharacterIds,
    characterBinding: shot.characterBinding,
    costumeVariantRefs: shot.costumeVariantRefs,
    sceneId: shot.sceneId,
    location: shot.location,
    mood: shot.mood,
    cameraMovement: shot.cameraMovement,
    transition: shot.transition,
    durationSeconds: shot.durationSeconds,
    customReferenceImages: shot.customReferenceImages,
    manualReferenceImage: shot.manualReferenceImage,
    previsReferenceImage: shot.previsReferenceImage,
  };
  const snapshot = {
    kind,
    shot: kind === 'keyframe'
      ? {
          ...commonShotInputs,
          imagePrompt: shot.imagePrompt,
          imageNegativePrompt: shot.imageNegativePrompt,
          imageParameters: shot.imageParameters,
        }
      : {
          ...commonShotInputs,
          videoPrompt: shot.videoPrompt,
          videoNegativePrompt: shot.videoNegativePrompt,
          videoParameters: shot.videoParameters,
          customReferenceVideos: shot.customReferenceVideos,
          // A video generated from an old still is no longer current when the
          // shot's authoritative keyframe changes, even if the old clip's
          // reference ledger is otherwise internally consistent.
          keyframeImage: shot.keyframeImage,
          keyframeInputFingerprint: shot.keyframeInputFingerprint,
        },
    execution,
    references: references.map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      imageUrl: reference.imageUrl,
      characterId: reference.characterId,
      subjectIds: reference.subjectIds,
      payloadFingerprint: reference.payloadFingerprint,
      sentToProvider: reference.sentToProvider,
      providerIndex: reference.providerIndex,
    })),
  };
  return fingerprintPayload(JSON.stringify(snapshot)) ?? 'empty';
}

export function isShotInputCurrent(
  shot: ShotSpec,
  kind: ShotGenerationKind,
  inputFingerprint: string | undefined,
  references: ShotReferenceAsset[] = [],
  execution?: ShotGenerationExecutionContext,
): boolean {
  if (!inputFingerprint) return false;
  return inputFingerprint === fingerprintShotInputs(shot, kind, references, execution);
}

/**
 * A persisted clip is reusable only when the request that created it can be
 * reproduced from the current shot and the clip's recorded reference slots.
 * Legacy clips without a receipt deliberately fail closed and must be rerun.
 */
export function isGeneratedVideoCurrent(
  shot: ShotSpec,
  clip: GeneratedClip,
  execution?: ShotGenerationExecutionContext,
): boolean {
  if (!clip.inputFingerprint) return false;
  if (clip.importedVideo) {
    const receipt = clip.importedVideo;
    return receipt.kind === 'imported_video' && receipt.audio === 'preserve'
      && /^[a-f0-9]{64}$/.test(receipt.sha256)
      && Number.isFinite(receipt.width) && receipt.width > 0 && Number.isFinite(receipt.height) && receipt.height > 0 && Number.isFinite(receipt.durationSeconds) && receipt.durationSeconds > 0
      && clip.videoUrl === receipt.sourceUrl && clip.durationSeconds === receipt.durationSeconds
      && clip.inputFingerprint === fingerprintImportedVideo(receipt)
      && receipt.shotInputFingerprint === fingerprintShotInputs(shot, 'video');
  }
  const effectiveExecution = execution ?? clip.generationContext;
  if (!effectiveExecution) {
    return clip.inputFingerprint === fingerprintShotInputs(shot, 'video', clip.videoReferenceAssets ?? []);
  }
  if (effectiveExecution.provider && clip.provider !== effectiveExecution.provider) return false;
  if (effectiveExecution.model && clip.model !== effectiveExecution.model) return false;

  const currentExecution = {
    ...effectiveExecution,
    provider: effectiveExecution.provider ?? clip.provider,
    model: effectiveExecution.model ?? clip.model,
  };
  return clip.inputFingerprint === fingerprintShotInputs(
    shot,
    'video',
    clip.videoReferenceAssets ?? [],
    currentExecution,
  );
}

export function fingerprintImportedVideo(receipt: ImportedVideoReceipt): string {
  return fingerprintPayload(JSON.stringify(receipt)) ?? 'empty';
}

export function fingerprintImportedVideoContext(spec: SceneSpec | undefined): string {
  return fingerprintPayload(JSON.stringify({ characters: spec?.characters ?? [], scenes: spec?.scenes ?? [] })) ?? 'empty';
}

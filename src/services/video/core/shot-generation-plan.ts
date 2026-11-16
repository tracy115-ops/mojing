import type {
  ShotGenerationExecutionContext,
  ShotGenerationPlan,
  ShotReferenceAsset,
  ShotSpec,
} from '@/types/video';
import type { VideoControlMode } from '@/types/providers';

export interface ShotGenerationPlanPatch {
  keyframe?: Partial<NonNullable<ShotGenerationPlan['keyframe']>> & { references?: ShotReferenceAsset[] };
  video?: Partial<NonNullable<ShotGenerationPlan['video']>> & { references?: ShotReferenceAsset[] };
}

/** Build the stable shot-level contract without embedding image payloads. */
export function updateShotGenerationPlan(
  shot: ShotSpec,
  patch: ShotGenerationPlanPatch = {},
): ShotGenerationPlan {
  const visibleSubjectIds = [...new Set((shot.visibleCharacterIds ?? shot.characterIds ?? []).filter(Boolean))];
  const offscreenSubjectIds = [...new Set((shot.offscreenCharacterIds ?? []).filter(Boolean))];
  const current = shot.generationPlan;
  return {
    schemaVersion: 1,
    shotId: shot.id,
    visibleSubjectIds,
    offscreenSubjectIds,
    sceneId: shot.sceneId,
    ...(current?.keyframe || patch.keyframe ? {
      keyframe: {
        ...current?.keyframe,
        ...patch.keyframe,
        references: patch.keyframe?.references ?? current?.keyframe?.references ?? [],
      },
    } : {}),
    ...(current?.video || patch.video ? {
      video: {
        ...current?.video,
        ...patch.video,
        references: patch.video?.references ?? current?.video?.references ?? [],
      },
    } : {}),
  };
}

export function describeShotGenerationPlan(plan: ShotGenerationPlan | undefined): string[] {
  if (!plan) return [];
  return [
    `subjects=${plan.visibleSubjectIds.join('|') || '-'}`,
    `offscreen=${plan.offscreenSubjectIds.join('|') || '-'}`,
    `keyframeRefs=${plan.keyframe?.references.filter((reference) => reference.sentToProvider !== false).length ?? 0}`,
    `videoRefs=${plan.video?.references.filter((reference) => reference.sentToProvider !== false).length ?? 0}`,
    `videoMode=${plan.video?.controlMode ?? '-'}`,
  ];
}

export type ShotGenerationPlanExecution = {
  inputFingerprint?: string;
  executionContext?: ShotGenerationExecutionContext;
  references: ShotReferenceAsset[];
  outputUrl?: string;
  controlMode?: VideoControlMode;
  referenceMode?: 'i2v' | 't2v';
};

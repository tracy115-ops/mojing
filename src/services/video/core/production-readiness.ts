import type { PipelinePreflightResult } from './pipeline-preflight-rules.ts';
import type {
  CharacterAnchor,
  SceneAnchor,
  ShotSpec,
  VideoProjectState,
  VideoStage,
} from '@/types/video';
import { isReusableEnvironmentReference } from './asset-reference-contract.ts';
import { needsTurnaroundGeneration } from './character-asset-binding.ts';
import {
  getShotProductionReadiness,
  isShotAssemblyReady,
  isShotKeyframeCurrent,
  type ShotProductionState,
} from './shot-production-contract.ts';
import { resolveAssemblyQualityRequirements } from './quality-policy.ts';
import { getContinuityHandoffIssue } from './shot-continuity.ts';
import { getShotStillPrompt, validateShotPlanContract, type ShotPlanIssue } from './shot-plan-contract.ts';

export type ProductionPhase = 'script' | 'assets' | 'shots' | 'timeline';

export type ProductionAction =
  | 'configure'
  | 'write_source'
  | 'plan'
  | 'review_plan'
  | 'prepare_assets'
  | 'review_shots'
  | 'assemble'
  | 'monitor'
  | 'repair'
  | 'complete';

export interface ProductionBlocker {
  code: string;
  phase: ProductionPhase;
  subjectId?: string;
  shotId?: string;
}

export interface ProductionContinuityRisk {
  shotId: string;
  previousShotId: string;
  reason: 'missing_previous_clip' | 'missing_tail_frame';
}

export interface ProductionReadiness {
  overall: 'idle' | 'running' | 'review' | 'complete' | 'error';
  phase: ProductionPhase;
  action: ProductionAction;
  activeStage?: VideoStage;
  failedStage?: VideoStage;
  sourceReady: boolean;
  planningReady: boolean;
  planningApproved: boolean;
  planningReviewRequired: boolean;
  planningIssues: ShotPlanIssue[];
  shots: ShotSpec[];
  characters: CharacterAnchor[];
  scenes: SceneAnchor[];
  counts: {
    shots: number;
    assetsRequired: number;
    assetsReady: number;
    charactersRequired: number;
    charactersReady: number;
    scenesRequired: number;
    scenesReady: number;
    keyframes: number;
    videoCandidates: number;
    approved: number;
  };
  shotStates: Record<string, ShotProductionState>;
  blockers: ProductionBlocker[];
  continuityRisks: ProductionContinuityRisk[];
  warnings: string[];
}

interface ProductionReadinessInput {
  sourceText?: string;
  preflight?: PipelinePreflightResult;
}

/**
 * One product-level state model for the production console.
 *
 * The runtime still has fine-grained stages, but the user should make
 * decisions against this smaller contract: source -> plan -> assets -> shots
 * -> timeline. This function deliberately contains no UI strings so it can be
 * reused by desktop UI, smoke tests, and future automation clients.
 */
export function getProductionReadiness(
  project: VideoProjectState,
  input: ProductionReadinessInput = {},
): ProductionReadiness {
  const sceneSpec = project.sceneSpec;
  const shots = sceneSpec?.shots ?? [];
  const characters = sceneSpec?.characters ?? [];
  const scenes = sceneSpec?.scenes ?? [];
  const sourceReady = !!input.sourceText?.trim() || sceneSpec?.meta.channel === 'direct';
  // Legacy persisted projects may predate the dedicated still prompt. The
  // execution layer has always used the motion prompt as its safe fallback;
  // keep those projects visible while requiring the new planners to emit both
  // contracts explicitly.
  const isLegacyPlan = !project.options?.qualityProfile;
  const planningIssues = validateShotPlanContract(isLegacyPlan
    ? shots.map((shot) => ({
        ...shot,
        sourceText: shot.sourceText?.trim() || shot.videoPrompt,
        imagePrompt: getShotStillPrompt(shot),
      }))
    : shots, {
    characters,
    scenes,
    // New quality-oriented projects must make the visible-subject decision
    // explicit. Projects without an options snapshot are legacy data and keep
    // the old compatibility behavior until the user edits the plan.
    requireAssetBindings: project.options?.enableCharacterAnchor === true && characters.length > 0,
  });
  const planningReady = planningIssues.length === 0;
  // Direct projects already arrive with a user-authored scene specification.
  // For novel projects, a freshly generated plan is explicitly held at the
  // extraction checkpoint until the user confirms it.
  const planningReviewRequired = planningReady
    && sceneSpec?.meta.channel !== 'direct'
    && project.stages.extraction?.status !== 'completed';
  const extractionReady = sceneSpec?.meta.channel === 'direct'
    || project.stages.extraction?.status === 'completed';
  const planningApproved = planningReady && !planningReviewRequired && extractionReady;

  const requiredCharacters = project.options?.enableCharacterAnchor === false ? [] : characters;
  const requiredScenes = project.options?.enableSceneImage === false ? [] : scenes;
  const anchorLimit = project.options?.characterAnchorLimit ?? 5;
  const singleView = project.stages.character_anchor?.input?.anchorMode === 'single';
  const characterReady = (character: CharacterAnchor, index: number) => (
    singleView || index >= anchorLimit
      ? !!(character.portraitImage || character.turnaroundImage)
      : !needsTurnaroundGeneration(character)
  );
  const readyCharacters = requiredCharacters.filter(characterReady);
  const readyScenes = requiredScenes.filter(isReusableEnvironmentReference);
  const assetsRequired = requiredCharacters.length + requiredScenes.length;
  const assetsReady = readyCharacters.length + readyScenes.length;

  const clipsByShot = new Map(project.clips.map((clip) => [clip.shotId, clip]));
  const shotStates = Object.fromEntries(shots.map((shot) => [
    shot.id,
    getShotProductionReadiness(shot, clipsByShot.get(shot.id), true).state,
  ]));
  const keyframes = shots.filter(isShotKeyframeCurrent).length;
  const videoCandidates = shots.filter((shot) => {
    const readiness = getShotProductionReadiness(shot, clipsByShot.get(shot.id), false);
    return readiness.hasVideo;
  }).length;
  const assemblyRequirements = resolveAssemblyQualityRequirements(project.options);
  const approved = shots.filter((shot) => isShotAssemblyReady(
    shot,
    clipsByShot.get(shot.id),
    assemblyRequirements,
  )).length;
  const continuityRisks = findContinuityRisks(shots, clipsByShot);

  const blockers: ProductionBlocker[] = [];
  if (input.preflight?.blocking.length) {
    blockers.push(...input.preflight.blocking.map((issue) => ({
      code: `provider:${issue.category}:${issue.code}`,
      phase: 'shots' as const,
    })));
  }
  if (!sourceReady) blockers.push({ code: 'source_required', phase: 'script' });
  if (sourceReady && !planningReady) blockers.push({ code: 'planning_required', phase: 'script' });
  for (const issue of planningIssues) {
    blockers.push({ code: `planning:${issue.code}`, phase: 'script', shotId: issue.shotId });
  }
  if (planningReviewRequired) blockers.push({ code: 'planning_review_required', phase: 'script' });
  for (const character of requiredCharacters.filter((item, index) => !characterReady(item, index))) {
    blockers.push({ code: 'character_reference_required', phase: 'assets', subjectId: character.id });
  }
  for (const scene of requiredScenes.filter((item) => !isReusableEnvironmentReference(item))) {
    blockers.push({ code: 'scene_reference_required', phase: 'assets', subjectId: scene.id });
  }
  for (const shot of shots.filter((item) => item.unresolvedCharacterRefs?.some((reference) => reference.trim()))) {
    blockers.push({ code: 'unresolved_character_binding', phase: 'shots', shotId: shot.id });
  }
  const stageError = findStageError(project);
  const isRunning = !!project.currentStage
    && project.currentStage !== 'idle'
    && project.currentStage !== 'complete'
    && project.stages[project.currentStage]?.status === 'running';
  const isAwaitingReview = project.stages.video_generation?.status === 'awaiting_review'
    || project.stages.video_review?.status === 'awaiting_review';

  let action: ProductionAction;
  if (stageError) action = 'repair';
  else if (isRunning) action = 'monitor';
  else if (input.preflight?.blocking.length) action = 'configure';
  else if (!sourceReady) action = 'write_source';
  else if (!planningReady) action = 'plan';
  else if (planningReviewRequired) action = 'review_plan';
  else if (assetsRequired > assetsReady) action = 'prepare_assets';
  else if (approved < shots.length) {
    action = 'review_shots';
  } else if (shots.length > 0 && !project.finalVideoUrl) action = 'assemble';
  else if (project.finalVideoUrl) action = 'complete';
  else action = 'plan';

  const overall = stageError
    ? 'error'
    : project.finalVideoUrl && approved === shots.length
      ? 'complete'
      : isRunning
        ? 'running'
      : planningReviewRequired || isAwaitingReview || approved > 0 || videoCandidates > 0
          ? 'review'
          : 'idle';

  return {
    overall,
    phase: phaseForAction(action),
    action,
    activeStage: project.currentStage,
    failedStage: stageError,
    sourceReady,
    planningReady,
    planningApproved,
    planningReviewRequired,
    planningIssues,
    shots,
    characters,
    scenes,
    counts: {
      shots: shots.length,
      assetsRequired,
      assetsReady,
      charactersRequired: requiredCharacters.length,
      charactersReady: readyCharacters.length,
      scenesRequired: requiredScenes.length,
      scenesReady: readyScenes.length,
      keyframes,
      videoCandidates,
      approved,
    },
    shotStates,
    blockers,
    continuityRisks,
    warnings: input.preflight?.warnings.map((issue) => `provider:${issue.category}:${issue.code}`) ?? [],
  };
}

export function phaseForAction(action: ProductionAction): ProductionPhase {
  switch (action) {
    case 'write_source':
    case 'plan':
    case 'review_plan':
      return 'script';
    case 'prepare_assets':
      return 'assets';
    case 'review_shots':
    case 'monitor':
    case 'repair':
      return 'shots';
    case 'assemble':
    case 'complete':
      return 'timeline';
    case 'configure':
      return 'shots';
  }
}

function findStageError(project: VideoProjectState): VideoStage | undefined {
  const current = project.currentStage;
  if (current && project.stages[current]?.status === 'error') return current;
  return Object.values(project.stages).find((stage) => stage.status === 'error')?.stage;
}

function findContinuityRisks(
  shots: ShotSpec[],
  clipsByShot: Map<string, VideoProjectState['clips'][number]>,
): ProductionContinuityRisk[] {
  const risks: ProductionContinuityRisk[] = [];
  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1];
    const current = shots[index];
    const reason = getContinuityHandoffIssue(previous, current, clipsByShot.get(previous.id));
    if (reason) risks.push({ shotId: current.id, previousShotId: previous.id, reason });
  }
  return risks;
}

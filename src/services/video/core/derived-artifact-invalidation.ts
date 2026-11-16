import type {
  CharacterAnchor,
  GeneratedClip,
  SceneAnchor,
  SceneSpec,
  ShotSpec,
  VideoStage,
  VideoStageState,
} from '../../../types/video.ts';

export interface ReconciledSceneSpecArtifacts {
  spec: SceneSpec;
  clips: GeneratedClip[];
  finalVideoUrl?: string;
  invalidateFrom?: Extract<VideoStage, 'keyframe_image' | 'video_generation'>;
}

type ShotLike = ShotSpec & {
  characters?: string[];
  offscreenCharacters?: string[];
};

const characterVisualKeys: Array<keyof CharacterAnchor> = [
  'id',
  'name',
  'aliases',
  'appearance',
  'entityType',
  'gender',
  'ageGroup',
  'portraitImage',
  'turnaroundImage',
  'turnaroundSourcePortrait',
  'costumeVariants',
  'seed',
  'consistencyTags',
];

const sceneVisualKeys: Array<keyof SceneAnchor> = [
  'id',
  'name',
  'aliases',
  'description',
  'backgroundImage',
  'backgroundReferenceRole',
  'backgroundReferenceVersion',
  'seed',
];

const keyframeInputKeys: Array<keyof ShotLike> = [
  'sourceText',
  'videoPrompt',
  'imagePrompt',
  'imageNegativePrompt',
  'imageParameters',
  'startState',
  'endState',
  'characters',
  'characterIds',
  'visibleCharacterIds',
  'offscreenCharacterIds',
  'characterBinding',
  'costumeVariantRefs',
  'sceneId',
  'location',
  'mood',
  'cameraMovement',
  'transition',
  'customReferenceImages',
  'manualReferenceImage',
  'previsReferenceImage',
];

const videoInputKeys: Array<keyof ShotLike> = [
  'sourceText',
  'videoPrompt',
  'videoNegativePrompt',
  'videoParameters',
  'startState',
  'endState',
  'seed',
  'durationSeconds',
  'characters',
  'characterIds',
  'visibleCharacterIds',
  'offscreenCharacterIds',
  'characterBinding',
  'costumeVariantRefs',
  'sceneId',
  'location',
  'mood',
  'cameraMovement',
  'transition',
  'customReferenceImages',
  'manualReferenceImage',
  'previsReferenceImage',
  'customReferenceVideos',
];

/**
 * Reconcile persisted derived assets after a scene spec replacement. A newly
 * supplied keyframe is treated as an authoritative fresh output; stale
 * keyframes are removed when their visual inputs changed.
 */
export function reconcileSceneSpecArtifacts(
  previousSpec: SceneSpec | undefined,
  nextSpec: SceneSpec,
  previousClips: GeneratedClip[],
  finalVideoUrl?: string,
): ReconciledSceneSpecArtifacts {
  const previousShots = new Map((previousSpec?.shots ?? []).map((shot) => [shot.id, shot]));
  const changedCharacterIds = changedEntityIds<CharacterAnchor>(previousSpec?.characters ?? [], nextSpec.characters ?? [], characterVisualKeys);
  const changedSceneIds = changedEntityIds<SceneAnchor>(previousSpec?.scenes ?? [], nextSpec.scenes ?? [], sceneVisualKeys);
  const affectedShotIds = new Set<string>();
  let keyframeInvalidation = false;
  let videoInvalidation = false;

  const shots = nextSpec.shots.map((nextShot) => {
    const previousShot = previousShots.get(nextShot.id);
    const characterChanged = [...changedCharacterIds].some((id) => shotReferencesCharacter(nextShot, id, previousSpec, nextSpec));
    const sceneChanged = [...changedSceneIds].some((id) => shotReferencesScene(nextShot, id, previousSpec, nextSpec));
    const keyframeInputsChanged = !!previousShot
      && hasChanged(previousShot as ShotLike, nextShot as ShotLike, keyframeInputKeys);
    const videoInputsChanged = !!previousShot
      && hasChanged(previousShot as ShotLike, nextShot as ShotLike, videoInputKeys);
    const keyframeReplaced = previousShot?.keyframeImage !== nextShot.keyframeImage;
    const freshKeyframe = !!nextShot.keyframeImage && keyframeReplaced;
    const staleKeyframe = (characterChanged || sceneChanged || keyframeInputsChanged)
      && !freshKeyframe;

    if (characterChanged || sceneChanged || keyframeInputsChanged || keyframeReplaced) {
      affectedShotIds.add(nextShot.id);
    }
    if (staleKeyframe) {
      keyframeInvalidation = true;
    }
    if (characterChanged || sceneChanged || keyframeInputsChanged || videoInputsChanged || keyframeReplaced) {
      videoInvalidation = true;
    }

    if (!staleKeyframe && !videoInputsChanged && !keyframeReplaced) return nextShot;

    const updates: Partial<ShotSpec> = {};
    if (characterChanged || sceneChanged) {
      // Imported visual review belongs to the cast/scene at inspection time.
      // Old imports remain viewable but need inspection again after visual edits.
      updates.versionHistory = nextShot.versionHistory?.map((version) => version.importedVideo
        ? { ...version, inputFingerprint: undefined, reviewStatus: 'unreviewed', reviewedAt: undefined }
        : version);
    }
    if (staleKeyframe) {
      updates.keyframeImage = undefined;
      updates.referenceAssets = undefined;
      updates.keyframeInputFingerprint = undefined;
      updates.keyframeGenerationContext = undefined;
      updates.generationPlan = undefined;
      updates.selectedVersionId = undefined;
      updates.lockedVersionId = undefined;
    } else if (keyframeReplaced && previousShot?.selectedVersionId === nextShot.selectedVersionId) {
      // The selected version points at the old derived image/video.
      updates.selectedVersionId = undefined;
      updates.lockedVersionId = undefined;
    }
    if (videoInputsChanged && !staleKeyframe && !keyframeReplaced) {
      // Keep a valid still, but do not keep presenting an old video version as current.
      updates.selectedVersionId = undefined;
      updates.lockedVersionId = undefined;
      if (nextShot.generationPlan) {
        updates.generationPlan = {
          ...nextShot.generationPlan,
          video: undefined,
        };
      }
    } else if (keyframeReplaced && nextShot.generationPlan) {
      updates.generationPlan = {
        ...nextShot.generationPlan,
        keyframe: undefined,
        video: undefined,
      };
    }
    return Object.keys(updates).length > 0 ? { ...nextShot, ...updates } : nextShot;
  });

  const nextShotIds = new Set(shots.map((shot) => shot.id));
  const clips = previousClips.filter((clip) => nextShotIds.has(clip.shotId) && !affectedShotIds.has(clip.shotId));
  const clipsChanged = clips.length !== previousClips.length;

  return {
    spec: { ...nextSpec, shots },
    clips,
    finalVideoUrl: clipsChanged || videoInvalidation ? undefined : finalVideoUrl,
    invalidateFrom: keyframeInvalidation
      ? 'keyframe_image'
      : videoInvalidation
        ? 'video_generation'
        : undefined,
  };
}

/**
 * Merge reusable outputs into a newly supplied spec without replacing its
 * current planning inputs. This is used when reopening or resuming a project:
 * portraits, backgrounds, keyframes, and selected versions may be reused only
 * when the inputs that produced them are unchanged.
 */
export function mergePersistedSceneSpecArtifacts(
  previousSpec: SceneSpec | undefined,
  nextSpec: SceneSpec,
): SceneSpec {
  if (!previousSpec) return nextSpec;

  const previousCharacters = new Map((previousSpec.characters ?? []).map((character) => [character.id, character]));
  const characters = nextSpec.characters?.map((character) => {
    const previous = previousCharacters.get(character.id);
    if (!previous || characterInputsChanged(previous, character)) return character;

    const previousVariants = new Map((previous.costumeVariants ?? []).map((variant) => [variant.id, variant]));
    return {
      ...character,
      voiceRef: character.voiceRef ?? previous.voiceRef,
      portraitImage: character.portraitImage ?? previous.portraitImage,
      turnaroundImage: character.turnaroundImage ?? previous.turnaroundImage,
      turnaroundSourcePortrait: character.turnaroundSourcePortrait ?? previous.turnaroundSourcePortrait,
      costumeVariants: character.costumeVariants?.map((variant) => {
        const previousVariant = previousVariants.get(variant.id);
        if (!previousVariant || costumeVariantInputsChanged(previousVariant, variant)) return variant;
        return { ...variant, portraitImage: variant.portraitImage ?? previousVariant.portraitImage };
      }),
    };
  });

  const previousScenes = new Map((previousSpec.scenes ?? []).map((scene) => [scene.id, scene]));
  const scenes = nextSpec.scenes?.map((scene) => {
    const previous = previousScenes.get(scene.id);
    if (!previous || sceneInputsChanged(previous, scene)) return scene;
    return {
      ...scene,
      backgroundImage: scene.backgroundImage ?? previous.backgroundImage,
      backgroundReferenceRole: scene.backgroundReferenceRole ?? previous.backgroundReferenceRole,
      backgroundReferenceVersion: scene.backgroundReferenceVersion ?? previous.backgroundReferenceVersion,
    };
  });

  const previousShots = new Map((previousSpec.shots ?? []).map((shot) => [shot.id, shot]));
  const shots = nextSpec.shots.map((shot) => {
    const previous = previousShots.get(shot.id);
    if (!previous) return shot;

    const keyframeInputsChanged = hasChanged(previous as ShotLike, shot as ShotLike, keyframeInputKeys);
    const videoInputsChanged = hasChanged(previous as ShotLike, shot as ShotLike, videoInputKeys);
    if (keyframeInputsChanged || videoInputsChanged) {
      return clearStaleShotArtifacts(previous, shot);
    }

    return {
      ...shot,
      keyframeImage: shot.keyframeImage ?? previous.keyframeImage,
      referenceAssets: shot.referenceAssets ?? previous.referenceAssets,
      generationPlan: shot.generationPlan ?? previous.generationPlan,
      versionHistory: shot.versionHistory ?? previous.versionHistory,
      selectedVersionId: shot.selectedVersionId ?? previous.selectedVersionId,
      audioTrack: shot.audioTrack ?? previous.audioTrack,
    };
  });

  return { ...nextSpec, characters, scenes, shots };
}

function clearStaleShotArtifacts(previous: ShotSpec, next: ShotSpec): ShotSpec {
  const hasFreshKeyframe = !!next.keyframeImage && next.keyframeImage !== previous.keyframeImage;
  const nextShot: ShotSpec = { ...next };

  if (!hasFreshKeyframe) {
    nextShot.keyframeImage = undefined;
    nextShot.referenceAssets = undefined;
    nextShot.keyframeInputFingerprint = undefined;
    nextShot.keyframeGenerationContext = undefined;
    nextShot.generationPlan = undefined;
    nextShot.selectedVersionId = undefined;
    nextShot.lockedVersionId = undefined;
    return nextShot;
  }

  // A new still is authoritative, but old audit metadata must not follow it.
  if (sameValue(next.referenceAssets, previous.referenceAssets)) nextShot.referenceAssets = undefined;
  if (next.generationPlan === previous.generationPlan) nextShot.generationPlan = undefined;
  if (next.selectedVersionId === previous.selectedVersionId) nextShot.selectedVersionId = undefined;
  if (next.lockedVersionId === previous.lockedVersionId) nextShot.lockedVersionId = undefined;
  return nextShot;
}

export function resetVideoStagesFrom(
  stages: Record<VideoStage, VideoStageState>,
  fromStage: Extract<VideoStage, 'keyframe_image' | 'video_generation'>,
  defaultSkippedStages: ReadonlySet<VideoStage>,
): Record<VideoStage, VideoStageState> {
  const startIndex = [
    'keyframe_image',
    'video_generation',
    'video_review',
    'audio_merge',
    'composing',
  ].indexOf(fromStage);
  if (startIndex < 0) return stages;

  const resetStages = { ...stages };
  const stageNames: VideoStage[] = [
    'keyframe_image',
    'video_generation',
    'video_review',
    'audio_merge',
    'composing',
  ];
  for (const stage of stageNames.slice(startIndex)) {
    const previous = resetStages[stage];
    if (!previous) continue;
    resetStages[stage] = {
      stage,
      status: defaultSkippedStages.has(stage) ? 'skipped' : 'pending',
      progress: 0,
      input: previous.input,
    };
  }
  return resetStages;
}

function changedEntityIds<T extends { id: string }>(
  previous: T[],
  next: T[],
  keys: Array<keyof T>,
): Set<string> {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const ids = new Set([...previousById.keys(), ...nextById.keys()]);
  return new Set([...ids].filter((id) => {
    const before = previousById.get(id);
    const after = nextById.get(id);
    return !before || !after || hasChanged(before, after, keys);
  }));
}

function characterInputsChanged(before: CharacterAnchor, after: CharacterAnchor): boolean {
  const left = characterInputSnapshot(before);
  const right = characterInputSnapshot(after);
  return !sameValue(left, right);
}

function characterInputSnapshot(character: CharacterAnchor): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...character };
  delete snapshot.portraitImage;
  delete snapshot.turnaroundImage;
  delete snapshot.turnaroundSourcePortrait;
  snapshot.costumeVariants = character.costumeVariants?.map((variant) => {
    const copy: Record<string, unknown> = { ...variant };
    delete copy.portraitImage;
    return copy;
  });
  return snapshot;
}

function costumeVariantInputsChanged(
  before: NonNullable<CharacterAnchor['costumeVariants']>[number],
  after: NonNullable<CharacterAnchor['costumeVariants']>[number],
): boolean {
  return before.id !== after.id || before.description !== after.description;
}

function sceneInputsChanged(before: SceneAnchor, after: SceneAnchor): boolean {
  const left: Record<string, unknown> = { ...before };
  const right: Record<string, unknown> = { ...after };
  delete left.backgroundImage;
  delete left.backgroundReferenceRole;
  delete left.backgroundReferenceVersion;
  delete right.backgroundImage;
  delete right.backgroundReferenceRole;
  delete right.backgroundReferenceVersion;
  return !sameValue(left, right);
}

function shotReferencesCharacter(
  shot: ShotLike,
  characterId: string,
  previousSpec: SceneSpec | undefined,
  nextSpec: SceneSpec,
): boolean {
  const character = nextSpec.characters?.find((candidate) => candidate.id === characterId)
    ?? previousSpec?.characters?.find((candidate) => candidate.id === characterId);
  if (!character) return false;
  const references = explicitCharacterReferences(shot);
  if (references.length > 0 || shot.characterBinding === 'explicit') {
    return references.some((reference) => characterIdentifiers(character).has(normalize(reference)));
  }
  const text = normalize([shot.sourceText, shot.videoPrompt, shot.narration].filter(Boolean).join(' '));
  return [...characterIdentifiers(character)].some((identifier) => identifier.length >= 2 && text.includes(identifier));
}

function shotReferencesScene(
  shot: ShotLike,
  sceneId: string,
  previousSpec: SceneSpec | undefined,
  nextSpec: SceneSpec,
): boolean {
  if (shot.sceneId) return shot.sceneId === sceneId;
  const scene = nextSpec.scenes?.find((candidate) => candidate.id === sceneId)
    ?? previousSpec?.scenes?.find((candidate) => candidate.id === sceneId);
  if (!scene) return false;
  const location = normalize(shot.location ?? '');
  if (!location) return false;
  return [scene.name, ...(scene.aliases ?? [])]
    .map(normalize)
    .filter((value) => value.length > 0)
    .some((value) => value === location || value.includes(location) || location.includes(value));
}

function explicitCharacterReferences(shot: ShotLike): string[] {
  if (Array.isArray(shot.visibleCharacterIds)) return shot.visibleCharacterIds;
  if (Array.isArray(shot.characterIds) && shot.characterIds.length > 0) return shot.characterIds;
  return shot.characters ?? [];
}

function characterIdentifiers(character: CharacterAnchor): Set<string> {
  return new Set([character.id, character.name, ...(character.aliases ?? [])].map(normalize));
}

function hasChanged<T extends object>(
  before: T,
  after: T,
  keys: Array<keyof T>,
): boolean {
  return keys.some((key) => !sameValue(before[key], after[key]));
}

function sameValue(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  try {
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s._-]/g, '');
}

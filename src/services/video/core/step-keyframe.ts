// Keyframe generation. The planner owns visual wording; this module owns
// canonical reference selection, ordering, validation, and persistence.

import { providerRouter } from '@/services/providers';
import { fingerprintPayload } from '@/services/providers/generation-snapshot';
import type {
  ShotSpec,
  CharacterAnchor,
  SceneAnchor,
  AspectRatio,
  ModelTier,
  ShotReferenceAsset,
  ShotReferenceTransport,
  ShotGenerationExecutionContext,
} from '@/types/video';
import type { GenerationReferenceInput, ImageReferenceCapability } from '@/types/providers';
import { saveAsset, readAsDataUri } from '../asset-store';
import { getEffectiveShotSeed, getSubjectContinuityShot, shotsShareScene } from './shot-continuity';
import { ENVIRONMENT_REFERENCE_VERSION } from './step-scene-image';
import { logger } from '@/services/log';
import {
  buildExactSubjectConstraint,
  buildMultiCharacterDnaTokens,
  buildOffscreenBindingText,
  buildSubjectExclusionPrompt,
  findMatchingCharacters,
} from './character-dna';
import { hasCurrentTurnaround, resolveCharacterReferenceImage } from './character-asset-binding';
import { fingerprintShotInputs } from './shot-generation-receipt';
import { updateShotGenerationPlan } from './shot-generation-plan';
import {
  chooseImageReferenceStrategy,
  shouldPreferContinuityReference,
} from './reference-strategy';

export interface KeyframeResult {
  shots: ShotSpec[];
  failedShotIds: string[];
}

interface CollectedRef {
  url: string;
  cropMiddleThird?: boolean;
  charName?: string;
  kind: ShotReferenceAsset['kind'];
  label: string;
  characterId?: string;
  subjectIds?: string[];
  omittedReason?: string;
}

interface PreparedReferences {
  candidates: CollectedRef[];
  sent: CollectedRef[];
  payloads: string[];
  transport: ShotReferenceTransport;
}

export async function runKeyframe(
  shots: ShotSpec[],
  ctx: {
    characters: CharacterAnchor[];
    scenes: SceneAnchor[];
    aspectRatio: AspectRatio;
    style?: string;
    imageTier: ModelTier;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
    openingReferenceImage?: string;
    seed?: number;
    requireCharacterReferences?: boolean;
    shouldAbort?: () => boolean;
  },
  onProgress?: (done: number, total: number) => void,
): Promise<KeyframeResult> {
  if (!shots.length) return { shots, failedShotIds: [] };
  if (ctx.requireCharacterReferences) assertCharacterReferences(shots, ctx.characters);

  const dimensions = aspectRatioToDims(ctx.aspectRatio);
  const sceneById = new Map(ctx.scenes.map((scene) => [scene.id, scene]));
  const result = shots.map((shot) => ({ ...shot }));
  const failedShotIds: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;

  for (let index = 0; index < shots.length; index++) {
    if (ctx.shouldAbort?.()) break;
    const shot = shots[index];
    const requestedImageModel = getParameterModel(shot.imageParameters) ?? ctx.imageModel;
    const imageCapabilities = providerRouter.getImageCapabilities(
      'storyboard',
      requestedImageModel,
      ctx.imageEndpointId,
    );
    const presentCharacters = findMatchingCharacters(shot, ctx.characters);
    const characterRefs = collectCharacterReferences(shot, presentCharacters);
    const customRefs = collectCustomReferences(shot);
    const manualShotRef = collectManualShotReference(shot, presentCharacters);
    const sceneRefs = collectSceneReferences(shot, sceneById);
    const continuityShot = getSubjectContinuityShot(result, shot);
    const previousKeyframeImage = continuityShot?.keyframeImage;
    const continuityRefs: CollectedRef[] = previousKeyframeImage
      ? [{
          url: previousKeyframeImage,
          kind: 'previous',
          subjectIds: presentCharacters.map((character) => character.id),
          label: `shot ${continuityShot?.index === undefined ? '' : continuityShot.index + 1} subject continuity frame`,
        }]
      : [];
    const openingRefs: CollectedRef[] = index === 0
      && characterRefs.length === 0
      && continuityRefs.length === 0
      && ctx.openingReferenceImage
      ? [{ url: ctx.openingReferenceImage, kind: 'opening', label: 'episode opening reference' }]
      : [];
    const preferContinuityReference = shouldPreferContinuityReference({
      hasMatchingContinuityShot: !!continuityShot,
      continuityReferenceCount: continuityRefs.length,
      hasManualShotReference: manualShotRef.length > 0 || !!shot.previsReferenceImage,
    });
    assertMultiSubjectReferenceStrategy(
      shot,
      presentCharacters,
      imageCapabilities.references,
      manualShotRef.length > 0,
    );
    const providerReferences = manualShotRef.length > 0
      ? manualShotRef
      : selectReferenceCandidates(
          shot,
          continuityShot,
          characterRefs,
          customRefs,
          continuityRefs,
          sceneRefs,
          openingRefs,
          imageCapabilities.references.supportsReferenceRoles,
          preferContinuityReference,
        );
    const resolvedReferences = await resolveProviderReferences(
      providerReferences,
      manualShotRef.length > 0
        ? manualShotRef
        : preferContinuityReference
          ? continuityRefs
          : characterRefs,
      presentCharacters,
      imageCapabilities.references,
      providerReferences.length === 1 && providerReferences[0].kind === 'previous',
    );
    const preparedReferences = await prepareReferencePayloads(
      resolvedReferences.candidates,
      resolvedReferences.required,
      imageCapabilities.references,
      ctx.requireCharacterReferences ?? false,
    );
    assertReferencePayloads(shot, presentCharacters, preparedReferences);
    const referenceAssets = buildReferenceAssets(
      shot.id,
      preparedReferences.candidates,
      preparedReferences,
    );
    result[index].referenceAssets = referenceAssets;

    try {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 800));
      const prompt = buildKeyframeInput(
        shot,
        presentCharacters,
        preparedReferences.sent,
        preparedReferences.transport,
        preferContinuityReference,
      );
      void logger.info(
        `[keyframe] shot=${shot.index + 1}/${shots.length} `
          + `subjects=${presentCharacters.map((character) => character.id).join('|') || '-'} `
          + `refs=characters:${characterRefs.length},custom:${customRefs.length},previous:${continuityRefs.length},opening:${openingRefs.length},scene:${sceneRefs.length},`
          + `sent=${preparedReferences.sent.length},payloads=${preparedReferences.payloads.length},transport=${preparedReferences.transport},max=${imageCapabilities.references.maxImages},`
          + `order=${preparedReferences.candidates.map((reference, refIndex) => `${refIndex + 1}:${reference.kind}:${reference.characterId ?? reference.label}:${reference.url === preparedReferences.sent.find((item) => item === reference)?.url ? 'sent' : 'omitted'}`).join('|')}`,
        'pipeline',
      );
      const image = await providerRouter.generateImage({
        taskType: 'storyboard',
        sourceLabel: `${shot.id}:keyframe`,
        prompt,
        negativePrompt: mergeNegativePrompts(shot.imageNegativePrompt),
        parameters: shot.imageParameters,
        aspectRatio: ctx.aspectRatio,
        referenceImages: preparedReferences.payloads,
        referenceSlots: buildGenerationReferenceInputs(shot.id, preparedReferences),
        width: dimensions.w,
        height: dimensions.h,
        style: ctx.style,
        endpointId: ctx.imageEndpointId,
        model: requestedImageModel,
        seed: getEffectiveShotSeed(shot, ctx.seed),
      });
      const seed = getEffectiveShotSeed(shot, ctx.seed);
      const executionContext = buildKeyframeExecutionContext({
        provider: image.provider,
        model: image.model,
        endpointId: image.endpointId ?? ctx.imageEndpointId,
      }, { ...ctx, seed });
      result[index].seed = seed;
      result[index].keyframeGenerationContext = executionContext;
      result[index].keyframeInputFingerprint = fingerprintShotInputs(
        shot,
        'keyframe',
        referenceAssets,
        executionContext,
      );
      const keyframeImage = await saveAsset(
        ctx.novelProjectId,
        'keyframe',
        image.imageData,
        `keyframe_shot_${index + 1}`,
      );
      result[index].keyframeImage = keyframeImage;
      result[index].generationPlan = updateShotGenerationPlan(result[index], {
        keyframe: {
          promptFingerprint: fingerprintPayload(prompt),
          inputFingerprint: result[index].keyframeInputFingerprint,
          executionContext,
          requestSnapshot: image.requestSnapshot,
          responseSnapshot: image.responseSnapshot,
          references: referenceAssets,
          outputUrl: keyframeImage,
        },
      });
      okCount++;
    } catch (err) {
      console.warn(`keyframe: failed for shot ${shot.id}`, err);
      lastErr = err;
      failedShotIds.push(shot.id);
    }
    done++;
    onProgress?.(done, shots.length);
  }

  if (ctx.requireCharacterReferences && failedShotIds.length > 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`Keyframe generation failed for ${failedShotIds.length} shot(s): ${reason}`);
  }
  if (okCount === 0 && shots.length > 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`All ${shots.length} keyframe generations failed: ${reason}`);
  }
  return { shots: result, failedShotIds };
}

export async function generateSingleKeyframe(
  shot: ShotSpec,
  shotIndex: number,
  _allShots: ShotSpec[],
  ctx: {
    characters: CharacterAnchor[];
    scenes: SceneAnchor[];
    aspectRatio: AspectRatio;
    style?: string;
    imageTier: ModelTier;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
    openingReferenceImage?: string;
    seed?: number;
    requireCharacterReferences?: boolean;
    /** A rendered tail is stronger continuity evidence than an older still. */
    continuityReferenceImage?: string;
    continuityReferenceShotIndex?: number;
    /** Use the rendered tail as the single authoritative visual input. */
    preferContinuityReference?: boolean;
  },
): Promise<{
  imagePath: string;
  seed?: number;
  referenceAssets: ShotReferenceAsset[];
  inputFingerprint: string;
  executionContext: ShotGenerationExecutionContext;
  generationPlan: NonNullable<ShotSpec['generationPlan']>;
}> {
  if (ctx.requireCharacterReferences) assertCharacterReferences([shot], ctx.characters);
  const dimensions = aspectRatioToDims(ctx.aspectRatio);
  const sceneById = new Map(ctx.scenes.map((scene) => [scene.id, scene]));
  const requestedImageModel = getParameterModel(shot.imageParameters) ?? ctx.imageModel;
  const imageCapabilities = providerRouter.getImageCapabilities(
    'storyboard',
    requestedImageModel,
    ctx.imageEndpointId,
  );
  const presentCharacters = findMatchingCharacters(shot, ctx.characters);
  const characterRefs = collectCharacterReferences(shot, presentCharacters);
  const customRefs = collectCustomReferences(shot);
  const manualShotRef = collectManualShotReference(shot, presentCharacters);
  const sceneRefs = collectSceneReferences(shot, sceneById);
  const continuityShot = getSubjectContinuityShot(_allShots, shot);
  const previousKeyframeImage = ctx.continuityReferenceImage || continuityShot?.keyframeImage;
  const continuityRefs: CollectedRef[] = previousKeyframeImage
    ? [{
        url: previousKeyframeImage,
        kind: 'previous',
        subjectIds: presentCharacters.map((character) => character.id),
        label: ctx.continuityReferenceImage
          ? `rendered tail frame from shot ${(ctx.continuityReferenceShotIndex ?? continuityShot?.index ?? 0) + 1}`
          : `shot ${continuityShot?.index === undefined ? '' : continuityShot.index + 1} subject continuity frame`,
      }]
      : [];
  const openingRefs: CollectedRef[] = shotIndex === 0
    && characterRefs.length === 0
    && continuityRefs.length === 0
    && ctx.openingReferenceImage
    ? [{ url: ctx.openingReferenceImage, kind: 'opening', label: 'episode opening reference' }]
    : [];
  assertMultiSubjectReferenceStrategy(
    shot,
    presentCharacters,
    imageCapabilities.references,
    manualShotRef.length > 0,
  );
  const providerReferences = manualShotRef.length > 0
    ? manualShotRef
    : selectReferenceCandidates(
        shot,
        continuityShot,
        characterRefs,
        customRefs,
        continuityRefs,
        sceneRefs,
        openingRefs,
        imageCapabilities.references.supportsReferenceRoles,
        ctx.preferContinuityReference === true && !!ctx.continuityReferenceImage && !shot.previsReferenceImage,
      );
  const requiredReferences = manualShotRef.length > 0
    ? manualShotRef
    : ctx.preferContinuityReference === true && !!ctx.continuityReferenceImage && !shot.previsReferenceImage
      ? continuityRefs
      : characterRefs;
  const resolvedReferences = await resolveProviderReferences(
    providerReferences,
    requiredReferences,
    presentCharacters,
    imageCapabilities.references,
    providerReferences.length === 1 && providerReferences[0].kind === 'previous',
  );
  const preparedReferences = await prepareReferencePayloads(
    resolvedReferences.candidates,
    resolvedReferences.required,
    imageCapabilities.references,
    ctx.requireCharacterReferences ?? false,
  );
  assertReferencePayloads(shot, presentCharacters, preparedReferences);

  void logger.info(
    `[keyframe] shot=${shot.index + 1}/${_allShots.length} `
      + `subjects=${presentCharacters.map((character) => character.id).join('|') || '-'} `
      + `refs=characters:${characterRefs.length},custom:${customRefs.length},previous:${continuityRefs.length},opening:${openingRefs.length},scene:${sceneRefs.length},`
      + `sent=${preparedReferences.sent.length},payloads=${preparedReferences.payloads.length},transport=${preparedReferences.transport},max=${imageCapabilities.references.maxImages},`
      + `order=${preparedReferences.candidates.map((reference, refIndex) => `${refIndex + 1}:${reference.kind}:${reference.characterId ?? reference.label}:${reference.url === preparedReferences.sent.find((item) => item === reference)?.url ? 'sent' : 'omitted'}`).join('|')}`,
    'pipeline',
  );
  const image = await providerRouter.generateImage({
    taskType: 'storyboard',
    sourceLabel: `${shot.id}:keyframe`,
    prompt: buildKeyframeInput(
      shot,
      presentCharacters,
      preparedReferences.sent,
      preparedReferences.transport,
      ctx.preferContinuityReference === true && !!ctx.continuityReferenceImage && !shot.previsReferenceImage,
    ),
    negativePrompt: mergeNegativePrompts(shot.imageNegativePrompt),
    parameters: shot.imageParameters,
    aspectRatio: ctx.aspectRatio,
    referenceImages: preparedReferences.payloads,
    referenceSlots: buildGenerationReferenceInputs(shot.id, preparedReferences),
    width: dimensions.w,
    height: dimensions.h,
    style: ctx.style,
    endpointId: ctx.imageEndpointId,
    model: requestedImageModel,
    seed: getEffectiveShotSeed(shot, ctx.seed),
  });
  const seed = getEffectiveShotSeed(shot, ctx.seed);
  const imagePath = await saveAsset(
    ctx.novelProjectId,
    'keyframe',
    image.imageData,
    `keyframe_shot_${shotIndex + 1}`,
  );
  const referenceAssets = buildReferenceAssets(shot.id, preparedReferences.candidates, preparedReferences);
  const executionContext = buildKeyframeExecutionContext({
    provider: image.provider,
    model: image.model,
    endpointId: image.endpointId ?? ctx.imageEndpointId,
  }, {
    ...ctx,
    seed,
    continuity: ctx.continuityReferenceImage
      ? {
          source: 'previous_tail',
          sourceShotId: continuityShot?.id,
          appliedTo: 'keyframe',
        }
      : undefined,
  });
  const generationPlan = updateShotGenerationPlan(shot, {
    keyframe: {
      promptFingerprint: fingerprintPayload(buildKeyframeInput(
        shot,
        presentCharacters,
        preparedReferences.sent,
        preparedReferences.transport,
        ctx.preferContinuityReference === true && !!ctx.continuityReferenceImage && !shot.previsReferenceImage,
      )),
      inputFingerprint: fingerprintShotInputs(
        shot,
        'keyframe',
        referenceAssets,
        executionContext,
      ),
      executionContext,
      requestSnapshot: image.requestSnapshot,
      responseSnapshot: image.responseSnapshot,
      references: referenceAssets,
      outputUrl: imagePath,
    },
  });
  return {
    imagePath,
    seed,
    referenceAssets,
    inputFingerprint: generationPlan.keyframe?.inputFingerprint ?? '',
    executionContext,
    generationPlan,
  };
}

function buildKeyframeExecutionContext(
  capabilities: { provider: string; model: string; endpointId?: string },
  ctx: {
    aspectRatio: AspectRatio;
    style?: string;
    seed?: number;
    continuity?: ShotGenerationExecutionContext['continuity'];
  },
): ShotGenerationExecutionContext {
  return {
    provider: capabilities.provider,
    model: capabilities.model,
    endpointId: capabilities.endpointId,
    seed: ctx.seed,
    aspectRatio: ctx.aspectRatio,
    ...(ctx.continuity ? { continuity: ctx.continuity } : {}),
  };
}

function getParameterModel(parameters?: Record<string, unknown>): string | undefined {
  const model = parameters?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

function selectReferenceCandidates(
  shot: ShotSpec,
  continuityShot: ShotSpec | undefined,
  characterRefs: CollectedRef[],
  customRefs: CollectedRef[],
  continuityRefs: CollectedRef[],
  sceneRefs: CollectedRef[],
  openingRefs: CollectedRef[],
  supportsReferenceRoles?: boolean,
  preferContinuityReference = false,
): CollectedRef[] {
  if (preferContinuityReference && continuityRefs.length > 0) {
    // A rendered tail already contains the current subjects, their wardrobe,
    // pose, lighting, and composition. Mixing it with portraits creates a
    // second identity authority and is a common source of duplicated subjects.
    return dedupeReferences(continuityRefs);
  }

  // Character references are the identity authority. A previous keyframe is
  // useful for pose and layout, but it is a weaker identity source and can
  // carry accidental wardrobe or subject drift into the next shot.
  if (characterRefs.length > 0) {
    if (supportsReferenceRoles !== true) {
      return dedupeReferences([...characterRefs, ...customRefs.filter(isPrevisReference)]);
    }
    return dedupeReferences([...characterRefs, ...customRefs, ...continuityRefs, ...sceneRefs, ...openingRefs]);
  }

  if (continuityRefs.length > 0) {
    // Providers without semantic slots receive only the prior frame; the shot
    // description remains responsible for establishing the current setting.
    if (supportsReferenceRoles !== true) return dedupeReferences([...continuityRefs, ...customRefs]);
    return dedupeReferences(continuityShot && shotsShareScene(continuityShot, shot)
      ? [...continuityRefs, ...customRefs]
      : [...continuityRefs, ...customRefs, ...sceneRefs]);
  }

  return dedupeReferences([...customRefs, ...sceneRefs, ...openingRefs]);
}

function collectCharacterReferences(shot: ShotSpec, characters: CharacterAnchor[]): CollectedRef[] {
  return characters.flatMap((character) => {
    const variantId = shot.costumeVariantRefs?.[character.id] || shot.costumeVariantRefs?.[character.name];
    const resolved = resolveCharacterReferenceImage(character, variantId);
    if (!resolved) return [];
    const variantLabel = variantId && resolved.source === 'variant' ? ' (' + variantId + ')' : '';
    return [{
      url: resolved.imageUrl,
      charName: character.name,
      kind: 'character' as const,
      cropMiddleThird: resolved.source === 'turnaround',
      label: character.name + variantLabel,
      characterId: character.id,
    }];
  });
}

function collectCustomReferences(shot: ShotSpec): CollectedRef[] {
  const userReferences: CollectedRef[] = (shot.customReferenceImages ?? [])
    .map((url, index) => ({
      url,
      kind: 'custom' as const,
      label: `user reference ${index + 1}`,
    }))
    .filter((reference) => !!reference.url);
  return shot.previsReferenceImage
    ? [{ url: shot.previsReferenceImage, kind: 'custom', label: '3D previs: composition and camera only' }, ...userReferences]
    : userReferences;
}

function isPrevisReference(reference: CollectedRef): boolean {
  return reference.kind === 'custom' && reference.label === '3D previs: composition and camera only';
}

function collectManualShotReference(
  shot: ShotSpec,
  presentCharacters: CharacterAnchor[],
): CollectedRef[] {
  const image = shot.manualReferenceImage?.trim();
  if (!image) return [];
  return [{
    url: image,
    kind: 'custom',
    label: 'human-approved shot reference',
    subjectIds: presentCharacters.map((character) => character.id),
  }];
}

function assertMultiSubjectReferenceStrategy(
  shot: ShotSpec,
  presentCharacters: CharacterAnchor[],
  capability: ImageReferenceCapability,
  hasManualShotReference: boolean,
): void {
  if (presentCharacters.length <= 1) return;
  if (!capability.supported || capability.maxImages <= 0) {
    throw new Error(
      `Shot ${shot.index + 1} contains ${presentCharacters.length} visible subjects, `
        + 'but the selected image model does not support reference images',
    );
  }
  if (presentCharacters.length > capability.maxImages && !hasManualShotReference) {
    if (capability.supportsReferenceRoles !== true && capability.maxImages >= 1) return;
    throw new Error(
      `Shot ${shot.index + 1} contains ${presentCharacters.length} visible subjects, `
        + `but the selected image model accepts at most ${capability.maxImages} reference image(s). `
        + 'Upload one human-approved shot reference image containing the visible subjects, or choose a model with a larger reference capacity.',
    );
  }
}

interface ResolvedProviderReferences {
  candidates: CollectedRef[];
  required: CollectedRef[];
}

function resolveProviderReferences(
  candidates: CollectedRef[],
  requiredReferences: CollectedRef[],
  presentCharacters: CharacterAnchor[],
  capability: ImageReferenceCapability,
  hasSingleCompleteReference: boolean,
): ResolvedProviderReferences {
  const eligible = candidates.filter((reference) => !reference.omittedReason);
  const strategy = chooseImageReferenceStrategy({
    candidateCount: eligible.length,
    visibleSubjectCount: presentCharacters.length,
    hasManualShotReference: candidates.some((reference) => reference.label === 'human-approved shot reference'),
    hasSingleCompleteReference,
    capability,
  });

  if (strategy === 'blocked') {
    if (presentCharacters.length > 0) {
      throw new Error('This image model cannot reliably bind multiple visible subjects from separate reference images. Upload one approved whole-shot reference image or choose a model with semantic subject slots.');
    }
    return { candidates, required: requiredReferences };
  }
  return { candidates, required: requiredReferences };
}

function dedupeReferences(references: CollectedRef[]): CollectedRef[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.url)) return false;
    seen.add(reference.url);
    return true;
  });
}

function collectSceneReferences(
  shot: ShotSpec,
  sceneById: Map<string, SceneAnchor>,
): CollectedRef[] {
  const scene = shot.sceneId ? sceneById.get(shot.sceneId) : undefined;
  if (!scene?.backgroundImage) return [];
  return [{
    url: scene.backgroundImage,
    kind: 'scene',
    label: scene.name,
    omittedReason: scene.backgroundReferenceRole === 'environment_only'
      && scene.backgroundReferenceVersion === ENVIRONMENT_REFERENCE_VERSION
      ? undefined
      : 'background is not verified as environment-only',
  }];
}

async function prepareReferencePayloads(
  candidates: CollectedRef[],
  requiredCharacterRefs: CollectedRef[],
  capability: {
    supported: boolean;
    maxImages: number;
    supportsReferenceRoles?: boolean;
  },
  requireCharacterReferences: boolean,
): Promise<PreparedReferences> {
  if (candidates.length === 0) return { candidates, sent: [], payloads: [], transport: 'direct' };

  if (!capability.supported || capability.maxImages <= 0) {
    if (candidates.some(isPrevisReference)) throw new Error('The selected image model cannot accept the explicit 3D composition reference');
    if (requireCharacterReferences && requiredCharacterRefs.length > 0) {
      throw new Error('The selected image model does not support character reference images for this shot');
    }
    return { candidates, sent: [], payloads: [], transport: 'direct' };
  }

  if (requiredCharacterRefs.length > capability.maxImages) {
    throw new Error(
      `The selected image model accepts at most ${capability.maxImages} reference image(s), `
        + `but this shot requires ${requiredCharacterRefs.length} visible subject reference(s)`,
    );
  }

  const eligibleCandidates = candidates.filter((reference) => !reference.omittedReason);
  const compositionReferences = eligibleCandidates.filter(isPrevisReference);
  if (requiredCharacterRefs.length + compositionReferences.length > capability.maxImages) {
    throw new Error('This image model has no remaining reference slot for the explicit 3D composition. Choose a model with more image references.');
  }
  // Untyped image endpoints do not preserve the meaning of slot 2, slot 3,
  // etc. For a multi-subject shot, however, dropping required subjects is a
  // deterministic quality failure. Send all required subject images first
  // and omit unrelated scene/continuity material from the untyped request.
  const rankedCandidates = capability.supportsReferenceRoles === true
    ? eligibleCandidates
    : [
        ...eligibleCandidates.filter((reference) => reference.kind === 'character'),
        ...eligibleCandidates.filter((reference) => reference.kind !== 'character'),
      ];
  const sentCandidates = capability.supportsReferenceRoles === true
    ? rankedCandidates.slice(0, capability.maxImages)
    : requiredCharacterRefs.length > 1
      ? [
          ...rankedCandidates
            .filter((reference) => reference.kind === 'character')
            .slice(0, capability.maxImages),
          ...rankedCandidates
            .filter((reference) => reference.kind !== 'character')
            .slice(0, Math.max(0, capability.maxImages - requiredCharacterRefs.length)),
        ]
      : selectUntypedAuthoritativeReferences(rankedCandidates);
  if (compositionReferences.some((reference) => !sentCandidates.includes(reference))) {
    throw new Error('The explicit 3D composition could not be included in this image request');
  }
  const omitted = capability.supportsReferenceRoles === true
    ? rankedCandidates.slice(sentCandidates.length)
    : rankedCandidates.filter((reference) => !sentCandidates.includes(reference));
  for (const reference of omitted) {
    reference.omittedReason = capability.supportsReferenceRoles === true
      ? 'model reference limit'
      : 'provider does not preserve semantic reference roles; one authoritative image was selected';
  }

  const sent: CollectedRef[] = [];
  const payloads: string[] = [];
  for (const reference of sentCandidates) {
    let dataUri = await readAsDataUri(reference.url);
    if (reference.cropMiddleThird) {
      dataUri = await cropMiddleThird(dataUri).catch((err) => {
        console.warn('keyframe: front crop failed; using full reference', err);
        return dataUri;
      });
    }
    if (!isUsableImagePayload(dataUri)) {
      const reason = 'image payload could not be read';
      if (isPrevisReference(reference)) throw new Error(`The 3D composition reference ${reason}`);
      if (reference.characterId && requireCharacterReferences) {
        throw new Error(`Reference image for character ${reference.characterId} ${reason}`);
      }
      reference.omittedReason = reason;
      continue;
    }
    sent.push(reference);
    payloads.push(dataUri);
  }

  return {
    candidates,
    sent,
    payloads,
    transport: capability.supportsReferenceRoles === true ? 'direct' : 'direct_untyped',
  };
}

/**
 * An untyped image endpoint has no semantic role guarantee. For one subject,
 * prefer the strongest identity reference; for a shot without subjects, use
 * continuity/custom/environment material as a single authoritative source.
 * Multi-subject selection is handled by prepareReferencePayloads so required
 * identities are never silently dropped.
 */
function selectUntypedAuthoritativeReferences(candidates: CollectedRef[]): CollectedRef[] {
  const composition = candidates.filter(isPrevisReference);
  const character = candidates.find((reference) => reference.kind === 'character');
  if (character) return [character, ...composition];
  const continuity = candidates.find((reference) => reference.kind === 'previous');
  if (continuity) return [continuity, ...composition];
  const custom = candidates.find((reference) => reference.kind === 'custom');
  if (custom) return [custom];
  const opening = candidates.find((reference) => reference.kind === 'opening');
  if (opening) return [opening];
  return candidates.length > 0 ? [candidates[0]] : [];
}

function buildGenerationReferenceInputs(
  shotId: string,
  prepared: PreparedReferences,
): GenerationReferenceInput[] {
  return prepared.sent.flatMap((reference, index) => {
    const image = prepared.payloads[index];
    if (!image) return [];
    return [{
      id: `${shotId}:reference:${index + 1}`,
      role: referenceRole(reference.kind),
      image,
      label: reference.label,
      subjectId: reference.characterId,
      subjectIds: reference.subjectIds,
    }];
  });
}

function referenceRole(kind: ShotReferenceAsset['kind']): GenerationReferenceInput['role'] {
  switch (kind) {
    case 'character': return 'subject';
    case 'scene': return 'environment';
    case 'previous': return 'continuity';
    case 'opening': return 'opening';
    case 'keyframe': return 'first_frame';
    case 'custom': return 'custom';
  }
}

function buildReferenceAssets(
  shotId: string,
  candidates: CollectedRef[],
  prepared: PreparedReferences,
): ShotReferenceAsset[] {
  return candidates.map((reference, index) => {
    const sentIndex = prepared.sent.indexOf(reference);
    const providerIndex = sentIndex;
    const omittedReason = reference.omittedReason;
    return {
      id: `${shotId}_reference_${index + 1}`,
      kind: reference.kind,
      label: reference.label,
      imageUrl: reference.url,
      characterId: reference.characterId,
      sentToProvider: sentIndex >= 0,
      providerIndex: providerIndex >= 0 ? providerIndex : undefined,
      transport: sentIndex >= 0 ? prepared.transport : undefined,
      subjectIds: reference.subjectIds,
      omittedReason: sentIndex >= 0 ? undefined : (omittedReason || 'not selected for provider request'),
      payloadFingerprint: sentIndex >= 0
        ? fingerprintPayload(prepared.payloads[sentIndex])
        : undefined,
    };
  });
}

function assertReferencePayloads(
  shot: ShotSpec,
  presentCharacters: CharacterAnchor[],
  prepared: PreparedReferences,
): void {
  const expectedIds = new Set(presentCharacters.map((character) => character.id));
  const actualIds = new Set(
    prepared.sent.flatMap((reference) => reference.kind === 'character'
      ? (reference.characterId ? [reference.characterId] : [])
      : (reference.subjectIds ?? [])),
  );
  const missingIds = [...expectedIds].filter((id) => !actualIds.has(id));
  if (missingIds.length > 0) {
    const missingNames = presentCharacters
      .filter((character) => missingIds.includes(character.id))
      .map((character) => character.name);
    throw new Error(
      `Shot ${shot.index + 1} has incomplete character references: expected ${presentCharacters.length}, `
        + `received ${prepared.sent.length}${missingNames.length ? `; missing ${missingNames.join(', ')}` : ''}`,
    );
  }
  const expectedPayloads = prepared.sent.length;
  if (expectedPayloads !== prepared.payloads.length) {
    throw new Error(
      `Shot ${shot.index + 1} reference payload count mismatch: expected ${expectedPayloads}, received ${prepared.payloads.length}`,
    );
  }
  if (prepared.payloads.some((image) => !isUsableImagePayload(image))) {
    throw new Error(`Shot ${shot.index + 1} contains an unreadable local reference payload`);
  }
}

function assertCharacterReferences(shots: ShotSpec[], characters: CharacterAnchor[]): void {
  for (const shot of shots) {
    const declaredRefs = (Array.isArray(shot.visibleCharacterIds)
      ? shot.visibleCharacterIds
      : shot.characterIds || [])
      .map((reference) => reference.trim())
      .filter(Boolean);
    const presentCharacters = findMatchingCharacters(shot, characters);
    const matchedRefs = new Set<string>();
    for (const character of presentCharacters) {
      matchedRefs.add(normalizeReference(character.id));
      matchedRefs.add(normalizeReference(character.name));
      for (const alias of character.aliases || []) matchedRefs.add(normalizeReference(alias));
    }
    const unresolved = declaredRefs.filter((reference) => !matchedRefs.has(normalizeReference(reference)));
    const missingImages = presentCharacters.filter((character) => {
      const variantId = shot.costumeVariantRefs?.[character.id] || shot.costumeVariantRefs?.[character.name];
      const variant = variantId
        ? character.costumeVariants?.find((item) => item.id === variantId)
        : undefined;
      return !variant?.portraitImage && !character.portraitImage && !hasCurrentTurnaround(character);
    }).map((character) => character.name);
    const missing = [...unresolved, ...missingImages];
    if (missing.length > 0) {
      throw new Error(`Shot ${shot.index + 1} is missing character references: ${Array.from(new Set(missing)).join(', ')}`);
    }
  }
}

function normalizeReference(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s._-]/g, '');
}

/** Describe the semantic mapping between declared references and provider payloads. */
function buildReferenceBindingText(
  references: CollectedRef[],
  transport: ShotReferenceTransport,
): string {
  if (!references.length) return '';
  const subjectOrdinals = new Map<string, number>();
  for (const reference of references) {
    const ids = reference.characterId ? [reference.characterId] : reference.subjectIds ?? [];
    for (const id of ids) {
      if (!subjectOrdinals.has(id)) subjectOrdinals.set(id, subjectOrdinals.size + 1);
    }
  }
  const tileLines = references.map((reference, index) => {
    const subjectOrdinal = (reference.characterId
      ? [reference.characterId]
      : reference.subjectIds ?? [])
      .map((id) => subjectOrdinals.get(id))
      .filter((ordinal): ordinal is number => ordinal !== undefined)
      .map((ordinal) => `S${ordinal}`)
      .join(',');
    const binding = subjectOrdinal ? ` -> ${subjectOrdinal}` : '';
    return `slot ${index + 1}: ${reference.kind}/${reference.characterId ?? reference.label}${binding}`;
  });
  if (transport === 'direct_untyped') {
    return [
      '[Unbound reference inputs]',
      'The provider receives these images in order, but this model does not guarantee semantic role binding. Preserve every required visible subject as a distinct entity; do not merge, duplicate, or transfer identities between visible subjects.',
      ...tileLines.map((line) => line.replace(/^slot/, 'input')),
      'For a multi-subject shot, the required subject inputs are sent together and unrelated environment inputs may be omitted to protect subject identity.',
    ].join('\n');
  }
  return [
    '[Reference slots]',
    ...tileLines,
    'Use each character slot only for that subject. Never transfer a character slot\'s clothing, colors, accessories, face, hair, or body traits to another subject.',
  ].join('\n');
}

function buildKeyframeInput(
  shot: ShotSpec,
  visibleCharacters: CharacterAnchor[],
  references: CollectedRef[],
  transport: ShotReferenceTransport,
  continuityReferenceAuthoritative = false,
): string {
  const hasCharacterReference = references.some((reference) => reference.kind === 'character');
  const stillPrompt = shot.imagePrompt?.trim() || shot.startState?.trim() || shot.sourceText?.trim();
  if (!stillPrompt) {
    throw new Error(`Shot ${shot.index + 1} has no dedicated keyframe prompt or still-state source`);
  }
  return [
    // A keyframe is a still-state input. Legacy shots may not have imagePrompt;
    // sourceText is a safer static fallback than a motion timeline.
    stillPrompt,
    shot.startState?.trim() ? `[First-frame state] ${shot.startState.trim()}` : '',
    '[Shot composition scope] Treat the shot description as composition, pose, action, camera, lighting, and environment guidance. It is not authoritative for a subject\'s identity or wardrobe.',
    buildExactSubjectConstraint(visibleCharacters),
    buildReferenceBindingText(references, transport),
    references.some(isPrevisReference)
      ? '[3D previs authority] The input labeled 3D previs defines camera, framing, screen positions, scale, occlusion, and pose only. Replace its mannequins with the bound character identities and wardrobe. Do not copy mannequin materials, marker letters, grid lines, or editor overlays into the final image.'
      : '',
    continuityReferenceAuthoritative
      ? '[Continuity authority] The supplied rendered tail is the authoritative visual state for this shot. Preserve the same visible subjects and identity while adapting only the requested composition, pose, action, or camera change. Do not introduce a second copy of any subject from an older portrait or reference.'
      : '',
    buildMultiCharacterDnaTokens(visibleCharacters, shot.costumeVariantRefs, {
      referenceBound: hasCharacterReference,
    }),
    buildOffscreenBindingText(shot),
    '[Subject authority] Bound subject records and their assigned reference tiles are authoritative. If the shot description or a negative constraint conflicts with a bound subject record, preserve the bound record.',
  ].filter(Boolean).join('\n\n');
}

function mergeNegativePrompts(plannedPrompt?: string): string | undefined {
  const parts = [plannedPrompt?.trim(), buildSubjectExclusionPrompt()].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function isUsableImagePayload(value: string): boolean {
  return /^data:image\/[\w.+-]+;base64,/i.test(value)
    || (/^https?:\/\//i.test(value) && !/^https?:\/\/asset\.localhost\//i.test(value))
    || /^[A-Za-z0-9+/\s]+=*$/.test(value);
}

function aspectRatioToDims(ar: AspectRatio): { w: number; h: number } {
  switch (ar) {
    case '16:9': return { w: 1280, h: 720 };
    case '9:16': return { w: 720, h: 1280 };
    case '1:1': return { w: 1024, h: 1024 };
  }
}

async function cropMiddleThird(dataUri: string): Promise<string> {
  const image = await loadImage(dataUri);
  const width = Math.floor(image.width / 3);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas 2d context unavailable');
  context.drawImage(image, width, 0, width, image.height, 0, 0, width, image.height);
  return canvas.toDataURL('image/png');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('reference image could not be loaded'));
    image.src = src;
  });
}

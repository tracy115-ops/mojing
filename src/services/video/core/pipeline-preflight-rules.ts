import type {
  LLMGenerationCapabilities,
  ImageGenerationCapabilities,
  VideoGenerationCapabilities,
} from '../../../types/providers.ts';
import type {
  DirectSourceMode,
  PipelineOptions,
  SceneSpec,
  VideoStage,
} from '../../../types/video.ts';
import { filterGenerationParameters } from '../../providers/provider-capabilities.ts';
import { resolveVideoQualityPolicy } from './quality-policy.ts';
import { getSubjectContinuityShot } from './shot-continuity.ts';

export type ProviderPreflightCategory = 'llm' | 'image' | 'video' | 'tts';

export type ProviderPreflightIssueCode =
  | 'missing-endpoint'
  | 'adapter-unavailable'
  | 'invalid-model'
  | 'i2v-first-frame-unsupported'
  | 'reference-unsupported'
  | 'multi-subject-reference-unsupported'
  | 'reference-mode-unavailable'
  | 'planner-parameter-unsupported'
  | 'visual-review-unavailable';

export interface PipelinePreflightIssue {
  code: ProviderPreflightIssueCode;
  category: ProviderPreflightCategory;
  provider?: string;
  model?: string;
  endpointId?: string;
  endpointName?: string;
  shotId?: string;
  detail?: string;
}

export interface PipelineProviderSnapshot {
  category: ProviderPreflightCategory;
  endpointId?: string;
  endpointName?: string;
  provider?: string;
  model?: string;
  adapterAvailable?: boolean;
  imageCapabilities?: ImageGenerationCapabilities;
  videoCapabilities?: VideoGenerationCapabilities;
  llmCapabilities?: LLMGenerationCapabilities;
  error?: {
    code: 'invalid-model' | 'missing-endpoint';
    detail?: string;
  };
}

export interface PipelinePreflightRulesInput {
  channel: 'novel' | 'direct';
  sourceMode?: DirectSourceMode;
  options: PipelineOptions;
  startStage?: VideoStage;
  endStage?: VideoStage;
  /** True when the caller is about to run the text planning stages. */
  planningRequired?: boolean;
  sceneSpec?: Pick<SceneSpec, 'characters' | 'scenes' | 'shots'>;
  /** Set explicitly when the scene spec has not been built yet. */
  hasCharacterReferences?: boolean;
  /** Set false only when the caller has proven that no speech will be rendered. */
  hasSpeech?: boolean;
  providers: Partial<Record<ProviderPreflightCategory, PipelineProviderSnapshot>>;
}

export interface PipelinePreflightResult {
  ok: boolean;
  requiredCategories: ProviderPreflightCategory[];
  providers: Partial<Record<ProviderPreflightCategory, PipelineProviderSnapshot>>;
  blocking: PipelinePreflightIssue[];
  warnings: PipelinePreflightIssue[];
}

const RUNTIME_STAGES: VideoStage[] = [
  'script_slicing',
  'storyboard_prompt',
  'extraction',
  'character_anchor',
  'scene_image',
  'keyframe_image',
  'voice_assignment',
  'tts',
  'video_generation',
  'video_review',
  'audio_merge',
  'composing',
];

export function getPipelineRequiredCategories(
  input: Pick<PipelinePreflightRulesInput, 'channel' | 'sourceMode' | 'options' | 'startStage' | 'endStage' | 'planningRequired' | 'sceneSpec' | 'hasCharacterReferences' | 'hasSpeech'>,
): ProviderPreflightCategory[] {
  const startIndex = stageIndex(input.startStage);
  const endIndex = input.endStage ? stageIndex(input.endStage) : RUNTIME_STAGES.length - 1;
  const includes = (stage: VideoStage): boolean => {
    const targetIndex = RUNTIME_STAGES.indexOf(stage);
    return targetIndex >= startIndex && targetIndex <= endIndex;
  };
  const categories = new Set<ProviderPreflightCategory>();
  const planningRequired = input.planningRequired
    ?? (input.channel === 'novel' && startIndex <= RUNTIME_STAGES.indexOf('extraction'));

  if (planningRequired) categories.add('llm');

  const hasCharacters = input.hasCharacterReferences
    ?? (input.sceneSpec?.characters?.length ?? 0) > 0;
  const hasScenes = (input.sceneSpec?.scenes?.length ?? 0) > 0;
  const hasSpeech = input.hasSpeech
    ?? (input.sceneSpec?.shots ?? []).some(shotHasSpeech);

  if (includes('character_anchor') && input.options.enableCharacterAnchor && hasCharacters) {
    categories.add('image');
  }
  if (includes('scene_image') && input.options.enableSceneImage && hasScenes) {
    categories.add('image');
  }
  if (includes('keyframe_image') && input.options.enableKeyframe) {
    categories.add('image');
  }
  if (includes('tts') && input.options.enableTTS && hasSpeech) {
    categories.add('tts');
  }
  if (includes('video_generation')) categories.add('video');
  if (includes('video_review') && resolveVideoQualityPolicy(input.options).visualReviewRequired) {
    categories.add('llm');
  }

  return [...categories];
}

/** Pure capability and binding checks used by every video entry point. */
export function evaluatePipelinePreflight(input: PipelinePreflightRulesInput): PipelinePreflightResult {
  const requiredCategories = getPipelineRequiredCategories(input);
  const blocking: PipelinePreflightIssue[] = [];
  const warnings: PipelinePreflightIssue[] = [];

  for (const category of requiredCategories) {
    const provider = input.providers[category];
    if (!provider || provider.error?.code === 'missing-endpoint') {
      blocking.push({
        code: 'missing-endpoint',
        category,
        endpointId: provider?.endpointId,
        endpointName: provider?.endpointName,
        detail: provider?.error?.detail,
      });
      continue;
    }
    if (provider.error?.code === 'invalid-model') {
      blocking.push({
        code: 'invalid-model',
        category,
        provider: provider.provider,
        model: provider.model,
        endpointId: provider.endpointId,
        endpointName: provider.endpointName,
        detail: provider.error.detail,
      });
      continue;
    }
    if (provider.adapterAvailable === false) {
      blocking.push({
        code: 'adapter-unavailable',
        category,
        provider: provider.provider,
        model: provider.model,
        endpointId: provider.endpointId,
        endpointName: provider.endpointName,
      });
    }
  }

  const image = input.providers.image?.imageCapabilities;
  const video = input.providers.video?.videoCapabilities;
  const reviewLLM = input.providers.llm?.llmCapabilities;
  const characterRefsExpected = input.hasCharacterReferences
    ?? (input.sceneSpec?.characters?.length ?? 0) > 0;
  const keyframeWillRun = requiredCategories.includes('image')
    && stageIndex(input.startStage) <= RUNTIME_STAGES.indexOf('keyframe_image')
    && (!input.endStage || stageIndex(input.endStage) >= RUNTIME_STAGES.indexOf('keyframe_image'))
    && input.options.enableKeyframe;

  if (keyframeWillRun && characterRefsExpected && image && image.references.supported === false) {
    blocking.push({
      code: 'reference-unsupported',
      category: 'image',
      provider: image.provider,
      model: image.model,
      endpointId: image.endpointId,
      detail: 'character-reference',
    });
  }

  if (keyframeWillRun && image && image.references.supported && input.sceneSpec) {
    for (const shot of input.sceneSpec.shots) {
      const visibleSubjectIds = new Set([
        ...(shot.visibleCharacterIds ?? shot.characterIds ?? []),
      ].map((reference) => reference.trim()).filter(Boolean));
      if (visibleSubjectIds.size <= 1 || shot.manualReferenceImage) continue;
      const hasCompleteContinuityReference = !!getSubjectContinuityShot(input.sceneSpec.shots, shot)?.keyframeImage;
      const lacksSemanticSlots = image.references.supportsReferenceRoles !== true;
      const lacksCapacity = image.references.maxImages < visibleSubjectIds.size;
      if ((lacksSemanticSlots || lacksCapacity) && !hasCompleteContinuityReference) {
        blocking.push({
          code: 'multi-subject-reference-unsupported',
          category: 'image',
          provider: image.provider,
          model: image.model,
          endpointId: image.endpointId,
          shotId: shot.id,
          detail: lacksSemanticSlots ? 'semantic-subject-slots' : 'reference-capacity',
        });
      }
    }
  }

  if (keyframeWillRun && image) {
    for (const shot of input.sceneSpec?.shots ?? []) {
      const rejected = filterGenerationParameters(shot.imageParameters, image).rejectedKeys;
      if (rejected.length === 0) continue;
      blocking.push({
        code: 'planner-parameter-unsupported',
        category: 'image',
        provider: image.provider,
        model: image.model,
        endpointId: image.endpointId,
        shotId: shot.id,
        detail: `imageParameters: ${rejected.join(', ')}`,
      });
    }
  }

  if (requiredCategories.includes('video') && video) {
    for (const shot of input.sceneSpec?.shots ?? []) {
      const rejected = filterGenerationParameters(shot.videoParameters, video).rejectedKeys;
      if (rejected.length === 0) continue;
      blocking.push({
        code: 'planner-parameter-unsupported',
        category: 'video',
        provider: video.provider,
        model: video.model,
        endpointId: video.endpointId,
        shotId: shot.id,
        detail: `videoParameters: ${rejected.join(', ')}`,
      });
    }
  }

  if (requiredCategories.includes('video') && video && input.options.enableI2V) {
    if (input.options.enableKeyframe && !video.references.supportsFirstFrame) {
      blocking.push({
        code: 'i2v-first-frame-unsupported',
        category: 'video',
        provider: video.provider,
        model: video.model,
        endpointId: video.endpointId,
      });
    } else if (!input.options.enableKeyframe && !video.references.supportsSubjectReferences) {
      blocking.push({
        code: 'reference-mode-unavailable',
        category: 'video',
        provider: video.provider,
        model: video.model,
        endpointId: video.endpointId,
      });
    }
  }

  if (requiredCategories.includes('video') && video && !input.options.enableI2V && video.references.supported) {
    warnings.push({
      code: 'reference-mode-unavailable',
      category: 'video',
      provider: video.provider,
      model: video.model,
      endpointId: video.endpointId,
      detail: 't2v-selected',
    });
  }

  if (requiredCategories.includes('llm')
    && (!input.endStage || stageIndex(input.endStage) >= RUNTIME_STAGES.indexOf('video_review'))
    && resolveVideoQualityPolicy(input.options).visualReviewRequired
    && (reviewLLM !== undefined && (!reviewLLM.supportsImageInputs || reviewLLM.maxImageInputs <= 0))) {
    blocking.push({
      code: 'visual-review-unavailable',
      category: 'llm',
      provider: reviewLLM?.provider,
      model: reviewLLM?.model,
      endpointId: reviewLLM?.endpointId,
      detail: 'quality profile requires a vision-capable review model',
    });
  }

  return {
    ok: blocking.length === 0,
    requiredCategories,
    providers: input.providers,
    blocking,
    warnings,
  };
}

function stageIndex(stage: VideoStage | undefined): number {
  if (!stage) return 0;
  const index = RUNTIME_STAGES.indexOf(stage);
  return index >= 0 ? index : 0;
}

function shotHasSpeech(shot: NonNullable<SceneSpec['shots']>[number]): boolean {
  return !!(
    shot.dialogue?.some((dialogue) => !!dialogue.text?.trim())
    || shot.narration?.trim()
    || shot.sourceText?.trim()
    || shot.videoPrompt?.trim()
  );
}

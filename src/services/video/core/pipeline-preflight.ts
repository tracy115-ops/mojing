import type {
  ApiEndpoint,
  ImageTaskType,
  LLMTaskType,
  VideoTaskType,
} from '@/types/providers';
import type {
  DirectSourceMode,
  PipelineOptions,
  SceneSpec,
  VideoStage,
} from '@/types/video';
import { providerRouter } from '@/services/providers';
import {
  getEndpointCategory,
  useProviderStore,
  type ProviderCategory,
} from '@/stores/providerStore';
import {
  evaluatePipelinePreflight,
  type PipelinePreflightResult,
  type PipelinePreflightRulesInput,
  type PipelineProviderSnapshot,
  type ProviderPreflightCategory,
} from './pipeline-preflight-rules';

export interface VideoPipelinePreflightInput {
  channel: 'novel' | 'direct';
  sourceMode?: DirectSourceMode;
  options: PipelineOptions;
  startStage?: VideoStage;
  planningRequired?: boolean;
  sceneSpec?: Pick<SceneSpec, 'characters' | 'scenes' | 'shots'>;
  hasCharacterReferences?: boolean;
  hasSpeech?: boolean;
  imageEndpointId?: string;
  imageModel?: string;
  videoEndpointId?: string;
  videoModel?: string;
  llmEndpointId?: string;
  llmModel?: string;
  ttsEndpointId?: string;
  ttsModel?: string;
}

export function collectVideoPipelinePreflight(
  input: VideoPipelinePreflightInput,
): PipelinePreflightResult {
  const providerStore = useProviderStore.getState();
  const requiredCategories = getRequiredCategories(input);
  const providers: Partial<Record<ProviderPreflightCategory, PipelineProviderSnapshot>> = {};

  for (const category of requiredCategories) {
    const endpointId = endpointIdFor(input, category);
    const endpoint = endpointId
      ? resolveEndpoint(providerStore.endpoints, category, endpointId)
      : providerStore.getActiveEndpoint(category);
    if (!endpoint) {
      providers[category] = {
        category,
        endpointId,
        error: {
          code: 'missing-endpoint',
          detail: endpointId
            ? `Configured ${category} endpoint "${endpointId}" is missing, disabled, or belongs to another category.`
            : `No enabled ${category} endpoint is configured.`,
        },
      };
      continue;
    }

    const snapshot: PipelineProviderSnapshot = {
      category,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      provider: String(endpoint.provider),
      model: modelFor(input, category, endpoint),
    };

    try {
      if (category === 'image') {
        const capabilities = providerRouter.getImageCapabilities(
          'storyboard' as ImageTaskType,
          input.imageModel,
          endpoint.id,
        );
        snapshot.model = capabilities.model;
        snapshot.adapterAvailable = capabilities.adapterAvailable;
        snapshot.imageCapabilities = capabilities;
      } else if (category === 'video') {
        const capabilities = providerRouter.getVideoCapabilities(
          'clip' as VideoTaskType,
          input.videoModel,
          endpoint.id,
        );
        snapshot.model = capabilities.model;
        snapshot.adapterAvailable = capabilities.adapterAvailable;
        snapshot.videoCapabilities = capabilities;
      } else if (category === 'llm') {
        snapshot.model = resolveLLMModel(input.llmModel, providerStore.config.llm, endpoint);
        snapshot.llmCapabilities = providerRouter.getLLMCapabilities('review', snapshot.model, endpoint.id);
      } else if (category === 'tts') {
        snapshot.model = input.ttsModel?.trim()
          || endpoint.models?.[0]
          || providerStore.config.tts?.defaultModel
          || 'provider-default';
      }
    } catch (error) {
      snapshot.error = {
        code: 'invalid-model',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    providers[category] = snapshot;
  }

  const rulesInput: PipelinePreflightRulesInput = {
    channel: input.channel,
    sourceMode: input.sourceMode,
    options: input.options,
    startStage: input.startStage,
    planningRequired: input.planningRequired,
    sceneSpec: input.sceneSpec,
    hasCharacterReferences: input.hasCharacterReferences,
    hasSpeech: input.hasSpeech,
    providers,
  };
  return evaluatePipelinePreflight(rulesInput);
}

function getRequiredCategories(input: VideoPipelinePreflightInput): ProviderPreflightCategory[] {
  return evaluatePipelinePreflight({
    channel: input.channel,
    sourceMode: input.sourceMode,
    options: input.options,
    startStage: input.startStage,
    planningRequired: input.planningRequired,
    sceneSpec: input.sceneSpec,
    hasCharacterReferences: input.hasCharacterReferences,
    hasSpeech: input.hasSpeech,
    providers: {},
  }).requiredCategories;
}

function endpointIdFor(input: VideoPipelinePreflightInput, category: ProviderCategory): string | undefined {
  if (category === 'image') return input.imageEndpointId;
  if (category === 'video') return input.videoEndpointId;
  if (category === 'llm') return input.llmEndpointId;
  return input.ttsEndpointId;
}

function resolveEndpoint(
  endpoints: ApiEndpoint[],
  category: ProviderCategory,
  endpointId?: string,
): ApiEndpoint | undefined {
  if (endpointId) {
    const endpoint = endpoints.find((candidate) => candidate.id === endpointId);
    return endpoint?.enabled && getEndpointCategory(endpoint) === category ? endpoint : undefined;
  }
  return endpoints.find((endpoint) => endpoint.enabled && getEndpointCategory(endpoint) === category);
}

function modelFor(
  input: VideoPipelinePreflightInput,
  category: 'image' | 'video' | 'llm' | 'tts',
  endpoint: ApiEndpoint,
): string {
  if (category === 'image') return input.imageModel?.trim() || endpoint.models?.[0] || 'provider-default';
  if (category === 'video') return input.videoModel?.trim() || endpoint.models?.[0] || 'provider-default';
  if (category === 'llm') return input.llmModel?.trim() || endpoint.models?.[0] || 'provider-default';
  return input.ttsModel?.trim() || endpoint.models?.[0] || 'provider-default';
}

function resolveLLMModel(
  requestedModel: string | undefined,
  config: { models: Partial<Record<LLMTaskType, string>>; defaultModel: string },
  endpoint: ApiEndpoint,
): string {
  const configured = requestedModel?.trim()
    || config.models.planning?.trim()
    || config.defaultModel?.trim();
  if (configured && endpoint.models?.length && !endpoint.models.includes(configured)) {
    throw new Error(
      `Requested llm model "${configured}" is not advertised by endpoint ${endpoint.id}. Available models: ${endpoint.models.join(', ')}`,
    );
  }
  return configured || endpoint.models?.[0] || 'provider-default';
}

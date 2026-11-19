// Model-facing image prompt planning. The application supplies facts and the
// active provider contract; the text model decides how to phrase the request.

import { providerRouter } from '@/services/providers';
import { formatCapabilitiesForPrompt } from '@/services/providers/provider-capabilities';
import type { ImageGenerationCapabilities, VideoGenerationCapabilities } from '@/types/providers';
import type { CharacterAnchor, SceneAnchor, ShotSpec } from '@/types/video';
import { parseLLMJson } from '@/services/novel/llm-json';
import { useSettingsStore } from '@/stores/settingsStore';
import { SHOT_DIRECTION_PLANNING_RULE } from './shot-motion-prompt';

export type ImagePromptPurpose =
  | 'character_portrait'
  | 'character_turnaround'
  | 'scene_background';

export interface ImagePromptPlan {
  prompt: string;
  negativePrompt?: string;
  parameters?: Record<string, unknown>;
}

export interface ImagePromptPlannerInput {
  purpose: ImagePromptPurpose;
  character?: CharacterAnchor;
  scene?: SceneAnchor;
  costumeOverride?: string;
  style?: string;
  requestedAspectRatio?: string;
  referenceCount?: number;
  promptOverride?: string;
  /** Entity references that must not appear in an environment-only image. */
  excludedEntities?: string[];
  /** Pin the same endpoint/model that will execute the planned request. */
  endpointId?: string;
  model?: string;
}

/**
 * Kept as a compatibility helper for the comic pipeline. It intentionally
 * does not translate or expand style names.
 */
export function getStyleNameZh(style?: string): string {
  return style?.trim() || '';
}

export async function planImagePrompt(input: ImagePromptPlannerInput, signal?: AbortSignal): Promise<ImagePromptPlan> {
  const capability = providerRouter.getImageCapabilities(
    input.purpose === 'scene_background' ? 'scene' : 'character',
    input.model,
    input.endpointId,
  );
  const configuredInstruction = getConfiguredInstruction(input.purpose);
  const systemPrompt = buildSystemPrompt(
    capability,
    configuredInstruction,
    input.purpose,
    (input.referenceCount ?? 0) > 0,
  );
  const userPrompt = buildUserPrompt(input);
  const request = {
    taskType: 'prompt_optimization' as const,
    systemPrompt,
    userPrompt,
    responseFormat: 'json' as const,
    temperature: 0.3,
    maxTokens: 700,
  };

  try {
    const response = await providerRouter.generate(request, signal);
    let plan = parsePlan(response.content);
    if (!plan) {
      const repaired = await providerRouter.generate({
        ...request,
        userPrompt: `${userPrompt}\n\nThe previous response was not valid JSON. Return only one JSON object matching the schema; do not use Markdown or explanation.`,
        temperature: 0.1,
      }, signal);
      plan = parsePlan(repaired.content);
    }
    if (plan) {
      return input.purpose === 'scene_background'
        ? sanitizeScenePlan(plan, input)
        : plan;
    }
    throw new Error('Image prompt planner returned no usable JSON plan');
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`image prompt planning failed for ${input.purpose}; using source facts`, err);
    return fallbackPlan(input);
  }
}

export interface VideoPromptPlannerInput {
  shot: Partial<Pick<
    ShotSpec,
    | 'sourceText'
    | 'videoPrompt'
    | 'location'
    | 'mood'
    | 'cameraMovement'
    | 'startState'
    | 'endState'
    | 'narration'
    | 'dialogue'
    | 'visibleCharacterIds'
    | 'offscreenCharacterIds'
  >>;
  style?: string;
  requestedAspectRatio?: string;
  durationSeconds?: number;
  /** Pin the same endpoint/model that will execute the planned request. */
  endpointId?: string;
  model?: string;
}

/** Plan a motion prompt from shot facts and the active video capability contract. */
export async function planVideoPrompt(input: VideoPromptPlannerInput): Promise<ImagePromptPlan> {
  const capability = providerRouter.getVideoCapabilities('clip', input.model, input.endpointId);
  const systemPrompt = buildVideoSystemPrompt(capability);
  const userPrompt = JSON.stringify({
    style: input.style,
    requestedAspectRatio: input.requestedAspectRatio,
    durationSeconds: input.durationSeconds,
    shot: input.shot,
  }, null, 2);

  try {
    const response = await providerRouter.generate({
      taskType: 'prompt_optimization',
      systemPrompt,
      userPrompt,
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 700,
    });
    const plan = parsePlan(response.content);
    if (plan) return plan;
    throw new Error('Video prompt planner returned no usable JSON plan');
  } catch (err) {
    console.warn('video prompt planning failed; preserving shot facts', err);
    return {
      prompt: input.shot.videoPrompt?.trim() || input.shot.sourceText?.trim() || '',
    };
  }
}

/** Existing callers can use this string-only facade while retaining planner output. */
export async function enrichCharacterPromptWithLLM(
  character: CharacterAnchor,
  style?: string,
  costumeOverride?: string,
): Promise<string> {
  const plan = await planImagePrompt({
    purpose: 'character_portrait',
    character,
    style,
    costumeOverride,
    requestedAspectRatio: '2:3',
  });
  return plan.prompt;
}

/** Existing callers can use this string-only facade while retaining planner output. */
export async function enrichScenePromptWithLLM(
  scene: SceneAnchor,
  style?: string,
): Promise<string> {
  const plan = await planImagePrompt({
    purpose: 'scene_background',
    scene,
    style,
  });
  return plan.prompt;
}

function buildSystemPrompt(
  capability: ImageGenerationCapabilities,
  configuredInstruction?: string,
  purpose?: ImagePromptPurpose,
  hasReference = false,
): string {
  const characterReferenceContract = purpose !== 'scene_background' && hasReference
    ? [
        'A supplied reference image is the authoritative visual source for the entity. Preserve its face, hair, body or form, clothing, colors, and accessories; do not redesign or reinterpret them.',
        'For a character turnaround, keep one identical entity and one identical outfit across the front, side, and back views. Show a clean full-body reference sheet on a neutral background with no additional entities or scene storytelling.',
        'Treat style as rendering, lighting, and finish guidance only. Do not let style change the entity design or wardrobe unless that change is explicitly present in the supplied appearance or costume override.',
      ].join('\n')
    : '';
  return [
    'You are a provider-aware image prompt planner.',
    'Return only one JSON object with prompt, optional negativePrompt, and optional parameters.',
    'Use only facts supplied in the input. Preserve names, appearance, entities, clothing, setting, and requested style without inventing identity details.',
    'Use the source language naturally; do not translate merely to satisfy a language rule.',
    'The prompt must describe the requested visual output for the selected purpose.',
    'For a character portrait, keep the requested entity as one coherent subject. For a turnaround, describe one entity across the requested views. For a scene background, keep the frame focused on the supplied environment and do not render story subjects or other entities listed as excluded.',
    characterReferenceContract,
    purpose === 'scene_background'
      ? 'For a scene background, excludedEntities are control data rather than scene content. Never repeat them in the generated prompt, and do not infer people, animals, or other story subjects from the scene description.'
      : '',
    'Only emit parameter keys listed in the provider capability contract. Omit optional parameters that are not justified by the supplied input. Never put image data, file paths, or reference-slot guesses in parameters.',
    'If selecting a model, set parameters.model to an advertised available model only.',
    configuredInstruction ? `[User-configured instruction]\n${configuredInstruction}` : '',
    '[Image Provider Capability Contract]',
    formatCapabilitiesForPrompt(capability),
    '[JSON shape]',
    '{ "prompt": "...", "negativePrompt": "...", "parameters": { "key": "value" } }',
  ].filter(Boolean).join('\n\n');
}

function buildVideoSystemPrompt(capability: VideoGenerationCapabilities): string {
  return [
    'You are a provider-aware video prompt planner.',
    SHOT_DIRECTION_PLANNING_RULE,
    'Return only one JSON object with prompt, optional negativePrompt, and optional parameters.',
    'Use only facts supplied in the input. Preserve entities, setting, action, dialogue, and state transitions without inventing story content.',
    'Describe motion and camera behavior only when supported by the supplied facts. Keep the shot physically coherent from first state to last state.',
    'Only emit parameter keys listed in the video provider capability contract. Omit optional parameters that are not justified by the input.',
    'Never put image data, file paths, or reference-slot guesses in parameters. Reference binding is handled by the execution stage.',
    'If selecting a model, set parameters.model to an advertised available model only.',
    '[Video Provider Capability Contract]',
    formatCapabilitiesForPrompt(capability),
    '[JSON shape]',
    '{ "prompt": "...", "negativePrompt": "...", "parameters": { "key": "value" } }',
  ].join('\n\n');
}

function buildUserPrompt(input: ImagePromptPlannerInput): string {
  const source = input.character
    ? {
        name: input.character.name,
        appearance: input.character.appearance,
        entityType: input.character.entityType,
        gender: input.character.gender,
        ageGroup: input.character.ageGroup,
        aliases: input.character.aliases,
        costumeOverride: input.costumeOverride,
      }
    : {
        name: input.scene?.name,
        description: input.scene?.description,
      };
  return JSON.stringify({
    purpose: input.purpose,
    requestedAspectRatio: input.requestedAspectRatio,
    referenceCount: input.referenceCount ?? 0,
    style: input.style,
    promptOverride: input.promptOverride,
    excludedEntities: input.excludedEntities,
    source,
  }, null, 2);
}

function parsePlan(content: string): ImagePromptPlan | undefined {
  let parsed = parseLLMJson<unknown>(content);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of ['plan', 'result', 'output', 'data']) {
      if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) {
        parsed = record[key];
        break;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const prompt = stringValue(record.prompt);
  if (!prompt) return undefined;
  return {
    prompt,
    negativePrompt: stringValue(record.negativePrompt),
    parameters: parameterObject(record.parameters),
  };
}

function fallbackPlan(input: ImagePromptPlannerInput): ImagePromptPlan {
  if (input.purpose === 'scene_background') {
    const source = input.promptOverride?.trim() || [
      stripEntityReferences(input.scene?.name, input.excludedEntities),
      stripEntityReferences(input.scene?.description, input.excludedEntities),
      input.style,
    ].filter((value): value is string => !!value?.trim()).join(', ');
    return {
      prompt: appendEnvironmentOnlyContract(stripEntityReferences(source, input.excludedEntities)),
      negativePrompt: input.excludedEntities?.filter(Boolean).join(', ') || undefined,
    };
  }
  if (input.promptOverride?.trim()) return { prompt: input.promptOverride.trim() };
  const source = input.character
    ? [
        input.character.name,
        input.character.appearance,
        input.costumeOverride,
        input.style,
        input.purpose === 'character_turnaround'
          ? 'single-entity full-body front, side, and back reference sheet on a neutral background'
          : '',
      ]
    : [stripEntityReferences(input.scene?.name, input.excludedEntities), stripEntityReferences(input.scene?.description, input.excludedEntities), input.style];
  return { prompt: source.filter((value): value is string => !!value?.trim()).join(', ') };
}

function sanitizeScenePlan(
  plan: ImagePromptPlan,
  input: ImagePromptPlannerInput,
): ImagePromptPlan {
  return {
    ...plan,
    prompt: appendEnvironmentOnlyContract(stripEntityReferences(plan.prompt, input.excludedEntities)),
  };
}

function appendEnvironmentOnlyContract(prompt: string): string {
  return [
    prompt.trim(),
    'Generate a clean environment-only plate. Do not render any story subject, person, animal, creature, or other foreground entity.',
  ].filter(Boolean).join('\n\n');
}

function stripEntityReferences(value: string | undefined, references?: string[]): string {
  if (!value?.trim() || !references?.length) return value?.trim() || '';
  return [...new Set(references)]
    .map((reference) => reference.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((current, reference) => {
      const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return current.replace(new RegExp(escaped, 'giu'), ' ');
    }, value)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?，。！？])/g, '$1')
    .trim();
}

function getConfiguredInstruction(purpose: ImagePromptPurpose): string | undefined {
  const templates = useSettingsStore.getState().settings.creative.promptTemplates;
  if (!useSettingsStore.getState().settings.creative.promptTemplatesEnabled || !templates) return undefined;
  const value = purpose === 'scene_background'
    ? templates.sceneEn || templates.sceneZh
    : purpose === 'character_turnaround'
      ? templates.turnaroundEn || templates.turnaroundZh
      : templates.portraitEn || templates.portraitZh;
  if (!value?.trim()) return undefined;
  return value.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parameterObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== null),
  );
}

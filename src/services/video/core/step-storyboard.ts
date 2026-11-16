import type {
  ImageGenerationCapabilities,
  LLMGenerateRequest,
  VideoGenerationCapabilities,
} from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { formatCapabilitiesForPrompt } from '@/services/providers/provider-capabilities';
import { parseLLMJson } from '@/services/novel/llm-json';
import type { ShotCharacterBinding, ShotSpec, AspectRatio, ShotTransition } from '@/types/video';
import { estimateSmartShotDuration } from './duration-estimator';
import { detectInputLanguage, hasLanguageMismatch } from './lang-detector';
import { assertShotPlanContract } from './shot-plan-contract';
import { SHOT_DIRECTION_PLANNING_RULE } from './shot-motion-prompt';

export interface StoryboardContext {
  aspectRatio: AspectRatio;
  defaultShotDuration: 3 | 5 | 10 | 15 | 18;
  targetDurationSeconds?: 5 | 15 | 30 | 60 | number;
  style?: string;
  continuityContext?: string;
  allowFallback?: boolean;
  imageCapabilities?: ImageGenerationCapabilities;
  videoCapabilities?: VideoGenerationCapabilities;
}

export interface StoryboardResult {
  shots: ShotSpec[];
}

interface LLMShot {
  id?: string;
  sourceText?: string;
  videoPrompt?: string;
  imagePrompt?: string;
  imageNegativePrompt?: string;
  videoNegativePrompt?: string;
  imageParameters?: Record<string, unknown>;
  videoParameters?: Record<string, unknown>;
  narration?: string;
  dialogue?: { speaker: string; text: string; emotion?: string }[];
  location?: string;
  mood?: string;
  cameraMovement?: string;
  transition?: ShotTransition;
  durationSeconds?: number;
  visibleCharacters?: string[];
  offscreenCharacters?: string[];
  characters?: string[];
  visibleCharacterIds?: string[];
  offscreenCharacterIds?: string[];
  characterIds?: string[];
  sceneId?: string;
  startState?: string;
  endState?: string;
  seed?: number;
}

/** Convert a direct prompt into planner-owned shot specs. */
export async function stepStoryboard(
  rawPrompt: string,
  ctx: StoryboardContext,
): Promise<StoryboardResult> {
  const imageCapabilities = ctx.imageCapabilities ?? providerRouter.getImageCapabilities('storyboard');
  const videoCapabilities = ctx.videoCapabilities ?? providerRouter.getVideoCapabilities('clip');
  const sourceLanguage = detectInputLanguage(rawPrompt);
  const request: LLMGenerateRequest = {
    taskType: 'translation',
    systemPrompt: buildSystemPrompt(ctx, imageCapabilities, videoCapabilities, sourceLanguage),
    userPrompt: ctx.continuityContext?.trim()
      ? `[Continuity Context]\n${ctx.continuityContext.trim()}\n\n[Current Script]\n${rawPrompt}`
      : rawPrompt,
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    let parsed: unknown = parseLLMJson<unknown>(resp.content);
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      parsed = ['shots', 'items', 'data', 'storyboard', 'scenes', 'result', 'output']
        .map((key) => record[key])
        .find(Array.isArray) ?? parsed;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Storyboard planner returned no usable shots');
    }
    let shots = parsed.map((item, index) => normalizeShot(
      (item && typeof item === 'object' ? item : {}) as LLMShot,
      index,
      ctx,
    ));
    if (hasLanguageMismatch(sourceLanguage, shots.flatMap(naturalLanguageFields))) {
      const repairResponse = await providerRouter.generate({
        ...request,
        userPrompt: `${request.userPrompt}\n\n[Language contract repair]\nThe source language is ${sourceLanguage === 'zh' ? 'Simplified Chinese' : 'English'}. Rewrite every natural-language output field in that language, preserve the source meaning and entity names, and return only the JSON shot array.`,
        temperature: 0.2,
      });
      let repaired: unknown = parseLLMJson<unknown>(repairResponse.content);
      if (repaired && !Array.isArray(repaired) && typeof repaired === 'object') {
        const record = repaired as Record<string, unknown>;
        repaired = ['shots', 'items', 'data', 'storyboard', 'scenes', 'result', 'output']
          .map((key) => record[key])
          .find(Array.isArray) ?? repaired;
      }
      if (Array.isArray(repaired)) {
        const repairedShots = repaired.map((item, index) => normalizeShot(
          (item && typeof item === 'object' ? item : {}) as LLMShot,
          index,
          ctx,
        ));
        if (!hasLanguageMismatch(sourceLanguage, repairedShots.flatMap(naturalLanguageFields))) {
          shots = repairedShots;
        } else {
          throw new Error(`Storyboard planner returned fields outside the ${sourceLanguage} source-language contract`);
        }
      } else {
        throw new Error(`Storyboard planner returned fields outside the ${sourceLanguage} source-language contract`);
      }
    }
    const plannedShots = applyContinuityHandoffs(shots);
    assertShotPlanContract(plannedShots);
    return { shots: plannedShots };
  } catch (err) {
    if (ctx.allowFallback === false) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Storyboard planning failed: ${reason}`);
    }
    console.warn('stepStoryboard planner failed; using source-preserving fallback', err);
    const fallback = fallbackStoryboard(rawPrompt, ctx);
    assertShotPlanContract(fallback.shots);
    return fallback;
  }
}

function buildSystemPrompt(
  ctx: StoryboardContext,
  imageCapabilities: ImageGenerationCapabilities,
  videoCapabilities: VideoGenerationCapabilities,
  sourceLanguage: 'zh' | 'en',
): string {
  const languageInstruction = sourceLanguage === 'zh'
    ? 'Write all natural-language output fields in Simplified Chinese. Do not translate the source into English.'
    : 'Write all natural-language output fields in English. Do not translate the source into Chinese.';
  const targetDuration = ctx.targetDurationSeconds || 30;
  const targetShotCount = Math.max(1, Math.round(targetDuration / ctx.defaultShotDuration));
  const plannerContract = [
    'You are a storyboard planning model. Split the script into coherent shots that preserve its events, entities, states, and dialogue.',
    `Plan about ${targetShotCount} shots for a target duration of ${targetDuration}s; return one JSON object per planned shot.`,
    languageInstruction,
    SHOT_DIRECTION_PLANNING_RULE,
    'A visible entity list is authoritative for frame composition. Mentioned or speaking entities may remain offscreen.',
    'imagePrompt should describe framing, pose, action, camera, lighting, and environment. Do not restate or alter a bound entity\'s identity, form, clothing, colors, or accessories; those facts come from the extracted entity records and their references.',
    'Do not invent asset URLs, entity ids, or reference-image positions. Asset binding happens after this stage.',
    'Declare transition as "continue" only when the same physical moment continues with the same visible subject set and scene. Use "cut" for a new edit segment, location, time, or subject set. Never infer a temporal handoff from matching names alone.',
    'For transition=continue, preserve visible subjects, location, wardrobe, and emotional state, and set startState from the previous shot endState. For transition=cut, define an independent startState when useful.',
    'Choose optional imageParameters and videoParameters from the capability contracts below. Omit unsupported or unnecessary keys.',
    'If selecting a model, set the matching parameters.model to one of the advertised available models; do not copy image parameters into videoParameters or vice versa.',
  ].join('\n');

  const outputSchema = [
    '[Output Schema]',
    '{',
    '  "videoPrompt": "motion-aware visual description",',
    '  "imagePrompt": "still/keyframe visual description",',
    '  "imageNegativePrompt": "optional string",',
    '  "videoNegativePrompt": "optional string",',
    '  "imageParameters": { "key": "value" },',
    '  "videoParameters": { "key": "value" },',
    '  "narration": "source narration or exact dialogue",',
    '  "dialogue": [{ "speaker": "entity name", "text": "dialogue" }],',
    '  "visibleCharacters": ["visible entity names"],',
    '  "offscreenCharacters": ["offscreen entity names"],',
    '  "characters": ["same values as visibleCharacters"],',
    '  "location": "scene label",',
    '  "mood": "shot mood",',
    '  "cameraMovement": "camera movement",',
    '  "transition": "cut" or "continue",',
    '  "durationSeconds": 5,',
    '  "startState": "visible state at first frame",',
    '  "endState": "visible state at last frame"',
    '}',
  ].join('\n');

  return [
    plannerContract,
    `[Project]\naspectRatio=${ctx.aspectRatio}\ndefaultShotDuration=${ctx.defaultShotDuration}s\nstyle=${ctx.style || '-'}`,
    outputSchema,
    '[Image Provider Capability Contract]',
    formatCapabilitiesForPrompt(imageCapabilities),
    '[Video Provider Capability Contract]',
    formatCapabilitiesForPrompt(videoCapabilities),
  ].filter(Boolean).join('\n\n');
}

function normalizeShot(item: LLMShot, index: number, ctx: StoryboardContext): ShotSpec {
  const dialogue = Array.isArray(item.dialogue) && item.dialogue.length > 0 ? item.dialogue : undefined;
  const narration = dialogue?.[0]?.text?.trim() || (item.narration ? String(item.narration).trim() : undefined);
  const videoPrompt = String(item.videoPrompt ?? '').trim() || String(item.sourceText ?? '').trim() || `Shot ${index + 1}`;
  const imagePrompt = String(item.imagePrompt ?? '').trim() || String(item.sourceText ?? '').trim() || undefined;
  const visibleRefs = firstStringArray(
    item.visibleCharacters,
    item.visibleCharacterIds,
    item.characters,
    item.characterIds,
  ) ?? [];
  const offscreenRefs = firstStringArray(item.offscreenCharacters, item.offscreenCharacterIds) ?? [];
  const hasExplicitVisibleList = [
    item.visibleCharacters,
    item.visibleCharacterIds,
    item.characters,
    item.characterIds,
  ].some(Array.isArray);
  const cameraMovement = item.cameraMovement;
  const durationSeconds = estimateSmartShotDuration({
    text: videoPrompt,
    narration,
    dialogue,
    cameraMovement,
    explicitDuration: typeof item.durationSeconds === 'number' ? item.durationSeconds : undefined,
    defaultShotDuration: ctx.defaultShotDuration,
  });

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `shot_${Date.now()}_${index}`,
    index,
    sourceText: typeof item.sourceText === 'string' ? item.sourceText : rawPromptForShot(videoPrompt),
    videoPrompt,
    imagePrompt,
    imageNegativePrompt: typeof item.imageNegativePrompt === 'string' ? item.imageNegativePrompt.trim() || undefined : undefined,
    videoNegativePrompt: typeof item.videoNegativePrompt === 'string' ? item.videoNegativePrompt.trim() || undefined : undefined,
    imageParameters: parameterObject(item.imageParameters),
    videoParameters: parameterObject(item.videoParameters),
    narration,
    dialogue,
    location: item.location,
    mood: item.mood,
    cameraMovement,
    transition: item.transition === 'continue' || item.transition === 'cut' ? item.transition : undefined,
    durationSeconds: durationSeconds as ShotSpec['durationSeconds'],
    characterIds: visibleRefs,
    visibleCharacterIds: visibleRefs,
    offscreenCharacterIds: offscreenRefs,
    characterBinding: hasExplicitVisibleList ? 'explicit' : 'inferred' as ShotCharacterBinding,
    sceneId: item.sceneId,
    startState: typeof item.startState === 'string' ? item.startState.trim() || undefined : undefined,
    endState: typeof item.endState === 'string' ? item.endState.trim() || undefined : undefined,
    seed: typeof item.seed === 'number' && Number.isFinite(item.seed) ? item.seed : undefined,
  };
}

function fallbackStoryboard(rawPrompt: string, ctx: StoryboardContext): StoryboardResult {
  const durationSeconds = estimateSmartShotDuration({
    text: rawPrompt,
    defaultShotDuration: ctx.defaultShotDuration,
  });
  return {
    shots: [{
      id: `shot_${Date.now()}_0`,
      index: 0,
      sourceText: rawPrompt,
      videoPrompt: rawPrompt,
      imagePrompt: rawPrompt,
      durationSeconds: durationSeconds as ShotSpec['durationSeconds'],
      characterIds: [],
      visibleCharacterIds: [],
      offscreenCharacterIds: [],
      characterBinding: 'inferred',
    }],
  };
}

function applyContinuityHandoffs(shots: ShotSpec[]): ShotSpec[] {
  return shots.map((shot, index) => {
    const previous = shots[index - 1];
    if (!previous || shot.startState?.trim() || !previous.endState?.trim()) return shot;
    if (shot.transition === 'cut') return shot;
    if (previous.location?.trim() && shot.location?.trim() && previous.location.trim() !== shot.location.trim()) {
      return shot;
    }
    return { ...shot, startState: previous.endState };
  });
}

function rawPromptForShot(prompt: string): string {
  return prompt;
}

function parameterObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== null));
}

function firstStringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function naturalLanguageFields(shot: ShotSpec): string[] {
  return [
    shot.sourceText,
    shot.videoPrompt,
    shot.imagePrompt,
    shot.imageNegativePrompt,
    shot.videoNegativePrompt,
    shot.narration,
    shot.location,
    shot.mood,
    shot.cameraMovement,
    shot.startState,
    shot.endState,
    ...(shot.dialogue?.map((item) => item.text) ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

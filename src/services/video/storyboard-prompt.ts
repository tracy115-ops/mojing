import { SHOT_DIRECTION_PLANNING_RULE } from './core/shot-motion-prompt';
import type {
  ImageGenerationCapabilities,
  LLMGenerateRequest,
  VideoGenerationCapabilities,
} from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { formatCapabilitiesForPrompt } from '@/services/providers/provider-capabilities';
import { parseLLMJson } from '@/services/novel/llm-json';
import type { ShotCharacterBinding, StoryboardShot } from '@/types/video';
import type { RawShot } from './chapter-slicer';
import { estimateSmartShotDuration } from './core/duration-estimator';
import { detectInputLanguage, hasLanguageMismatch } from './core/lang-detector';
import { assertShotPlanContract } from './core/shot-plan-contract';

const MAX_SHOTS_PER_CALL = 3;

export interface StoryboardContext {
  novelTitle: string;
  genre: string;
  style: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  defaultShotDuration: 3 | 5 | 10 | 18;
  continuityContext?: string;
  /** Full script context retains global constraints outside individual shots. */
  sourceContext?: string;
  allowFallback?: boolean;
  /** Language of the supplied source text, used as a planner contract. */
  sourceLanguage?: 'zh' | 'en';
  /** Active provider/model contracts are part of the planner input. */
  imageCapabilities?: ImageGenerationCapabilities;
  videoCapabilities?: VideoGenerationCapabilities;
}

interface StoryboardHandoff {
  location?: string;
  visibleCharacters?: string[];
  mood?: string;
  endState?: string;
}

export async function buildStoryboard(
  rawShots: RawShot[],
  ctx: StoryboardContext,
  onProgress?: (done: number, total: number) => void,
): Promise<StoryboardShot[]> {
  const result: StoryboardShot[] = [];
  const total = rawShots.length;
  let previousHandoff: StoryboardHandoff | undefined;

  for (let i = 0; i < rawShots.length; i += MAX_SHOTS_PER_CALL) {
    const batch = rawShots.slice(i, i + MAX_SHOTS_PER_CALL);
    const shots = await processBatch(batch, ctx, previousHandoff);
    result.push(...shots);
    const lastShot = shots[shots.length - 1];
    previousHandoff = lastShot
      ? {
          location: lastShot.location,
          visibleCharacters: lastShot.visibleCharacters ?? lastShot.characters,
          mood: lastShot.mood,
          endState: lastShot.endState,
        }
      : previousHandoff;
    onProgress?.(Math.min(i + MAX_SHOTS_PER_CALL, total), total);
  }

  return result;
}

async function processBatch(
  batch: RawShot[],
  ctx: StoryboardContext,
  previousHandoff?: StoryboardHandoff,
): Promise<StoryboardShot[]> {
  const request: LLMGenerateRequest = {
    taskType: 'planning',
    systemPrompt: buildSystemPrompt(ctx),
    userPrompt: buildUserPrompt(batch, ctx, previousHandoff),
    responseFormat: 'json',
    temperature: 0.6,
    maxTokens: 8192,
  };

  try {
    const response = await providerRouter.generate(request);
    let parsed = parseStoryboardArray(response.content);

    if (!parsed || parsed.length !== batch.length) {
      const repairResponse = await providerRouter.generate({
        ...request,
        userPrompt: `${request.userPrompt}\n\nReturn exactly ${batch.length} objects in the requested JSON array. Do not return markdown or commentary.`,
        temperature: 0.2,
      });
      parsed = parseStoryboardArray(repairResponse.content);
    }

    if (!parsed || parsed.length === 0) {
      throw new Error('Storyboard planner returned no usable shots');
    }
    if (parsed.length !== batch.length) {
      throw new Error(`Storyboard planner returned ${parsed.length} shots, expected ${batch.length}`);
    }

    const normalized = parsed.map((item, index) => normalizeShot(item, batch[index], ctx, index));
    const sourceLanguage = ctx.sourceLanguage
      ?? detectInputLanguage(batch.map((raw) => raw.rawText).join('\n'));
    if (!hasLanguageMismatch(sourceLanguage, normalized.flatMap(naturalLanguageFields))) {
      assertShotPlanContract(normalized);
      return normalized;
    }

    const repairedResponse = await providerRouter.generate({
      ...request,
      userPrompt: `${request.userPrompt}\n\n[Language contract repair]\nThe source language is ${sourceLanguage === 'zh' ? 'Simplified Chinese' : 'English'}. Rewrite every natural-language output field in that language, preserve the source meaning and entity names, return exactly ${batch.length} JSON objects, and return no markdown.`,
      temperature: 0.2,
    });
    const repaired = parseStoryboardArray(repairedResponse.content);
    if (repaired?.length === batch.length) {
      const repairedShots = repaired.map((item, index) => normalizeShot(item, batch[index], ctx, index));
      if (!hasLanguageMismatch(sourceLanguage, repairedShots.flatMap(naturalLanguageFields))) {
        assertShotPlanContract(repairedShots);
        return repairedShots;
      }
    }
    throw new Error(`Storyboard planner returned fields outside the ${sourceLanguage} source-language contract`);
  } catch (err) {
    if (ctx.allowFallback === false) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Storyboard planning failed: ${reason}`);
    }
    console.warn('Storyboard planner failed; using source-preserving fallback', err);
    const fallback = batch.map((raw, index) => fallbackShot(raw, ctx, index));
    assertShotPlanContract(fallback);
    return fallback;
  }
}

function parseStoryboardArray(content: string): Record<string, unknown>[] | null {
  let parsed: unknown = parseLLMJson<unknown>(content);
  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const arrayValue = ['shots', 'items', 'data', 'storyboard', 'scenes', 'result', 'list', 'output']
      .map((key) => record[key])
      .find(Array.isArray);
    parsed = arrayValue ?? parsed;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
}

function naturalLanguageFields(shot: StoryboardShot): string[] {
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

function buildSystemPrompt(ctx: StoryboardContext): string {
  const languageInstruction = ctx.sourceLanguage === 'zh'
    ? 'Write all natural-language output fields in Simplified Chinese. Do not translate the source into English.'
    : ctx.sourceLanguage === 'en'
      ? 'Write all natural-language output fields in English. Do not translate the source into Chinese.'
      : 'Write natural-language output fields in the source language; do not translate merely to satisfy a formatting rule.';
  const plannerContract = [
    'You are a storyboard planning model. Convert each source segment into one coherent shot while preserving events, entities, and quoted dialogue.',
    'Return only a JSON array with exactly one object per input segment.',
    languageInstruction,
    SHOT_DIRECTION_PLANNING_RULE,
    'visibleCharacters contains only entities visible in the frame. offscreenCharacters contains named entities intentionally outside the frame.',
    'imagePrompt should describe framing, pose, action, camera, lighting, and environment. Do not restate or alter a bound entity\'s identity, form, clothing, colors, or accessories; those facts come from extracted entity records and their references.',
    'Do not invent entity ids, asset URLs, or reference-image positions. Downstream stages bind real assets after extraction.',
    'imagePrompt is the still/keyframe prompt. videoPrompt is the motion prompt. Keep them aligned without copying one into the other.',
    'Keep script headings, camera directions, timing and production requirements out of dialogue and narration. Use dialogue=[] when no character speaks, and narration="" when the shot has no voice-over.',
    'Declare transition as "continue" only when the same physical moment continues with the same visible subject set and scene. Use "cut" for a new edit segment, location, time, or subject set. Never infer a temporal handoff from matching names alone.',
    'For transition=continue, preserve location, visible subjects, wardrobe, and emotional state, and set startState from the previous shot endState. For transition=cut, define an independent startState when useful.',
    'imageParameters and videoParameters are planner decisions. Use only keys from the matching capability contract, and omit optional keys that do not help this shot.',
    'If selecting a model, set the matching parameters.model to one of the advertised available models; do not copy image parameters into videoParameters or vice versa.',
    'Do not put reference images inside either parameter object. The execution stage owns reference ordering and transport.',
  ].join('\n');

  const projectContext = [
    '[Project Context]',
    `title=${ctx.novelTitle}`,
    `genre=${ctx.genre}`,
    `style=${ctx.style}`,
    `aspectRatio=${ctx.aspectRatio}`,
    `defaultShotDuration=${ctx.defaultShotDuration}s`,
  ].join('\n');

  const outputSchema = [
    '[Output Schema]',
    '{',
    '  "videoPrompt": "motion-aware visual description",',
    '  "imagePrompt": "keyframe visual description",',
    '  "imageNegativePrompt": "optional string when supported and useful",',
    '  "videoNegativePrompt": "optional string when supported and useful",',
    '  "imageParameters": { "only": "keys from image capability contract" },',
    '  "videoParameters": { "only": "keys from video capability contract" },',
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

  const capabilityContext = [
    '[Image Provider Capability Contract]',
    formatCapabilitiesForPrompt(ctx.imageCapabilities),
    '[Video Provider Capability Contract]',
    formatCapabilitiesForPrompt(ctx.videoCapabilities),
  ].join('\n');

  return [plannerContract, projectContext, outputSchema, capabilityContext]
    .filter(Boolean)
    .join('\n\n');
}

function buildUserPrompt(batch: RawShot[], ctx: StoryboardContext, previousHandoff?: StoryboardHandoff): string {
  const sourceContext = ctx.sourceContext?.trim()
    ? `[Full Script Context]\n${ctx.sourceContext.trim()}\nApply its shared setting and production constraints to the segments below. Return shots only for those segments.\n\n`
    : '';
  const continuity = ctx.continuityContext?.trim()
    ? `[Continuity Context]\n${ctx.continuityContext.trim()}\n\n`
    : '';
  const handoff = previousHandoff
    ? [
        '[Previous Shot Handoff]',
        `location=${previousHandoff.location || '-'}`,
        `visibleCharacters=${previousHandoff.visibleCharacters?.join(', ') || '-'}`,
        `mood=${previousHandoff.mood || '-'}`,
        `endState=${previousHandoff.endState || '-'}`,
        'If the next segment continues this scene, use this handoff as the next shot start state.',
        '',
      ].join('\n')
    : '';
  const items = batch.map((raw, index) => [
    `--- Source Segment ${index + 1} ---`,
    `chapter=${raw.sourceChapterNumber}`,
    `source=${raw.rawText.slice(0, 3000)}`,
    `candidateEntities=${raw.characters.join(', ') || '-'}`,
    `offscreenEntities=${raw.offscreenCharacters?.join(', ') || '-'}`,
    `location=${raw.location || '-'}`,
    `mood=${raw.mood || '-'}`,
  ].join('\n')).join('\n\n');
  return `${sourceContext}${continuity}${handoff}${items}`;
}

function normalizeShot(
  item: Record<string, unknown>,
  raw: RawShot,
  ctx: StoryboardContext,
  fallbackIndex = 0,
): StoryboardShot {
  const dialogue = normalizeDialogue(item.dialogue) ?? extractDialogue(raw.rawText);
  const narration = typeof item.narration === 'string'
    ? item.narration.trim()
    : dialogue?.[0]?.text?.trim() || raw.rawText.slice(0, 80) || `Shot ${fallbackIndex + 1}`;
  const shotIndex = numberValue(item.index) ?? raw.index ?? fallbackIndex;
  const videoPrompt = stringValue(item.videoPrompt) || stringValue(item.sourceText) || raw.rawText || fallbackVideoPrompt(raw, shotIndex);
  const imagePrompt = stringValue(item.imagePrompt) || stringValue(item.sourceText) || undefined;
  const visibleRefs = firstStringArray(item.visibleCharacters, item.visibleCharacterIds, item.characters, item.characterIds)
    ?? (raw.characterBinding === 'explicit' ? raw.characters : []);
  const offscreenRefs = firstStringArray(item.offscreenCharacters, item.offscreenCharacterIds) ?? raw.offscreenCharacters ?? [];
  const hasExplicitVisibleList = [item.visibleCharacters, item.visibleCharacterIds, item.characters, item.characterIds]
    .some(Array.isArray);
  const durationSeconds = estimateSmartShotDuration({
    text: videoPrompt,
    narration,
    dialogue,
    cameraMovement: stringValue(item.cameraMovement) ?? defaultCamera(raw),
    hasAction: raw.hasAction,
    explicitDuration: numberValue(item.durationSeconds),
    defaultShotDuration: ctx.defaultShotDuration,
  });

  return {
    id: stringValue(item.id) || raw.id || `shot_${shotIndex + 1}`,
    index: shotIndex,
    sourceChapterId: raw.sourceChapterId || 'ch_1',
    sourceText: stringValue(item.sourceText) || raw.rawText || `Shot ${shotIndex + 1}`,
    videoPrompt,
    imagePrompt,
    imageNegativePrompt: stringValue(item.imageNegativePrompt),
    videoNegativePrompt: stringValue(item.videoNegativePrompt),
    imageParameters: parameterObject(item.imageParameters),
    videoParameters: parameterObject(item.videoParameters),
    startState: stringValue(item.startState),
    endState: stringValue(item.endState),
    seed: numberValue(item.seed),
    narration,
    durationSeconds,
    characters: visibleRefs,
    visibleCharacters: visibleRefs,
    offscreenCharacters: offscreenRefs,
    visibleCharacterIds: visibleRefs,
    offscreenCharacterIds: offscreenRefs,
    characterBinding: hasExplicitVisibleList || raw.characterBinding === 'explicit' ? 'explicit' : 'inferred',
    location: stringValue(item.location) || raw.location,
    mood: stringValue(item.mood) ?? raw.mood,
    cameraMovement: stringValue(item.cameraMovement) ?? defaultCamera(raw),
    transition: item.transition === 'continue' || item.transition === 'cut' ? item.transition : undefined,
    dialogue,
  };
}

function fallbackShot(raw: RawShot, ctx: StoryboardContext, index = 0): StoryboardShot {
  const dialogue = extractDialogue(raw.rawText);
  const narration = dialogue?.[0]?.text?.trim() || raw.rawText.slice(0, 80);
  const videoPrompt = raw.rawText.trim() || fallbackVideoPrompt(raw, index);
  const durationSeconds = estimateSmartShotDuration({
    text: videoPrompt,
    narration,
    dialogue,
    cameraMovement: defaultCamera(raw),
    hasAction: raw.hasAction,
    defaultShotDuration: ctx.defaultShotDuration,
  });
  const visible = raw.characterBinding === 'explicit' ? raw.characters : [];
  return {
    id: raw.id || `shot_${index + 1}`,
    index: raw.index ?? index,
    sourceChapterId: raw.sourceChapterId,
    sourceText: raw.rawText || `Shot ${index + 1}`,
    videoPrompt,
    imagePrompt: videoPrompt,
    videoNegativePrompt: undefined,
    narration,
    durationSeconds,
    characters: visible,
    visibleCharacters: visible,
    offscreenCharacters: raw.offscreenCharacters ?? [],
    visibleCharacterIds: visible,
    offscreenCharacterIds: raw.offscreenCharacters ?? [],
    characterBinding: raw.characterBinding ?? 'inferred',
    location: raw.location,
    mood: raw.mood,
    cameraMovement: defaultCamera(raw),
    dialogue,
  };
}

function fallbackVideoPrompt(raw: RawShot, index = 0): string {
  return raw.rawText.trim();
}

function defaultCamera(_raw: RawShot): string | undefined {
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parameterObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== null));
}

function normalizeDialogue(value: unknown): { speaker: string; text: string; emotion?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const speaker = stringValue(record.speaker);
    const text = stringValue(record.text);
    if (!speaker || !text) return [];
    const emotion = stringValue(record.emotion);
    return [{ speaker, text, ...(emotion ? { emotion } : {}) }];
  });
  return result;
}

function firstStringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.map(String).map((item) => item.trim()).filter(Boolean);
    }
  }
  return undefined;
}

export function extractDialogue(text: string): { speaker: string; text: string }[] | undefined {
  if (!text) return undefined;
  const output: { speaker: string; text: string }[] = [];
  const linePattern = /(?:^|[\n.!?！？。！？])\s*([^:\n：]{1,40})\s*(?:dialogue|对白)?\s*[:：]\s*["“「]?([^\n"”」]{1,500})["”」]?/gu;
  for (const match of text.matchAll(linePattern)) {
    const speaker = match[1].trim();
    const dialogueText = match[2].trim();
    if (/^(?:(?:镜头|分镜|场景|画面|运镜|旁白|解说|字幕|音效|音乐)(?:\s*\d|[（(【\s]|$)|(?:shot|scene|camera|narration|voice[ -]?over|sfx|bgm)\b)/iu.test(speaker)) continue;
    if (speaker && dialogueText) output.push({ speaker, text: dialogueText });
  }
  return output.length > 0 ? output : undefined;
}

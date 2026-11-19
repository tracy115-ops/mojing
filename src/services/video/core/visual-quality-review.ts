import { providerRouter } from '@/services/providers';
import {
  extractFrameAt,
} from '../ffmpeg-bridge';
import {
  getAssetDirectory,
  isRemoteUrl,
  readAsDataUri,
  resolveLocalPath,
  toWebviewUrl,
} from '../asset-store';
import type {
  CharacterAnchor,
  GeneratedClip,
  SceneAnchor,
  ShotSpec,
  VideoVisualQualityReview,
} from '@/types/video';
import { normalizeVisualReview, SHOT_VISUAL_CHECKS, unavailableVisualReview } from './visual-quality-normalizer';

export { normalizeVisualReview } from './visual-quality-normalizer';

export interface VisualQualityReviewOptions {
  /** Actual decoded output samples, particularly for imported browser media. */
  outputFrames?: string[];
  projectId?: string;
  llmEndpointId?: string;
  llmModel?: string;
  characters?: CharacterAnchor[];
  scenes?: SceneAnchor[];
  reviewedAt?: string;
  signal?: AbortSignal;
}

interface VisualInput {
  id: string;
  label: string;
  kind: 'reference' | 'frame';
  sourceUrl?: string;
  dataUri: string;
}

export function evaluateKeyframeVisually(
  shot: ShotSpec,
  imageUrl: string,
  options: VisualQualityReviewOptions,
): Promise<VideoVisualQualityReview> {
  return evaluateShotVisuals(shot, { ...options, outputFrames: [imageUrl] });
}

/**
 * Review sampled output frames against the structured shot contract.
 *
 * This service deliberately does not contain story-specific nouns or prompt
 * rules. The shot's own bindings and descriptions are the only expected
 * state supplied to the visual model.
 */
export async function evaluateVideoClipVisually(
  shot: ShotSpec,
  clip: GeneratedClip,
  options: VisualQualityReviewOptions = {},
): Promise<VideoVisualQualityReview> {
  return evaluateShotVisuals(shot, options, clip);
}

async function evaluateShotVisuals(
  shot: ShotSpec,
  options: VisualQualityReviewOptions,
  clip?: GeneratedClip,
): Promise<VideoVisualQualityReview> {
  const reviewedAt = options.reviewedAt ?? new Date().toISOString();
  const still = !clip;
  const requiredChecks = still
    ? SHOT_VISUAL_CHECKS.filter((id) => id !== 'temporal_consistency')
    : SHOT_VISUAL_CHECKS;
  const capabilities = providerRouter.getLLMCapabilities('review', options.llmModel, options.llmEndpointId);
  if (!capabilities.supportsImageInputs || capabilities.maxImageInputs <= 0) {
    return unavailableVisualReview(
      reviewedAt,
      'The configured review model does not declare image-input support. Add an llm capability contract or choose a vision model.',
    );
  }

  const inputs = await collectVisualInputs(shot, clip, options, capabilities.maxImageInputs);
  if (inputs.filter((input) => input.kind === 'frame').length === 0) {
    return unavailableVisualReview(reviewedAt, 'No readable output frame was available for visual review.');
  }

  const visibleRefs = visibleCharacterIds(shot);
  const expectedSubjects = (options.characters ?? [])
    .filter((character) => visibleRefs.some((reference) => characterReferenceMatches(character, reference)))
    .map((character) => ({
      id: character.id,
      name: character.name,
      appearance: character.appearance,
      entityType: character.entityType,
    }));
  const scene = shot.sceneId
    ? options.scenes?.find((candidate) => candidate.id === shot.sceneId)
    : undefined;
  const inputManifest = inputs.map((input, index) => `${index + 1}. ${input.kind.toUpperCase()} ${input.label}`);

  try {
    const response = await providerRouter.generate({
      taskType: 'review',
      model: capabilities.model,
      temperature: 0.1,
      maxTokens: 1400,
      responseFormat: 'json',
      systemPrompt: [
        'You are a strict visual quality reviewer for generated video shots.',
        ...(still ? ['Assess the single supplied keyframe as a still. Check framing, subject identity, wardrobe, and intended starting pose.'] : []),
        'Inspect the supplied images, compare them with the structured shot contract, and never infer a pass from filenames or prompt text alone.',
        'Count visible entities conservatively. An unbound visible entity is a failure for subject_count.',
        'Return JSON only. Every required check id must appear exactly once.',
        'Use status pass, warning, or fail. Use scores from 0 to 100.',
      ].join('\n'),
      userPrompt: JSON.stringify({
        task: still ? 'Evaluate the proposed first frame for this shot.' : 'Evaluate one generated video clip from sampled frames.',
        expected: {
          visibleSubjects: expectedSubjects,
          visibleSubjectIds: visibleCharacterIds(shot),
          offscreenSubjectIds: shot.offscreenCharacterIds ?? [],
          scene: scene ? { id: scene.id, name: scene.name, description: scene.description } : undefined,
          location: shot.location,
          mood: shot.mood,
          startState: shot.startState,
          endState: shot.endState,
          cameraMovement: shot.cameraMovement,
          sourceText: shot.sourceText,
          shotPrompt: still ? shot.imagePrompt : shot.videoPrompt,
        },
        sampledInputs: inputManifest,
        requiredChecks,
        outputShape: {
          overallScore: 'number 0..100',
          summary: 'short evidence-based text',
          checks: [{ id: 'one required check id', status: 'pass|warning|fail', score: 'number 0..100', message: 'short finding', evidence: 'optional visual evidence' }],
        },
      }, null, 2),
      imageInputs: inputs.map((input) => input.dataUri),
    }, options.signal);
    return normalizeVisualReview(response.content, {
      reviewedAt,
      provider: response.provider,
      model: response.model,
      frameCount: inputs.filter((input) => input.kind === 'frame').length,
    }, still);
  } catch (error) {
    return unavailableVisualReview(
      reviewedAt,
      `Visual review failed: ${error instanceof Error ? error.message : String(error)}`,
      capabilities.provider,
      capabilities.model,
    );
  }
}

async function collectVisualInputs(
  shot: ShotSpec,
  clip: GeneratedClip | undefined,
  options: VisualQualityReviewOptions,
  maxInputs: number,
): Promise<VisualInput[]> {
  const frames: VisualInput[] = [];
  const references: VisualInput[] = [];
  const seen = new Set<string>();

  const addInput = async (
    target: VisualInput[],
    id: string,
    label: string,
    kind: VisualInput['kind'],
    url: string | undefined,
  ): Promise<void> => {
    if (!url || seen.has(url)) return;
    const dataUri = await readAsDataUri(url);
    if (!isImageDataUri(dataUri)) return;
    seen.add(url);
    target.push({ id, label, kind, sourceUrl: url, dataUri });
  };

  for (const [index, frame] of (options.outputFrames ?? []).entries()) {
    await addInput(frames, `${shot.id}:output:${index}`, `sampled output frame ${index + 1}`, 'frame', frame);
  }
  if (clip) {
    if (!options.outputFrames?.length && !clip.importedVideo) await addInput(frames, `${shot.id}:first`, 'first frame / approved keyframe', 'frame', shot.keyframeImage ?? clip.keyframeImage);
    const middleFrame = await extractMiddleFrame(clip, shot, options.projectId);
    await addInput(frames, `${shot.id}:middle`, 'middle frame / sampled output', 'frame', middleFrame);
    await addInput(frames, `${shot.id}:last`, 'last frame / sampled output', 'frame', clip.lastFrameImage);
  }

  const visibleIds = visibleCharacterIds(shot);
  for (const character of options.characters ?? []) {
    if (!visibleIds.some((id) => characterReferenceMatches(character, id))) continue;
    await addInput(references, character.id, `identity reference / ${character.name}`, 'reference', character.portraitImage);
  }

  for (const asset of shot.referenceAssets ?? []) {
    if (asset.sentToProvider === false) continue;
    await addInput(references, asset.id, `canonical reference / ${asset.label}`, 'reference', asset.imageUrl);
  }

  // Preserve output frames first. If the LLM has a small image budget it is
  // more useful to inspect the actual clip than to omit its temporal samples.
  return [...frames, ...references].slice(0, Math.max(1, maxInputs));
}

async function extractMiddleFrame(
  clip: GeneratedClip,
  shot: ShotSpec,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;
  const videoPath = resolveLocalPath(clip.videoUrl);
  if (!videoPath || isRemoteUrl(videoPath) || videoPath.startsWith('data:')) return undefined;
  try {
    const directory = await getAssetDirectory(projectId, 'last-frame');
    const outputPath = `${directory}/visual_review_middle_${shot.index + 1}_${crypto.randomUUID()}.png`;
    const result = await extractFrameAt({
      videoPath,
      outputPath,
      timeSeconds: Math.max(0.05, clip.durationSeconds / 2),
    });
    return toWebviewUrl(result.outputPath);
  } catch {
    return undefined;
  }
}

function visibleCharacterIds(shot: ShotSpec): string[] {
  return [...new Set((shot.visibleCharacterIds ?? shot.characterIds ?? []).map((id) => id.trim()).filter(Boolean))];
}

function characterReferenceMatches(character: { id: string; name: string; aliases?: string[] }, reference: string): boolean {
  const normalizedReference = normalizeReference(reference);
  return [character.id, character.name, ...(character.aliases ?? [])]
    .some((candidate) => normalizeReference(candidate) === normalizedReference);
}

function normalizeReference(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s._-]/g, '');
}

function isImageDataUri(value: string | undefined): value is string {
  return !!value && /^data:image\/[\w.+-]+;base64,/i.test(value);
}

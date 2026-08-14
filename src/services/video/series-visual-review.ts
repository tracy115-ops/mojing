import type { CharacterAnchor, SceneAnchor, SceneSpec } from '@/types/video';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import { readAsDataUri } from './asset-store';

export interface VisualReviewIssue {
  shotIndex: number;
  passed: boolean;
  reason: string;
}

export interface SeriesVisualReview {
  reviewedShots: number;
  issues: VisualReviewIssue[];
}

/** User-triggered visual review. Image 1 is the keyframe; remaining images are its canonical references. */
export async function reviewSeriesEpisodeVisuals(
  sceneSpec: SceneSpec,
  library: { characters?: CharacterAnchor[]; scenes?: SceneAnchor[] },
): Promise<SeriesVisualReview> {
  const characterById = new Map((library.characters ?? []).map((character) => [character.id, character]));
  const sceneById = new Map((library.scenes ?? []).map((scene) => [scene.id, scene]));
  const candidates = sceneSpec.shots.filter((shot) => !!shot.keyframeImage).slice(0, 8);
  const issues: VisualReviewIssue[] = [];

  for (const shot of candidates) {
    const refs = shot.characterIds.flatMap((id) => {
      const character = characterById.get(id);
      const variantId = shot.costumeVariantRefs?.[id];
      const variant = variantId ? character?.costumeVariants?.find((item) => item.id === variantId) : undefined;
      return variant?.portraitImage ?? character?.portraitImage ? [variant?.portraitImage ?? character!.portraitImage!] : [];
    });
    const sceneRef = shot.sceneId ? sceneById.get(shot.sceneId)?.backgroundImage : undefined;
    const sources = [shot.keyframeImage!, ...refs, ...(sceneRef ? [sceneRef] : [])].slice(0, 5);
    const imageInputs = await Promise.all(sources.map((source) => readAsDataUri(source)));
    const response = await providerRouter.generate({
      taskType: 'review',
      systemPrompt: 'You are a strict visual continuity reviewer. Image 1 is a generated keyframe. Remaining images are canonical character, costume, and scene references. Return JSON only: {"passed":boolean,"reason":"short Chinese explanation"}. Mark passed false only for a material mismatch in face, hair, costume, or scene.',
      userPrompt: `Review shot ${shot.index + 1}. Compare the first image against all following references.`,
      imageInputs,
      responseFormat: 'json',
      temperature: 0.1,
      maxTokens: 300,
    });
    const parsed = parseLLMJson<{ passed?: unknown; reason?: unknown }>(response.content);
    issues.push({
      shotIndex: shot.index + 1,
      passed: parsed?.passed !== false,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '模型未返回可用说明',
    });
  }

  return { reviewedShots: candidates.length, issues };
}

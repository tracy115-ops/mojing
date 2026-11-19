// Character reference generation. Prompt content and optional provider
// parameters are planned by the text model; this module owns asset binding.

import { providerRouter } from '@/services/providers';
import type { CharacterAnchor, ModelTier } from '@/types/video';
import { saveAsset, readAsDataUri } from '../asset-store';
import { planImagePrompt, type ImagePromptPlan } from './prompt-enricher';
import { needsTurnaroundGeneration } from './character-asset-binding';

export interface CharacterAnchorResult {
  characters: CharacterAnchor[];
  failed: string[];
}

export async function runCharacterAnchor(
  characters: CharacterAnchor[],
  ctx: {
    style?: string;
    imageTier: ModelTier;
    limit: number;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
    anchorMode?: 'single' | 'turnaround';
    characterPrompts?: Record<string, string>;
    turnaroundPrompts?: Record<string, string>;
    promptOverride?: string;
    shouldAbort?: () => boolean;
  },
  onProgress?: (done: number, total: number) => void,
): Promise<CharacterAnchorResult> {
  const limited = characters.slice(0, Math.max(0, ctx.limit));
  const wantTurnaround = ctx.anchorMode !== 'single';
  const total = countAnchorsNeeded(limited, wantTurnaround);
  if (total === 0) return { characters, failed: [] };

  const result: CharacterAnchor[] = characters.map((character) => ({
    ...character,
    costumeVariants: character.costumeVariants?.map((variant) => ({ ...variant })),
  }));
  const failed: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;

  for (let i = 0; i < limited.length; i++) {
    if (ctx.shouldAbort?.()) break;
    const character = limited[i];
    const customPortraitPrompt = ctx.characterPrompts?.[character.id] || ctx.characterPrompts?.[character.name];
    const portraitPlan: ImagePromptPlan = customPortraitPrompt?.trim()
      ? { prompt: customPortraitPrompt.trim() }
      : await planImagePrompt({
          purpose: 'character_portrait',
          character,
          style: ctx.style,
          requestedAspectRatio: '2:3',
          endpointId: ctx.imageEndpointId,
          model: ctx.imageModel,
        });

    let portraitOk = !!result[i].portraitImage;
    let currentPortraitRaw = '';
    if (!portraitOk) {
      try {
        const image = await providerRouter.generateImage({
          taskType: 'character',
          prompt: portraitPlan.prompt,
          negativePrompt: portraitPlan.negativePrompt,
          parameters: portraitPlan.parameters,
          aspectRatio: '2:3',
          width: 768,
          height: 1152,
          style: ctx.style,
          seed: character.seed,
          endpointId: ctx.imageEndpointId,
          model: ctx.imageModel,
        });
        currentPortraitRaw = image.imageData;
        result[i].portraitImage = await saveAsset(
          ctx.novelProjectId,
          'portrait',
          image.imageData,
          `char_${sanitizeFileName(character.name)}`,
        );
        // A newly generated portrait invalidates any older derived sheet.
        result[i].turnaroundImage = undefined;
        result[i].turnaroundSourcePortrait = undefined;
        portraitOk = true;
        okCount++;
      } catch (err) {
        console.warn(`character_anchor: portrait failed for ${character.name}`, err);
        lastErr = err;
        failed.push(character.name);
      }
      done++;
      onProgress?.(done, total);
    }

    if (character.costumeVariants?.length) {
      for (let j = 0; j < character.costumeVariants.length; j++) {
        const variant = character.costumeVariants[j];
        if (variant.id === 'default') continue;
        if (result[i].costumeVariants?.[j].portraitImage) continue;
        try {
          const variantPlan = await planImagePrompt({
            purpose: 'character_portrait',
            character,
            costumeOverride: variant.description,
            style: ctx.style,
            requestedAspectRatio: '2:3',
            endpointId: ctx.imageEndpointId,
            model: ctx.imageModel,
          });
          const image = await providerRouter.generateImage({
            taskType: 'character',
            prompt: variantPlan.prompt,
            negativePrompt: variantPlan.negativePrompt,
            parameters: variantPlan.parameters,
            aspectRatio: '2:3',
            width: 768,
            height: 1152,
            style: ctx.style,
            seed: character.seed,
            endpointId: ctx.imageEndpointId,
            model: ctx.imageModel,
          });
          result[i].costumeVariants![j].portraitImage = await saveAsset(
            ctx.novelProjectId,
            'portrait',
            image.imageData,
            `char_${sanitizeFileName(character.name)}_${sanitizeFileName(variant.id)}`,
          );
          okCount++;
        } catch (err) {
          console.warn(`character_anchor: variant failed for ${character.name}/${variant.id}`, err);
          lastErr = err;
        }
        done++;
        onProgress?.(done, total);
      }
    }

    const portraitUrl = result[i].portraitImage;
    const turnaroundIsStale = !!result[i].turnaroundSourcePortrait
      && result[i].turnaroundSourcePortrait !== portraitUrl;
    if (wantTurnaround
      && (!result[i].turnaroundImage || turnaroundIsStale)
      && portraitOk
      && (portraitUrl || currentPortraitRaw)) {
      try {
        const reference = currentPortraitRaw || await readAsDataUri(portraitUrl!);
        const customTurnaroundPrompt = ctx.turnaroundPrompts?.[character.id]
          || ctx.turnaroundPrompts?.[character.name];
        const turnaroundPlan: ImagePromptPlan = customTurnaroundPrompt?.trim()
          ? { prompt: customTurnaroundPrompt.trim() }
          : await planImagePrompt({
              purpose: 'character_turnaround',
              character,
              style: ctx.style,
              requestedAspectRatio: '3:2',
              referenceCount: reference ? 1 : 0,
              endpointId: ctx.imageEndpointId,
              model: ctx.imageModel,
            });
        const image = await providerRouter.generateImage({
          taskType: 'character',
          prompt: turnaroundPlan.prompt,
          negativePrompt: turnaroundPlan.negativePrompt,
          parameters: turnaroundPlan.parameters,
          aspectRatio: '3:2',
          width: 1536,
          height: 1024,
          style: ctx.style,
          referenceImages: reference ? [reference] : undefined,
          seed: character.seed,
          endpointId: ctx.imageEndpointId,
          model: ctx.imageModel,
        });
        result[i].turnaroundImage = await saveAsset(
          ctx.novelProjectId,
          'portrait',
          image.imageData,
          `char_${sanitizeFileName(character.name)}_turnaround`,
        );
        result[i].turnaroundSourcePortrait = portraitUrl;
        okCount++;
      } catch (err) {
        console.warn(`character_anchor: turnaround failed for ${character.name}`, err);
        lastErr = err;
        failed.push(character.name);
      }
      done++;
      onProgress?.(done, total);
    } else if (wantTurnaround && !portraitOk) {
      done++;
      onProgress?.(done, total);
    }
  }

  if (okCount === 0 && total > 0 && !result.some((character) => !!character.portraitImage)) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`All character reference generations failed: ${reason}`);
  }

  return { characters: result, failed };
}

export async function generateSingleCharacterPortrait(
  character: CharacterAnchor,
  _allCharacters: CharacterAnchor[],
  ctx: {
    style?: string;
    imageTier?: ModelTier;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
  },
): Promise<string> {
  const plan = await planImagePrompt({
    purpose: 'character_portrait',
    character,
    style: ctx.style,
    requestedAspectRatio: '2:3',
    endpointId: ctx.imageEndpointId,
    model: ctx.imageModel,
  });
  const image = await providerRouter.generateImage({
    taskType: 'character',
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    parameters: plan.parameters,
    aspectRatio: '2:3',
    width: 768,
    height: 1152,
    style: ctx.style,
    seed: character.seed,
    endpointId: ctx.imageEndpointId,
    model: ctx.imageModel,
  });
  return saveAsset(
    ctx.novelProjectId,
    'portrait',
    image.imageData,
    `char_${sanitizeFileName(character.name)}_${Date.now()}`,
  );
}

export async function generateSingleCharacterTurnaround(
  character: CharacterAnchor,
  ctx: {
    style?: string;
    imageTier?: ModelTier;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
  },
): Promise<string> {
  const reference = character.portraitImage
    ? await readAsDataUri(character.portraitImage)
    : undefined;
  const plan = await planImagePrompt({
    purpose: 'character_turnaround',
    character,
    style: ctx.style,
    requestedAspectRatio: '3:2',
    referenceCount: reference ? 1 : 0,
    endpointId: ctx.imageEndpointId,
    model: ctx.imageModel,
  });
  const image = await providerRouter.generateImage({
    taskType: 'character',
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    parameters: plan.parameters,
    aspectRatio: '3:2',
    width: 1536,
    height: 1024,
    style: ctx.style,
    referenceImages: reference ? [reference] : undefined,
    seed: character.seed,
    endpointId: ctx.imageEndpointId,
    model: ctx.imageModel,
  });
  return saveAsset(
    ctx.novelProjectId,
    'portrait',
    image.imageData,
    `char_${sanitizeFileName(character.name)}_turnaround_${Date.now()}`,
  );
}

function countAnchorsNeeded(chars: CharacterAnchor[], includeTurnaround: boolean): number {
  let count = 0;
  for (const character of chars) {
    if (!character.portraitImage) count++;
    count += character.costumeVariants?.filter(
      (variant) => variant.id !== 'default' && !variant.portraitImage,
    ).length ?? 0;
    if (includeTurnaround && needsTurnaroundGeneration(character)) count++;
  }
  return count;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

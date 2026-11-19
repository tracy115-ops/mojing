// step-scene-image.ts — 步 7:场景图生成
// 对 SceneAnchor[] 生成场景背景图。同 sceneId 跨镜共享一张。

import { providerRouter } from '@/services/providers';
import type { CharacterAnchor, SceneAnchor, AspectRatio, ModelTier } from '@/types/video';
import { saveAsset } from '../asset-store';
import { planImagePrompt } from './prompt-enricher';
import { ENVIRONMENT_REFERENCE_VERSION, isReusableEnvironmentReference } from './asset-reference-contract';

export { ENVIRONMENT_REFERENCE_VERSION } from './asset-reference-contract';

export interface SceneImageResult {
  scenes: SceneAnchor[];
  failed: string[];
}

export async function runSceneImage(
  scenes: SceneAnchor[],
  ctx: {
    aspectRatio: AspectRatio;
    style?: string;
    imageTier: ModelTier;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
    characters?: CharacterAnchor[];
    shouldAbort?: () => boolean;
  },
  onProgress?: (done: number, total: number) => void,
): Promise<SceneImageResult> {
  if (!scenes.length) return { scenes, failed: [] };

  const dims = aspectRatioToDims(ctx.aspectRatio);
  const result: SceneAnchor[] = scenes.map((s) => ({ ...s }));
  const failed: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;
  const total = scenes.filter((scene) => !isReusableEnvironmentReference(scene)).length;
  if (total === 0) return { scenes: result, failed: [] };

  for (let i = 0; i < scenes.length; i++) {
    if (ctx.shouldAbort?.()) {
      break;
    }
    const s = scenes[i];
    if (isReusableEnvironmentReference(result[i])) continue;
    // Keep stale output visible if generation fails, but remove its verified
    // status so downstream keyframe generation cannot reuse it.
    result[i].backgroundReferenceRole = undefined;
    result[i].backgroundReferenceVersion = undefined;
    try {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const plan = await planImagePrompt({
        purpose: 'scene_background',
        scene: s,
        style: ctx.style,
        requestedAspectRatio: ctx.aspectRatio,
        excludedEntities: collectEntityReferences(ctx.characters),
        endpointId: ctx.imageEndpointId,
        model: ctx.imageModel,
      });
      const img = await providerRouter.generateImage({
        taskType: 'scene',
        prompt: plan.prompt,
        negativePrompt: plan.negativePrompt,
        parameters: plan.parameters,
        aspectRatio: ctx.aspectRatio,
        width: dims.w,
        height: dims.h,
        style: ctx.style,
        endpointId: ctx.imageEndpointId,
        model: ctx.imageModel,
      });
      result[i].backgroundImage = await saveAsset(
        ctx.novelProjectId,
        'background',
        img.imageData,
        `scene_${sanitizeFileName(s.name)}`,
      );
      result[i].backgroundReferenceRole = 'environment_only';
      result[i].backgroundReferenceVersion = ENVIRONMENT_REFERENCE_VERSION;
      okCount++;
    } catch (err) {
      console.warn(`scene_image: failed for ${s.name}`, err);
      lastErr = err;
      failed.push(s.name);
    }
    done++;
    onProgress?.(done, total);
  }

  if (okCount === 0 && total > 0 && !result.some((scene) => !!scene.backgroundImage)) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 个场景图都生成失败。最近一次错误:${reason}`);
  }

  return { scenes: result, failed };
}

export async function generateSingleSceneImage(
  scene: SceneAnchor,
  ctx: {
    aspectRatio?: AspectRatio;
    style?: string;
    imageTier?: ModelTier;
    imageEndpointId?: string;
    imageModel?: string;
    novelProjectId: string;
    characters?: CharacterAnchor[];
  },
): Promise<string> {
  const dims = aspectRatioToDims(ctx.aspectRatio || '16:9');
  const plan = await planImagePrompt({
    purpose: 'scene_background',
    scene,
    style: ctx.style,
    requestedAspectRatio: ctx.aspectRatio || '16:9',
    excludedEntities: collectEntityReferences(ctx.characters),
    endpointId: ctx.imageEndpointId,
    model: ctx.imageModel,
  });
  const img = await providerRouter.generateImage({
    taskType: 'scene',
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    parameters: plan.parameters,
    aspectRatio: ctx.aspectRatio || '16:9',
    width: dims.w,
    height: dims.h,
    style: ctx.style,
    endpointId: ctx.imageEndpointId,
    model: ctx.imageModel,
  });
  const savedPath = await saveAsset(
    ctx.novelProjectId,
    'background',
    img.imageData,
    `scene_${sanitizeFileName(scene.name)}_${Date.now()}`,
  );
  return savedPath;
}

function collectEntityReferences(characters?: CharacterAnchor[]): string[] {
  return [...new Set((characters ?? []).flatMap((character) => [
    character.name,
    ...(character.aliases ?? []),
  ]).map((value) => value.trim()).filter(Boolean))];
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function aspectRatioToDims(ar: AspectRatio): { w: number; h: number } {
  switch (ar) {
    case '16:9':
      return { w: 1280, h: 720 };
    case '9:16':
      return { w: 720, h: 1280 };
    case '1:1':
      return { w: 1024, h: 1024 };
  }
}

// step-keyframe.ts — 步 9:镜头关键帧生成
// 对 ShotSpec[] 生成每镜关键帧。referenceImages 拼接:
//   - 在场角色立绘(对应 costumeVariant;无 variant 时用 default)
//   - 场景背景图
// 失败回退:该镜 keyframeImage 留空,步 10 走 T2V。

import { providerRouter } from '@/services/providers';
import type {
  ShotSpec,
  CharacterAnchor,
  SceneAnchor,
  AspectRatio,
  ModelTier,
} from '@/types/video';

export interface KeyframeResult {
  shots: ShotSpec[];
  /** 生成失败的 shotId 列表,UI 用于标黄 */
  failedShotIds: string[];
}

export async function runKeyframe(
  shots: ShotSpec[],
  ctx: {
    characters: CharacterAnchor[];
    scenes: SceneAnchor[];
    aspectRatio: AspectRatio;
    style?: string;
    imageTier: ModelTier;
  },
  onProgress?: (done: number, total: number) => void,
): Promise<KeyframeResult> {
  if (!shots.length) return { shots, failedShotIds: [] };

  const dims = aspectRatioToDims(ctx.aspectRatio);
  const charById = new Map(ctx.characters.map((c) => [c.id, c]));
  const sceneById = new Map(ctx.scenes.map((s) => [s.id, s]));

  const result: ShotSpec[] = shots.map((s) => ({ ...s }));
  const failedShotIds: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;
  const total = shots.length;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const referenceImages: string[] = [];

    // 收集在场角色立绘
    for (const charId of shot.characterIds) {
      const c = charById.get(charId);
      if (!c) continue;
      const variantId = shot.costumeVariantRefs?.[charId];
      const variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
      const img = variant?.portraitImage ?? c.portraitImage;
      if (img) referenceImages.push(img);
    }

    // 场景背景图
    if (shot.sceneId) {
      const sc = sceneById.get(shot.sceneId);
      if (sc?.backgroundImage) referenceImages.push(sc.backgroundImage);
    }

    try {
      const img = await providerRouter.generateImage({
        taskType: 'storyboard',
        prompt: buildKeyframePrompt(shot, ctx.characters, ctx.style),
        referenceImages,
        width: dims.w,
        height: dims.h,
        style: ctx.style,
      });
      result[i].keyframeImage = img.imageData;
      okCount++;
    } catch (err) {
      console.warn(`keyframe: failed for shot ${shot.id}`, err);
      lastErr = err;
      failedShotIds.push(shot.id);
      // keyframeImage 留空,步 10 自动走 T2V
    }
    done++;
    onProgress?.(done, total);
  }

  if (okCount === 0 && total > 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 个镜头关键帧都生成失败。最近一次错误:${reason}`);
  }

  return { shots: result, failedShotIds };
}

function buildKeyframePrompt(
  shot: ShotSpec,
  characters: CharacterAnchor[],
  style?: string,
): string {
  const charById = new Map(characters.map((c) => [c.id, c]));
  const presentChars = shot.characterIds
    .map((id) => charById.get(id))
    .filter((c): c is CharacterAnchor => !!c);

  const charBlock = presentChars.length
    ? presentChars
        .map((c) => {
          const variantId = shot.costumeVariantRefs?.[c.id];
          const variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
          const look = variant ? `${c.appearance}, wearing ${variant.description}` : c.appearance;
          return `- ${c.name}: ${look}`;
        })
        .join('\n')
    : '';

  // 把未生成立绘的角色(超出 limit)的外貌塞进 prompt 兜底
  return [
    'cinematic keyframe for a video shot',
    shot.videoPrompt,
    charBlock ? `\nCharacters in frame (use provided reference images; preserve face and costume exactly):\n${charBlock}` : '',
    shot.location ? `Location: ${shot.location}` : '',
    shot.mood ? `Mood: ${shot.mood}` : '',
    shot.cameraMovement ? `Camera: ${shot.cameraMovement}` : '',
    style ? `${style} style` : 'cinematic style',
    'rule of thirds, no text, no watermark',
  ]
    .filter(Boolean)
    .join(', ');
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

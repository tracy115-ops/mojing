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
import { saveAsset, readAsDataUri } from '../asset-store';
import { getStyleEnhancers } from './step-video-gen';
import { getCharacterAestheticTag } from './step-character-anchor';

export interface KeyframeResult {
  shots: ShotSpec[];
  /** 生成失败的 shotId 列表,UI 用于标黄 */
  failedShotIds: string[];
}

interface CollectedRef {
  /** 原始 URL/data URI */
  url: string;
  /** 三视图立绘:需要裁出中间 1/3 作为 reference */
  cropMiddleThird?: boolean;
}

export async function runKeyframe(
  shots: ShotSpec[],
  ctx: {
    characters: CharacterAnchor[];
    scenes: SceneAnchor[];
    aspectRatio: AspectRatio;
    style?: string;
    imageTier: ModelTier;
    novelProjectId: string;
    /** 系列上一集的收束关键帧，只影响本集第一镜。 */
    openingReferenceImage?: string;
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
    const charRefs: CollectedRef[] = [];
    const sceneRefs: CollectedRef[] = [];

    // 收集在场角色立绘（支持 ID / 名称 / 别名 / 正文与 Prompt 语义深度匹配）
    const presentChars = findMatchingCharacters(shot, ctx.characters);
    for (const c of presentChars) {
      const variantId = shot.costumeVariantRefs?.[c.id] || shot.costumeVariantRefs?.[c.name];
      let variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
      if (!variant && c.costumeVariants?.length) {
        variant = autoResolveCostumeVariant(c, `${shot.sourceText || ''} ${shot.videoPrompt || ''}`);
      }
      if (variant && variant.portraitImage) {
        charRefs.push({ url: variant.portraitImage });
      } else if (c.portraitImage) {
        charRefs.push({ url: c.portraitImage });
      }
    }

    // 场景背景图
    if (shot.sceneId) {
      const sc = sceneById.get(shot.sceneId);
      if (sc?.backgroundImage) sceneRefs.push({ url: sc.backgroundImage });
    }

    // 顺序优化(核心关键):
    // 1. 角色立绘必须排在最前面(Index 0)！因为多数 AI 绘图/多图参考 API(FLUX / DALL-E / Kolors)
    //    优先使用 referenceImages[0] 锁定人物人脸与服饰细节。之前把场景图插在 [0]，导致人脸参考图被直接忽略！
    // 2. 前一镜头关键帧(若存在且同一场景)跟在后面，确保前后镜头连贯性。
    // 3. 场景背景图跟在末尾提供环境调性。
    const prevKeyframeRef: CollectedRef[] = (i > 0 && result[i - 1]?.keyframeImage)
      ? [{ url: result[i - 1].keyframeImage! }]
      : [];

    const episodeOpeningRef: CollectedRef[] = i === 0 && ctx.openingReferenceImage
      ? [{ url: ctx.openingReferenceImage }]
      : [];
    const rawReferences: CollectedRef[] = [...charRefs, ...episodeOpeningRef, ...prevKeyframeRef, ...sceneRefs];

    // 立绘/背景图在 store 里是 webview URL(http://asset.localhost/...),
    // Agnes / 多数 provider 的 image 字段只接受 base64 data URI 或纯 base64。
    // 这里统一读盘转成 data URI — 已经是 data URI 的会原样返回。
    // 三视图立绘先转 data URI,再裁出中间 1/3 作为 reference(让 provider 拿到正视图)。
    const referenceImages: string[] = [];
    for (const ref of rawReferences) {
      const dataUri = await readAsDataUri(ref.url);
      if (ref.cropMiddleThird) {
        const cropped = await cropMiddleThird(dataUri).catch((err) => {
          console.warn('keyframe: cropMiddleThird failed, fallback to full image', err);
          return dataUri;
        });
        referenceImages.push(cropped);
      } else {
        referenceImages.push(dataUri);
      }
    }

    try {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const img = await providerRouter.generateImage({
        taskType: 'storyboard',
        prompt: buildKeyframePrompt(shot, ctx.characters, ctx.style, i > 0 ? result[i - 1] : undefined),
        referenceImages,
        width: dims.w,
        height: dims.h,
        style: ctx.style,
      });
      result[i].keyframeImage = await saveAsset(
        ctx.novelProjectId,
        'keyframe',
        img.imageData,
        `keyframe_shot_${i + 1}`,
      );
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

export async function generateSingleKeyframe(
  shot: ShotSpec,
  shotIndex: number,
  allShots: ShotSpec[],
  ctx: {
    characters: CharacterAnchor[];
    scenes: SceneAnchor[];
    aspectRatio: AspectRatio;
    style?: string;
    imageTier: ModelTier;
    novelProjectId: string;
    openingReferenceImage?: string;
  },
): Promise<string> {
  const dims = aspectRatioToDims(ctx.aspectRatio);
  const charById = new Map(ctx.characters.map((c) => [c.id, c]));
  const sceneById = new Map(ctx.scenes.map((s) => [s.id, s]));

  const charRefs: CollectedRef[] = [];
  const sceneRefs: CollectedRef[] = [];

  for (const charId of shot.characterIds) {
    const c = charById.get(charId);
    if (!c) continue;
    const variantId = shot.costumeVariantRefs?.[charId];
    const variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
    if (variant) {
      if (variant.portraitImage) {
        charRefs.push({ url: variant.portraitImage });
      }
    } else if (c.portraitImage) {
      charRefs.push({ url: c.portraitImage });
    }
  }

  if (shot.sceneId) {
    const sc = sceneById.get(shot.sceneId);
    if (sc?.backgroundImage) sceneRefs.push({ url: sc.backgroundImage });
  }

  const prevKeyframeRef: CollectedRef[] = (shotIndex > 0 && allShots[shotIndex - 1]?.keyframeImage)
    ? [{ url: allShots[shotIndex - 1].keyframeImage! }]
    : [];

  const episodeOpeningRef: CollectedRef[] = shotIndex === 0 && ctx.openingReferenceImage
    ? [{ url: ctx.openingReferenceImage }]
    : [];
  const rawReferences: CollectedRef[] = [...charRefs, ...episodeOpeningRef, ...prevKeyframeRef, ...sceneRefs];

  const referenceImages: string[] = [];
  for (const ref of rawReferences) {
    const dataUri = await readAsDataUri(ref.url);
    if (ref.cropMiddleThird) {
      const cropped = await cropMiddleThird(dataUri).catch((err) => {
        console.warn('keyframe: cropMiddleThird failed, fallback to full image', err);
        return dataUri;
      });
      referenceImages.push(cropped);
    } else {
      referenceImages.push(dataUri);
    }
  }

  const prevShot = shotIndex > 0 ? allShots[shotIndex - 1] : undefined;
  const img = await providerRouter.generateImage({
    taskType: 'storyboard',
    prompt: buildKeyframePrompt(shot, ctx.characters, ctx.style, prevShot),
    referenceImages,
    width: dims.w,
    height: dims.h,
    style: ctx.style,
  });

  return await saveAsset(
    ctx.novelProjectId,
    'keyframe',
    img.imageData,
    `keyframe_shot_${shotIndex + 1}`,
  );
}

import { buildMultiCharacterDnaTokens, autoResolveCostumeVariant, findMatchingCharacters } from './character-dna';

function buildKeyframePrompt(
  shot: ShotSpec,
  characters: CharacterAnchor[],
  style?: string,
  _prevShot?: ShotSpec,
): string {
  const isChinese = /[\u4e00-\u9fa5]/.test(shot.videoPrompt);
  const presentChars = findMatchingCharacters(shot, characters);

  // 1. 角色外貌特征（忠实保留原貌与变装）
  const charDnaText = buildMultiCharacterDnaTokens(
    presentChars,
    shot.costumeVariantRefs,
    isChinese,
    `${shot.sourceText || ''} ${shot.videoPrompt || ''}`,
  );

  if (isChinese) {
    const parts = [
      charDnaText,
      shot.videoPrompt,
      shot.location ? `场景：${shot.location}` : '',
      shot.cameraMovement ? `镜头：${shot.cameraMovement}` : '',
      shot.mood ? `氛围：${shot.mood}` : '',
      style ? `${style}风格` : '电影写实风格',
      '超高清画面，精致细节，无文字，无水印，无三视图，无分屏',
    ].filter(Boolean);
    return parts.join('，');
  }

  const parts = [
    charDnaText,
    shot.videoPrompt,
    shot.location ? `location: ${shot.location}` : '',
    shot.cameraMovement ? `camera: ${shot.cameraMovement}` : '',
    shot.mood ? `mood: ${shot.mood}` : '',
    style ? `${style} style` : 'cinematic style',
    'high quality, sharp focus, no text, no watermark, no split screen, no character sheet',
  ].filter(Boolean);

  return parts.join(', ');
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

/**
 * 三视图立绘(横向 1536×1024,正/侧/背 三视图并排)裁出中间 1/3(正视图)。
 * 输入必须是 data URI(`data:image/...;base64,...`)。
 *
 * 用 webview 里的 Image + Canvas API 完成,失败抛错(调用方有 fallback)。
 */
async function cropMiddleThird(dataUri: string): Promise<string> {
  const img = await loadImage(dataUri);
  const sw = Math.floor(img.width / 3);
  const sh = img.height;
  const sx = sw; // 中间 1/3 的 x 起点
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('canvas 2d context unavailable');
  ctx2d.drawImage(img, sx, 0, sw, sh, 0, 0, sw, sh);
  // PNG 无损,避免 JPEG 压缩损失 reference 细节
  return canvas.toDataURL('image/png');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`image load failed: ${String(e)}`));
    img.src = src;
  });
}

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

    // 收集在场角色立绘。
    // 三视图策略:
    //   - 完整三视图(model sheet)→ 让 provider 看到角色正/侧/背全貌
    //   - 裁好的正面图(中间 1/3)→ 精准锚定正脸
    //   - 单图立绘(无三视图时)→ 直接用作正面 reference
    // variant 立绘永远是单图,不走裁剪。
    for (const charId of shot.characterIds) {
      const c = charById.get(charId);
      if (!c) continue;
      const variantId = shot.costumeVariantRefs?.[charId];
      const variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
      if (variant) {
        if (variant.portraitImage) {
          charRefs.push({ url: variant.portraitImage });
        }
      } else if (c.turnaroundImage) {
        // 完整三视图先 push(作 model sheet 参考)
        charRefs.push({ url: c.turnaroundImage });
        // 再 push 裁好的正面图(精准锚定)— 同一张图会被读两次但内容不同
        charRefs.push({ url: c.turnaroundImage, cropMiddleThird: true });
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

    const rawReferences: CollectedRef[] = [...charRefs, ...prevKeyframeRef, ...sceneRefs];

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
        prompt: buildKeyframePrompt(shot, ctx.characters, ctx.style),
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

function buildKeyframePrompt(
  shot: ShotSpec,
  characters: CharacterAnchor[],
  style?: string,
): string {
  const charById = new Map(characters.map((c) => [c.id, c]));
  const presentChars = shot.characterIds
    .map((id) => charById.get(id))
    .filter((c): c is CharacterAnchor => !!c);

  let charText = '';
  if (presentChars.length === 1) {
    const c = presentChars[0];
    const variantId = shot.costumeVariantRefs?.[c.id];
    const variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
    const desc = variant ? `${c.name} (${c.appearance}, wearing ${variant.description})` : `${c.name} (${c.appearance})`;
    charText = `main character in frame: ${desc}, single isolated person, maintain 100% facial features and clothing consistency with reference image`;
  } else if (presentChars.length > 1) {
    // 多角色镜头: 注入空间位置标定与防肢体污染粘连指令
    const positions = ['left side of frame', 'right side of frame', 'center of frame'];
    const separatedChars = presentChars
      .map((c, idx) => {
        const pos = positions[idx % positions.length];
        const variantId = shot.costumeVariantRefs?.[c.id];
        const variant = variantId ? c.costumeVariants?.find((v) => v.id === variantId) : undefined;
        const desc = variant ? `${c.name} (${c.appearance}, wearing ${variant.description})` : `${c.name} (${c.appearance})`;
        return `${desc} located on ${pos}`;
      })
      .join('; distinct separate person: ');

    charText = `multiple characters in scene: [${separatedChars}]. Standalone distinct individuals with clear spatial separation, no merged bodies, no extra limbs, no overlapping torsos, sharp character silhouettes, perfect anatomy`;
  } else {
    charText = 'no humans, no people, empty scene, background scenery shot';
  }

  const parts = [
    'cinematic movie keyframe storyboard',
    shot.videoPrompt,
    charText,
    shot.location ? `location: ${shot.location}` : '',
    shot.mood ? `mood: ${shot.mood}` : '',
    shot.cameraMovement ? `camera angle: ${shot.cameraMovement}` : '',
    style ? `${style} style` : 'cinematic style',
    'masterpiece, 8k resolution, highly detailed, perfect composition',
    'no text, no watermark, no signature, no bad anatomy, no extra arms, no fused limbs',
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

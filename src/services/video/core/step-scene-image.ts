// step-scene-image.ts — 步 7:场景图生成
// 对 SceneAnchor[] 生成场景背景图。同 sceneId 跨镜共享一张。

import { providerRouter } from '@/services/providers';
import type { SceneAnchor, AspectRatio, ModelTier } from '@/types/video';

export interface SceneImageResult {
  scenes: SceneAnchor[];
  failed: string[];
}

export async function runSceneImage(
  scenes: SceneAnchor[],
  ctx: { aspectRatio: AspectRatio; style?: string; imageTier: ModelTier },
  onProgress?: (done: number, total: number) => void,
): Promise<SceneImageResult> {
  if (!scenes.length) return { scenes, failed: [] };

  const dims = aspectRatioToDims(ctx.aspectRatio);
  const result: SceneAnchor[] = scenes.map((s) => ({ ...s }));
  const failed: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;
  const total = scenes.length;

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    try {
      const img = await providerRouter.generateImage({
        taskType: 'scene',
        prompt: buildScenePrompt(s, ctx.style),
        width: dims.w,
        height: dims.h,
        style: ctx.style,
      });
      result[i].backgroundImage = img.imageData;
      okCount++;
    } catch (err) {
      console.warn(`scene_image: failed for ${s.name}`, err);
      lastErr = err;
      failed.push(s.name);
    }
    done++;
    onProgress?.(done, total);
  }

  if (okCount === 0 && total > 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 个场景图都生成失败。最近一次错误:${reason}`);
  }

  return { scenes: result, failed };
}

function buildScenePrompt(s: SceneAnchor, style?: string): string {
  return [
    `environment establishing shot of ${s.name}`,
    s.description,
    'wide angle, no people, cinematic composition',
    'rule of thirds, atmospheric lighting',
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark',
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

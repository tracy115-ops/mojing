// step-scene-image.ts — 步 7:场景图生成
// 对 SceneAnchor[] 生成场景背景图。同 sceneId 跨镜共享一张。

import { providerRouter } from '@/services/providers';
import type { SceneAnchor, AspectRatio, ModelTier } from '@/types/video';
import { saveAsset } from '../asset-store';
import { enrichScenePromptWithLLM, getStyleNameZh } from './prompt-enricher';
import { detectInputLanguage } from './lang-detector';

export interface SceneImageResult {
  scenes: SceneAnchor[];
  failed: string[];
}

export async function runSceneImage(
  scenes: SceneAnchor[],
  ctx: { aspectRatio: AspectRatio; style?: string; imageTier: ModelTier; novelProjectId: string },
  onProgress?: (done: number, total: number) => void,
): Promise<SceneImageResult> {
  if (!scenes.length) return { scenes, failed: [] };

  const dims = aspectRatioToDims(ctx.aspectRatio);
  const result: SceneAnchor[] = scenes.map((s) => ({ ...s }));
  const failed: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;
  const total = scenes.filter((scene) => !scene.backgroundImage).length;
  if (total === 0) return { scenes: result, failed: [] };

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (result[i].backgroundImage) continue;
    try {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const scenePrompt = await enrichScenePromptWithLLM(s, ctx.style);
      const img = await providerRouter.generateImage({
        taskType: 'scene',
        prompt: scenePrompt,
        width: dims.w,
        height: dims.h,
        style: ctx.style,
      });
      result[i].backgroundImage = await saveAsset(
        ctx.novelProjectId,
        'background',
        img.imageData,
        `scene_${sanitizeFileName(s.name)}`,
      );
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

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function buildScenePrompt(s: SceneAnchor, style?: string): string {
  const desc = s.description || '';
  const fullText = `${s.name} ${desc} ${style || ''}`;
  const isChinese = detectInputLanguage(fullText) === 'zh';
  const styleZh = getStyleNameZh(style);

  if (isChinese) {
    return [
      `环境空景图：${s.name}`,
      desc,
      '纯背景画面，无人物，无人影，无角色，仅风景建筑环境',
      '广角视角，电影级构图，三分法，大气光影',
      `${styleZh}风格`,
      '高清细节大作',
      '无文字，无水印，无签名，无人物',
    ]
      .filter(Boolean)
      .join('，');
  }
  return [
    `environment establishing shot of ${s.name}`,
    desc,
    'empty scene, no humans, no people, no character, background scenery only',
    'wide angle, cinematic composition, rule of thirds, atmospheric lighting',
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark, no signature, no people',
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

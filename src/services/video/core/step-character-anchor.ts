// step-character-anchor.ts — 步 6:角色立绘生成
// 对每个 CharacterAnchor 调 providerRouter.generateImage 生成 default 立绘,
// 若有 costumeVariants,每个 variant 额外生成一张。
// 单个失败不阻塞,标记 portraitImage 为 undefined。

import { providerRouter } from '@/services/providers';
import type { CharacterAnchor, ModelTier } from '@/types/video';

export interface CharacterAnchorResult {
  /** 更新后的角色(立绘已填入 portraitImage / costumeVariants[].portraitImage) */
  characters: CharacterAnchor[];
  /** 失败的角色 name 列表,UI 用于标黄 */
  failed: string[];
}

/**
 * 步 6:批量生成角色立绘。
 * limit:超出此数量的角色不生成(其外貌描述会拼到该镜头关键帧 prompt 里)。
 */
export async function runCharacterAnchor(
  characters: CharacterAnchor[],
  ctx: { style?: string; imageTier: ModelTier; limit: number },
  onProgress?: (done: number, total: number) => void,
): Promise<CharacterAnchorResult> {
  const limited = characters.slice(0, Math.max(0, ctx.limit));
  const total = countAnchorsNeeded(limited);
  if (total === 0) return { characters, failed: [] };

  const result: CharacterAnchor[] = characters.map((c) => ({ ...c, costumeVariants: c.costumeVariants?.map((v) => ({ ...v })) }));
  const failed: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;

  for (let i = 0; i < limited.length; i++) {
    const c = limited[i];
    const prompt = buildPortraitPrompt(c, ctx.style);

    // default 立绘
    try {
      const img = await providerRouter.generateImage({
        taskType: 'character',
        prompt,
        width: 768,
        height: 1152, // 2:3 portrait
        style: ctx.style,
      });
      result[i].portraitImage = img.imageData;
      okCount++;
    } catch (err) {
      console.warn(`character_anchor: failed for ${c.name}`, err);
      lastErr = err;
      failed.push(c.name);
    }
    done++;
    onProgress?.(done, total);

    // variant 立绘
    if (c.costumeVariants?.length) {
      for (let j = 0; j < c.costumeVariants.length; j++) {
        const v = c.costumeVariants[j];
        if (v.id === 'default') continue; // default 已生成
        try {
          const img = await providerRouter.generateImage({
            taskType: 'character',
            prompt: buildPortraitPrompt(c, ctx.style, v.description),
            width: 768,
            height: 1152,
            style: ctx.style,
          });
          result[i].costumeVariants![j].portraitImage = img.imageData;
          okCount++;
        } catch (err) {
          console.warn(`character_anchor: failed variant ${c.name}/${v.id}`, err);
          lastErr = err;
        }
        done++;
        onProgress?.(done, total);
      }
    }
  }

  // 如果一张图都没成功,把整个 stage 当作失败,让上层标记为 error。
  // 否则 UI 会显示 completed 但实际无任何产物。
  if (okCount === 0 && total > 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 次立绘调用都失败(${failed.length} 个角色)。最近一次错误:${reason}`);
  }

  return { characters: result, failed };
}

function countAnchorsNeeded(chars: CharacterAnchor[]): number {
  let n = 0;
  for (const c of chars) {
    n += 1; // default
    if (c.costumeVariants?.length) {
      n += c.costumeVariants.filter((v) => v.id !== 'default').length;
    }
  }
  return n;
}

function buildPortraitPrompt(c: CharacterAnchor, style?: string, costumeOverride?: string): string {
  const parts = [
    `character reference portrait of ${c.name}`,
    c.appearance,
    costumeOverride ? `wearing ${costumeOverride}` : '',
    'neutral pose, plain background, soft studio lighting',
    'full body visible from head to knee',
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark, no signature',
  ].filter(Boolean);
  return parts.join(', ');
}

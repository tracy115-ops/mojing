// step-character-anchor.ts — 步 6:角色立绘生成
//
// 每个角色生成两张图:
//   1. 单图立绘(768×1152 正面) → portraitImage
//   2. 三视图(1536×1024 正/侧/背) → turnaroundImage(独立字段,不覆盖 portraitImage)
//      用单图作 reference,保证三视图里的角色和单图是同一个人
//
// variant 立绘:每个 variant 额外生成一张单图(没有三视图)
//
// keyframe 步骤同时用 turnaroundImage(完整 model sheet + 裁中间 1/3 正面)和
// portraitImage 做 reference,让 provider 多角度看到角色设计。

import { providerRouter } from '@/services/providers';
import type { CharacterAnchor, ModelTier } from '@/types/video';
import { saveAsset, readAsDataUri } from '../asset-store';

export interface CharacterAnchorResult {
  /** 更新后的角色(立绘已填入 portraitImage / turnaroundImage / costumeVariants[].portraitImage) */
  characters: CharacterAnchor[];
  /** 失败的角色 name 列表,UI 用于标黄 */
  failed: string[];
}

/**
 * 步 6:批量生成角色立绘(单图 + 三视图)。
 * limit:超出此数量的角色不生成(其外貌描述会拼到该镜头关键帧 prompt 里)。
 *
 * 落盘:每张图生成后立即调 saveAsset 写到 appDataDir,UI 拿到的就是
 * 跨会话稳定的 webview URL(http/data URI 形式都转成本地文件)。
 *
 * anchorMode(可选,向后兼容):'single' 只生成单图(老项目/快速测试用),
 * 不传或 'turnaround' 都会同时生成单图 + 三视图。
 */
export async function runCharacterAnchor(
  characters: CharacterAnchor[],
  ctx: {
    style?: string;
    imageTier: ModelTier;
    limit: number;
    novelProjectId: string;
    /** 立绘模式:'single' 只生成单图;'turnaround'(默认) 生成单图+三视图。
     *  注意:无论选什么,portraitImage 始终会生成,不会被覆盖。 */
    anchorMode?: 'single' | 'turnaround';
    /** 用户编辑后的整体 prompt(覆盖内部 build 的拼接结果)。
     *  只对 default 单图立绘生效;三视图和 variant 仍按 build 拼接。 */
    characterPrompts?: Record<string, string>;
    /** 向后兼容的单句 promptOverride(只在其匹配指定角色时使用) */
    promptOverride?: string;
  },
  onProgress?: (done: number, total: number) => void,
): Promise<CharacterAnchorResult> {
  const limited = characters.slice(0, Math.max(0, ctx.limit));
  // 默认生成三视图,只有显式传 'single' 才跳过
  const wantTurnaround = ctx.anchorMode !== 'single';
  const total = countAnchorsNeeded(limited, wantTurnaround);
  if (total === 0) return { characters, failed: [] };

  const result: CharacterAnchor[] = characters.map((c) => ({
    ...c,
    costumeVariants: c.costumeVariants?.map((v) => ({ ...v })),
  }));
  const failed: string[] = [];
  let done = 0;
  let okCount = 0;
  let lastErr: unknown = null;

  for (let i = 0; i < limited.length; i++) {
    const c = limited[i];

    // 按角色 ID 或角色名匹配独立专属提示词，彻底防止多角色提示词踩踏与混淆
    const customPrompt = ctx.characterPrompts?.[c.id] || ctx.characterPrompts?.[c.name];
    const portraitPrompt = customPrompt && customPrompt.trim()
      ? customPrompt
      : buildPortraitPrompt(c, limited, ctx.style);
    let portraitOk = false;
    try {
      const img = await providerRouter.generateImage({
        taskType: 'character',
        prompt: portraitPrompt,
        width: 768,
        height: 1152,
        style: ctx.style,
      });
      result[i].portraitImage = await saveAsset(
        ctx.novelProjectId,
        'portrait',
        img.imageData,
        `char_${sanitizeFileName(c.name)}`,
      );
      okCount++;
      portraitOk = true;
    } catch (err) {
      console.warn(`character_anchor: portrait failed for ${c.name}`, err);
      lastErr = err;
      failed.push(c.name);
    }
    done++;
    onProgress?.(done, total);

    // --- 阶段 1b:variant 单图立绘 ---
    if (c.costumeVariants?.length) {
      for (let j = 0; j < c.costumeVariants.length; j++) {
        const v = c.costumeVariants[j];
        if (v.id === 'default') continue; // default 已生成
        try {
          const img = await providerRouter.generateImage({
            taskType: 'character',
            prompt: buildPortraitPrompt(c, limited, ctx.style, v.description),
            width: 768,
            height: 1152,
            style: ctx.style,
          });
          result[i].costumeVariants![j].portraitImage = await saveAsset(
            ctx.novelProjectId,
            'portrait',
            img.imageData,
            `char_${sanitizeFileName(c.name)}_${sanitizeFileName(v.id)}`,
          );
          okCount++;
        } catch (err) {
          console.warn(`character_anchor: failed variant ${c.name}/${v.id}`, err);
          lastErr = err;
        }
        done++;
        onProgress?.(done, total);
      }
    }

    // --- 阶段 2:三视图(默认生成,且 default 立绘成功) ---
    // 三视图作为附加产物,**不覆盖** portraitImage。
    // 用 default 立绘做 reference,保证三视图里的角色和单图是同一个人。
    const portraitUrl = result[i].portraitImage;
    if (wantTurnaround && portraitOk && portraitUrl) {
      try {
        const turnaroundRef = await readAsDataUri(portraitUrl);
        const img = await providerRouter.generateImage({
          taskType: 'character',
          prompt: buildTurnaroundPrompt(c, ctx.style, customPrompt),
          width: 1536,
          height: 1024,
          style: ctx.style,
          referenceImages: [turnaroundRef],
        });
        result[i].turnaroundImage = await saveAsset(
          ctx.novelProjectId,
          'portrait',
          img.imageData,
          `char_${sanitizeFileName(c.name)}_turnaround`,
        );
        okCount++;
      } catch (err) {
        // 三视图失败不影响主流程 — 单图立绘已成功,keyframe 会回退用单图
        console.warn(`character_anchor: turnaround failed for ${c.name} (non-blocking)`, err);
        lastErr = err;
      }
      done++;
      onProgress?.(done, total);
    } else if (wantTurnaround && !portraitOk) {
      // 单图都失败了,跳过三视图但仍计 done(避免进度卡住)
      done++;
      onProgress?.(done, total);
    }
  }

  // 如果一张图都没成功,把整个 stage 当作失败,让上层标记为 error。
  if (okCount === 0 && total > 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 次立绘调用都失败(${failed.length} 个角色)。最近一次错误:${reason}`);
  }

  return { characters: result, failed };
}

/** 计算需要生成的图片数:default + variants + (可选)turnaround */
function countAnchorsNeeded(chars: CharacterAnchor[], includeTurnaround: boolean): number {
  let n = 0;
  for (const c of chars) {
    n += 1; // default 单图
    if (c.costumeVariants?.length) {
      n += c.costumeVariants.filter((v) => v.id !== 'default').length;
    }
    if (includeTurnaround) n += 1; // 三视图(每个角色额外一张)
  }
  return n;
}

function buildPortraitPrompt(
  c: CharacterAnchor,
  _allChars: CharacterAnchor[],
  style?: string,
  costumeOverride?: string,
): string {
  // 彻底隔离单角色提示词，绝不上串其他角色的描述，防止 AI 生成时把多角色特征揉到同一个人身上
  const parts = [
    `solo, 1person, single character portrait of ${c.name}`,
    `character appearance and physical features: ${c.appearance}`,
    costumeOverride ? `wearing ${costumeOverride}` : '',
    'neutral pose, plain solid background, studio lighting',
    'full body visible from head to toe, single centered figure',
    'high quality character design sheet, concept art',
    style ? `${style} style` : 'cinematic style',
    '8k detail, photorealistic',
    'no text, no watermark, no signature, no extra people',
  ].filter(Boolean);
  return parts.join(', ');
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * 三视图(turnaround / model sheet)prompt 模板。
 * 让 provider 在同一张图里画出 正面/侧面/背面 三个角度。
 * 调用时通常会传入 default 单图作 reference,让三视图里的角色和单图保持一致。
 * 后续 keyframe 拿到三视图后会自动裁出正面那 1/3 作为 reference。
 */
function buildTurnaroundPrompt(
  c: CharacterAnchor,
  style?: string,
  customAppearance?: string,
): string {
  const appearance = customAppearance && customAppearance.trim() ? customAppearance : c.appearance;
  const parts = [
    `solo, 1person, character model sheet and turnaround sheet of ${c.name}`,
    `exclusive identity for ${c.name}: ${appearance}`,
    `showing 3 distinct angle views side-by-side of ONLY ${c.name}:`,
    `1. FRONT VIEW: full front face showing facial features, eye color, front hair and outfit of ${c.name}`,
    `2. SIDE PROFILE VIEW: 90 degree side profile showing nose shape, side silhouette and hair of ${c.name}`,
    `3. BACK VIEW: full back view showing hairstyle and outfit design from behind for ${c.name}`,
    'all 3 views must maintain 100% identical face, body proportions, clothing and art style',
    'neutral standing pose, plain solid white background, studio lighting',
    'full body visible from head to toe in each view',
    'character concept art design sheet',
    style ? `${style} style` : 'cinematic style',
    '8k resolution, photorealistic, highly detailed',
    'no text labels, no watermark, no signature, no extra people, no other characters',
  ].filter(Boolean);
  return parts.join(', ');
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

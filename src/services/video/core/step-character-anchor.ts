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
import { enrichCharacterPromptWithLLM } from './prompt-enricher';
import { detectInputLanguage } from './lang-detector';

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
  // 默认使用高保真精致单图立绘，避免生成多视图并排导致的五官变形与丑陋画面
  const wantTurnaround = ctx.anchorMode === 'turnaround';
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
      : await enrichCharacterPromptWithLLM(c, ctx.style);
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

import { getStyleEnhancers } from './step-video-gen';

export function getCharacterAestheticTag(fullText: string): string {
  const text = fullText.toLowerCase();
  const isChinese = /[\u4e00-\u9fa5]/.test(fullText);

  // 1. 显式欧美 / 外国特征
  if (/western|caucasian|american|european|blond|blonde|blue eyes|欧美|白人|金发|碧眼/i.test(text)) {
    return '';
  }

  // 2. 动物 / 宠物 / 奇幻生物 (猫/狗/胖橘猫/神兽/妖/机器人等) -> 避免强加人类面部与性别词导致毁图！
  if (/cat|dog|animal|pet|dragon|monster|robot|fox|wolf|bear|tiger|lion|bird|monkey|猫|狗|胖橘|橘猫|肥猫|动物|神兽|妖|怪|兽|机器人|坐骑|宠物|狐狸|狼|熊|虎|狮|鸟|猴|悟空/i.test(text)) {
    return isChinese
      ? '大师级角色设计，精细毛发与物理质感，生动生物特征，高品质概念图'
      : 'masterpiece character design, highly detailed fur and physical texture, expressive creature features, high quality concept art';
  }

  // 3. 男性角色 -> 东方男性美学 (英俊/汉子/儒雅/和尚/少爷/老者)
  if (/male|man|boy|monk|guy|gentleman|king|father|brother|prince|master|男|汉子|和尚|小和尚|老和尚|少年|青年|大叔|老者|皇帝|王爷|少爷|师傅|师父|公|爷|哥|侠客|书生/i.test(text)) {
    return isChinese
      ? '东方男子英俊面容，五官端正，儒雅威武气场，东方男性美学'
      : 'handsome East Asian Chinese male features, refined facial structure, dignified posture, elegant oriental male aesthetic';
  }

  // 4. 女性角色 (默认/显式女性) -> 东方女神/佳人
  return isChinese
    ? '东方绝色女子，精致面容，温婉优雅气场，瓷白肌肤，东方佳人美学'
    : 'gorgeous East Asian Chinese beauty, delicate Chinese facial features, fair porcelain skin, silky hair, elegant almond eyes, oriental goddess aesthetic';
}

function buildPortraitPrompt(
  c: CharacterAnchor,
  _allChars: CharacterAnchor[],
  style?: string,
  costumeOverride?: string,
): string {
  const fullText = `${c.name} ${c.appearance} ${style || ''} ${costumeOverride || ''}`;
  const isChinese = detectInputLanguage(fullText) === 'zh';
  const styleEnhancer = getStyleEnhancers(fullText, style);
  const isCartoonOrAnime = /anime|2d|comic|manga|二次元|动漫|动画|手绘|卡通|插画/i.test(fullText);
  const aestheticTag = getCharacterAestheticTag(fullText);

  if (isChinese) {
    const artTypeTag = isCartoonOrAnime
      ? '高清2D二次元单人角色立绘，精细动漫画作'
      : '写实人像摄影，高品质电影角色照，超高清精细特征';

    const parts = [
      `角色单人全身立绘：${c.name}`,
      aestheticTag,
      `完整外貌特征：${c.appearance}`,
      costumeOverride ? `穿着服饰：${costumeOverride}` : '',
      '全身设计锁定：保持面部、发型、发色、服装款式、服饰细节、身材比例、配饰完全一致',
      '自然站姿，纯色简洁背景，工作室光照',
      '从头到脚全身完整可见，单人居中',
      artTypeTag,
      styleEnhancer,
      '无文字，无水印，无签名，无多余人物，无残缺，无三视图模型板',
    ].filter(Boolean);
    return parts.join('，');
  }

  const artTypeTag = isCartoonOrAnime
    ? 'high quality 2D anime single character portrait, detailed anime artwork'
    : 'photorealistic portrait photography, high quality cinematic character photo, hyperrealistic detailed features';

  const parts = [
    `solo, single character portrait of ${c.name}`,
    aestheticTag,
    `complete character appearance and physical features: ${c.appearance}`,
    costumeOverride ? `wearing ${costumeOverride}` : '',
    'full-body character design lock, 100% identical face, hairstyle, hair color, clothing outfit, costume details, body proportions, and accessories',
    'neutral pose, plain simple solid background, studio lighting',
    'full body visible from head to toe, single centered figure',
    artTypeTag,
    styleEnhancer,
    'no text, no watermark, no signature, no extra people, no bad anatomy, no character sheet, no turnaround, no multiple views',
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
 * 后续 keyframe 拿到三视图后会自动裁出中间 1/3 作为 reference。
 */
function buildTurnaroundPrompt(
  c: CharacterAnchor,
  style?: string,
  customAppearance?: string,
): string {
  const appearance = customAppearance && customAppearance.trim() ? customAppearance : c.appearance;
  const fullText = `${c.name} ${appearance} ${style || ''}`;
  const isChinese = detectInputLanguage(fullText) === 'zh';
  const styleEnhancer = getStyleEnhancers(fullText, style);

  const isCartoonOrAnime = /anime|2d|comic|manga|二次元|动漫|动画|手绘|卡通|插画/i.test(fullText);
  const aestheticTag = getCharacterAestheticTag(fullText);

  if (isChinese) {
    const artTypeTag = isCartoonOrAnime
      ? '高清2D动漫角色三视图模型板'
      : '写实角色三视图摄影图，3全身摄影视角';

    const parts = [
      `三视图角色模型板，三屏并列展现3个全身姿态（左侧正面视图，中间侧面视图，右侧背面视图）：${c.name}，100%保持与参考图0的角色外观一致`,
      aestheticTag,
      `角色外貌、发型、服饰与身材细节：${appearance}`,
      '并排站立，3个独立视角，从头到脚全身完整可见',
      '纯色简洁浅色背景，工作室光照',
      artTypeTag,
      styleEnhancer,
      '100%保持正面、侧面、背面面部五官与服饰完全一致',
      '高细节大作，最高品质',
      '无文字，无数字，无标签，无水印，无标志，无多余肢体',
    ].filter(Boolean);
    return parts.join('，');
  }

  const artTypeTag = isCartoonOrAnime
    ? 'high quality 2D anime character turnaround sheet'
    : 'photorealistic character turnaround photo sheet, 3 full body photography views';

  const parts = [
    `3-panel split view character turnaround sheet, 3 full body views standing side-by-side: front view on the left, side profile view in the middle, back view on the right of ${c.name}, 100% exact identical full-body character design match with reference image 0`,
    aestheticTag,
    `character appearance, hair, costume, outfit, and body shape: ${appearance}`,
    'standing side-by-side, 3 separate angles, full body visible from head to toe',
    'simple plain solid light background, studio lighting',
    artTypeTag,
    styleEnhancer,
    '100% identical face and facial features, consistent outfit across all 3 views',
    'high quality, highly detailed, masterwork',
    'no text, no numbers, no labels, no watermark, no logo, no extra limbs',
  ].filter(Boolean);
  return parts.join(', ');
}

function sanitizeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

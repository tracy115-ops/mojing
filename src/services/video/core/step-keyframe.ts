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
  /** 角色名称，供提示词与参考图绑定 */
  charName?: string;
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
    shouldAbort?: () => boolean;
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
    if (ctx.shouldAbort?.()) {
      break;
    }
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
        charRefs.push({ url: variant.portraitImage, charName: c.name });
      } else if (c.portraitImage) {
        charRefs.push({ url: c.portraitImage, charName: c.name });
      } else if (c.turnaroundImage) {
        charRefs.push({ url: c.turnaroundImage, cropMiddleThird: true, charName: c.name });
      }
    }

    // 场景背景图
    if (shot.sceneId) {
      const sc = sceneById.get(shot.sceneId);
      if (sc?.backgroundImage) sceneRefs.push({ url: sc.backgroundImage });
    }

    // 顺序优化(核心关键):
    // 1. 角色立绘必须排在最前面(Index 0)！锁定人物人脸与服饰细节。
    // 2. 前一镜头关键帧(若存在且同一场景)跟在后面，确保空间光源与动作接戏连贯。
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
      const primaryChar = ctx.characters.find((c) =>
        (shot.characterIds || []).some((sc: string) => sc === c.name || sc === c.id || (c.aliases || []).includes(sc)),
      );
      const isChinese = /[\u4e00-\u9fa5]/.test(shot.videoPrompt);
      const negPrompt = buildKeyframeNegativePrompt(
        presentChars,
        isChinese,
        `${shot.sourceText || ''} ${shot.videoPrompt || ''}`,
      );
      const prompt = buildKeyframePrompt(
        shot,
        ctx.characters,
        ctx.style,
        i > 0 ? result[i - 1] : undefined,
        charRefs.map((cr) => cr.charName).filter(Boolean) as string[],
      );
      const img = await providerRouter.generateImage({
        taskType: 'storyboard',
        prompt,
        negativePrompt: negPrompt,
        referenceImages,
        width: dims.w,
        height: dims.h,
        style: ctx.style,
        seed: primaryChar?.seed,
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
  const isChinese = /[\u4e00-\u9fa5]/.test(shot.videoPrompt);
  const presentChars = findMatchingCharacters(shot, ctx.characters);
  const negPrompt = buildKeyframeNegativePrompt(
    presentChars,
    isChinese,
    `${shot.sourceText || ''} ${shot.videoPrompt || ''}`,
  );
  const img = await providerRouter.generateImage({
    taskType: 'storyboard',
    prompt: buildKeyframePrompt(shot, ctx.characters, ctx.style, prevShot),
    negativePrompt: negPrompt,
    referenceImages,
    width: dims.w,
    height: dims.h,
    style: ctx.style,
    seed: presentChars[0]?.seed,
  });

  return await saveAsset(
    ctx.novelProjectId,
    'keyframe',
    img.imageData,
    `keyframe_shot_${shotIndex + 1}`,
  );
}

import { buildMultiCharacterDnaTokens, autoResolveCostumeVariant, findMatchingCharacters, isCrowdScene } from './character-dna';

function buildKeyframeNegativePrompt(
  presentChars: CharacterAnchor[],
  isChinese: boolean,
  contextText = '',
): string {
  // 1. 如果分镜剧本或描述明确包含群体、街市、围观、大场面等群体情境：
  // 绝对严禁将“人群、路人、多个人物、双人、多人”等加入负向词！确保背景人群自然生成！
  if (isCrowdScene(contextText)) {
    return isChinese
      ? '分屏，三视图，多镜头拼接，文字，水印，签名，低质量，面部畸变，肢体变形'
      : 'split screen, character sheet, collage, text, watermark, signature, bad anatomy, deformed face, deformed limbs';
  }

  // 2. 区分人类与真实动物角色，封闭/聚焦镜头下的形态守卫与防幽灵角色控制
  const isAnimal = (c: CharacterAnchor) => {
    const isExplicitAnthro = /(兽人|拟人|妖怪|化形|半人|人身|anthro|furry|humanoid)/i.test(`${c.name} ${c.appearance || ''}`);
    if (isExplicitAnthro) return false;
    return /(猫|狗|小狗|小猫|橘猫|金毛|柯基|宠物|鸟|兔|狐狸|cat|dog|kitten|puppy|pet|fox|rabbit)/i.test(c.name) ||
      /(四足|纯动物|橘白相间|猫咪|毛茸茸的猫|cat fur|tabby)/i.test(c.appearance || '');
  };

  const humanChars = presentChars.filter((c) => !isAnimal(c));
  const animalChars = presentChars.filter((c) => isAnimal(c));

  const extraNegs: string[] = [];
  for (const c of animalChars) {
    extraNegs.push(
      isChinese
        ? '兽人，拟人化人形，人类身体，人类大师，人类道士，人类道长，额外人类道姑'
        : 'furry humanoid, anthropomorphic animal, human master, human monk, human Taoist, extra human priest',
    );
  }

  const extraStr = extraNegs.length > 0 ? `，${extraNegs.join('，')}` : '';

  if (humanChars.length === 0) {
    return isChinese
      ? `人物，角色，人类，女人，男人，人群，路人，多余人物，多头，多分身，分屏，三视图，文字，水印，签名${extraStr}`
      : `person, human, people, man, woman, crowd, character, 1person, 2people, extra people, split screen, character sheet, text, watermark${extraStr ? ', ' + extraStr : ''}`;
  }

  if (humanChars.length === 1) {
    const isFemale = humanChars[0].gender === 'female' || /女|妹|姐|娘|妇|姬|雪|琳|雅|母|儿|师妹/i.test(humanChars[0].name);
    const genderSpecificNeg = isFemale
      ? (isChinese ? '第二个女人，双人女性，双女，两个女人，多余女人，人类道士，人类大师，人类道姑' : '2women, 2girls, two women, two girls, second woman, extra woman, human master, human monk')
      : (isChinese ? '第二个男人，双人男性，双男，两个男人，多余男人，人类道士，人类大师' : '2men, 2boys, two men, two boys, second man, extra man, human master, human monk');

    return isChinese
      ? `多头，多分身，分屏，三视图，文字，水印，签名，未提及的前景第二人，多余人物，${genderSpecificNeg}${extraStr}`
      : `split screen, character sheet, text, watermark, unmentioned extra foreground person, extra people, ${genderSpecificNeg}${extraStr ? ', ' + extraStr : ''}`;
  }

  return isChinese
    ? `分屏，三视图，文字，水印，签名，未提及的前景额外第三人，多余人物，多余女人${extraStr}`
    : `split screen, character sheet, text, watermark, unmentioned extra foreground character, 3people, extra woman, extra person${extraStr ? ', ' + extraStr : ''}`;
}

function buildKeyframePrompt(
  shot: ShotSpec,
  characters: CharacterAnchor[],
  style?: string,
  prevShot?: ShotSpec,
  referenceCharNames?: string[],
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

  // 2. 参考图身份映射（遵循 2026 多图合成规范，杜绝动物与拟人混淆、杜绝多余路人）
  let refBindingText = '';
  if (referenceCharNames && referenceCharNames.length > 0) {
    if (referenceCharNames.length === 1) {
      refBindingText = isChinese
        ? `【单参考图对应】严格以此参考图锁定角色【${referenceCharNames[0]}】的原始面貌体态与服饰，全场严格仅有此1位主角，严禁添加任何未在参考图中的多余人物`
        : `[Reference] Match character [${referenceCharNames[0]}] appearance strictly from the reference image, strictly NO unmentioned extra character`;
    } else {
      const mappings = referenceCharNames.map((name, idx) => `图${idx + 1}对应在场主体【${name}】`).join('，');
      refBindingText = isChinese
        ? `【多图参考对应】${mappings}，全场画面严格仅有这${referenceCharNames.length}个在场主体，绝不允许出现任何参考图以外的第二女人或多余人物！画面主角严格按照各参考图还原体态外貌与色彩，主次层次分明`
        : `[Reference Mapping] ${referenceCharNames.map((name, idx) => `Image ${idx + 1} is [${name}]`).join(', ')}, exactly these ${referenceCharNames.length} subjects in the scene, strictly NO additional person outside reference images!`;
    }
  }

  // 3. 景别与构图自适应增强 (特写强化面部微表情/眼神光，全景强化全身比例与真实接地投影)
  let framingText = '';
  const promptLower = (shot.videoPrompt || '').toLowerCase();
  const isCloseUp = /(特写|面部|脸部|微表情|眼神|头部特写|眼眸|close-up|closeup|face close)/i.test(promptLower);
  const isWideShot = /(全景|远景|大全景|广角|全身|wide shot|long shot|full body)/i.test(promptLower);
  const isMediumShot = /(中景|近景|半身|胸像|medium shot|waist up)/i.test(promptLower);

  if (isCloseUp) {
    framingText = isChinese
      ? '【特写镜头景别】强化五官面部微表情，眼神聚焦清澈带有眼神光，发丝与皮肤纹理极其细腻，背景自然景深虚化'
      : '[Close-up Framing] Enhanced subtle facial expression, clear eye contact with catchlights, extremely fine hair and skin textures, shallow depth of field';
  } else if (isWideShot) {
    framingText = isChinese
      ? '【全景/远景景别】展现全身完整比例与站姿体态，脚踏实地并带有真实地面接触阴影(Contact Shadow)，环境空间透视恢弘自然'
      : '[Wide-shot Framing] Full body proportions and posture, realistic ground contact shadow, grand spatial perspective';
  } else if (isMediumShot) {
    framingText = isChinese
      ? '【中近景构图】半身肢体动作自然，衣褶与服饰细节分明，黄金比例构图'
      : '[Medium-shot Framing] Natural upper body gesture, crisp clothing folds, golden ratio composition';
  }

  // 4. 前后分镜接戏与空间/光影连续性
  let continuityText = '';
  if (prevShot) {
    const isSameScene = (prevShot.sceneId && shot.sceneId && prevShot.sceneId === shot.sceneId)
      || (prevShot.location && shot.location && prevShot.location === shot.location);
    if (isSameScene) {
      continuityText = isChinese
        ? '【镜头接戏连贯】承接上一镜头的环境空间位置、同款色温与主光源投射角度、动作走向与氛围保持高度一致'
        : '[Shot Continuity] seamlessly inherits spatial position, color temperature, key light direction, and motion trajectory from previous shot';
    }
  }

  if (isChinese) {
    const parts = [
      refBindingText,
      charDnaText,
      framingText,
      shot.videoPrompt,
      continuityText,
      shot.location ? `场景：${shot.location}` : '',
      shot.cameraMovement ? `镜头：${shot.cameraMovement}` : '',
      shot.mood ? `氛围：${shot.mood}` : '',
      style ? `${style}风格` : '电影写实风格',
    ].filter(Boolean);
    return parts.join('，');
  }

  const parts = [
    refBindingText,
    charDnaText,
    framingText,
    shot.videoPrompt,
    continuityText,
    shot.location ? `location: ${shot.location}` : '',
    shot.cameraMovement ? `camera: ${shot.cameraMovement}` : '',
    shot.mood ? `mood: ${shot.mood}` : '',
    style ? `${style} style` : 'cinematic style',
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

// step-video-gen.ts — 步 10:视频生成(T2V / I2V 切换)
// shot.keyframeImage 存在 → I2V(referenceImages=[keyframe])
// 否则 → T2V
// 保留并发池(VIDEO_GENERATION_CONCURRENCY),单镜失败不阻塞其他。

import { providerRouter } from '@/services/providers';
import type {
  ShotSpec,
  GeneratedClip,
  VideoSpec,
  CharacterAnchor,
} from '@/types/video';
import { saveAsset, readAsDataUri, isValidVideoClip } from '../asset-store';
import { detectInputLanguage } from './lang-detector';

const VIDEO_GENERATION_CONCURRENCY = 2;

export interface VideoGenOptions {
  spec: Pick<VideoSpec, 'resolution' | 'fps' | 'videoTier'>;
  /** Direct modal 传入具体的 endpointId(可选);Novel pipeline 走全局 primary */
  endpointId?: string;
  /** Direct modal 传入具体的 model(可选);Novel 用 tierToDefaultModel */
  model?: string;
  /** 视频来源标记 */
  sceneSource?: 'novel' | 'direct';
  sourceMode?: 'pure' | 'extract' | 'multishot';
  characters?: CharacterAnchor[];
  /**
   * 用于产物落盘(appDataDir/video-assets/<projectId>/clip/)。
   * Novel pipeline 总是传;Direct modal 可不传 — 不传则不落盘,
   * clip.videoUrl 直接用 provider 返回的原值(关闭重开会失效,但 direct 模式本来就不 persist)。
   */
  novelProjectId?: string;
}

export interface VideoGenResult {
  clips: GeneratedClip[];
  failedShotIds: string[];
}

/**
 * 步 10:并发跑所有镜头。
 * enableI2V=false 时强制 T2V(忽略 keyframeImage)。
 *
 * 断点续跑:如果 preExistingClips 里有某个 shotId 的 clip 且 videoUrl 仍有效,
 * 该 shot 直接跳过不重跑。failedShotIds 会合并进返回结果(便于上游 UI 高亮)。
 */
export async function runVideoGen(
  shots: ShotSpec[],
  options: VideoGenOptions,
  enableI2V: boolean,
  onProgress?: (done: number, total: number) => void,
  shouldAbort?: () => boolean,
  /** 单镜完成立即回调,让 UI 能流式看到 clip 填入(否则要等全部跑完才有数据) */
  onClip?: (clip: GeneratedClip) => void,
  /** 已有的 clip(从持久化状态传入),用于 shot 级断点续跑 */
  preExistingClips?: GeneratedClip[],
): Promise<VideoGenResult> {
  // 用 Map 快速查:哪些 shotId 已经有真正可播放/可合成的有效 clip (排除历史残留的 video_xxx ID 字符串)
  const existingByShotId = new Map<string, GeneratedClip>();
  for (const c of preExistingClips ?? []) {
    if (c.shotId && isValidVideoClip(c)) {
      existingByShotId.set(c.shotId, c);
    }
  }

  // 只跑没有有效 clip 的 shot
  const toRun = shots.filter((s) => !existingByShotId.has(s.id));
  const skippedCount = shots.length - toRun.length;

  // failedShotIds 只记本次新跑失败的 shot(之前跑成的不会被标失败)
  const failedShotIds: string[] = [];
  const clips: GeneratedClip[] = [];
  let done = 0;
  let lastErr: unknown = null;
  const total = toRun.length;
  onProgress?.(0, total);

  if (total === 0) {
    // 全部 shot 都已有 clip,直接返回(返回空 clips 数组,上游用 preExistingClips)
    return { clips: [], failedShotIds: [] };
  }

  const pending = toRun.slice();
  const worker = async (): Promise<void> => {
    while (pending.length > 0 && !shouldAbort?.()) {
      const shot = pending.shift();
      if (!shot) break;
      try {
        const clip = await generateOne(shot, options, enableI2V);
        clips.push(clip);
        onClip?.(clip);
      } catch (err) {
        console.warn(`video_gen: failed for shot ${shot.id}`, err);
        lastErr = err;
        failedShotIds.push(shot.id);
      }
      done++;
      onProgress?.(done, total);
    }
  };

  const workers = Array.from({ length: Math.min(VIDEO_GENERATION_CONCURRENCY, Math.max(1, toRun.length)) }, () => worker());
  await Promise.all(workers);

  // 如果本次有要跑的 shot 但全部失败,抛错让上层标记 stage 为 error
  if (total > 0 && clips.length === 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 个视频生成都失败(已有 ${skippedCount} 个 clip 被跳过)。最近一次错误:${reason}`);
  }

  return { clips, failedShotIds };
}

/**
 * 单镜头生成视频片段（供单镜头重生成与精修使用）
 */
export async function generateSingleVideoClip(
  shot: ShotSpec,
  options: VideoGenOptions,
  enableI2V = true,
): Promise<GeneratedClip> {
  return generateOne(shot, options, enableI2V);
}

async function generateOne(
  shot: ShotSpec,
  options: VideoGenOptions,
  enableI2V: boolean,
): Promise<GeneratedClip> {
  const [w, h] = parseResolution(options.spec.resolution);
  // Agnes / 部分其他 provider 的 image 字段要 base64,不接受 URL。
  // asset-store 落盘后 keyframe 可能是 webview URL,这里读盘转回 data URI。
  let referenceImages: string[] = [];
  const refSource = shot.keyframeImage
    || options.characters?.find((c) => shot.characterIds.includes(c.id))?.portraitImage;
  if (enableI2V && refSource) {
    const dataUri = await readAsDataUri(refSource);
    if (dataUri) {
      referenceImages.push(dataUri);
    }
  }

  const enhancedPrompt = buildEnhancedVideoPrompt(shot);
  const targetModel = options.model ?? tierToDefaultModel(options.spec.videoTier);

  let response;
  try {
    response = await providerRouter.generateVideo({
      taskType: 'clip',
      prompt: enhancedPrompt,
      model: targetModel,
      endpointId: options.endpointId,
      width: w,
      height: h,
      durationSeconds: shot.durationSeconds,
      fps: options.spec.fps,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    });
  } catch (err) {
    // 如果 I2V 模式报错(中转站不支持参考图/参考图过大/模型拒绝 I2V),自动平滑回退到 T2V 模式重试
    if (enableI2V && referenceImages.length > 0) {
      console.warn(`video_gen: I2V failed for shot ${shot.id}, falling back to T2V`, err);
      response = await providerRouter.generateVideo({
        taskType: 'clip',
        prompt: enhancedPrompt,
        model: targetModel,
        endpointId: options.endpointId,
        width: w,
        height: h,
        durationSeconds: shot.durationSeconds,
        fps: options.spec.fps,
        referenceImages: undefined,
      });
    } else {
      throw err;
    }
  }

  // 落盘:把 http URL / data URI 转成稳定的本地文件路径(Novel 模式下)。
  // Direct 模式不落盘(novelProjectId 没传)。
  const videoUrl = options.novelProjectId
    ? await saveAsset(options.novelProjectId, 'clip', response.videoData, `clip_shot_${shot.index + 1}`)
    : response.videoData;

  return {
    shotId: shot.id,
    videoUrl,
    thumbnailUrl: undefined,
    durationSeconds: response.durationSeconds || shot.durationSeconds,
    provider: response.provider,
    model: response.model,
    hasAudio: false,
    generatedAt: new Date().toISOString(),
    keyframeImage: shot.keyframeImage,
    sceneSource: options.sceneSource,
    sourceMode: options.sourceMode,
  };
}

function parseResolution(s: string): [number, number] {
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) return [1920, 1080];
  return [Number(m[1]), Number(m[2])];
}

/**
 * 根据 tier 选默认模型 ID。
 *
 * **重要**:返回空字符串,让 adapter 内置默认值生效。
 * 之前硬编码 'kling-v2',导致切到 Agnes Video Provider 后
 * 仍然传 'kling-v2' → Agnes API `model_not_found` 错误。
 *
 * 用户如果需要特定模型,应在「设置 → 任务模型 → 视频」里显式指定。
 */
export function tierToDefaultModel(_tier: VideoSpec['videoTier']): string {
  return '';
}

/**
 * 智能画面风格增强矩阵：根据用户选择的风格预设与提示词语境，动态匹配最佳画质与艺术调色词，
 * 彻底消除硬编码风格冲突（如给二次元动漫强加 8K 写实数码、给复古老电影强加现代 ARRI 镜头）。
 */
export function getStyleEnhancers(promptText: string, stylePreset?: string): string {
  const text = (promptText + ' ' + (stylePreset || '')).toLowerCase();
  const isChinese = /[\u4e00-\u9fa5]/.test(promptText);

  // 1. 二次元 / 动漫 / 漫画
  if (stylePreset === 'anime' || /anime|2d|comic|manga|二次元|动漫|动画|手绘|新海诚|日漫/i.test(text)) {
    return isChinese
      ? '二次元动漫美学，新海诚电影画风，精细赛璐璐勾线，高清2D动画，细腻背景画作，动漫名场面，自然流畅动作'
      : 'vibrant anime visual style, Makoto Shinkai aesthetic, clean cel shading, high quality 2D animation, detailed background artwork, masterpiece anime keyframe, smooth animation movement';
  }

  // 2. 复古胶片 / 80-90年代港片 / 邵氏武侠
  if (stylePreset === 'retro_film' || /80年代|90年代|邵氏|港产|武侠|胶片|复古|老电影|黄调|颗粒|色散|软焦|晕光|vintage|retro|film|grain|1980s|1990s|shaw brothers/i.test(text)) {
    return isChinese
      ? '1980年代胶片复古美学，邵氏电影武侠画风，暖色饱和度港片调色，柔光晕染，怀旧复古胶片质感，光学镜头色散'
      : '1980s vintage 35mm film aesthetic, Shaw Brothers wuxia movie style, warm saturated retro film color grading, soft glow halation, nostalgic analog film texture, optical lens dispersion';
  }

  // 3. 国风水墨 / 仙侠古风
  if (/国风|水墨|仙侠|古风|水墨画|汉服|wuxia|xianxia|ink wash|chinese aesthetic/i.test(text)) {
    return isChinese
      ? '传统东方美学，古风仙侠电影意境，柔和大气光影，高雅东方艺术构图，电影级色彩和谐'
      : 'traditional Chinese aesthetic, elegant wuxia movie atmosphere, soft atmospheric lighting, graceful oriental artistic composition, cinematic color harmony';
  }

  // 4. 赛博朋克 / 科幻
  if (/cyberpunk|sci-fi|neon|futuristic|赛博朋克|科幻|霓虹|机甲/i.test(text)) {
    return isChinese
      ? '赛博朋克美学，绚丽霓虹灯光倒影，大气科幻构图，高清电影质感'
      : 'cyberpunk aesthetic, vibrant neon reflections, volumetric fog, atmospheric futuristic lighting, cinematic sci-fi composition';
  }

  // 5. 真实纪录片 / 自然风光
  if (stylePreset === 'documentary' || /documentary|realistic|nature|real life|纪录片|真实|写实|自然/i.test(text)) {
    return isChinese
      ? '国家地理纪录片风格，自然日光，真实物理细节，真实色彩平衡，高清清晰对焦'
      : 'National Geographic documentary style, natural daylight, photorealistic textures, realistic physical details, true-to-life color balance, crisp focus';
  }

  // 6. 默认: 现代商业级电影大片 (Cinematic)
  return isChinese
    ? '电影级光影，35mm镜头景深虚化，自然动作，高细节大作构图，清晰无瑕'
    : 'cinematic movie lighting, 35mm lens depth of field, natural motion, high detail, masterpiece composition, no artifact, clean focus';
}

function buildEnhancedVideoPrompt(shot: ShotSpec, stylePreset?: string): string {
  const basePrompt = shot.videoPrompt.trim();
  const isChinese = detectInputLanguage(basePrompt + ' ' + (shot.mood || '') + ' ' + (shot.narration || '')) === 'zh';

  // 对白/旁白镜头: 显式注入说话口型与面部动效提示词 (解决说话与配音对不上的问题)
  const lipSyncPrompt = shot.narration && shot.narration.trim().length > 0
    ? (isChinese
        ? '角色自然说话，唇形与嘴唇动作同步，面部表情生动'
        : 'character speaking naturally, realistic lip movement synced to dialogue, expressive mouth animation')
    : '';

  // 多角色同框镜头: 显式注入独立肢体与空间分隔提示词 (解决肢体相互污染粘连的问题)
  const multiCharIsolation = shot.characterIds && shot.characterIds.length > 1
    ? (isChinese
        ? '主体清晰分明，独立人物动作，无肢体融合，无肢体重叠，边界清晰'
        : 'distinct separate figures, no body fusion, no overlapping limbs, clean character boundaries, independent character movement')
    : '';

  // 关键原则：用户原始提示词第一优先！
  // 如果用户的提示词本身已经很详细（> 50 字符），说明用户提供了精准的艺术指导，
  // 系统绝不上串或硬加预置模板词，保持 100% 用户原意，零污染零稀释！
  const isUserDetailedPrompt = basePrompt.length > 50;

  const delimiter = isChinese ? '，' : ', ';

  if (isUserDetailedPrompt) {
    return [
      basePrompt,
      lipSyncPrompt,
      multiCharIsolation,
    ].filter(Boolean).join(delimiter);
  }

  // 仅在用户提示词极其简短时，才补全默认基础镜头与风格辅助词
  const camera = shot.cameraMovement
    ? (isChinese ? `${shot.cameraMovement}运镜` : `${shot.cameraMovement} camera movement`)
    : '';
  const mood = shot.mood
    ? (isChinese ? `${shot.mood}氛围` : `${shot.mood} atmosphere`)
    : '';
  const styleEnhancers = getStyleEnhancers(basePrompt + ' ' + (shot.mood || ''), stylePreset);

  return [
    basePrompt,
    camera,
    mood,
    lipSyncPrompt,
    multiCharIsolation,
    styleEnhancers,
  ].filter(Boolean).join(delimiter);
}

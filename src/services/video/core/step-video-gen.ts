// step-video-gen.ts — 视频生成(T2V / 关键帧 I2V / 主体参考)
// 关键帧定义时间位置，主体参考图只约束身份，二者不能共用数组位置语义。
// 保留并发池(VIDEO_GENERATION_CONCURRENCY),单镜失败不阻塞其他。

import { providerRouter } from '@/services/providers';
import type {
  ShotSpec,
  GeneratedClip,
  VideoSpec,
  CharacterAnchor,
  SceneAnchor,
  ShotReferenceAsset,
  ShotGenerationExecutionContext,
} from '@/types/video';
import type { VideoControlMode } from '@/types/providers';
import type { GenerationReferenceInput } from '@/types/providers';
import {
  saveAsset,
  readAsDataUri,
  isValidVideoClip,
  isAssetAvailable,
  getAssetDirectory,
  isRemoteUrl,
  resolveLocalPath,
  toWebviewUrl,
} from '../asset-store';
import { extractLastFrame } from '../ffmpeg-bridge';
import { mergeClipsByShotId } from './clip-order';
import {
  getAdjacentShot,
  getContinuityHandoffIssue,
  getEffectiveShotSeed,
  shouldUseRenderedTailAsFirstFrame,
  shotsShareScene,
  shotsShareSubjects,
} from './shot-continuity';
import {
  buildSubjectExclusionPrompt,
  findMatchingCharacters,
} from './character-dna';
import { resolveCharacterReferenceImage } from './character-asset-binding';
import { selectVideoControlMode } from '@/services/providers/provider-capabilities';
import { fingerprintPayload } from '@/services/providers/generation-snapshot';
import { fingerprintShotInputs, isGeneratedVideoCurrent } from './shot-generation-receipt';
import { isApprovedVideoClip, isShotKeyframeApproved } from './shot-production-contract';
import { generateSingleKeyframe } from './step-keyframe';
import { buildVideoGenerationPrompt } from './shot-motion-prompt';

const VIDEO_GENERATION_CONCURRENCY = 2;

export interface VideoGenOptions {
  spec: Pick<VideoSpec, 'resolution' | 'fps' | 'videoTier'> & Partial<Pick<VideoSpec, 'aspectRatio'>>;
  /** Image endpoint used by character, scene, and keyframe stages. */
  imageEndpointId?: string;
  /** Style guide used when a rendered tail is turned into the next keyframe. */
  imageStyle?: string;
  /** Scene library used by continuity keyframe generation. */
  scenes?: SceneAnchor[];
  /** Optional fixed image model; omitted so the planner may choose an advertised model. */
  imageModel?: string;
  /** Direct modal 传入具体的 endpointId(可选);Novel pipeline 走全局 primary */
  endpointId?: string;
  /** Direct modal 传入具体的 model(可选);Novel 用 tierToDefaultModel */
  model?: string;
  /** 视频来源标记 */
  sceneSource?: 'novel' | 'direct';
  sourceMode?: 'pure' | 'extract' | 'multishot';
  characters?: CharacterAnchor[];
  /** 所有镜头列表，用于提取前后镜头的连续性与首尾帧衔接 */
  allShots?: ShotSpec[];
  /** I2V 质量模式：缺少关键帧或 I2V 请求失败时禁止静默退回 T2V。 */
  requireKeyframeForI2V?: boolean;
  /** Optional explicit mode from a single-shot workspace. Pipeline runs auto-select from capabilities. */
  controlMode?: VideoControlMode;
  /** Only an explicit caller may opt into an I2V -> T2V quality downgrade. */
  allowReferenceFallback?: boolean;
  /** Batch production must prove the previous tail before continuing a matching sequence. */
  requireContinuityHandoff?: boolean;
  /**
   * Which temporal artifact is allowed to become the provider's first frame.
   * The approved keyframe is the default; previous-tail handoff is explicit.
   */
  temporalAuthority?: 'approved_keyframe' | 'previous_tail';
  /** Rebuild matching-shot keyframes from the previous rendered tail. */
  continuityKeyframeMode?: 'off' | 'tail_anchor';
  /**
   * An explicit transition plan may opt into a future keyframe as the
   * provider's last-frame constraint. Disabled by default because forcing a
   * future still can make providers morph through unrelated poses or subjects.
   */
  usePlannedLastFrame?: boolean;
  /** Optional manual seed from the single-shot workspace. */
  seed?: number;
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
  /** Called when continuity production creates a new keyframe for a shot. */
  onShotUpdate?: (shot: ShotSpec) => void,
): Promise<VideoGenResult> {
  if (enableI2V && options.requireKeyframeForI2V) {
    const blockedKeyframes = shots.filter((shot) => !isShotKeyframeApproved(shot));
    if (blockedKeyframes.length > 0) {
      throw new Error(
        `I2V requires a current approved keyframe. Review or regenerate these shots before video generation: ${blockedKeyframes.map((shot) => shot.index + 1).join(', ')}`,
      );
    }
  }

  // 用 Map 快速查:哪些 shotId 已经有真正可播放/可合成的有效 clip (排除历史残留的 video_xxx ID 字符串)
  const existingByShotId = new Map<string, GeneratedClip>();
  const preExistingByShotId = new Map((preExistingClips ?? []).map((clip) => [clip.shotId, clip]));
  const usesPreviousTailAuthority = shouldUsePreviousTailAuthority(options);
  for (const c of preExistingClips ?? []) {
    const shot = shots.find((candidate) => candidate.id === c.shotId);
    const previousShot = shot ? getAdjacentShot(options.allShots, shot, -1) : undefined;
    const previousClip = previousShot ? preExistingByShotId.get(previousShot.id) : undefined;
    const matchesContinuitySegment = !!previousShot
      && shotsShareScene(previousShot, shot!)
      && shotsShareSubjects(previousShot, shot!);
    const requiresTailAnchoredKeyframe = options.continuityKeyframeMode === 'tail_anchor'
      && !!previousShot
      && shotsShareScene(previousShot, shot!)
      && shotsShareSubjects(previousShot, shot!);
    const hasApprovedPreviousTail = !!previousShot
      && isApprovedVideoClip(previousShot, previousClip)
      && !!previousClip?.lastFrameImage;
    const requiresRenderedTailHandoff = usesPreviousTailAuthority
      && !!options.requireContinuityHandoff
      && matchesContinuitySegment
      && !shot?.manualReferenceImage
      && c.videoControlMode === 'keyframe'
      && hasApprovedPreviousTail;
    const hasTailHandoffReceipt = c.generationContext?.continuity?.source === 'previous_tail'
      && c.videoReferenceAssets?.some((asset) => asset.kind === 'previous' && asset.sentToProvider !== false);
    if (
      shot
      && (!requiresTailAnchoredKeyframe || hasTailHandoffReceipt)
      && (!requiresRenderedTailHandoff || hasTailHandoffReceipt)
      && isGeneratedVideoCurrent(shot, c, resolveVideoExecutionContext({ ...options, model: getParameterModel(shot.videoParameters) ?? options.model }))
      && isValidVideoClip(c)
      && await isAssetAvailable(c.videoUrl)
    ) {
      existingByShotId.set(c.shotId, c);
    }
  }

  // 只跑没有有效 clip 的 shot
  const toRun = shots.filter((s) => !existingByShotId.has(s.id));
  const skippedCount = shots.length - toRun.length;

  // failedShotIds 只记本次新跑失败的 shot(之前跑成的不会被标失败)
  const failedShotIds: string[] = [];
  const generatedClips: GeneratedClip[] = [];
  const clipsByShotId = new Map(existingByShotId);
  let done = 0;
  let lastErr: unknown = null;
  const total = toRun.length;
  onProgress?.(skippedCount, shots.length);

  if (total === 0) {
    // 全部 shot 都已有 clip,直接返回(返回空 clips 数组,上游用 preExistingClips)
    return { clips: mergeClipsByShotId([...existingByShotId.values()], [], shots), failedShotIds: [] };
  }

  const pending = toRun.slice();
  const continuityMode = (options.allShots?.length ?? 0) > 1;
  const worker = async (): Promise<void> => {
    while (pending.length > 0 && !shouldAbort?.()) {
      const shot = pending.shift();
      if (!shot) break;
      try {
        const previousShot = getAdjacentShot(options.allShots, shot, -1);
        const previousClip = previousShot ? clipsByShotId.get(previousShot.id) : undefined;
        const previousLastFrameImage = previousShot
          && shotsShareScene(previousShot, shot)
          && shotsShareSubjects(previousShot, shot)
          && isApprovedVideoClip(previousShot, previousClip)
          ? previousClip?.lastFrameImage
          : undefined;
        if (options.continuityKeyframeMode === 'tail_anchor' && !shot.manualReferenceImage) {
          const handoffIssue = getContinuityHandoffIssue(
            previousShot,
            shot,
            previousLastFrameImage ? previousClip : undefined,
          );
          if (handoffIssue) {
            throw new Error(
              `Shot ${shot.index + 1} cannot continue the previous shot: ${handoffIssue === 'missing_previous_clip'
                ? `shot ${previousShot?.index === undefined ? '?' : previousShot.index + 1} has no valid video output`
                : `shot ${previousShot?.index === undefined ? '?' : previousShot.index + 1} has no extracted tail frame`}`,
            );
          }
        }
        const clip = await generateOne(shot, options, enableI2V, previousLastFrameImage, onShotUpdate);
        clipsByShotId.set(shot.id, clip);
        generatedClips.push(clip);
        onClip?.(clip);
      } catch (err) {
        console.warn(`video_gen: failed for shot ${shot.id}`, err);
        lastErr = err;
        failedShotIds.push(shot.id);
      }
      done++;
      onProgress?.(skippedCount + done, shots.length);
    }
  };

  const concurrency = continuityMode ? 1 : VIDEO_GENERATION_CONCURRENCY;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, toRun.length)) }, () => worker());
  await Promise.all(workers);

  if (failedShotIds.length > 0 && options.requireKeyframeForI2V) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`I2V 生成有 ${failedShotIds.length} 个镜头失败，已禁止降级为 T2V。最近一次错误：${reason}`);
  }

  // 如果本次有要跑的 shot 但全部失败,抛错让上层标记 stage 为 error
  if (total > 0 && clipsByShotId.size === 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 个视频生成都失败(已有 ${skippedCount} 个 clip 被跳过)。最近一次错误:${reason}`);
  }

  return {
    clips: mergeClipsByShotId([...existingByShotId.values()], generatedClips, shots),
    failedShotIds,
  };
}

/**
 * 单镜头生成视频片段（供单镜头工作台、重生成与精修使用）
 */
export async function generateSingleVideoClip(
  shot: ShotSpec,
  options: VideoGenOptions,
  enableI2V = true,
  previousLastFrameImage?: string,
  onShotUpdate?: (shot: ShotSpec) => void,
): Promise<GeneratedClip> {
  return generateOne(shot, options, enableI2V, previousLastFrameImage, onShotUpdate);
}

async function generateOne(
  shot: ShotSpec,
  options: VideoGenOptions,
  enableI2V: boolean,
  previousLastFrameImage?: string,
  onShotUpdate?: (shot: ShotSpec) => void,
): Promise<GeneratedClip> {
  if (enableI2V && options.requireKeyframeForI2V && !isShotKeyframeApproved(shot)) {
    throw new Error(`Shot ${shot.index + 1} requires a current approved keyframe before I2V generation`);
  }
  const [w, h] = parseResolution(options.spec.resolution);
  const targetModel = getParameterModel(shot.videoParameters)
    ?? (options.model?.trim() || undefined);
  const videoCapabilities = enableI2V
    ? providerRouter.getVideoCapabilities('clip', targetModel, options.endpointId)
    : undefined;
  let referenceImages: string[] = [];
  const subjectReferences: Array<{ id: string; image: string; label?: string }> = [];
  let videoReferenceAssets: ShotReferenceAsset[] = [];
  let firstFrame: string | undefined;
  let lastFrame: string | undefined;
  let renderedTailUsed = false;
  const previousShot = getAdjacentShot(options.allShots, shot, -1);
  const nextShot = getAdjacentShot(options.allShots, shot, 1);
  const hasMatchingPreviousShot = !!previousShot
    && shotsShareScene(previousShot, shot)
    && shotsShareSubjects(previousShot, shot);
  if (options.continuityKeyframeMode === 'tail_anchor'
    && hasMatchingPreviousShot
    && !shot.manualReferenceImage
    && options.controlMode !== 'reference'
    && options.controlMode !== 'text'
    && !previousLastFrameImage) {
    throw new Error(
      `Shot ${shot.index + 1} requires the previous rendered tail frame before generation can continue`,
    );
  }

  if (
    enableI2V
    && options.continuityKeyframeMode === 'tail_anchor'
    && hasMatchingPreviousShot
    && previousLastFrameImage
    && options.novelProjectId
  ) {
    // Rendered output is the only artifact that proves where the previous
    // shot actually ended. Rebuild the next still from that tail before I2V
    // instead of sending an unrelated portrait or a stale planned still.
    const continuityKeyframe = await generateSingleKeyframe(
      shot,
      shot.index,
      options.allShots ?? [shot],
      {
        characters: options.characters ?? [],
        scenes: options.scenes ?? [],
        aspectRatio: options.spec.aspectRatio ?? '16:9',
        style: options.imageStyle,
        imageTier: 'value',
        imageEndpointId: options.imageEndpointId,
        imageModel: options.imageModel,
        novelProjectId: options.novelProjectId,
        seed: getEffectiveShotSeed(shot, options.seed),
        requireCharacterReferences: false,
        continuityReferenceImage: previousLastFrameImage,
        continuityReferenceShotIndex: previousShot?.index,
        preferContinuityReference: true,
      },
    );
    shot = {
      ...shot,
      keyframeImage: continuityKeyframe.imagePath,
      keyframeInputFingerprint: continuityKeyframe.inputFingerprint,
      keyframeGenerationContext: continuityKeyframe.executionContext,
      referenceAssets: continuityKeyframe.referenceAssets,
      generationPlan: continuityKeyframe.generationPlan,
    };
    onShotUpdate?.(shot);
  }
  let controlMode: VideoControlMode = 'text';
  if (enableI2V) {
    if (!videoCapabilities) throw new Error('Video capabilities are unavailable for I2V generation');
    const requestedMode = options.controlMode;
    const presentCharactersForReferences = findMatchingCharacters(shot, options.characters);
    const loadTemporalReferences = requestedMode === 'keyframe'
      || (!requestedMode && videoCapabilities.references.supportsFirstFrame);
    const loadSubjectReferences = requestedMode === 'reference'
      || (!requestedMode && videoCapabilities.references.supportsSubjectReferences);
    // User-bound images are identity/style references, never temporal frames.
    const manualReferenceImage = shot.manualReferenceImage?.trim();
    const manualSubjectIds = shot.visibleCharacterIds ?? shot.characterIds ?? [];
    let hasManualSubjectReference = false;
    const allowAutomaticCustomReferences = (
      requestedMode === 'reference'
      || presentCharactersForReferences.length === 0
      || !!manualReferenceImage
    );
    if (manualReferenceImage) {
      const id = `${shot.id}_video_manual_reference`;
      const label = '人工确认的整镜构图参考';
      if (!allowAutomaticCustomReferences || !loadSubjectReferences) {
        videoReferenceAssets.push({
          id,
          kind: 'custom',
          label,
          imageUrl: manualReferenceImage,
          subjectIds: manualSubjectIds,
          sentToProvider: false,
          omittedReason: !allowAutomaticCustomReferences
            ? 'Automatic mode keeps canonical character references as the only identity inputs'
            : requestedMode === 'keyframe'
            ? '当前请求使用首帧/尾帧时间控制，整镜构图参考不会混入时间槽位'
            : '当前视频模型不支持主体参考图',
        });
      } else {
        const dataUri = await readAsDataUri(manualReferenceImage);
        if (dataUri) {
          hasManualSubjectReference = true;
          appendSubjectReference(subjectReferences, videoReferenceAssets, {
            id,
            image: dataUri,
            label,
            asset: {
              id,
              kind: 'custom',
              label,
              imageUrl: manualReferenceImage,
              subjectIds: manualSubjectIds,
              payloadFingerprint: fingerprintPayload(dataUri),
            },
          });
        } else {
          videoReferenceAssets.push({
            id,
            kind: 'custom',
            label,
            imageUrl: manualReferenceImage,
            subjectIds: manualSubjectIds,
            sentToProvider: false,
            omittedReason: '人工构图参考无法读取为 provider payload',
          });
        }
      }
    }
    const customReferenceImages = (shot.customReferenceImages ?? []).filter(Boolean);
    for (const [index, img] of customReferenceImages.entries()) {
      const id = `${shot.id}_video_custom_${index + 1}`;
      const label = `用户参考图 ${index + 1}`;
      if (hasManualSubjectReference) {
        videoReferenceAssets.push({
          id,
          kind: 'custom',
          label,
          imageUrl: img,
          sentToProvider: false,
          omittedReason: '人工确认的整镜构图参考已作为唯一主体参考，避免重复身份输入',
        });
        continue;
      }
      if (!loadSubjectReferences) {
        videoReferenceAssets.push({
          id,
          kind: 'custom',
          label,
          imageUrl: img,
          sentToProvider: false,
          omittedReason: requestedMode === 'keyframe'
            ? '当前请求使用首帧/尾帧时间控制，主体参考图不能混入该语义槽位'
            : '当前视频模型不支持主体参考图',
        });
        continue;
      }
      const dataUri = await readAsDataUri(img);
      if (dataUri) {
        appendSubjectReference(subjectReferences, videoReferenceAssets, {
          id,
          image: dataUri,
          label,
          asset: { id, kind: 'custom', label, imageUrl: img, payloadFingerprint: fingerprintPayload(dataUri) },
        });
      } else {
        videoReferenceAssets.push({
          id,
          kind: 'custom',
          label,
          imageUrl: img,
          sentToProvider: false,
          omittedReason: '参考图无法读取为 provider payload',
        });
      }
    }

    // 本镜关键帧始终是首帧。只有本镜关键帧缺失时，才承接同主体连续镜头的真实尾帧。
    const useRenderedTail = shouldUseRenderedTailAsFirstFrame({
      required: !!options.requireContinuityHandoff,
      hasMatchingPreviousShot,
      hasPreviousTailFrame: !!previousLastFrameImage,
      supportsFirstFrame: videoCapabilities.references.supportsFirstFrame,
      requestedMode,
      hasManualShotReference: !!manualReferenceImage || hasManualSubjectReference,
      temporalAuthority: shouldUsePreviousTailAuthority(options) ? 'previous_tail' : 'approved_keyframe',
    });
    if (useRenderedTail && previousShot && previousLastFrameImage) {
      const dataUri = await readAsDataUri(previousLastFrameImage);
      if (dataUri) {
        firstFrame = dataUri;
        renderedTailUsed = true;
        videoReferenceAssets.push({
          id: `${shot.id}_video_previous_tail`,
          kind: 'previous',
          label: `Previous shot tail frame (shot ${previousShot.index + 1})`,
          imageUrl: previousLastFrameImage,
          subjectIds: shot.visibleCharacterIds ?? shot.characterIds,
          payloadFingerprint: fingerprintPayload(dataUri),
        });
      }
    }

    // A matching rendered tail is the temporal authority for a continuous
    // segment. The approved keyframe remains the reviewed composition target
    // and is used when no actual tail handoff is available.
    if (!renderedTailUsed && loadTemporalReferences && options.requireContinuityHandoff && hasMatchingPreviousShot && previousLastFrameImage && previousShot) {
      const dataUri = await readAsDataUri(previousLastFrameImage);
      if (dataUri) {
        videoReferenceAssets.push({
          id: `${shot.id}_video_previous_tail`,
          kind: 'previous',
          label: `Previous shot tail frame (shot ${previousShot.index + 1})`,
          imageUrl: previousLastFrameImage,
          sentToProvider: false,
          omittedReason: 'Recorded for continuity validation; the current approved keyframe is the temporal first frame',
          payloadFingerprint: fingerprintPayload(dataUri),
        });
      }
    }

    if (loadTemporalReferences && shot.keyframeImage) {
      const dataUri = await readAsDataUri(shot.keyframeImage);
      if (dataUri) {
        if (!renderedTailUsed) firstFrame = dataUri;
        videoReferenceAssets.push({
          id: `${shot.id}_video_keyframe`,
          kind: 'keyframe',
          label: '本镜关键帧（首帧）',
          imageUrl: shot.keyframeImage,
          ...(renderedTailUsed ? {
            sentToProvider: false,
            omittedReason: 'The previous rendered tail is the temporal first-frame handoff for this continuous segment',
          } : {}),
          payloadFingerprint: fingerprintPayload(dataUri),
        });
      } else {
        videoReferenceAssets.push({
          id: `${shot.id}_video_keyframe`,
          kind: 'keyframe',
          label: 'Current approved keyframe (first frame)',
          imageUrl: shot.keyframeImage,
          sentToProvider: false,
          omittedReason: 'The current approved keyframe could not be read as a provider payload',
        });
      }
    }

    // 没有手动主体参考时，自动补齐所有在场角色的身份参考，而不是把立绘误当视频首帧。
    if (loadSubjectReferences && presentCharactersForReferences.length && !hasManualSubjectReference) {
      for (const c of presentCharactersForReferences) {
        const variantId = shot.costumeVariantRefs?.[c.id] || shot.costumeVariantRefs?.[c.name];
        const imgUrl = resolveCharacterReferenceImage(c, variantId)?.imageUrl;
        if (imgUrl) {
          const dataUri = await readAsDataUri(imgUrl);
          if (dataUri) {
            const id = `${shot.id}_video_character_${c.id}`;
            const label = `${c.name}（主体参考）`;
            appendSubjectReference(subjectReferences, videoReferenceAssets, {
              id,
              image: dataUri,
              label,
              asset: {
                id,
                kind: 'character',
                label,
                imageUrl: imgUrl,
                characterId: c.id,
                payloadFingerprint: fingerprintPayload(dataUri),
              },
            });
          } else {
            videoReferenceAssets.push({
              id: `${shot.id}_video_character_${c.id}`,
              kind: 'character',
              label: `${c.name}（主体参考）`,
              imageUrl: imgUrl,
              characterId: c.id,
              sentToProvider: false,
              omittedReason: '角色参考图无法读取为 provider payload',
            });
          }
        }
      }
    }

    // 只有首帧存在时才允许设置尾帧，避免单独的尾帧被 provider 当成首帧。
    controlMode = selectVideoControlMode({
      requestedMode,
      hasFirstFrame: !!firstFrame,
      hasSubjectReferences: subjectReferences.length > 0,
      // Auto mode should animate the approved keyframe whenever the selected
      // model supports temporal control. Subject references are a fallback for
      // models that cannot accept a first frame, or an explicit user choice;
      // preferring them here would discard the shot composition we just made.
      preferSubjectReferences: false,
    }, videoCapabilities);
    if (options.requireKeyframeForI2V && !requestedMode && controlMode === 'reference' && firstFrame) {
      // Pipeline runs with a generated keyframe must keep temporal control as
      // the source of truth. User-selected reference mode remains explicit.
      controlMode = 'keyframe';
    }
    if (options.requireKeyframeForI2V && controlMode !== 'keyframe') {
      throw new Error(`Shot ${shot.index + 1} requires keyframe I2V, but no readable first-frame reference is available`);
    }
    if (controlMode === 'keyframe' && !firstFrame) {
      throw new Error(`Shot ${shot.index + 1} keyframe mode requires a readable first-frame reference`);
    }
    if (controlMode === 'reference' && subjectReferences.length === 0) {
      throw new Error(`Shot ${shot.index + 1} reference mode requires a readable subject reference`);
    }

    if (options.usePlannedLastFrame === true
      && controlMode === 'keyframe' && !renderedTailUsed && options.continuityKeyframeMode !== 'tail_anchor'
      && firstFrame && videoCapabilities.references.supportsLastFrame
      && nextShot && shotsShareScene(shot, nextShot)
      && shotsShareSubjects(shot, nextShot) && nextShot.keyframeImage) {
      const nextDataUri = await readAsDataUri(nextShot.keyframeImage);
      if (nextDataUri) {
        lastFrame = nextDataUri;
        videoReferenceAssets.push({
          id: `${shot.id}_video_next_keyframe`,
          kind: 'keyframe',
          label: `下一镜关键帧（镜头 ${nextShot.index + 1}，尾帧约束）`,
          imageUrl: nextShot.keyframeImage,
          payloadFingerprint: fingerprintPayload(nextDataUri),
        });
      }
    }

    // 兼容仍从 referenceImages 读取输入的 provider；顺序只表达首尾帧或主体参考，绝不混用。
    referenceImages = firstFrame
      ? [firstFrame, ...(lastFrame ? [lastFrame] : [])]
      : subjectReferences.map((reference) => reference.image);
    markVideoReferenceAssets(videoReferenceAssets, controlMode, subjectReferences, shot.id);
    // The provider contract is intentionally exclusive: temporal frames and
    // subject references are never sent together, even when both were loaded
    // while choosing the best supported mode.
    if (controlMode !== 'keyframe') {
      firstFrame = undefined;
      lastFrame = undefined;
      referenceImages = [];
    }
  }

  const isI2VMode = controlMode !== 'text';
  const activeSubjectReferences = controlMode === 'reference' ? subjectReferences : [];
  if (enableI2V && options.requireKeyframeForI2V && !isI2VMode) {
    throw new Error(`镜头 ${shot.index + 1} 的参考图无法读取，已停止 I2V 生成。`);
  }
  let videoReferenceMode: 'i2v' | 't2v' = isI2VMode ? 'i2v' : 't2v';
  let videoReferenceFallbackReason: string | undefined;
  const referenceSlots = buildVideoReferenceInputs(
    shot.id,
    videoReferenceAssets,
    controlMode,
    firstFrame,
    lastFrame,
    activeSubjectReferences,
  );
  const presentCharacters = findMatchingCharacters(shot, options.characters);
  const prompt = buildVideoGenerationPrompt(shot, presentCharacters, controlMode);
  if (!prompt) throw new Error(`Shot ${shot.index + 1} has no video prompt`);
  const seed = getEffectiveShotSeed(shot, options.seed);
  let response;
  try {
    response = await providerRouter.generateVideo({
      taskType: 'clip',
      sourceLabel: `${shot.id}:video`,
      prompt,
      negativePrompt: [shot.videoNegativePrompt, buildSubjectExclusionPrompt()].filter(Boolean).join(', '),
      parameters: shot.videoParameters,
      model: targetModel,
      endpointId: options.endpointId,
      width: w,
      height: h,
      aspectRatio: options.spec.aspectRatio,
      durationSeconds: shot.durationSeconds,
      fps: options.spec.fps,
      seed,
      controlMode,
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
      referenceSlots: referenceSlots.length > 0 ? referenceSlots : undefined,
      firstFrame,
      lastFrame,
      subjectReferences: activeSubjectReferences.length > 0 ? activeSubjectReferences : undefined,
    });
  } catch (err) {
    // 如果 I2V 模式报错(中转站不支持参考图/参考图过大/模型拒绝 I2V),自动平滑回退到 T2V 模式重试
    if (isI2VMode && options.allowReferenceFallback === true && !options.requireKeyframeForI2V && !options.controlMode) {
      console.warn(`video_gen: I2V failed for shot ${shot.id}, falling back to T2V`, err);
      videoReferenceMode = 't2v';
      controlMode = 'text';
      videoReferenceFallbackReason = err instanceof Error ? err.message : String(err);
      videoReferenceAssets = videoReferenceAssets.map((asset) => ({
        ...asset,
        sentToProvider: false,
        providerIndex: undefined,
        omittedReason: `I2V 请求失败，已降级为 T2V：${videoReferenceFallbackReason}`,
      }));
      response = await providerRouter.generateVideo({
        taskType: 'clip',
        sourceLabel: `${shot.id}:video:fallback`,
        prompt: buildVideoGenerationPrompt(shot, presentCharacters, 'text'),
        negativePrompt: [shot.videoNegativePrompt, buildSubjectExclusionPrompt()].filter(Boolean).join(', '),
        parameters: shot.videoParameters,
        model: targetModel,
        endpointId: options.endpointId,
        width: w,
        height: h,
        aspectRatio: options.spec.aspectRatio,
        durationSeconds: shot.durationSeconds,
        fps: options.spec.fps,
        seed,
        controlMode: 'text',
        referenceImages: undefined,
        referenceSlots: undefined,
        firstFrame: undefined,
        lastFrame: undefined,
        subjectReferences: undefined,
      });
    } else {
      throw err;
    }
  }

  const continuityContext = renderedTailUsed && previousShot
    ? {
        source: 'previous_tail' as const,
        sourceShotId: previousShot.id,
        appliedTo: 'video' as const,
      }
    : shot.keyframeGenerationContext?.continuity;
  const generationContext: ShotGenerationExecutionContext = {
    ...resolveVideoExecutionContext(options),
    provider: response.provider,
    model: response.model,
    seed,
    resolution: options.spec.resolution,
    fps: options.spec.fps,
    aspectRatio: options.spec.aspectRatio,
    ...(controlMode === 'keyframe' ? {
      temporalAuthority: renderedTailUsed ? 'previous_tail' as const : 'approved_keyframe' as const,
    } : {}),
    ...(continuityContext ? {
      continuity: {
        ...continuityContext,
        appliedTo: 'video' as const,
      },
    } : {}),
  };
  const inputFingerprint = fingerprintShotInputs(
    shot,
    'video',
    videoReferenceAssets,
    generationContext,
  );

  // 落盘:把 http URL / data URI 转成稳定的本地文件路径(Novel 模式下)。
  // Direct 模式不落盘(novelProjectId 没传)。
  const videoUrl = options.novelProjectId
    ? await saveAsset(options.novelProjectId, 'clip', response.videoData, `clip_shot_${shot.index + 1}`)
    : response.videoData;
  const lastFrameImage = await extractLastFrameIfPossible(options.novelProjectId, videoUrl, shot.index);

  return {
    shotId: shot.id,
    videoUrl,
    thumbnailUrl: undefined,
    lastFrameImage,
    durationSeconds: response.durationSeconds || shot.durationSeconds,
    provider: response.provider,
    model: response.model,
    hasAudio: false,
    generatedAt: new Date().toISOString(),
    seed,
    inputFingerprint,
    generationContext,
    requestSnapshot: response.requestSnapshot,
    responseSnapshot: response.responseSnapshot,
    keyframeImage: shot.keyframeImage,
    videoReferenceAssets,
    videoReferenceMode,
    videoControlMode: controlMode,
    videoReferenceFallbackReason,
    sceneSource: options.sceneSource,
    sourceMode: options.sourceMode,
  };
}

function getParameterModel(parameters?: Record<string, unknown>): string | undefined {
  const model = parameters?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : undefined;
}

function shouldUsePreviousTailAuthority(options: VideoGenOptions): boolean {
  return options.temporalAuthority === 'previous_tail'
    || options.continuityKeyframeMode === 'tail_anchor';
}

function resolveVideoExecutionContext(options: VideoGenOptions): ShotGenerationExecutionContext {
  try {
    const capabilities = providerRouter.getVideoCapabilities('clip', options.model, options.endpointId);
    return {
      provider: capabilities.provider,
      model: capabilities.model,
      endpointId: capabilities.endpointId,
      aspectRatio: options.spec.aspectRatio,
      resolution: options.spec.resolution,
      fps: options.spec.fps,
    };
  } catch {
    return {
      model: options.model,
      endpointId: options.endpointId,
      aspectRatio: options.spec.aspectRatio,
      resolution: options.spec.resolution,
      fps: options.spec.fps,
    };
  }
}

function buildVideoReferenceInputs(
  shotId: string,
  assets: ShotReferenceAsset[],
  controlMode: VideoControlMode,
  firstFrame: string | undefined,
  lastFrame: string | undefined,
  subjectReferences: Array<{ id: string; image: string; label?: string }>,
): GenerationReferenceInput[] {
  if (controlMode === 'reference') {
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    return subjectReferences.map((reference) => ({
      id: reference.id,
      role: 'subject' as const,
      image: reference.image,
      label: reference.label,
      subjectId: assetById.get(reference.id)?.characterId,
      subjectIds: assetById.get(reference.id)?.subjectIds,
    }));
  }
  if (controlMode !== 'keyframe') return [];

  const firstAsset = assets.find((asset) => (
    (asset.kind === 'keyframe' || asset.kind === 'previous')
      && asset.sentToProvider !== false
  )) ?? assets.find((asset) => asset.kind === 'keyframe' || asset.kind === 'previous');
  const lastAsset = assets.find((asset) => asset.id === `${shotId}_video_next_keyframe`);
  return [
    ...(firstFrame ? [{
      id: firstAsset?.id ?? `${shotId}:first-frame`,
      role: 'first_frame' as const,
      image: firstFrame,
      label: firstAsset?.label,
      subjectIds: firstAsset?.subjectIds,
    }] : []),
    ...(lastFrame ? [{
      id: lastAsset?.id ?? `${shotId}:last-frame`,
      role: 'last_frame' as const,
      image: lastFrame,
      label: lastAsset?.label,
      subjectIds: lastAsset?.subjectIds,
    }] : []),
  ];
}

function appendSubjectReference(
  subjectReferences: Array<{ id: string; image: string; label?: string }>,
  assets: ShotReferenceAsset[],
  input: {
    id: string;
    image: string;
    label: string;
    asset: ShotReferenceAsset;
  },
): void {
  const duplicate = subjectReferences.find((reference) => reference.image === input.image);
  if (duplicate) {
    // A library-selected character image can be the same file as the
    // automatically bound portrait. Keep one provider slot and retain the
    // stronger character binding in the lineage record.
    const existingAsset = assets.find((asset) => asset.id === duplicate.id);
    if (existingAsset && input.asset.characterId && !existingAsset.characterId) {
      existingAsset.characterId = input.asset.characterId;
      existingAsset.label = input.label;
    }
    return;
  }
  subjectReferences.push({ id: input.id, image: input.image, label: input.label });
  assets.push(input.asset);
}

function markVideoReferenceAssets(
  assets: ShotReferenceAsset[],
  controlMode: VideoControlMode,
  subjectReferences: Array<{ id: string; image: string; label?: string }>,
  shotId: string,
): void {
  const subjectIndexes = new Map(subjectReferences.map((reference, index) => [reference.id, index]));
  for (const asset of assets) {
    if (asset.sentToProvider === false && asset.omittedReason) continue;

    if (controlMode === 'reference' && (asset.kind === 'custom' || asset.kind === 'character')) {
      const providerIndex = subjectIndexes.get(asset.id);
      if (providerIndex !== undefined) {
        asset.sentToProvider = true;
        asset.providerIndex = providerIndex;
        asset.transport = 'direct';
      } else {
        asset.sentToProvider = false;
        asset.omittedReason = '重复的参考图已合并为一个 provider 槽位';
      }
      continue;
    }

    if (controlMode === 'keyframe'
      && (asset.kind === 'keyframe' || asset.kind === 'previous')) {
      const isLastFrame = asset.id === `${shotId}_video_next_keyframe`;
      asset.sentToProvider = true;
      asset.providerIndex = isLastFrame ? 1 : 0;
      asset.transport = 'direct';
      continue;
    }

    asset.sentToProvider = false;
    asset.providerIndex = undefined;
    asset.omittedReason = controlMode === 'text'
      ? '当前请求使用纯文本模式'
      : controlMode === 'keyframe'
        ? '当前请求使用首帧/尾帧时间控制，主体参考图未发送'
        : '当前请求使用主体参考控制，时间帧未发送';
  }
}

async function extractLastFrameIfPossible(
  projectId: string | undefined,
  videoUrl: string,
  shotIndex: number,
): Promise<string | undefined> {
  if (!projectId || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;
  const localPath = resolveLocalPath(videoUrl);
  if (!localPath || localPath.startsWith('data:') || isRemoteUrl(localPath)) return undefined;

  try {
    const directory = await getAssetDirectory(projectId, 'last-frame');
    const outputPath = `${directory}/last_frame_shot_${shotIndex + 1}.png`;
    const result = await extractLastFrame({ videoPath: localPath, outputPath });
    return toWebviewUrl(result.outputPath);
  } catch (err) {
    console.warn(`video_gen: failed to extract last frame for shot ${shotIndex + 1}`, err);
    return undefined;
  }
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

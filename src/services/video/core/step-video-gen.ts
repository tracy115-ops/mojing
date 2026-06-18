// step-video-gen.ts — 步 10:视频生成(T2V / I2V 切换)
// shot.keyframeImage 存在 → I2V(referenceImages=[keyframe])
// 否则 → T2V
// 保留并发池(VIDEO_GENERATION_CONCURRENCY),单镜失败不阻塞其他。

import { providerRouter } from '@/services/providers';
import type {
  ShotSpec,
  GeneratedClip,
  VideoSpec,
} from '@/types/video';

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
}

export interface VideoGenResult {
  clips: GeneratedClip[];
  failedShotIds: string[];
}

/**
 * 步 10:并发跑所有镜头。
 * enableI2V=false 时强制 T2V(忽略 keyframeImage)。
 */
export async function runVideoGen(
  shots: ShotSpec[],
  options: VideoGenOptions,
  enableI2V: boolean,
  onProgress?: (done: number, total: number) => void,
  shouldAbort?: () => boolean,
): Promise<VideoGenResult> {
  const pending = shots.slice();
  const clips: GeneratedClip[] = [];
  const failedShotIds: string[] = [];
  let done = 0;
  let lastErr: unknown = null;
  const total = shots.length;
  onProgress?.(0, total);

  const worker = async (): Promise<void> => {
    while (pending.length > 0 && !shouldAbort?.()) {
      const shot = pending.shift();
      if (!shot) break;
      try {
        const clip = await generateOne(shot, options, enableI2V);
        clips.push(clip);
      } catch (err) {
        console.warn(`video_gen: failed for shot ${shot.id}`, err);
        lastErr = err;
        failedShotIds.push(shot.id);
      }
      done++;
      onProgress?.(done, total);
    }
  };

  const workers = Array.from({ length: Math.min(VIDEO_GENERATION_CONCURRENCY, Math.max(1, shots.length)) }, () => worker());
  await Promise.all(workers);

  if (total > 0 && clips.length === 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${total} 个视频生成都失败。最近一次错误:${reason}`);
  }

  return { clips, failedShotIds };
}

async function generateOne(
  shot: ShotSpec,
  options: VideoGenOptions,
  enableI2V: boolean,
): Promise<GeneratedClip> {
  const [w, h] = parseResolution(options.spec.resolution);
  const useI2V = enableI2V && !!shot.keyframeImage;

  const response = await providerRouter.generateVideo({
    taskType: 'clip',
    prompt: shot.videoPrompt,
    model: options.model ?? tierToDefaultModel(options.spec.videoTier),
    endpointId: options.endpointId,
    width: w,
    height: h,
    durationSeconds: shot.durationSeconds,
    fps: options.spec.fps,
    referenceImages: useI2V ? [shot.keyframeImage!] : [],
  });

  return {
    shotId: shot.id,
    videoUrl: response.videoData,
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
 * Phase 1 只接入了 Kling,后续按 tier 扩展到 Seedance / Veo / Sora。
 */
export function tierToDefaultModel(tier: VideoSpec['videoTier']): string {
  switch (tier) {
    case 'free':
      return 'kling-v2';
    case 'value':
      return 'kling-v2';
    case 'quality':
      return 'kling-v2-pro';
    case 'premium':
      return 'kling-v2-pro';
    default:
      return 'kling-v2';
  }
}

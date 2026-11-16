// step-compose.ts — 步 12-14:FFmpeg 拼接 + 字幕 + 导出
// 从 pipeline.ts 抽取的合成逻辑。
// 单镜头直接返回 clip URL,多镜头走 FFmpeg 拼接。

import { probeFFmpeg, downloadClip, composeClips } from '../ffmpeg-bridge';
import { resolveLocalPath, isRemoteUrl, toWebviewUrl, isValidVideoClip } from '../asset-store';
import { runAudioMerge } from './step-audio-merge';
import { orderClipsByShots } from './clip-order';
import { normalizeTimelineState } from './timeline-state';
import { getAssemblyBlockers } from './shot-production-contract';
import type { AssemblyQualityRequirements } from './quality-policy';
import type { GeneratedClip, ShotSpec, VideoTimelineState } from '@/types/video';

export interface ComposeOptions {
  novelProjectId: string;
  clips: GeneratedClip[];
  shots: ShotSpec[];
  hardcodeSubtitles: boolean;
  style?: string;
  timelineState?: VideoTimelineState;
  assemblyRequirements?: AssemblyQualityRequirements;
}

export interface ComposeResult {
  /** 最终成片 URL(单镜头=该镜头 clip,多镜头=FFmpeg 拼接后的 mp4 路径) */
  finalVideoUrl: string;
  /** 是否走了降级(FFmpeg 不可用时用第一镜) */
  degraded: boolean;
  durationSeconds?: number;
  sizeBytes?: number;
}

export async function runCompose(opts: ComposeOptions): Promise<ComposeResult> {
  if (opts.clips.length === 0) {
    throw new Error('No clips to compose');
  }

  const timelineState = normalizeTimelineState(
    opts.timelineState,
    opts.shots.map((shot) => shot.id),
  );
  const shots = timelineState.shotOrder
    .filter((shotId) => !timelineState.disabledShotIds.includes(shotId))
    .map((shotId) => opts.shots.find((shot) => shot.id === shotId))
    .filter((shot): shot is ShotSpec => !!shot);
  const includedShotIds = new Set(shots.map((shot) => shot.id));
  // Generation is concurrent, but composition must follow the persisted timeline order.
  let clips = orderClipsByShots(
    opts.clips.filter((clip) => includedShotIds.has(clip.shotId)),
    shots,
  );
  if (clips.length === 0) {
    throw new Error('No enabled clips to compose');
  }

  const assemblyBlockers = getAssemblyBlockers(shots, clips, opts.assemblyRequirements);
  if (assemblyBlockers.length > 0) {
    const labels = assemblyBlockers
      .slice(0, 6)
      .map(({ shot, reason }) => `#${shot.index + 1}(${reason})`)
      .join(', ');
    throw new Error(
      `Assembly is blocked until every enabled shot has an approved locked video version: ${labels}`,
    );
  }

  // 兜底防御：若镜头存在 TTS 中文配音音轨 (shot.audioTrack)，但 clip 尚未融合音轨 (!clip.hasAudio)，
  // 自动在合成前触发一次音视合并，确保中文配音 100% 融入最终成片中！
  const unmergedShots = shots.filter((s) => {
    const c = clips.find((clip) => clip.shotId === s.id);
    return s.audioTrack && c && !c.hasAudio;
  });

  if (unmergedShots.length > 0) {
    console.log(`step-compose: 检测到 ${unmergedShots.length} 个镜头的 TTS 中文配音尚未合并进视频，自动补跑音视合并...`);
    try {
      const mergeResult = await runAudioMerge(shots, {
        novelProjectId: opts.novelProjectId,
        clips,
      });
      if (mergeResult.mergedShotIds.length > 0) {
        const mergedSet = new Set(mergeResult.mergedShotIds);
        const shotToMerged = new Map(
          mergeResult.shots
            .filter((s) => mergedSet.has(s.id))
            .map((s) => [s.id, s.audioTrack]),
        );
        clips = clips.map((clip) => {
          const mergedPath = shotToMerged.get(clip.shotId);
          if (mergedPath && !mergedPath.startsWith('data:')) {
            return {
              ...clip,
              videoUrl: toWebviewUrl(mergedPath),
              hasAudio: true,
            };
          }
          return clip;
        });
      }
    } catch (err) {
      console.warn('step-compose: 自动补跑音视合并失败，将继续使用原 Clip 进行合成:', err);
    }
  }

  const hasSubtitleBurnIn = opts.hardcodeSubtitles && shots.some((shot) => !!shot.narration?.trim());
  const hasTimelineEdits = clips.some((clip) => {
    const trim = timelineState.trims[clip.shotId];
    return (trim?.startSeconds ?? 0) > 0 || (trim?.endSeconds ?? 0) > 0;
  }) || Math.abs(timelineState.dialogueVolume - 1) > 0.001 || hasSubtitleBurnIn;

  // 单镜头且没有时间轴编辑时直接返回原始片段。
  if (clips.length === 1 && !hasTimelineEdits) {
    return { finalVideoUrl: toWebviewUrl(resolveLocalPath(clips[0].videoUrl)), degraded: false };
  }

  // 多镜头:走 FFmpeg
  const probe = await probeFFmpeg().catch(() => null);
  if (!probe?.available) {
    if (hasTimelineEdits) {
      throw new Error('时间轴裁剪或音量调整需要 FFmpeg，当前环境不可用，未生成未应用编辑的成片。');
    }
    // FFmpeg 不可用:降级用第一镜(转成 webview URL)
    console.warn('step-compose: FFmpeg unavailable, using first clip as final');
    return { finalVideoUrl: toWebviewUrl(resolveLocalPath(clips[0].videoUrl)), degraded: true };
  }

  const workDir = await getWorkDir(opts.novelProjectId);
  const localPaths: string[] = [];
  const subtitles: (string | null)[] = [];
  const trimStartSeconds: number[] = [];
  const trimEndSeconds: number[] = [];
  const invalidReasons: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];

    // 校验 clip 是否为真正可播放的视频路径（过滤掉旧数据中的 video_xxx ID 字符串）
    if (!isValidVideoClip(clip)) {
      const reason = `镜头 #${i + 1} (${clip.shotId}): 视频地址无效或非本地文件/可播放 URL (${clip.videoUrl?.slice(0, 30)}...)`;
      console.warn(`step-compose: ${reason}`);
      invalidReasons.push(reason);
      continue;
    }

    // 先把 webview URL(http://asset.localhost/...)反解成本地路径
    const local = resolveLocalPath(clip.videoUrl);
    let resolvedPath: string;
    if (local !== clip.videoUrl) {
      resolvedPath = local;
    } else if (!isRemoteUrl(clip.videoUrl)) {
      resolvedPath = clip.videoUrl;
    } else {
      // 真正的远程 URL — 下载
      const ext = guessExt(clip.videoUrl);
      const downloaded = await downloadClip(clip.videoUrl, workDir, `clip_${i}${ext}`);
      resolvedPath = downloaded.savedPath;
    }

    // Rust 端校验文件存在 + 非空(避免 ffmpeg 拿到 0 字节文件报 "No streams found")
    if (!(await isFileValid(resolvedPath))) {
      const reason = `镜头 #${i + 1} (${clip.shotId}): 媒体文件为空或不可读 (${resolvedPath})`;
      console.warn(`step-compose: ${reason}`);
      invalidReasons.push(reason);
      continue;
    }
    localPaths.push(resolvedPath);
    const shot = shots.find((s) => s.id === clip.shotId);
    subtitles.push(shot?.narration ?? null);
    trimStartSeconds.push(timelineState.trims[clip.shotId]?.startSeconds ?? 0);
    trimEndSeconds.push(timelineState.trims[clip.shotId]?.endSeconds ?? 0);
  }

  if (localPaths.length === 0) {
    const reasonsSummary = invalidReasons.slice(0, 3).join('；');
    throw new Error(
      `合成失败: 没有可用的有效视频片段 (共 ${opts.clips.length} 个镜头，有效 0 个)。原因: ${reasonsSummary || '上游视频生成未完成或媒体文件损坏'}。请检查视频服务商设置，或在下方分镜列表点击 🎬 单镜重试。`,
    );
  }

  const outputPath = `${workDir}/final.mp4`;

  const result = await composeClips({
    clipPaths: localPaths,
    subtitles,
    outputPath,
    hardcodeSubtitles: opts.hardcodeSubtitles,
    style: opts.style,
    trimStartSeconds,
    trimEndSeconds,
    audioVolume: timelineState.dialogueVolume,
  });

  return {
    finalVideoUrl: result.outputPath,
    degraded: false,
    durationSeconds: result.durationSeconds,
    sizeBytes: result.sizeBytes,
  };
}

async function getWorkDir(novelProjectId: string): Promise<string> {
  try {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const base = await appDataDir();
    return `${base}/video-cache/${novelProjectId}`;
  } catch {
    return `/tmp/mojing-video/${novelProjectId}`;
  }
}

/** 通过 Rust 端 stat 校验文件存在且 >1KB(避免 ffmpeg 拿到 0 字节文件) */
async function isFileValid(path: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return !!path;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const r = await invoke<{ bytes: number; exists: boolean }>('asset_stat_path', { path });
    return r.exists && r.bytes > 1024;
  } catch {
    // Rust 命令不存在或路径不可访问 — 让 compose 自己再试,而不是提前丢弃
    return !!path;
  }
}

function guessExt(url: string): string {
  const m = url.match(/\.(mp4|mov|webm|mkv)(\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.mp4';
}

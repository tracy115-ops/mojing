// step-audio-merge.ts — 步 11:音视合并
// 把每个有 audioTrack 的 shot 的 clip(videoUrl)和 audioTrack 合并。
//
// 难点:shot.audioTrack 是 base64 data URI(TTS 返回),clip.videoUrl 可能是远程 URL,
// FFmpeg 命令需要本地文件路径。所以:
//   1. 落地 audioTrack(base64 → 临时文件)
//   2. 落地 videoUrl(远程 → 下载;data URI → 解码;本地路径 → 直接用)
//   3. 调 ffmpeg_merge_audio
//   4. 把合并后的本地路径写回 shot(覆盖 audioTrack 字段表示"已合并")
//
// 单镜失败不阻塞。FFmpeg 不可用时整步跳过。

import { probeFFmpeg, downloadClip, mergeAudio, writeDataUri } from '../ffmpeg-bridge';
import type { ShotSpec, GeneratedClip } from '@/types/video';

export interface AudioMergeResult {
  shots: ShotSpec[];
  /** clip.videoUrl 已更新(指向合并后文件)的 shotId 集合 */
  mergedShotIds: string[];
  failedShotIds: string[];
}

export interface AudioMergeCtx {
  novelProjectId: string;
  /** clip by shotId,用于拿到 videoUrl */
  clips: GeneratedClip[];
}

export async function runAudioMerge(
  shots: ShotSpec[],
  ctx: AudioMergeCtx,
  onProgress?: (done: number, total: number) => void,
): Promise<AudioMergeResult> {
  const total = shots.length;
  const probe = await probeFFmpeg().catch(() => null);
  if (!probe?.available) {
    // FFmpeg 不可用:整步跳过
    console.warn('step-audio-merge: FFmpeg unavailable, skipping');
    return { shots, mergedShotIds: [], failedShotIds: [] };
  }

  const workDir = await getWorkDir(ctx.novelProjectId);
  const result: ShotSpec[] = shots.map((s) => ({ ...s }));
  const mergedShotIds: string[] = [];
  const failedShotIds: string[] = [];

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const clip = ctx.clips.find((c) => c.shotId === shot.id);

    if (!shot.audioTrack || !clip) {
      // 没音轨或没 clip,跳过
      onProgress?.(i + 1, total);
      continue;
    }

    try {
      const localVideoPath = await materializeVideo(clip.videoUrl, workDir, `v_${i}`);
      const localAudioPath = await materializeAudio(shot.audioTrack, workDir, `a_${i}`);
      const outputPath = `${workDir}/merged_${i}.mp4`;

      await mergeAudio({
        videoPath: localVideoPath,
        audioPath: localAudioPath,
        outputPath,
      });

      // 把合并后的本地路径写回 shot 的 audioTrack(标记已合并),
      // 同时通知调用方该 clip 的 videoUrl 应该更新为 outputPath。
      result[i].audioTrack = outputPath;
      mergedShotIds.push(shot.id);
    } catch (err) {
      console.warn(`audio_merge: failed for shot ${shot.id}`, err);
      failedShotIds.push(shot.id);
      // audioTrack 保留原 base64,UI 仍能播
    }
    onProgress?.(i + 1, total);
  }

  return { shots: result, mergedShotIds, failedShotIds };
}

/** 把 videoUrl 落地为本地文件:远程下载 / data URI 解码 / 本地路径直用 */
async function materializeVideo(url: string, workDir: string, name: string): Promise<string> {
  if (/^https?:\/\//.test(url)) {
    const ext = guessExt(url) || '.mp4';
    const downloaded = await downloadClip(url, workDir, `${name}${ext}`);
    return downloaded.savedPath;
  }
  if (url.startsWith('data:')) {
    const ext = guessDataExt(url) || '.mp4';
    const path = `${workDir}/${name}${ext}`;
    await writeDataUriToFile(url, path);
    return path;
  }
  // 已经是本地路径
  return url;
}

/** 把 audioTrack(base64 data URI)落地为本地文件 */
async function materializeAudio(dataUri: string, workDir: string, name: string): Promise<string> {
  if (!dataUri.startsWith('data:')) {
    // 已经是本地路径
    return dataUri;
  }
  const ext = guessDataExt(dataUri) || '.mp3';
  const path = `${workDir}/${name}${ext}`;
  await writeDataUriToFile(dataUri, path);
  return path;
}

async function writeDataUriToFile(dataUri: string, path: string): Promise<void> {
  await writeDataUri({ dataUri, outputPath: path });
}

function guessExt(url: string): string | undefined {
  const m = url.match(/\.(mp4|mov|webm|mkv|mp3|wav|opus|aac|flac|m4a)(\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : undefined;
}

function guessDataUri(dataUri: string): string | undefined {
  const m = dataUri.match(/^data:audio\/([\w-]+);/i);
  return m ? m[1].toLowerCase() : undefined;
}

function guessDataExt(dataUri: string): string | undefined {
  const fmt = guessDataUri(dataUri);
  if (!fmt) return undefined;
  // 标准 audio/ 后缀
  if (['mp3', 'wav', 'opus', 'aac', 'flac', 'm4a'].includes(fmt)) return `.${fmt}`;
  return '.mp3';
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

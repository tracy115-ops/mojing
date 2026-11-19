// step-audio-merge.ts — 步 11:音视合并
// 把每个有 audioTrack 的 shot 的 clip(videoUrl)和 audioTrack 合并。
//
// 难点:shot.audioTrack 是 base64 data URI(TTS 返回),clip.videoUrl 可能是远程 URL,
// FFmpeg 命令需要本地文件路径。所以:
//   1. 落地 audioTrack(base64 → 临时文件)
//   2. 落地 videoUrl(远程 → 下载;data URI → 解码;本地路径 → 直接用)
//   3. 调 ffmpeg_merge_audio
//   4. 把带声音的片段交给下游，分镜继续引用独立配音。

import { probeFFmpeg, downloadClip, mergeAudio, writeDataUri } from '../ffmpeg-bridge';
import { resolveLocalPath, isRemoteUrl, isAssetAvailable, toWebviewUrl } from '../asset-store';
import { t } from '@/i18n';
import type { ShotSpec, GeneratedClip } from '@/types/video';
import { hasMergedDialogue } from './stage-artifact-health';

export interface AudioMergeResult {
  clips: GeneratedClip[];
  failedShotIds: string[];
}

export function describeAudioMergeFailure(shots: ShotSpec[], failedShotIds: string[]): string {
  const indexes = shots.filter((shot) => failedShotIds.includes(shot.id)).map((shot) => shot.index + 1);
  return t('video.workflow.audioMergeFailure', { shots: indexes.join(', ') });
}

export type BGMMoodStyle = 'epic_action' | 'suspense_thriller' | 'warm_emotional' | 'comic_funny' | 'cyberpunk';

export interface AudioMergeCtx {
  novelProjectId: string;
  signal?: AbortSignal;
  /** clip by shotId,用于拿到 videoUrl */
  clips: GeneratedClip[];
  /** 可选背景音乐风格预设 */
  bgmStyle?: BGMMoodStyle;
  /** BGM 混音音量 (0.0 ~ 1.0,默认 0.20 避免掩盖 TTS 旁白) */
  bgmVolume?: number;
}

export async function runAudioMerge(
  shots: ShotSpec[],
  ctx: AudioMergeCtx,
  onProgress?: (done: number, total: number) => void,
): Promise<AudioMergeResult> {
  const total = shots.length;
  const workDir = `${await getWorkDir(ctx.novelProjectId)}/audio-${crypto.randomUUID()}`;
  const clips = new Map(ctx.clips.map((clip) => [clip.shotId, clip]));
  const failedShotIds: string[] = [];
  let checkedFFmpeg = false;

  for (let i = 0; i < shots.length; i++) {
    ctx.signal?.throwIfAborted();
    const shot = shots[i];
    const clip = clips.get(shot.id);
    if (!shot.audioTrack || clip?.importedVideo?.audio === 'preserve') {
      onProgress?.(i + 1, total);
      continue;
    }
    if (!clip) {
      failedShotIds.push(shot.id);
      onProgress?.(i + 1, total);
      continue;
    }
    if (hasMergedDialogue(shot, clip, resolveLocalPath) && await isAssetAvailable(clip.videoUrl)) {
      onProgress?.(i + 1, total);
      continue;
    }

    if (!checkedFFmpeg) {
      const probe = await probeFFmpeg().catch(() => null);
      if (!probe?.available) throw new Error(t('video.workflow.audioMergeUnavailable'));
      checkedFFmpeg = true;
    }

    try {
      const version = shot.versionHistory?.find((item) => item.id === clip.shotVersionId && item.type === 'video');
      const videoUrl = version?.url && await isAssetAvailable(version.url) ? version.url : clip.videoUrl;
      const localVideoPath = await materializeVideo(videoUrl, workDir, `v_${i}`);
      const localAudioPath = await materializeAudio(shot.audioTrack, workDir, `a_${i}`);
      const outputPath = `${workDir}/merged_${i}.mp4`;

      ctx.signal?.throwIfAborted();
      await mergeAudio({
        videoPath: localVideoPath,
        audioPath: localAudioPath,
        outputPath,
      });

      ctx.signal?.throwIfAborted();
      clips.set(shot.id, {
        ...clip,
        videoUrl: toWebviewUrl(outputPath),
        hasAudio: true,
        audioTrack: shot.audioTrack,
      });
    } catch (err) {
      ctx.signal?.throwIfAborted();
      console.warn(`audio_merge: failed for shot ${shot.id}`, err);
      failedShotIds.push(shot.id);
    }
    onProgress?.(i + 1, total);
  }

  return { clips: [...clips.values()], failedShotIds };
}

/** 把 videoUrl 落地为本地文件:webview URL 反解 / 远程下载 / data URI 解码 / 本地路径直用 */
async function materializeVideo(url: string, workDir: string, name: string): Promise<string> {
  // webview URL(http://asset.localhost/...) → 反解出本地路径,直接用
  const localPath = resolveLocalPath(url);
  if (localPath !== url) {
    return localPath;
  }
  if (isRemoteUrl(url)) {
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

/** 把 audioTrack(base64 data URI / webview URL / 本地路径)落地为本地文件 */
async function materializeAudio(input: string, workDir: string, name: string): Promise<string> {
  // webview URL 或本地路径 → 直接用
  const localPath = resolveLocalPath(input);
  if (localPath !== input) {
    return localPath;
  }
  if (!input.startsWith('data:')) {
    // 已经是本地路径
    return input;
  }
  const ext = guessDataExt(input) || '.mp3';
  const path = `${workDir}/${name}${ext}`;
  await writeDataUriToFile(input, path);
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

// step-compose.ts — 步 12-14:FFmpeg 拼接 + 字幕 + 导出
// 从 pipeline.ts 抽取的合成逻辑。
// 单镜头直接返回 clip URL,多镜头走 FFmpeg 拼接。

import { probeFFmpeg, downloadClip, composeClips } from '../ffmpeg-bridge';
import type { GeneratedClip, ShotSpec } from '@/types/video';

export interface ComposeOptions {
  novelProjectId: string;
  clips: GeneratedClip[];
  shots: ShotSpec[];
  hardcodeSubtitles: boolean;
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

  // 单镜头:直接返回该镜 URL
  if (opts.clips.length === 1) {
    return { finalVideoUrl: opts.clips[0].videoUrl, degraded: false };
  }

  // 多镜头:走 FFmpeg
  const probe = await probeFFmpeg().catch(() => null);
  if (!probe?.available) {
    // FFmpeg 不可用:降级用第一镜
    console.warn('step-compose: FFmpeg unavailable, using first clip as final');
    return { finalVideoUrl: opts.clips[0].videoUrl, degraded: true };
  }

  const workDir = await getWorkDir(opts.novelProjectId);
  const localPaths: string[] = [];
  for (let i = 0; i < opts.clips.length; i++) {
    const clip = opts.clips[i];
    const isRemote = /^https?:\/\//.test(clip.videoUrl);
    if (!isRemote) {
      localPaths.push(clip.videoUrl);
      continue;
    }
    const ext = guessExt(clip.videoUrl);
    const downloaded = await downloadClip(clip.videoUrl, workDir, `clip_${i}${ext}`);
    localPaths.push(downloaded.savedPath);
  }

  const outputPath = `${workDir}/final.mp4`;
  const subtitles = opts.clips.map((clip) => {
    const shot = opts.shots.find((s) => s.id === clip.shotId);
    return shot?.narration ?? null;
  });

  const result = await composeClips({
    clipPaths: localPaths,
    subtitles,
    outputPath,
    hardcodeSubtitles: opts.hardcodeSubtitles,
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

function guessExt(url: string): string {
  const m = url.match(/\.(mp4|mov|webm|mkv)(\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.mp4';
}

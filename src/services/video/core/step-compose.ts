// step-compose.ts — 步 12-14:FFmpeg 拼接 + 字幕 + 导出
// 从 pipeline.ts 抽取的合成逻辑。
// 单镜头直接返回 clip URL,多镜头走 FFmpeg 拼接。

import { probeFFmpeg, downloadClip, composeClips } from '../ffmpeg-bridge';
import { resolveLocalPath, isRemoteUrl, toWebviewUrl } from '../asset-store';
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

  // 单镜头:直接返回该镜 URL(转成 webview URL 让前端能播)
  if (opts.clips.length === 1) {
    return { finalVideoUrl: toWebviewUrl(resolveLocalPath(opts.clips[0].videoUrl)), degraded: false };
  }

  // 多镜头:走 FFmpeg
  const probe = await probeFFmpeg().catch(() => null);
  if (!probe?.available) {
    // FFmpeg 不可用:降级用第一镜(转成 webview URL)
    console.warn('step-compose: FFmpeg unavailable, using first clip as final');
    return { finalVideoUrl: toWebviewUrl(resolveLocalPath(opts.clips[0].videoUrl)), degraded: true };
  }

  const workDir = await getWorkDir(opts.novelProjectId);
  const localPaths: string[] = [];
  const subtitles: (string | null)[] = [];
  for (let i = 0; i < opts.clips.length; i++) {
    const clip = opts.clips[i];

    // video-gen 失败时 videoUrl 可能为空 — 跳过这个 clip,避免 ffmpeg 拿到坏路径报
    // "No streams found"。
    if (!clip.videoUrl || clip.videoUrl.length < 5) {
      console.warn(`step-compose: skip clip ${clip.shotId} — empty videoUrl`);
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
      console.warn(`step-compose: skip clip ${clip.shotId} — file invalid or empty: ${resolvedPath}`);
      continue;
    }
    localPaths.push(resolvedPath);
    const shot = opts.shots.find((s) => s.id === clip.shotId);
    subtitles.push(shot?.narration ?? null);
  }

  if (localPaths.length === 0) {
    throw new Error(
      '合成失败:没有任何有效的 clip 文件。上游 video_generation 可能全部失败 — 请检查视频 provider 配置和额度。',
    );
  }

  const outputPath = `${workDir}/final.mp4`;

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

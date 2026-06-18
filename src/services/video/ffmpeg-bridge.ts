// ============================================================================
// FFmpeg Bridge — 前端调用 Tauri 后端 FFmpeg 命令
// ============================================================================
// 三个能力：
//   1. probe  — 检测 FFmpeg 是否可用（首次调用会触发 ffmpeg-sidecar 自动下载）
//   2. download — 把远程视频 URL 下载到本地（webview fetch 无法写任意路径）
//   3. compose — 拼接多个本地 clip，可选硬编码字幕
//
// 在非 Tauri 环境（如纯浏览器开发）下，所有方法返回 null/抛错让调用方降级。

export interface ProbeResult {
  available: boolean;
  version?: string;
  error?: string;
}

export interface DownloadResult {
  savedPath: string;
  bytes: number;
}

export interface ComposeRequest {
  clipPaths: string[];
  subtitles: (string | null)[];
  outputPath: string;
  hardcodeSubtitles: boolean;
}

export interface ComposeResult {
  outputPath: string;
  durationSeconds?: number;
  sizeBytes?: number;
}

export interface MergeAudioRequest {
  videoPath: string;
  audioPath: string;
  outputPath: string;
}

export interface MergeAudioResult {
  outputPath: string;
}

export interface WriteDataUriRequest {
  dataUri: string;
  outputPath: string;
}

export interface WriteDataUriResult {
  savedPath: string;
  bytes: number;
}

/** 是否在 Tauri 桌面环境内 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`${cmd} requires Tauri environment`);
  }
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

export async function probeFFmpeg(): Promise<ProbeResult> {
  try {
    return await invoke<ProbeResult>('ffmpeg_probe', {});
  } catch (err) {
    return { available: false, error: String(err) };
  }
}

export async function downloadClip(url: string, destDir: string, filename: string): Promise<DownloadResult> {
  return invoke<DownloadResult>('ffmpeg_download_clip', { url, destDir, filename });
}

export async function composeClips(req: ComposeRequest): Promise<ComposeResult> {
  return invoke<ComposeResult>('ffmpeg_compose_clips', { req });
}

export async function mergeAudio(req: MergeAudioRequest): Promise<MergeAudioResult> {
  return invoke<MergeAudioResult>('ffmpeg_merge_audio', { req });
}

export async function writeDataUri(req: WriteDataUriRequest): Promise<WriteDataUriResult> {
  return invoke<WriteDataUriResult>('ffmpeg_write_data_uri', { req });
}

export interface ExportRequest {
  sourcePath: string;
  outputPath: string;
  /** Target vertical resolution. 0/null = keep original. */
  targetHeight?: number;
}

export interface ExportResult {
  outputPath: string;
  durationSeconds?: number;
  sizeBytes?: number;
}

export async function exportVideo(req: ExportRequest): Promise<ExportResult> {
  return invoke<ExportResult>('ffmpeg_export', { req });
}

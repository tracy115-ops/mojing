// asset-store.ts — 产物落盘 + 跨会话引用
//
// 解决"关闭重开 / 切换任务再切回来,产物 URL 失效"的问题。
// 之前:provider 返回的 http URL / data URI 直接塞进 videoStore —
//   - http URL:CDN 可能过期
//   - data URI:虽然自带数据,但巨大,存 localStorage 撑爆
//   - blob: URL:进程结束即失效
//
// 现在:每张图 / 每个 clip / 每段音频拿到后,立刻调 saveAsset() 落盘到
// appDataDir/video-assets/<projectId>/<kind>/<name>,用 convertFileSrc
// 转成 webview 可加载的 tauri:// URL。
//
// 落盘失败不阻塞 stage — 返回原始 URL 作为降级。

import { downloadClip, writeDataUri } from './ffmpeg-bridge';
import { logger } from '@/services/log';

export type AssetKind =
  | 'portrait'
  | 'background'
  | 'keyframe'
  | 'clip'
  | 'audio'
  | 'final';

let cachedAppDataDir: string | null = null;
/** 缓存 convertFileSrc 函数,避免每次 toWebviewUrl 都 dynamic import */
let convertFileSrcFn: ((p: string) => string) | null = null;
let convertFileSrcLoaded = false;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function loadConvertFileSrc(): Promise<void> {
  if (convertFileSrcLoaded) return;
  convertFileSrcLoaded = true;
  if (!isTauri()) return;
  try {
    const mod = (await import('@tauri-apps/api/core')) as unknown as {
      convertFileSrc?: (p: string) => string;
    };
    if (mod.convertFileSrc) {
      convertFileSrcFn = mod.convertFileSrc;
    }
  } catch {
    // 降级:toWebviewUrl 返回原路径
  }
}

// 启动时 fire-and-forget 加载,让后续 toWebviewUrl 能拿到同步函数
void loadConvertFileSrc();

async function getAppDataBase(): Promise<string> {
  if (cachedAppDataDir) return cachedAppDataDir;
  if (!isTauri()) {
    cachedAppDataDir = `/tmp/mojing-video`;
    return cachedAppDataDir;
  }
  const { appDataDir } = await import('@tauri-apps/api/path');
  const base = await appDataDir();
  cachedAppDataDir = base;
  return base;
}

async function ensureWorkDir(projectId: string, kind: AssetKind): Promise<string> {
  const base = await getAppDataBase();
  const dir = `${base}/video-assets/${sanitizeId(projectId)}/${kind}`;
  // Rust 命令(downloadClip / writeDataUri)在 Rust 端会自己创建目录,
  // 前端不需要预先 mkdir(plugin-fs 也没装)。直接返回路径。
  return dir;
}

function sanitizeId(id: string): string {
  // 文件系统不友好的字符替换掉,避免路径异常
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function guessExtFromUrl(url: string, kind: AssetKind): string {
  // 视频
  const v = url.match(/\.(mp4|mov|webm|mkv)(\?|$)/i);
  if (v) return `.${v[1].toLowerCase()}`;
  // 音频
  const a = url.match(/\.(mp3|wav|opus|aac|flac|m4a)(\?|$)/i);
  if (a) return `.${a[1].toLowerCase()}`;
  // 图片
  const i = url.match(/\.(png|jpg|jpeg|webp|gif)(\?|$)/i);
  if (i) return `.${i[1].toLowerCase()}`;
  // 默认
  if (kind === 'clip' || kind === 'final') return '.mp4';
  if (kind === 'audio') return '.mp3';
  return '.png';
}

function guessExtFromDataUri(dataUri: string, kind: AssetKind): string {
  const m = dataUri.match(/^data:(image|audio|video)\/([\w-]+);/i);
  if (m) {
    const fmt = m[2].toLowerCase();
    // 标准 image 后缀
    if (['png', 'jpeg', 'jpg', 'webp', 'gif'].includes(fmt)) return fmt === 'jpeg' ? '.jpg' : `.${fmt}`;
    if (['mp3', 'wav', 'opus', 'aac', 'flac', 'm4a'].includes(fmt)) return `.${fmt}`;
    if (['mp4', 'webm', 'mov', 'mkv'].includes(fmt)) return `.${fmt}`;
  }
  // 兜底
  if (kind === 'clip' || kind === 'final') return '.mp4';
  if (kind === 'audio') return '.mp3';
  return '.png';
}

let fileCounter = 0;
function uniqueName(prefix: string, ext: string): string {
  // 加时间戳 + 自增计数器避免冲突
  const ts = Date.now().toString(36);
  const n = (fileCounter++).toString(36);
  return `${prefix}_${ts}_${n}${ext}`;
}

/**
 * 把一个产物(图片/视频/音频)落盘,返回 webview 可加载的 URL。
 *
 * 输入支持:
 *   - http(s):// — 走 downloadClip 下载
 *   - data: URI  — 走 writeDataUri 解码
 *   - 已经是本地路径 — 直接转 convertFileSrc
 *
 * 落盘失败时返回原始输入(降级),不抛错。
 * 非 Tauri 环境(浏览器开发)直接返回原值。
 */
export async function saveAsset(
  projectId: string,
  kind: AssetKind,
  content: string,
  namePrefix?: string,
): Promise<string> {
  if (!content) return content;

  // 非 Tauri 环境直接返回
  if (!isTauri()) return content;

  // 已经是本地路径 — 可能是上次落盘的产物或 audio-merge 写过的文件
  if (/^[a-zA-Z]:[\\/]/.test(content) || content.startsWith('/')) {
    return toWebviewUrl(content);
  }

  try {
    const dir = await ensureWorkDir(projectId, kind);
    const prefix = namePrefix ?? kind;
    let savedPath: string;

    if (/^https?:\/\//.test(content)) {
      const ext = guessExtFromUrl(content, kind);
      const filename = uniqueName(prefix, ext);
      const r = await downloadClip(content, dir, filename);
      savedPath = r.savedPath;
    } else if (content.startsWith('data:')) {
      const ext = guessExtFromDataUri(content, kind);
      const filename = uniqueName(prefix, ext);
      const fullPath = `${dir}/${filename}`;
      await writeDataUri({ dataUri: content, outputPath: fullPath });
      savedPath = fullPath;
    } else {
      // 不是 http 也不是 data 也不是路径 — 不知道是啥,原样返回
      return content;
    }

    return toWebviewUrl(savedPath);
  } catch (err) {
    void logger.warn(
      `[asset-store] saveAsset(${kind}) 失败,降级用原始 URL: ${err instanceof Error ? err.message : String(err)}`,
      'asset',
    );
    return content;
  }
}

/**
 * 本地文件路径 → webview 可加载的 URL。
 *
 * Tauri 2 在开启了 asset protocol 的情况下(本项目 tauri.conf.json 里
 * `dangerousDisableAssetCspModification: true` + CSP 允许 asset:),
 * convertFileSrc(path) 会返回 `http://asset.localhost/<encoded>` 形式 URL,
 * 可直接喂给 <img src> / <video src>。
 *
 * 非 Tauri 环境直接返回原路径。
 *
 * 注意:函数是同步的,依赖启动时预加载的 convertFileSrcFn。如果还没加载完,
 * 返回原路径 —— 这种竞态只影响启动 100ms 内的调用,后续都用转换后的 URL。
 */
export function toWebviewUrl(localPath: string): string {
  if (!isTauri()) return localPath;
  if (!convertFileSrcFn) return localPath;
  try {
    return convertFileSrcFn(localPath);
  } catch {
    return localPath;
  }
}

// --- 清理 / 统计 ---

export interface AssetStats {
  bytes: number;
  files: number;
}

export interface CleanResult {
  deletedBytes: number;
  deletedFiles: number;
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 查某个项目产物目录占用(字节数 + 文件数) */
export async function getProjectAssetStats(projectId: string): Promise<AssetStats> {
  if (!isTauri()) return { bytes: 0, files: 0 };
  try {
    const r = await tauriInvoke<{ bytes: number; files: number }>('asset_stats_project', {
      projectId,
    });
    return r;
  } catch {
    return { bytes: 0, files: 0 };
  }
}

/** 删某个项目的全部产物。返回删掉的文件数和字节数。 */
export async function cleanProjectAssets(projectId: string): Promise<CleanResult> {
  if (!isTauri()) return { deletedBytes: 0, deletedFiles: 0 };
  const r = await tauriInvoke<{ deleted_bytes: number; deleted_files: number }>(
    'asset_clean_project',
    { projectId },
  );
  return { deletedBytes: r.deleted_bytes, deletedFiles: r.deleted_files };
}

/** 删全部项目的产物。慎用。 */
export async function cleanAllAssets(): Promise<CleanResult> {
  if (!isTauri()) return { deletedBytes: 0, deletedFiles: 0 };
  const r = await tauriInvoke<{ deleted_bytes: number; deleted_files: number }>(
    'asset_clean_all',
    {},
  );
  return { deletedBytes: r.deleted_bytes, deletedFiles: r.deleted_files };
}

/**
 * 把一个本地资源(可能是 webview URL / 绝对路径 / data URI)统一转成 data URI。
 *
 * 用途:某些 provider(Agnes Video)的 image 字段只接受 base64,
 * 但我们的产物是落盘的文件、store 里存的是 `tauri://...` 的 webview URL。
 * 调用方传 URL 进来,我们读盘转成 `data:image/png;base64,xxxx` 返回。
 *
 * 输入已经是 data URI 时原样返回(避免重复编码)。
 * 非 Tauri 环境无法读盘,原样返回(让 adapter 抛清晰错误)。
 */
export async function readAsDataUri(urlOrPath: string): Promise<string> {
  if (!urlOrPath) return urlOrPath;
  // 已经是 data URI,直接返回
  if (urlOrPath.startsWith('data:')) return urlOrPath;
  if (!isTauri()) return urlOrPath;
  try {
    return await tauriInvoke<string>('asset_read_as_data_uri', { path: urlOrPath });
  } catch (err) {
    void logger.warn(
      `[asset-store] readAsDataUri(${urlOrPath.slice(0, 80)}) failed: ${err instanceof Error ? err.message : String(err)}`,
      'asset',
    );
    return urlOrPath;
  }
}

/**
 * 把一个资源 URL 解析成 ffmpeg / Rust 后端能直接读的本地文件系统路径。
 *
 * 三种输入:
 *   - webview URL(`http://asset.localhost/<encoded>` 或 `https://asset.localhost/...`)
 *     → 反向 percent-decode 拿到本地绝对路径
 *   - 绝对路径(`C:\...` / `/home/...`)→ 原样返回
 *   - 远程 URL(`http(s)://` 开头但 host 不是 asset.localhost)→ 原样返回,
 *     调用方需要自己 downloadClip
 *
 * 用途:之前 audio_merge / compose 用 `/^https?:\/\//.test(url)` 判断"是否远程",
 * 但 webview URL 也是 http:// 开头,会被误判去 downloadClip,后端 reqwest 拉不到
 * webview 协议导致空文件,ffmpeg 拼出进度 0 的成品。
 */
export function resolveLocalPath(url: string): string {
  if (!url) return url;
  // webview URL: http(s)://asset.localhost/<encoded path>
  const m = url.match(/^https?:\/\/asset\.localhost\/(.*)$/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return url;
}

/**
 * 判断一个 URL 是否是真正的远程 URL(http(s):// 但 host 不是 asset.localhost)。
 * webview URL 不算远程 — 它是本地文件的 webview 包装。
 */
export function isRemoteUrl(url: string): boolean {
  if (!url) return false;
  if (!/^https?:\/\//.test(url)) return false;
  // asset.localhost 是 Tauri 的 asset protocol host,算本地
  if (/^https?:\/\/asset\.localhost\//.test(url)) return false;
  return true;
}

/** 字节数 → 可读字符串(KB/MB/GB) */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

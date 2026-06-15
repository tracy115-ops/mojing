// ============================================================================
// Video Pipeline — 编排 Phase 1 流水线
// ============================================================================
// 流程：
//   script_slicing     ← chapter-slicer.ts (本地启发式，无 LLM)
//   storyboard_prompt  ← storyboard-prompt.ts (LLM 批处理)
//   [skipped]          ← character_anchor (Phase 2)
//   [skipped]          ← storyboard_image (Phase 2)
//   video_generation   ← providerRouter.generateVideo (T2V，按 shot 并发)
//   voice_subtitle     ← (Phase 1 占位：暂不生成 TTS，字幕直接走原文 narration)
//   composing          ← (Phase 1 占位：FFmpeg 后端待实现)
//
// 设计要点：
//   - 每个阶段独立、可重入（重试时跳过已完成的 shot）
//   - 通过回调 onStageChange / onProgress 让 UI 订阅状态
//   - 异常不中断整条流水线，只标记单个 shot 失败

import type {
  VideoProjectState,
  VideoStage,
  StoryboardShot,
  GeneratedClip,
  VideoSpec,
} from '@/types/video';
import type { NovelChapter, NovelMetadata } from '@/types';
import { useVideoStore } from '@/stores/videoStore';
import { providerRouter } from '@/services/providers';
import { sliceChapters, type RawShot } from './chapter-slicer';
import { buildStoryboard, type StoryboardContext } from './storyboard-prompt';
import { probeFFmpeg, downloadClip, composeClips } from './ffmpeg-bridge';

export interface PipelineCallbacks {
  onStageChange?: (stage: VideoStage) => void;
  onShotProgress?: (done: number, total: number) => void;
  onError?: (msg: string) => void;
}

export interface PipelineInput {
  novelProjectId: string;
  novelTitle: string;
  genre: string;
  style: string;
  /** 用户选定的章节（按顺序） */
  chapters: Pick<NovelChapter, 'id' | 'order' | 'content'>[];
  spec: VideoSpec;
}

const VIDEO_GENERATION_CONCURRENCY = 2;

export class VideoPipeline {
  private readonly input: PipelineInput;
  private readonly cb: PipelineCallbacks;
  private aborted = false;

  constructor(input: PipelineInput, cb: PipelineCallbacks = {}) {
    this.input = input;
    this.cb = cb;
  }

  abort(): void {
    this.aborted = true;
  }

  async run(): Promise<VideoProjectState | null> {
    const store = useVideoStore.getState();
    store.initProject(this.input.novelProjectId, this.input.chapters.map((c) => c.id), this.input.spec);

    try {
      await this.runScriptSlicing();
      if (this.aborted) return null;
      await this.runStoryboardPrompt();
      if (this.aborted) return null;
      await this.runVideoGeneration();
      if (this.aborted) return null;
      await this.runComposing();
      return useVideoStore.getState().getProject(this.input.novelProjectId) ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useVideoStore.getState().setError(this.input.novelProjectId, msg);
      this.cb.onError?.(msg);
      return null;
    }
  }

  // --- stages ---

  private async runScriptSlicing(): Promise<void> {
    const { novelProjectId, chapters, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'script_slicing';

    store.advanceToStage(novelProjectId, stage);
    store.setStageStatus(novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    const rawShots: RawShot[] = sliceChapters(
      chapters.map((c) => ({ id: c.id, number: c.order + 1, content: c.content })),
      {
        targetWordsPerShot: spec.shotDurationSeconds === 10 ? 1200 : 600,
      },
    );

    // Phase 1 占位：先把 RawShot 直接作为 StoryboardShot 的源，待 storyboard_prompt 优化
    store.setShots(novelProjectId, rawShots.map(toPlaceholderShot));
    store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
  }

  private async runStoryboardPrompt(): Promise<void> {
    const { novelProjectId, novelTitle, genre, style, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'storyboard_prompt';

    store.advanceToStage(novelProjectId, stage);
    store.setStageStatus(novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    const project = store.getProject(novelProjectId);
    if (!project) throw new Error('Video project not initialized');

    const ctx: StoryboardContext = {
      novelTitle,
      genre,
      style,
      aspectRatio: spec.aspectRatio,
      defaultShotDuration: spec.shotDurationSeconds,
    };

    const rawShots: RawShot[] = project.shots.map((sh) => ({
      id: sh.id,
      index: sh.index,
      sourceChapterId: sh.sourceChapterId ?? '',
      sourceChapterNumber: 0,
      rawText: sh.sourceText,
      characters: sh.characters,
      location: sh.location,
      mood: sh.mood,
      hasDialogue: !!sh.dialogue,
      hasAction: false,
    }));

    const shots = await buildStoryboard(rawShots, ctx, (done, total) => {
      store.setStageStatus(novelProjectId, stage, 'running', { progress: done / total });
      this.cb.onShotProgress?.(done, total);
    });

    store.setShots(novelProjectId, shots);
    store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
  }

  private async runVideoGeneration(): Promise<void> {
    const { novelProjectId, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'video_generation';

    store.advanceToStage(novelProjectId, stage);
    store.setStageStatus(novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    const project = store.getProject(novelProjectId);
    if (!project) throw new Error('Video project not initialized');

    const pending = project.shots.filter((sh) => {
      const exists = project.clips.some((c) => c.shotId === sh.id);
      return !exists;
    });

    let done = 0;
    const total = pending.length;
    this.cb.onShotProgress?.(done, total);

    // 简单的并发池
    const queue = [...pending];
    const workers: Promise<void>[] = [];
    for (let w = 0; w < VIDEO_GENERATION_CONCURRENCY; w++) {
      workers.push(this.videoWorker(queue, spec, async (clip) => {
        store.addClip(novelProjectId, clip);
        done += 1;
        store.setStageStatus(novelProjectId, stage, 'running', { progress: done / total });
        this.cb.onShotProgress?.(done, total);
      }));
    }
    await Promise.all(workers);

    store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
  }

  private async videoWorker(
    queue: StoryboardShot[],
    spec: VideoSpec,
    onDone: (clip: GeneratedClip) => Promise<void>,
  ): Promise<void> {
    while (queue.length > 0 && !this.aborted) {
      const shot = queue.shift();
      if (!shot) break;
      try {
        const clip = await this.generateOneClip(shot, spec);
        await onDone(clip);
      } catch (err) {
        console.warn(`Video gen failed for shot ${shot.id}:`, err);
        // 标记该 shot 失败但不中断其他 shot；UI 会显示缺失的片段
      }
    }
  }

  private async generateOneClip(shot: StoryboardShot, spec: VideoSpec): Promise<GeneratedClip> {
    const [w, h] = parseResolution(spec.resolution);
    const response = await providerRouter.generateVideo({
      taskType: 'clip',
      prompt: shot.videoPrompt,
      model: tierToDefaultModel(spec.videoTier),
      width: w,
      height: h,
      durationSeconds: shot.durationSeconds,
      fps: spec.fps,
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
    };
  }

  /**
   * Phase 1 合成：
   *   1. 检测 FFmpeg（Tauri 环境）
   *   2. 把远程 clip URL 全部下载到本地临时目录
   *   3. 调用 FFmpeg 拼接 + 可选字幕硬编码
   *   4. 把最终成片路径写入 store
   * 非 Tauri 环境降级：直接用第一个 clip URL 作为占位。
   */
  private async runComposing(): Promise<void> {
    const { novelProjectId, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'composing';

    store.advanceToStage(novelProjectId, stage);
    store.setStageStatus(novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    const project = store.getProject(novelProjectId);
    if (!project) throw new Error('Video project not initialized');
    if (project.clips.length === 0) {
      throw new Error('No clips to compose');
    }

    // 1) Tauri 环境检测
    const probe = await probeFFmpeg().catch(() => null);
    if (!probe?.available) {
      // 非 Tauri / FFmpeg 不可用：降级，直接用第一个 clip URL
      console.warn('VideoPipeline: FFmpeg unavailable, using first clip as final');
      store.setFinalVideo(novelProjectId, project.clips[0].videoUrl);
      store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
      return;
    }

    // 2) 下载远程 clips 到本地临时目录
    const workDir = `${(await getWorkDir(novelProjectId))}`;
    const localPaths: string[] = [];
    for (let i = 0; i < project.clips.length; i++) {
      const clip = project.clips[i];
      const isRemote = /^https?:\/\//.test(clip.videoUrl);
      if (!isRemote) {
        localPaths.push(clip.videoUrl);
        continue;
      }
      const ext = guessExt(clip.videoUrl);
      const downloaded = await downloadClip(clip.videoUrl, workDir, `clip_${i}${ext}`);
      localPaths.push(downloaded.savedPath);
      store.setStageStatus(novelProjectId, stage, 'running', {
        progress: (i + 1) / (project.clips.length * 2),
      });
    }

    // 3) 调用 FFmpeg 合成
    const outputPath = `${workDir}/final.mp4`;
    const subtitles = project.clips.map((clip) => {
      const shot = project.shots.find((s) => s.id === clip.shotId);
      return shot?.narration ?? null;
    });
    const result = await composeClips({
      clipPaths: localPaths,
      subtitles,
      outputPath,
      hardcodeSubtitles: spec.hardcodeSubtitles,
    });

    // 4) 写入最终成片
    store.setFinalVideo(novelProjectId, result.outputPath);
    store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
  }
}

async function getWorkDir(novelProjectId: string): Promise<string> {
  // 在 Tauri 环境用 app data dir；非 Tauri 走浏览器降级（不会到这里）
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

// --- helpers ---

function toPlaceholderShot(raw: RawShot): StoryboardShot {
  return {
    id: raw.id,
    index: raw.index,
    sourceChapterId: raw.sourceChapterId,
    sourceText: raw.rawText,
    videoPrompt: '',  // 待 storyboard_prompt 填充
    durationSeconds: 5,
    characters: raw.characters,
    location: raw.location,
    mood: raw.mood,
    narration: raw.rawText.slice(0, 80),
  };
}

function parseResolution(s: string): [number, number] {
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) return [1920, 1080];
  return [Number(m[1]), Number(m[2])];
}

/**
 * 根据 tier 选默认模型 ID。Phase 1 只接入了 Kling（已有 adapter），
 * 后续按 tier 扩展到 Seedance / Veo / Sora。
 */
function tierToDefaultModel(tier: VideoSpec['videoTier']): string {
  switch (tier) {
    case 'free':     return 'kling-v2';   // Kling 标准版
    case 'value':    return 'kling-v2';
    case 'quality':  return 'kling-v2-pro';
    case 'premium':  return 'kling-v2-pro';
    default:         return 'kling-v2';
  }
}

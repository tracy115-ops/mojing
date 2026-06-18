// ============================================================================
// Video Pipeline — Novel 通道入口(瘦身后接入 core)
// ============================================================================
// 职责:
//   1. chapter-slicer + storyboard-prompt 产出 ShotSpec[]
//   2. step-extract 补全场景/道具
//   3. 构造 SceneSpec
//   4. 调 core/pipeline-runner 跑下游 14 步子集
//
// 下游 6/7/9/10/12-14 由 runner 编排,本文件只管"剧本处理"段(步 1-5)。

import type {
  VideoProjectState,
  VideoStage,
  StoryboardShot,
  VideoSpec,
  SceneSpec,
  ShotSpec,
  PipelineOptions,
  CharacterAnchor,
} from '@/types/video';
import type { NovelChapter } from '@/types';
import { useVideoStore } from '@/stores/videoStore';
import { sliceChapters, type RawShot } from './chapter-slicer';
import { buildStoryboard, type StoryboardContext } from './storyboard-prompt';
import { stepExtract } from './core/step-extract';
import { runPipeline, type VideoGenOptions } from './core/pipeline-runner';
import { pushStageContext, popStageContext } from '@/services/providers/invocation-context';

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
  /** 用户选定的章节(按顺序) */
  chapters: Pick<NovelChapter, 'id' | 'order' | 'content'>[];
  spec: VideoSpec;
  /** Phase 2:用户勾选的可选步骤 */
  options?: PipelineOptions;
}

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
    const { novelProjectId, chapters, spec, options } = this.input;
    store.initProject(novelProjectId, chapters.map((c) => c.id), spec);

    // 默认开关(若用户没传 options,从 spec 的 enable* 字段构造)
    const pipelineOptions: PipelineOptions =
      options ?? specToOptions(spec);

    store.setPipelineOptions(novelProjectId, pipelineOptions);

    try {
      // --- 步 1:章节切片 ---
      const rawShots = await this.runScriptSlicing();

      // --- 步 2+5:LLM 改写 + 分镜 ---
      const storyboardShots = await this.runStoryboardPrompt(rawShots);

      // --- 步 3:提取角色/场景/道具 ---
      const sceneSpec = await this.runExtraction(rawShots, storyboardShots);

      // --- 步 4:音色(期 3) ---
      // 暂跳过

      // --- 步 6-14:交由 core runner ---
      const videoGen: VideoGenOptions = {
        spec: {
          resolution: spec.resolution,
          fps: spec.fps,
          videoTier: spec.videoTier,
        },
        sceneSource: 'novel',
        sourceMode: 'multishot', // Novel 通道语义上是多镜头
      };

      return await runPipeline({
        novelProjectId,
        spec: sceneSpec,
        options: pipelineOptions,
        callbacks: this.cb,
        videoGen,
        shouldAbort: () => this.aborted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useVideoStore.getState().setError(novelProjectId, msg);
      this.cb.onError?.(msg);
      return null;
    }
  }

  // --- 步 1 ---

  private async runScriptSlicing(): Promise<RawShot[]> {
    const { chapters, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'script_slicing';

    store.advanceToStage(this.input.novelProjectId, stage);
    store.setStageStatus(this.input.novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    const totalWords = chapters.reduce((s, c) => s + c.content.length, 0);
    store.setStageInputSummary(this.input.novelProjectId, stage, {
      headline: `${chapters.length} 个章节 / 共 ${totalWords.toLocaleString()} 字`,
      details: chapters.map((c) => `第 ${c.order + 1} 章 · ${(c.content.length / 1000).toFixed(1)}k 字`),
      upstreamArtifacts: undefined,
    });

    pushStageContext({ novelProjectId: this.input.novelProjectId, stage });
    try {
      const rawShots: RawShot[] = sliceChapters(
        chapters.map((c) => ({ id: c.id, number: c.order + 1, content: c.content })),
        {
          targetWordsPerShot: spec.shotDurationSeconds === 10 ? 1200 : 600,
        },
      );

      store.setShots(this.input.novelProjectId, rawShots.map(toPlaceholderShot));
      store.setStageStatus(this.input.novelProjectId, stage, 'completed', { progress: 1 });
      return rawShots;
    } finally {
      popStageContext();
    }
  }

  // --- 步 2+5 ---

  private async runStoryboardPrompt(rawShots: RawShot[]): Promise<StoryboardShot[]> {
    const { novelProjectId, novelTitle, genre, style, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'storyboard_prompt';

    store.advanceToStage(novelProjectId, stage);
    store.setStageStatus(novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    store.setStageInputSummary(novelProjectId, stage, {
      headline: `${rawShots.length} 个候选镜头(章节切片后)`,
      details: rawShots.slice(0, 10).map((r, i) => `镜头 ${i + 1} · ${(r.rawText.length / 1000).toFixed(1)}k 字`),
      upstreamArtifacts: `输入 ${rawShots.reduce((s, r) => s + r.rawText.length, 0).toLocaleString()} 字`,
    });

    const ctx: StoryboardContext = {
      novelTitle,
      genre,
      style,
      aspectRatio: spec.aspectRatio,
      defaultShotDuration: spec.shotDurationSeconds,
    };

    pushStageContext({ novelProjectId, stage });
    try {
      const shots = await buildStoryboard(rawShots, ctx, (done, total) => {
        store.setStageStatus(novelProjectId, stage, 'running', { progress: done / total });
        this.cb.onShotProgress?.(done, total);
      });

      store.setShots(novelProjectId, shots);
      store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
      return shots;
    } finally {
      popStageContext();
    }
  }

  // --- 步 3 ---

  private async runExtraction(
    rawShots: RawShot[],
    storyboardShots: StoryboardShot[],
  ): Promise<SceneSpec> {
    const { novelProjectId, novelTitle, style, spec } = this.input;
    const store = useVideoStore.getState();
    const stage: VideoStage = 'extraction';

    store.advanceToStage(novelProjectId, stage);
    store.setStageStatus(novelProjectId, stage, 'running');
    this.cb.onStageChange?.(stage);

    // 把所有 RawShot 拼成大文本供 LLM 提取
    const fullText = rawShots.map((r) => r.rawText).join('\n\n');

    store.setStageInputSummary(novelProjectId, stage, {
      headline: `${rawShots.length} 个镜头原文,共 ${fullText.length.toLocaleString()} 字`,
      details: storyboardShots.slice(0, 5).map((s) => `镜头 ${s.index + 1} · ${(s.videoPrompt || s.sourceText).slice(0, 40)}…`),
      upstreamArtifacts: `storyboard 已产出 ${storyboardShots.length} 镜`,
    });

    // 把 storyboard shot 转成 ShotSpec(占位 characterIds)
    const shotSpecs: ShotSpec[] = storyboardShots.map((s) => ({
      id: s.id,
      index: s.index,
      sourceChapterId: s.sourceChapterId,
      sourceText: s.sourceText,
      videoPrompt: s.videoPrompt,
      narration: s.narration,
      dialogue: s.dialogue,
      characterIds: s.characters, // chapter-slicer 启发式检测的字符串列表
      location: s.location,
      mood: s.mood,
      cameraMovement: s.cameraMovement,
      durationSeconds: (s.durationSeconds === 10 ? 10 : 5) as 5 | 10,
    }));

    // 步 3 提取:LLM 解析大文本,产出结构化角色/场景/道具
    // 注意:shotSpecs 里的 characterIds 是中文名(从 chapter-slicer 来),
    // LLM 会输出 characterIdMap 把名字映射成 char_xxx,
    // 我们在 step-extract 里用名字回填。
    pushStageContext({ novelProjectId, stage });
    let extractResult;
    try {
      extractResult = await stepExtract({
        text: fullText,
        shots: shotSpecs,
      });
    } finally {
      popStageContext();
    }

    // chapter-slicer 检测的角色是中文名,step-extract 也会输出中文名的角色,
    // 但 step-extract 内部已经做了占位 id 替换。这里再保险一次:把 shots 里
    // 没匹配上的中文名 characterIds 清掉(因为没法生成对应立绘)。
    const knownCharNames = new Set(extractResult.characters.map((c) => c.name));
    const knownCharIds = new Set(extractResult.characters.map((c) => c.id));
    const finalShots: ShotSpec[] = (extractResult.resolvedShots ?? shotSpecs).map((sh) => ({
      ...sh,
      characterIds: sh.characterIds.filter((id) => knownCharIds.has(id) || knownCharNames.has(id)),
    }));

    // 把残留的中文名 characterIds 转成对应角色 id
    const nameToId = new Map(extractResult.characters.map((c) => [c.name, c.id] as const));
    for (const sh of finalShots) {
      sh.characterIds = sh.characterIds
        .map((id) => nameToId.get(id) ?? id)
        .filter((id, idx, arr) => knownCharIds.has(id) && arr.indexOf(id) === idx);
    }

    const sceneSpec: SceneSpec = {
      characters: extractResult.characters,
      scenes: extractResult.scenes,
      props: extractResult.props,
      shots: finalShots,
      meta: {
        title: novelTitle,
        style,
        genre: this.input.genre,
        aspectRatio: spec.aspectRatio,
        defaultShotDuration: spec.shotDurationSeconds,
        sourceMode: 'multishot',
        channel: 'novel',
      },
    };

    store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
    return sceneSpec;
  }
}

// --- helpers ---

function toPlaceholderShot(raw: RawShot): StoryboardShot {
  return {
    id: raw.id,
    index: raw.index,
    sourceChapterId: raw.sourceChapterId,
    sourceText: raw.rawText,
    videoPrompt: '',
    durationSeconds: 5,
    characters: raw.characters,
    location: raw.location,
    mood: raw.mood,
    narration: raw.rawText.slice(0, 80),
  };
}

/**
 * 从 VideoSpec 的 enable* 字段构造 PipelineOptions。
 * 默认全开角色锚定 + 关键帧 + I2V,场景图和 TTS 默认关(成本敏感)。
 */
function specToOptions(spec: VideoSpec): PipelineOptions {
  return {
    enableCharacterAnchor: spec.enableCharacterAnchor ?? true,
    enableSceneImage: spec.enableSceneImage ?? false,
    enableTTS: spec.enableTTS ?? false,
    enableKeyframe: true,
    enableI2V: true,
    enableAudioMerge: spec.enableTTS ?? false,
    enableSubtitles: spec.hardcodeSubtitles,
    characterAnchorLimit: 5,
  };
}

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
import type { NovelChapter, NovelMetadata } from '@/types';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { sliceChapters, type RawShot } from './chapter-slicer';
import { buildStoryboard, type StoryboardContext } from './storyboard-prompt';
import { stepExtract } from './core/step-extract';
import { runPipeline, type VideoGenOptions } from './core/pipeline-runner';
import { pushStageContext, popStageContext } from '@/services/providers/invocation-context';
import { applySeriesProjectLibrary } from './series-character-library';

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
  /** 系列剧集传入的锁定角色资产；章节仍可来自任意小说项目。 */
  seriesCharacters?: CharacterAnchor[];
  seriesScenes?: import('@/types/video').SceneAnchor[];
  seriesStyleGuide?: string;
  /** 上一集结尾状态，仅参与本次分镜规划。 */
  seriesContinuityContext?: string;
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

  /**
   * 从 store 里已存在的 project state 重建 VideoPipeline 实例,用于断点续跑。
   *
   * 场景:用户失败后点「从失败处重试」,或重启应用后想继续未完成的流水线。
   * 此时 VideoGeneratorModal 早已关闭,原 pipeline 实例丢失;但 project state
   * 仍在 videoStore 里(已 persist),我们只需从 projectStore 拉出 novel 元信息
   * + chapters,重建 PipelineInput 即可。
   *
   * 返回 null 表示找不到对应的 novel project(UI 应降级到 fresh start)。
   *
   * Direct 通道(`direct_*` 项目 ID):不存在 novel project,但 spec / options /
   * sceneSpec 都在 videoStore 里。跳过 novel project 查找,直接用 store 状态重建。
   */
  static forResume(
    novelProjectId: string,
    cb: PipelineCallbacks = {},
  ): VideoPipeline | null {
    const videoProject = useVideoStore.getState().getProject(novelProjectId);
    if (!videoProject) return null;

    // Direct 通道 / 纯视频项目: 无 novel 类型的项目元信息,直接用 videoStore 中的 spec/options 重建。
    const novelProject = useProjectStore
      .getState()
      .projects.find((p) => p.id === novelProjectId);

    if (!novelProject || novelProject.type === 'video' || novelProjectId.startsWith('direct_')) {
      return new VideoPipeline(
        {
          novelProjectId,
          novelTitle: novelProject?.title || 'Video',
          genre: '',
          style: '',
          chapters: [],
          spec: videoProject.spec,
          options: videoProject.options,
        },
        cb,
      );
    }

    const meta = novelProject.metadata as NovelMetadata | undefined;
    const chapters: Pick<NovelChapter, 'id' | 'order' | 'content'>[] = (videoProject.selectedChapterIds ?? [])
      .map((cid) => meta?.chapters?.find((c) => c.id === cid))
      .filter((c): c is NovelChapter => !!c);

    return new VideoPipeline(
      {
        novelProjectId,
        novelTitle: novelProject.title,
        genre: meta?.genre || '',
        style: meta?.style || '',
        chapters,
        spec: videoProject.spec,
        options: videoProject.options,
      },
      cb,
    );
  }

  async run(): Promise<VideoProjectState | null> {
    const store = useVideoStore.getState();
    const { novelProjectId, chapters, spec, options } = this.input;
    store.initProject(novelProjectId, chapters.map((c) => c.id), spec, this.input.novelTitle);

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
        novelProjectId,
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

  /**
   * 断点续跑:不 initProject(保留已有 stage 状态/产物),直接重跑 pipeline。
   * - 前 3 步(script_slicing/storyboard/extraction)各自检查 completed,
   *   完成的直接用现有 shots,不重新跑 LLM。
   * - core runner 内部对每个 stage 做 live-completed 检查(见 isStageLiveCompleted)。
   * - 视频生成支持 shot 级增量(runVideoGen 的 preExistingClips)。
   *
   * 场景:用户失败后点「从失败处重试」,或重启应用后继续未完成的流水线。
   */
  async resume(): Promise<VideoProjectState | null> {
    const store = useVideoStore.getState();
    const { novelProjectId, chapters, spec, options } = this.input;
    const existing = store.getProject(novelProjectId);
    if (!existing) {
      // 还没跑过,降级到 run()
      return this.run();
    }

    // 用已有 options,但如果本次传入了新 options 则覆盖
    const pipelineOptions: PipelineOptions = options ?? existing.options ?? specToOptions(spec);
    store.setPipelineOptions(novelProjectId, pipelineOptions);
    // 清掉 error 状态,但保留各 stage 状态(让 runPipeline 内部判断)
    store.setError(novelProjectId, undefined);

    try {
      // Direct 通道:不走 script_slicing/storyboard/extraction。
      // sceneSpec 已经在首次跑时写进了 store(DirectVideoModal 调 runPipeline 前
      // 由 buildSceneFromPrompt 构造,在 runner 里通过 setSceneSpec 持久化)。
      // 失败重试时直接复用 store 里的 sceneSpec,否则报错提示用户重新建任务。
      if (novelProjectId.startsWith('direct_')) {
        if (!existing.sceneSpec) {
          throw new Error(
            'Direct 任务缺少 sceneSpec,无法续跑。请关闭后重新生成(可能是早期版本未持久化)。',
          );
        }
        const videoGen: VideoGenOptions = {
          spec: {
            resolution: spec.resolution,
            fps: spec.fps,
            videoTier: spec.videoTier,
          },
          sceneSource: 'direct',
          sourceMode: 'multishot',
          novelProjectId,
        };

        return await runPipeline({
          novelProjectId,
          spec: existing.sceneSpec,
          options: pipelineOptions,
          callbacks: this.cb,
          videoGen,
          shouldAbort: () => this.aborted,
        });
      }

      // 前 3 步逻辑(Novel 通道):已完成则直接复用,否则跑一遍。
      // 跳过条件:script_slicing 必须 completed(否则后面两个 stage 没有 rawShots 输入)。
      // 如果 script_slicing completed 但 storyboard/extraction 失败,则需要重建 rawShots;
      // 这种情况比较少见,我们就直接从头重跑前三步。
      const scriptDone = existing.stages.script_slicing?.status === 'completed' && existing.shots.length > 0;
      const extractionDone = existing.stages.extraction?.status === 'completed' && !!existing.sceneSpec;

      let sceneSpec: SceneSpec | null = null;

      if (extractionDone) {
        // 三步都跑过且 sceneSpec 仍在,直接用
        sceneSpec = existing.sceneSpec!;
      } else if (scriptDone) {
        // slicing 跑过但 extraction 没完成 — 前三步整体重跑(无法可靠重建 RawShot)
        const rawShots = await this.runScriptSlicing();
        const storyboardShots = await this.runStoryboardPrompt(rawShots);
        sceneSpec = await this.runExtraction(rawShots, storyboardShots);
      } else {
        // 没跑过,从头跑
        const rawShots = await this.runScriptSlicing();
        const storyboardShots = await this.runStoryboardPrompt(rawShots);
        sceneSpec = await this.runExtraction(rawShots, storyboardShots);
      }

      const videoGen: VideoGenOptions = {
        spec: {
          resolution: spec.resolution,
          fps: spec.fps,
          videoTier: spec.videoTier,
        },
        sceneSource: 'novel',
        sourceMode: 'multishot',
        novelProjectId,
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
      const isScript = this.input.genre === 'script' || this.input.genre === 'custom_script';
      const rawShots: RawShot[] = sliceChapters(
        chapters.map((c) => ({ id: c.id, number: c.order + 1, content: c.content })),
        {
          isScript,
          targetWordsPerShot: isScript ? 100 : (spec.shotDurationSeconds === 10 ? 1200 : 600),
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
      continuityContext: this.input.seriesContinuityContext,
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
      durationSeconds: (typeof s.durationSeconds === 'number' && s.durationSeconds > 0 ? s.durationSeconds : 4) as any,
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

    const boundSpec = applySeriesProjectLibrary(sceneSpec, {
      characters: this.input.seriesCharacters,
      scenes: this.input.seriesScenes,
      styleGuide: this.input.seriesStyleGuide,
    });

    const matchedChars = boundSpec.meta.matchedCharacterNames ?? [];
    const unmatchedChars = boundSpec.meta.unmatchedCharacterNames ?? [];
    const matchedScenes = boundSpec.meta.matchedSceneNames ?? [];

    const summaryDetails = [
      ...storyboardShots.slice(0, 3).map((s) => `镜头 ${s.index + 1} · ${(s.videoPrompt || s.sourceText).slice(0, 30)}…`),
    ];
    if (matchedChars.length > 0) {
      summaryDetails.push(`✅ 已匹配系列角色 (${matchedChars.length}): ${matchedChars.join(', ')}`);
    }
    if (unmatchedChars.length > 0) {
      summaryDetails.push(`⚠️ 剧集局部/新角色 (${unmatchedChars.length}): ${unmatchedChars.join(', ')}`);
    }
    if (matchedScenes.length > 0) {
      summaryDetails.push(`🏛️ 已匹配系列场景 (${matchedScenes.length}): ${matchedScenes.join(', ')}`);
    }

    store.setStageInputSummary(novelProjectId, stage, {
      headline: `提取完成: ${boundSpec.characters?.length ?? 0} 个角色, ${boundSpec.scenes?.length ?? 0} 个场景`,
      details: summaryDetails,
      upstreamArtifacts: `storyboard ${storyboardShots.length} 镜 / 系列资产已绑定`,
    });

    store.setStageStatus(novelProjectId, stage, 'completed', { progress: 1 });
    return boundSpec;
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
 * 默认开启全部 11 步完整流水线(包含角色锚定、场景空景图、TTS 配音与音视拼接)。
 */
function specToOptions(spec: VideoSpec): PipelineOptions {
  return {
    enableCharacterAnchor: spec.enableCharacterAnchor ?? true,
    enableSceneImage: spec.enableSceneImage ?? true,
    enableTTS: spec.enableTTS ?? true,
    enableKeyframe: true,
    enableI2V: true,
    enableAudioMerge: spec.enableTTS ?? true,
    enableSubtitles: spec.hardcodeSubtitles ?? true,
    characterAnchorLimit: 5,
  };
}

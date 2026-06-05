import type {
  AutopilotState,
  AutopilotStatus,
  NovelStage,
  CircuitBreakerState,
} from '@/types/pipeline';
import type { StoryPhaseState, Foreshadowing, ChapterAftermathResult } from '@/types/narrative';
import type { NovelChapter, NovelMetadata } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { MemoryEngine } from './memory-engine';
import { ContextBudgetAllocator } from './context-budget';
import { ForeshadowingTracker } from './foreshadowing-tracker';
import { ChapterAftermathPipeline } from './chapter-aftermath';

export type AutopilotEventType =
  | 'stage_change'
  | 'chapter_progress'
  | 'chapter_complete'
  | 'review_complete'
  | 'error'
  | 'status_change';

export interface AutopilotEvent {
  type: AutopilotEventType;
  novelId: string;
  data: Record<string, unknown>;
}

type AutopilotEventHandler = (event: AutopilotEvent) => void;

interface AutopilotConfig {
  novelId: string;
  title: string;
  genre: string;
  style: string;
  targetChapterCount: number;
  targetWordCount: number;
  existingChapters: NovelChapter[];
  onUpdateChapter: (chapterId: string, updates: Partial<NovelChapter>) => void;
  onAddChapter: () => string; // returns new chapter id
  onUpdateMetadata: (updates: Partial<NovelMetadata>) => void;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000;
const WORDS_PER_CHAPTER_TARGET = 3000;

export class AutopilotEngine {
  private state: AutopilotState;
  private breaker: CircuitBreakerState;
  private memory: MemoryEngine;
  private budget: ContextBudgetAllocator;
  private foreshadowing: ForeshadowingTracker;
  private aftermath: ChapterAftermathPipeline;
  private abortController: AbortController | null = null;
  private handlers: Set<AutopilotEventHandler> = new Set();
  private config: AutopilotConfig;
  private storyPhase: StoryPhaseState | null = null;

  constructor(config: AutopilotConfig) {
    this.config = config;
    this.state = {
      novelId: config.novelId,
      status: 'idle',
      currentStage: 'idle',
      currentChapterNumber: config.existingChapters.length,
      currentBeatIndex: 0,
      targetChapterCount: config.targetChapterCount,
      targetWordCount: config.targetWordCount,
      currentWordCount: config.existingChapters.reduce((s, c) => s + c.wordCount, 0),
      consecutiveFailures: 0,
      progress: 0,
    };
    this.breaker = {
      state: 'closed',
      failureCount: 0,
      failureThreshold: CIRCUIT_BREAKER_THRESHOLD,
      resetTimeoutMs: CIRCUIT_BREAKER_RESET_MS,
    };
    this.memory = new MemoryEngine(config.novelId);
    this.budget = new ContextBudgetAllocator();
    this.foreshadowing = new ForeshadowingTracker();
    this.aftermath = new ChapterAftermathPipeline();
  }

  // --- Event system ---

  onEvent(handler: AutopilotEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(type: AutopilotEventType, data: Record<string, unknown> = {}) {
    const event: AutopilotEvent = { type, novelId: this.state.novelId, data };
    for (const handler of this.handlers) {
      try { handler(event); } catch { /* swallow */ }
    }
  }

  // --- State access ---

  getState(): AutopilotState {
    return { ...this.state };
  }

  getBreaker(): CircuitBreakerState {
    return { ...this.breaker };
  }

  getStoryPhase(): StoryPhaseState | null {
    return this.storyPhase;
  }

  // --- Control ---

  async start(): Promise<void> {
    if (this.state.status === 'running') return;

    this.abortController = new AbortController();
    this.updateStatus('running');
    this.emit('status_change', { status: 'running' });

    try {
      await this.runLoop();
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
        this.updateStatus('error');
        this.emit('error', { error: this.state.lastError });
      }
    }
  }

  pause(): void {
    if (this.state.status !== 'running') return;
    this.updateStatus('paused');
    this.abortController?.abort();
    this.emit('status_change', { status: 'paused' });
  }

  resume(): void {
    if (this.state.status !== 'paused') return;
    this.start();
  }

  stop(): void {
    this.abortController?.abort();
    this.updateStatus('idle');
    this.state.currentStage = 'idle';
    this.emit('status_change', { status: 'idle' });
  }

  // --- Main loop ---

  private async runLoop(): Promise<void> {
    const startChapter = this.state.currentChapterNumber;
    const targetChapter = this.state.targetChapterCount;

    for (let ch = startChapter; ch < targetChapter; ch++) {
      if (this.abortController?.signal.aborted) return;
      if (this.breaker.state === 'open') {
        this.updateStatus('paused');
        this.emit('status_change', { status: 'paused', reason: 'circuit_breaker' });
        return;
      }

      this.state.currentChapterNumber = ch;
      this.state.progress = ch / targetChapter;
      this.emit('stage_change', { stage: this.state.currentStage, chapter: ch });

      try {
        await this.generateChapter(ch);
        this.state.consecutiveFailures = 0;
        this.state.currentWordCount = this.config.existingChapters.reduce(
          (s, c) => s + c.wordCount,
          0,
        );
      } catch (err) {
        this.state.consecutiveFailures++;
        this.breaker.failureCount++;

        if (this.breaker.failureCount >= this.breaker.failureThreshold) {
          this.breaker.state = 'open';
          this.breaker.lastFailureTime = new Date().toISOString();
          this.updateStatus('paused');
          this.emit('status_change', {
            status: 'paused',
            reason: 'circuit_breaker',
            error: `连续 ${this.breaker.failureCount} 次生成失败，已自动暂停。最后错误：${this.state.lastError}`,
          });
          return;
        }

        this.state.lastError = err instanceof Error ? err.message : String(err);
        this.emit('error', { error: `第${ch + 1}章生成失败: ${this.state.lastError}`, chapter: ch });
        // Update store so UI can show the error immediately
        const store = await import('@/stores/autopilotStore').then(m => m.useAutopilotStore.getState());
        store.setAutopilotState(this.state.novelId, { lastError: `第${ch + 1}章失败: ${this.state.lastError}` });
        // Continue to next chapter after brief pause
        await this.delay(2000);
      }
    }

    this.state.progress = 1;
    this.updateStatus('completed');
    this.emit('status_change', { status: 'completed' });
  }

  // --- Chapter generation pipeline ---

  private async generateChapter(chapterIndex: number): Promise<void> {
    const chapterNumber = chapterIndex + 1;

    // Stage 1: Macro planning
    this.setStage('macro_planning');
    this.computeStoryPhase(chapterIndex);
    const macroPlan = await this.doMacroPlanning(chapterIndex);

    // Stage 2: Act beat planning
    this.setStage('act_beat_planning');
    const outline = await this.doActBeatPlanning(chapterIndex, macroPlan);

    // Add chapter to store
    const chapterId = this.config.onAddChapter();
    this.config.onUpdateChapter(chapterId, {
      title: macroPlan.title || `第${chapterNumber}章`,
      outline,
      status: 'drafting',
    });

    // Stage 3: Chapter generation
    this.setStage('chapter_generation');
    const content = await this.doChapterGeneration(chapterIndex, outline, chapterId);

    // Stage 4: Chapter review
    this.setStage('chapter_review');
    await this.doChapterReview(chapterIndex, content, chapterId);

    // Post-chapter aftermath
    await this.doAftermath(chapterIndex, content);
  }

  // --- Stage implementations ---

  private async doMacroPlanning(chapterIndex: number): Promise<{ title: string; direction: string }> {
    this.emit('stage_change', { stage: 'macro_planning', chapter: chapterIndex });

    const prevChapters = this.config.existingChapters
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-3)
      .map((c) => `第${c.order + 1}章 ${c.title}: ${c.outline}`)
      .join('\n');

    const phaseDirective = this.storyPhase
      ? ContextBudgetAllocator.buildPhaseDirective(this.storyPhase)
      : '';

    const foreshadowingContext = this.foreshadowing.buildForeshadowingContext(
      chapterIndex,
      this.storyPhase ?? ContextBudgetAllocator.computeStoryPhase(chapterIndex, this.state.targetChapterCount),
    );

    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: `你是一个资深小说策划师。你的任务是为下一章制定宏观方向。

小说：${this.config.title}
类型：${this.config.genre}
风格：${this.config.style}

${phaseDirective}

${foreshadowingContext}

请输出JSON格式：
{
  "title": "章节标题",
  "direction": "本章发展方向和核心冲突（100-200字）",
  "target_word_count": 3000
}`,
      userPrompt: prevChapters
        ? `已有章节概要：\n${prevChapters}\n\n请为第${chapterIndex + 1}章制定方向。`
        : `这是小说的开篇。请为第1章制定方向。`,
      responseFormat: 'json',
      temperature: 0.8,
      maxTokens: 1024,
    };

    const response = await providerRouter.generate(request);
    try {
      const data = JSON.parse(response.content);
      return {
        title: data.title || `第${chapterIndex + 1}章`,
        direction: data.direction || '',
      };
    } catch {
      return { title: `第${chapterIndex + 1}章`, direction: '' };
    }
  }

  private async doActBeatPlanning(chapterIndex: number, macroPlan: { title: string; direction: string }): Promise<string> {
    this.emit('stage_change', { stage: 'act_beat_planning', chapter: chapterIndex });

    const prevSummary = this.config.existingChapters
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-1)
      .map((c) => c.content.slice(-500))
      .join('\n');

    const factLockText = this.memory.buildFactLockText();
    const beatLockText = this.memory.buildBeatLockText();
    const clueLockText = this.memory.buildClueLockText();

    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: `你是一个专业的小说大纲规划师。根据宏观方向，生成详细的章节大纲。

大纲应包含：场景设定、主要事件节拍（3-5个）、人物行动、情绪走向、关键对话要点、伏笔设计。

小说：${this.config.title}
类型：${this.config.genre}
风格：${this.config.style}

${factLockText}
${beatLockText}
${clueLockText}`,
      userPrompt: `${prevSummary ? `上一章结尾：\n${prevSummary}\n\n` : ''}宏观方向：${macroPlan.direction}\n\n请为第${chapterIndex + 1}章 "${macroPlan.title}" 生成详细大纲。`,
      temperature: 0.8,
      maxTokens: 1024,
    };

    const response = await providerRouter.generate(request);
    return response.content;
  }

  private async doChapterGeneration(chapterIndex: number, outline: string, chapterId: string): Promise<string> {
    this.emit('stage_change', { stage: 'chapter_generation', chapter: chapterIndex });

    // Build context using onion model
    this.budget = new ContextBudgetAllocator();

    const factLockText = this.memory.buildFactLockText();
    const beatLockText = this.memory.buildBeatLockText();
    const clueLockText = this.memory.buildClueLockText();
    const foreshadowingText = this.foreshadowing.buildForeshadowingContext(
      chapterIndex,
      this.storyPhase ?? ContextBudgetAllocator.computeStoryPhase(chapterIndex, this.state.targetChapterCount),
    );

    if (factLockText) this.budget.registerFactLock(factLockText);
    if (beatLockText) this.budget.registerBeatLock(beatLockText);
    if (clueLockText) this.budget.registerClueLock(clueLockText);
    if (foreshadowingText) this.budget.registerActiveForeshadowing(foreshadowingText);

    this.budget.registerStoryAnchor(`小说: ${this.config.title} | 类型: ${this.config.genre} | 风格: ${this.config.style}`);
    this.budget.registerChapterOutline(outline);

    const prevContent = this.config.existingChapters
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-1)
      .map((c) => c.content.slice(-1500))
      .join('\n');
    if (prevContent) this.budget.registerPreviousChapter(prevContent);

    const { prompt: contextPrompt } = this.budget.allocate();

    const phaseDirective = this.storyPhase
      ? ContextBudgetAllocator.buildPhaseDirective(this.storyPhase)
      : '';

    const request: LLMGenerateRequest = {
      taskType: 'generation',
      systemPrompt: `你是一个优秀的小说作家。根据大纲和上下文写出精彩的章节正文。

要求：
- 文笔流畅，描写生动
- 对话自然，符合人物性格
- 情节紧凑，有张力
- 字数 ${WORDS_PER_CHAPTER_TARGET} 字左右

小说：${this.config.title}
类型：${this.config.genre}
风格：${this.config.style}

${phaseDirective}

${contextPrompt}`,
      userPrompt: `大纲：\n${outline}\n\n请写出第${chapterIndex + 1}章的正文。`,
      temperature: 0.85,
      maxTokens: 4096,
    };

    // Stream content with real-time updates
    let fullContent = '';
    let lastFlushTime = 0;

    // Notify UI to switch to this chapter immediately
    this.emit('chapter_progress', {
      chapter: chapterIndex,
      chapterId,
      wordCount: 0,
    });

    for await (const chunk of providerRouter.stream(request)) {
      if (this.abortController?.signal.aborted) break;
      fullContent += chunk.delta;

      // Throttle store updates to ~8/sec — smooth enough visually, not killing React
      const now = Date.now();
      if (now - lastFlushTime > 120) {
        lastFlushTime = now;
        this.config.onUpdateChapter(chapterId, {
          content: fullContent,
          wordCount: fullContent.length,
          status: 'drafting',
        });

        this.emit('chapter_progress', {
          chapter: chapterIndex,
          chapterId,
          wordCount: fullContent.length,
        });
      }
    }

    // Final flush — always write the complete content
    this.config.onUpdateChapter(chapterId, {
      content: fullContent,
      wordCount: fullContent.length,
      status: 'drafting',
    });

    return fullContent;
  }

  private async doChapterReview(chapterIndex: number, content: string, chapterId: string): Promise<void> {
    this.emit('stage_change', { stage: 'chapter_review', chapter: chapterIndex });

    const request: LLMGenerateRequest = {
      taskType: 'review',
      systemPrompt: `你是一个严格的小说审稿编辑。审查章节正文的质量。

评分维度（每项0-10分）：
1. 情节连贯性：是否与前文矛盾
2. 人物一致性：对话和行动是否符合人设
3. 文笔质量：描写是否生动流畅
4. 节奏感：叙事节奏是否合理
5. 读者吸引力：是否引人入胜

输出JSON：
{
  "scores": { "coherence": 8, "character": 7, "prose": 8, "pacing": 7, "engagement": 8 },
  "overall": 7.6,
  "issues": ["问题描述1", "问题描述2"],
  "suggestions": ["改进建议1", "改进建议2"],
  "pass": true
}`,
      userPrompt: content,
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 1024,
    };

    try {
      const response = await providerRouter.generate(request);
      const review = JSON.parse(response.content);
      const passed = review.pass !== false && (review.overall ?? 0) >= 6;

      this.config.onUpdateChapter(chapterId, {
        status: passed ? 'complete' : 'revising',
      });

      this.emit('review_complete', {
        chapter: chapterIndex,
        chapterId,
        review,
        passed,
      });
    } catch {
      // Review failed, mark as complete anyway
      this.config.onUpdateChapter(chapterId, { status: 'complete' });
    }
  }

  private async doAftermath(chapterIndex: number, content: string): Promise<void> {
    try {
      // Update memory engine from chapter content (extracts beats, clues, anchors)
      await this.memory.updateFromChapter(chapterIndex + 1, content);
    } catch (err) {
      console.warn('AutopilotEngine: memory update failed', err);
    }

    try {
      // Run aftermath pipeline (extracts triples, foreshadowing, etc.)
      const result: ChapterAftermathResult = await this.aftermath.process(
        this.state.novelId,
        chapterIndex + 1,
        content,
        this.foreshadowing.serialize(),
      );

      // Merge extracted triples into memory
      if (result.triples?.length) {
        this.memory.mergeTriples(result.triples);
      }

      // Process new foreshadowings
      for (const planted of result.foreshadowings.planted) {
        this.foreshadowing.plant(planted);
      }
      for (const resolved of result.foreshadowings.resolved) {
        this.foreshadowing.resolve(resolved.id, resolved.resolvedInChapter ?? chapterIndex + 1);
      }
    } catch (err) {
      console.warn('AutopilotEngine: aftermath pipeline failed', err);
    }

    // Always emit chapter_complete with whatever data we have
    const narrative = this.getNarrativeData();
    this.emit('chapter_complete', {
      chapter: chapterIndex,
      narrative,
    });
  }

  // --- Helpers ---

  private computeStoryPhase(chapterIndex: number): void {
    this.storyPhase = ContextBudgetAllocator.computeStoryPhase(
      chapterIndex,
      this.state.targetChapterCount,
    );
  }

  private setStage(stage: NovelStage): void {
    this.state.currentStage = stage;
    this.emit('stage_change', { stage });
  }

  private updateStatus(status: AutopilotStatus): void {
    this.state.status = status;
    this.state.lastRunAt = new Date().toISOString();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Narrative data extraction for UI ---

  getNarrativeData() {
    const mem = this.memory.serialize();
    return {
      triples: mem.factLock.relationshipGraph,
      anchors: mem.factLock.timelineAnchors,
      beats: mem.beatLock.completedBeats,
      foreshadowing: this.foreshadowing.serialize(),
    };
  }

  // --- Serialize state for store persistence ---

  serializeState() {
    const mem = this.memory.serialize();
    return {
      autopilot: this.getState(),
      breaker: this.getBreaker(),
      storyPhase: this.storyPhase,
      foreshadowing: this.foreshadowing.serialize(),
      triples: mem.factLock.relationshipGraph,
      anchors: mem.factLock.timelineAnchors,
      beats: mem.beatLock.completedBeats,
    };
  }
}

import type {
  AutopilotState,
  AutopilotStatus,
  NovelStage,
  CircuitBreakerState,
} from '@/types/pipeline';
import type { StoryPhaseState, Beat, GlobalPlan, StoryNode } from '@/types/narrative';
import type { NovelChapter, NovelMetadata } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { MemoryEngine } from './memory-engine';
import { ContextBudgetAllocator } from './context-budget';
import { ForeshadowingTracker } from './foreshadowing-tracker';
import { CheckpointManager } from './checkpoint-manager';
import { TensionScoringService } from './tension-scorer';
import { KnowledgeGraphEngine } from './knowledge-graph';
import { GovernanceEngine } from './governance-engine';
import { NarrativeRepository } from './narrative-repository';
import { parseLLMJson } from './llm-json';
import { ChapterReviewer, type ChapterReviewContext, type ChapterReviewReport } from './chapter-reviewer';
import { isReviewCurrent } from './editorial-review';
import { textFingerprint } from './writing-context';
import { collectNovelStreamText, generatePlanningResponse } from './planning-generation';
import { reviewStoryPlan } from './story-plan-review';
import {
  magnifyOutlineToBeats,
  getConductorSignal,
  adjustBeatTargetWords,
  WORDS_PER_CHAPTER_TARGET,
} from './chapter-conductor';
import { getTemplate } from './prompt-templates';

export type AutopilotEventType =
  | 'stage_change'
  | 'chapter_progress'
  | 'chapter_complete'
  | 'review_complete'
  | 'error'
  | 'status_change'
  | 'beat_plan'
  | 'beat_start'
  | 'beat_complete';

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
  description?: string;
  language?: string;
  targetChapterCount: number;
  targetWordCount: number;
  existingChapters: NovelChapter[];
  onUpdateChapter: (chapterId: string, updates: Partial<NovelChapter>) => void;
  onAddChapter: (volumeId?: string) => string;
  onAddVolume: (title: string) => string;
  onUpdateMetadata: (updates: Partial<NovelMetadata>) => void;
  getChapters: () => NovelChapter[];
  // New StoryNode callbacks (optional — if provided, engine uses StoryNode path)
  getStoryNodes?: () => StoryNode[];
  onSetStoryNodes?: (nodes: StoryNode[]) => void;
  onUpdateStoryNode?: (nodeId: string, updates: Partial<StoryNode>) => void;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000;
const CHAPTER_WRITING_DRAFT = 'chapter-writing-draft';
const NOVEL_PROSE_CONTEXT_BUDGET = 48_000;

interface ChapterWritingDraft {
  chapterId: string;
  beats: Beat[];
  nextBeat: number;
  content: string;
  previousFingerprint: string;
  overspendDebt: number;
}

export class AutopilotEngine {
  private state: AutopilotState;
  private breaker: CircuitBreakerState;
  private memory: MemoryEngine;
  private budget: ContextBudgetAllocator;
  private foreshadowing: ForeshadowingTracker;
  private checkpoint: CheckpointManager;
  private tension: TensionScoringService;
  private knowledgeGraph: KnowledgeGraphEngine;
  private governance: GovernanceEngine;
  private reviewer: ChapterReviewer;
  private repo: NarrativeRepository;
  private abortController: AbortController | null = null;
  private handlers: Set<AutopilotEventHandler> = new Set();
  private config: AutopilotConfig;
  private storyPhase: StoryPhaseState | null = null;
  private globalPlan: GlobalPlan | null = null;

  constructor(config: AutopilotConfig) {
    this.config = config;
    this.repo = new NarrativeRepository(config.novelId);
    this.checkpoint = new CheckpointManager(config.novelId);
    this.tension = new TensionScoringService(config.novelId);
    this.knowledgeGraph = new KnowledgeGraphEngine(config.novelId);
    this.governance = new GovernanceEngine(config.novelId);
    this.reviewer = new ChapterReviewer(config.novelId);
    const startingChapter = this.firstUnfinishedChapter(config.existingChapters) ?? config.existingChapters.length;
    this.state = {
      novelId: config.novelId,
      status: 'idle',
      currentStage: 'idle',
      currentChapterNumber: startingChapter,
      currentBeatIndex: 0,
      targetChapterCount: config.targetChapterCount,
      targetWordCount: config.targetWordCount,
      currentWordCount: config.existingChapters.reduce((s, c) => s + c.wordCount, 0),
      consecutiveFailures: 0,
      progress: Math.min(1, startingChapter / Math.max(1, config.targetChapterCount)),
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

    // Restore persisted narrative data (Bible, triples, foreshadowing, beats)
    this.restoreFromRepository();
    // Then try checkpoint restore (overrides if checkpoint exists)
    this.restoreFromCheckpoint();
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

  getGlobalPlan(): GlobalPlan | null {
    return this.globalPlan;
  }

  // --- Control ---

  async start(): Promise<void> {
    if (this.state.status === 'running') return;

    const controller = new AbortController();
    this.abortController = controller;
    const firstUnfinished = this.firstUnfinishedChapter(this.config.getChapters());
    if (firstUnfinished !== undefined) {
      this.state.currentChapterNumber = Math.min(this.state.currentChapterNumber, firstUnfinished);
      this.state.progress = Math.min(1, this.state.currentChapterNumber / Math.max(1, this.state.targetChapterCount));
    }
    this.state.lastError = undefined;
    this.updateStatus('running');
    this.emit('status_change', { status: 'running' });

    try {
      // Check for existing global plan (resume scenario)
      const existingPlan = this.repo.loadGlobalPlan();
      if (existingPlan) {
        this.globalPlan = existingPlan;
      } else {
        // Global planning phase — plan all volumes and chapters upfront
        this.setStage('global_planning');
        this.emit('stage_change', { stage: 'global_planning' });
        const plan = await this.doGlobalPlanning();
        if (controller.signal.aborted) return;
        this.globalPlan = plan;
        await this.executeGlobalPlan(plan);
      }

      await this.runLoop();
    } catch (err) {
      if (!controller.signal.aborted) {
        this.state.lastError = err instanceof Error ? err.message : String(err);
        this.updateStatus('error');
        this.emit('error', { error: this.state.lastError });
        this.emit('status_change', { status: 'error', error: this.state.lastError });
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
    const signal = this.abortController?.signal;
    const startChapter = this.state.currentChapterNumber;
    const targetChapter = this.state.targetChapterCount;

    for (let ch = startChapter; ch < targetChapter; ch++) {
      if (signal?.aborted) return;
      if (this.state.status === 'paused') return;
      if (this.breaker.state === 'open') {
        this.updateStatus('paused');
        this.emit('status_change', { status: 'paused', reason: 'circuit_breaker' });
        return;
      }

      this.state.currentChapterNumber = ch;
      this.state.progress = ch / targetChapter;
      this.emit('stage_change', { stage: this.state.currentStage, chapter: ch, progress: this.state.progress });

      try {
        await this.generateChapter(ch);
        if (!this.isRunning() || signal?.aborted) return;
        this.state.consecutiveFailures = 0;
        this.state.currentWordCount = this.config.getChapters().reduce(
          (s, c) => s + c.wordCount,
          0,
        );
      } catch (err) {
        if (signal?.aborted) return;
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
        try {
          const store = await import('@/stores/autopilotStore').then(m => m.useAutopilotStore.getState());
          store.setAutopilotState(this.state.novelId, { lastError: `第${ch + 1}章失败: ${this.state.lastError}` });
        } catch { /* store not available */ }
        this.updateStatus('paused');
        this.emit('status_change', { status: 'paused', reason: 'chapter_failed' });
        return;
      }
    }

    this.state.progress = 1;
    this.updateStatus('completed');
    this.emit('status_change', { status: 'completed' });
  }

  // --- Chapter generation pipeline ---

  private async generateChapter(chapterIndex: number): Promise<void> {
    const signal = this.abortController?.signal;
    const chapterNumber = chapterIndex + 1;
    const chapters = this.config.getChapters();
    const existing = chapters.find(c => c.order === chapterIndex);
    const draft = this.repo.loadCustomData<ChapterWritingDraft | null>(CHAPTER_WRITING_DRAFT, null);
    if (existing && draft?.chapterId === existing.id && existing.status === 'drafting') {
      this.computeStoryPhase(chapterIndex);
      await this.generateAndReviewChapter(chapterIndex, existing.outline, existing.id, signal, draft);
      return;
    }
    if (existing?.content.trim()) {
      // Resume reviews the saved draft; it must not silently replace a chapter the author edited.
      const report = this.reviewer.loadHistory().find(r => r.chapter === chapterIndex);
      if (this.canSkipChapter(existing, report, chapters)) return;
      this.setStage('chapter_review');
      const content = await this.doQualityGateRewrite(chapterIndex, existing.content, existing.id);
      if (this.state.status === 'paused' || signal?.aborted) return;
      await this.doAftermath(chapterIndex, content, existing.id);
      return;
    }

    // Stage 1: Macro planning
    this.setStage('macro_planning');
    this.computeStoryPhase(chapterIndex);
    const macroPlan = await this.doMacroPlanning(chapterIndex);
    if (signal?.aborted) return;

    // Stage 2: Act beat planning
    this.setStage('act_beat_planning');
    const outline = await this.doActBeatPlanning(chapterIndex, macroPlan);
    if (signal?.aborted) return;

    // Find existing stub from global planning, or create new chapter
    let chapterId: string;
    // Try StoryNode path first
    if (this.config.getStoryNodes) {
      const nodes = this.config.getStoryNodes();
      const chapterNodes = nodes.filter((n) => n.nodeType === 'chapter').sort((a, b) => a.order - b.order);
      const existingNode = chapterNodes[chapterIndex];
      if (existingNode && existingNode.status === 'planned') {
        chapterId = existingNode.id;
      } else if (existingNode) {
        chapterId = existingNode.id;
      } else {
        chapterId = this.config.onAddChapter();
      }
    } else {
      const latestChapters = this.config.getChapters();
      const existingStub = latestChapters.find(
        (c) => c.order === chapterIndex && c.status === 'planned',
      );
      chapterId = existingStub
        ? existingStub.id
        : this.config.onAddChapter();
    }

    this.config.onUpdateChapter(chapterId, {
      title: macroPlan.title || `第${chapterNumber}章`,
      outline,
      status: 'drafting',
    });
    // Also update StoryNode if callback available
    this.config.onUpdateStoryNode?.(chapterId, {
      title: macroPlan.title || `第${chapterNumber}章`,
      outline,
      status: 'drafting',
    });

    this.emit('chapter_progress', { chapterId, chapterNumber });

    await this.generateAndReviewChapter(chapterIndex, outline, chapterId, signal);
  }

  private async generateAndReviewChapter(chapterIndex: number, outline: string, chapterId: string, signal?: AbortSignal, draft?: ChapterWritingDraft) {
    // Stage 3: Chapter generation (beat loop)
    this.setStage('chapter_generation');
    let content = await this.doChapterGeneration(chapterIndex, outline, chapterId, draft);
    if (signal?.aborted) return;

    // Stage 4: Chapter review and any targeted revision
    this.setStage('chapter_review');
    content = await this.doQualityGateRewrite(chapterIndex, content, chapterId);
    if (this.state.status === 'paused' || signal?.aborted) return;

    // Post-chapter aftermath
    await this.doAftermath(chapterIndex, content, chapterId);
  }

  // --- Stage implementations ---

  private isRunning(): boolean { return this.state.status === 'running'; }

  private reviewContext(chapterIndex: number, chapters = this.config.getChapters()): ChapterReviewContext {
    return { source: {
      title: this.config.title, description: this.config.description || '', genre: this.config.genre,
      style: this.config.style, language: this.config.language,
    }, chapters, outline: chapters.find(c => c.order === chapterIndex)?.outline };
  }

  private canSkipChapter(chapter: NovelChapter, report: ChapterReviewReport | undefined, chapters: NovelChapter[]): boolean {
    if (chapter.status !== 'complete' || !chapter.content.trim()) return false;
    // Existing manuscripts may have been marked complete before review reports existed.
    return !report || (report.status === 'reviewed' && isReviewCurrent(report, chapter.content,
      this.reviewer.buildContext(chapter.order, this.reviewContext(chapter.order, chapters))));
  }

  private firstUnfinishedChapter(chapters: NovelChapter[]): number | undefined {
    const reports = new Map(this.reviewer.loadHistory().map(report => [report.chapter, report]));
    return chapters.find(chapter => !this.canSkipChapter(chapter, reports.get(chapter.order), chapters))?.order;
  }

  private readingContext(chapterIndex: number, sceneFocus = ''): string {
    return this.reviewer.buildContext(chapterIndex, this.reviewContext(chapterIndex), 'writing', sceneFocus);
  }

  private chapterPlanningScope(chapterIndex: number): string {
    const chapters = this.globalPlan?.chapters ?? [];
    const current = chapters.find(chapter => chapter.order === chapterIndex);
    if (!current) return '';
    const volume = this.globalPlan?.volumes[current.volumeIndex];
    const next = chapters.filter(chapter => chapter.order > chapterIndex)
      .map(chapter => '第' + (chapter.order + 1) + '章 ' + chapter.title + '：' + (chapter.keyEvents?.join('、') || chapter.outline).slice(0, 140));
    return [
      '【本章与后续章节的安排，供作者规划】',
      current.title + '：' + current.outline,
      ...(current.keyEvents?.length ? ['本章关键事件：' + current.keyEvents.join('、')] : []),
      ...(volume ? ['当前卷：' + volume.title + '（' + volume.theme + '）'] : []),
      ...(next.length ? ['后续章节已安排的事件：', ...next] : []),
      '保留本章的目标和章末处境。已经发生的情节接着写后果。后续章的事件与揭示留到相应章节。',
    ].join('\n');
  }

  private async doMacroPlanning(chapterIndex: number): Promise<{ title: string; direction: string }> {
    this.emit('stage_change', { stage: 'macro_planning', chapter: chapterIndex });

    const prevChapters = this.config.getChapters()
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-3)
        .map((c) => `第${c.order + 1}章 ${c.title}结尾原文: ${c.content.slice(-500)}`)
      .join('\n');

    const phaseDirective = this.storyPhase
      ? ContextBudgetAllocator.buildPhaseDirective(this.storyPhase)
      : '';

    // The shared reading context includes the author's ledger without forced closure.
    const foreshadowingContext = '';

    // Inject global plan context for richer per-chapter planning
    let globalPlanContext = '';
    if (this.globalPlan) {
      globalPlanContext = `【全局规划上下文】
主线：${this.globalPlan.mainPlot}
核心冲突：${this.globalPlan.coreConflict}
主题：${this.globalPlan.themeMessage}
预定结局（作者规划，角色尚未必知情）：${this.globalPlan.ending}
${this.chapterPlanningScope(chapterIndex)}`;
    }

    const template = getTemplate('macro-planning');
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: this.readingContext(chapterIndex) + '\n\n' + template!.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        phaseDirective: `${phaseDirective}\n${globalPlanContext}`,
        foreshadowingContext,
        chapterNumber: String(chapterIndex + 1),
        prevChapters,
      }),
      userPrompt: template!.buildUser({
        prevChapters,
        chapterNumber: String(chapterIndex + 1),
      }),
      responseFormat: 'json',
      temperature: 0.8,
      maxTokens: 2048,
    };

    const signal = this.abortController?.signal;
    const response = await generatePlanningResponse(
      maxTokens => providerRouter.generate({ ...request, maxTokens }, signal),
      request.maxTokens,
      signal,
    );
    try {
      const data = parseLLMJson<{ direction?: string; conflictCore?: string; endingHook?: string; title?: string }>(response.content);
      if (!data) return { title: `第${chapterIndex + 1}章`, direction: '' };
      // Build richer direction that includes conflict and hook
      const parts: string[] = [];
      if (data.direction) parts.push(data.direction);
      if (data.conflictCore) parts.push(`核心冲突: ${data.conflictCore}`);
      if (data.endingHook) parts.push(`章末处境: ${data.endingHook}`);
      return {
        title: data.title || `第${chapterIndex + 1}章`,
        direction: parts.length > 0 ? parts.join('\n') : '',
      };
    } catch {
      return { title: `第${chapterIndex + 1}章`, direction: '' };
    }
  }

  // --- Global planning: plan all volumes and chapters before generation ---

  private async doGlobalPlanning(): Promise<GlobalPlan> {
    const bible = this.repo.loadBible();

    // Format Bible data for the prompt
    const charactersText = bible.characters
      .map((c) => `- ${c.name}（${c.importance}）: ${c.description}`)
      .join('\n');
    const worldbuildingText = bible.worldSettings
      .map((s) => `- [${s.category}] ${s.name}: ${s.description}`)
      .join('\n');
    const locationsText = bible.locations
      .map((l) => `- ${l.name}: ${l.description}`)
      .join('\n');

    // The current outline is already included in the shared writing context.
    const plotNote = this.repo.loadCustomData<unknown>('plot-outline', null)
      ? undefined : bible.timelineNotes?.find(n => n.id === 'plot-outline');
    const plotOutlineStages = plotNote ? `${plotNote.event}\n${plotNote.significance || ''}` : '';

    const template = getTemplate('global-planning');
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: this.readingContext(this.state.currentChapterNumber) + '\n\n' + template!.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        targetWordCount: String(this.config.targetWordCount),
        targetChapterCount: String(this.config.targetChapterCount),
        worldbuilding: worldbuildingText || '无',
        characters: charactersText || '无',
        locations: locationsText || '无',
        plotOutlineStages,
      }),
      userPrompt: template!.buildUser({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        targetWordCount: String(this.config.targetWordCount),
        targetChapterCount: String(this.config.targetChapterCount),
        worldbuilding: worldbuildingText || '无',
        characters: charactersText || '无',
        locations: locationsText || '无',
        plotOutlineStages,
      }),
      responseFormat: 'json',
      temperature: 0.7,
      maxTokens: 8192,
    };

    const response = await generatePlanningResponse(maxTokens => providerRouter.generate({ ...request, maxTokens, thinking: false }, this.abortController?.signal));
    try {
      const reviewed = await reviewStoryPlan(this.readingContext(this.state.currentChapterNumber), response.content, this.abortController?.signal);
      const data = reviewed.plan as Record<string, any>;
      const plan: GlobalPlan = {
        mainPlot: data.mainPlot || '',
        coreConflict: data.coreConflict || '',
        themeMessage: data.themeMessage || '',
        volumes: (data.volumes || []).map((v: any) => ({
          title: v.title || `卷`,
          startChapter: Number(v.startChapter) || 0,
          endChapter: Number(v.endChapter) || 0,
          theme: v.theme || '',
        })),
        chapters: (data.chapters || []).map((c: any) => ({
          order: Number(c.order) || 0,
          title: c.title || `第${(c.order ?? 0) + 1}章`,
          outline: c.outline || '',
          volumeIndex: Number(c.volumeIndex) || 0,
          keyEvents: c.keyEvents || [],
          tensionHint: Number(c.tensionHint) || 5,
        })),
        ending: data.ending || '',
      };
      if (!plan.mainPlot.trim() || plan.chapters.length !== this.config.targetChapterCount || !plan.volumes.length
        || plan.chapters.some(c => !Number.isInteger(c.order) || c.order < 0 || c.order >= this.config.targetChapterCount || !c.outline.trim()
          || !Number.isInteger(c.volumeIndex) || c.volumeIndex < 0 || c.volumeIndex >= plan.volumes.length || !Array.isArray(c.keyEvents))
        || new Set(plan.chapters.map(c => c.order)).size !== plan.chapters.length) throw new Error('规划缺少可用主线、章节大纲或存在重复章节');
      this.repo.saveGlobalPlan(plan);
      this.repo.saveCustomData('global-plan-review', { changes: reviewed.changes, reviewedAt: new Date().toISOString() });
      return plan;
    } catch (error) {
      throw new Error('全书规划未完成，已有正文与资料已保留：' + String(error));
    }
  }

  private async executeGlobalPlan(plan: GlobalPlan): Promise<void> {
    // Use StoryNode path if callbacks are available
    if (this.config.getStoryNodes && this.config.onSetStoryNodes) {
      const existingNodes = this.config.getStoryNodes();
      const timestamp = new Date().toISOString();
      let nodes = [...existingNodes];

      // Create volume nodes
      const volumeIdMap: Map<number, string> = new Map();
      for (let i = 0; i < plan.volumes.length; i++) {
        const existingVolume = existingNodes.find(n => n.nodeType === 'volume' && n.title === plan.volumes[i].title);
        if (existingVolume) { volumeIdMap.set(i, existingVolume.id); continue; }
        const id = crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        volumeIdMap.set(i, id);
        nodes.push({
          id,
          novelId: this.config.novelId,
          nodeType: 'volume',
          parentId: null,
          order: i,
          title: plan.volumes[i].title,
          description: plan.volumes[i].theme,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      // Create chapter nodes
      for (let i = 0; i < plan.chapters.length; i++) {
        const ch = plan.chapters[i];
        if (this.config.getChapters().some(existing => existing.order === ch.order)) continue;
        const parentId = volumeIdMap.get(ch.volumeIndex) ?? null;
        nodes.push({
          id: crypto.randomUUID?.() ?? `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          novelId: this.config.novelId,
          nodeType: 'chapter',
          parentId,
          order: ch.order,
          title: ch.title,
          outline: ch.outline,
          content: '',
          wordCount: 0,
          status: 'planned',
          keyEvents: ch.keyEvents,
          tensionHint: ch.tensionHint,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      this.config.onSetStoryNodes(nodes);
      this.emit('stage_change', { stage: 'global_planning', plan: { volumes: plan.volumes.length, chapters: plan.chapters.length } });
      return;
    }

    // Legacy path
    const volumeIdMap: Map<number, string> = new Map();
    for (let i = 0; i < plan.volumes.length; i++) {
      const volId = this.config.onAddVolume(plan.volumes[i].title);
      volumeIdMap.set(i, volId);
    }

    for (const ch of plan.chapters) {
      if (this.config.getChapters().some(existing => existing.order === ch.order)) continue;
      const volId = volumeIdMap.get(ch.volumeIndex);
      const chapterId = this.config.onAddChapter(volId);
      this.config.onUpdateChapter(chapterId, {
        title: ch.title,
        outline: ch.outline,
        status: 'planned',
      });
    }

    this.emit('stage_change', { stage: 'global_planning', plan: { volumes: plan.volumes.length, chapters: plan.chapters.length } });
  }

  private async doActBeatPlanning(chapterIndex: number, macroPlan: { title: string; direction: string }): Promise<string> {
    this.emit('stage_change', { stage: 'act_beat_planning', chapter: chapterIndex });

    const prevSummary = this.config.getChapters()
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-1)
      .map((c) => c.content.slice(-500))
      .join('\n');

    const template = getTemplate('act-beat-planning');
    const scope = this.chapterPlanningScope(chapterIndex);
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: this.readingContext(chapterIndex) + '\n\n' + scope + '\n\n' + template!.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        factLock: '',
        beatLock: '',
        clueLock: '',
      }),
      userPrompt: template!.buildUser({
        prevSummary,
        macroDirection: macroPlan.direction,
        chapterNumber: String(chapterIndex + 1),
        chapterTitle: macroPlan.title,
      }),
      temperature: 0.8,
      maxTokens: 4096,
      thinking: false,
    };

    const signal = this.abortController?.signal;
    const response = await generatePlanningResponse(
      maxTokens => providerRouter.generate({ ...request, maxTokens }, signal),
      request.maxTokens,
      signal,
    );
    signal?.throwIfAborted();
    return this.reviewer.prepareOutline(chapterIndex, response.content, this.reviewContext(chapterIndex), { scope, signal });
  }

  // --- Beat-based Chapter Generation (core upgrade) ---

  private async doChapterGeneration(chapterIndex: number, outline: string, chapterId: string, draft?: ChapterWritingDraft): Promise<string> {
    const abortSignal = this.abortController?.signal;
    this.emit('stage_change', { stage: 'chapter_generation', chapter: chapterIndex });

    // Notify UI to switch to this chapter
    this.emit('chapter_progress', { chapter: chapterIndex, chapterId, wordCount: 0 });

    // Step 1: Magnify outline into beats
    const beats = draft?.beats ?? await magnifyOutlineToBeats(outline, WORDS_PER_CHAPTER_TARGET, chapterIndex, abortSignal);
    if (abortSignal?.aborted) return '';
    this.emit('beat_plan', {
      chapter: chapterIndex,
      chapterId,
      beats: beats.map((b) => ({ index: b.index, description: b.description, targetWords: b.targetWords, focus: b.focus })),
    });

    // Step 2: Beat loop
    const readContent = () => this.config.getChapters().find(c => c.id === chapterId)?.content;
    let savedContent = readContent() ?? '';
    let chapterContent = draft?.previousFingerprint === textFingerprint(savedContent) ? draft.content : savedContent;
    let overspendDebt = draft?.overspendDebt ?? 0;
    let lastFlushTime = 0;

    for (const beat of beats.slice(draft?.nextBeat ?? 0)) {
      if (abortSignal?.aborted) return chapterContent;

      const wordsUsed = chapterContent.length;
      const signal = getConductorSignal(beat.index, beats.length, wordsUsed, WORDS_PER_CHAPTER_TARGET);
      const adjustedTarget = adjustBeatTargetWords(beat, signal, overspendDebt);

      // Build context for this beat
      this.budget = new ContextBudgetAllocator(NOVEL_PROSE_CONTEXT_BUDGET);
      this.buildBeatContext(chapterIndex, chapterContent, beat.description);

      const { prompt: contextPrompt } = this.budget.allocate();

      // Build beat prompt using template
      const template = getTemplate('beat-generation')!;
      const systemPrompt = template.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        phaseDirective: this.storyPhase ? ContextBudgetAllocator.buildPhaseDirective(this.storyPhase) : '',
        context: contextPrompt,
        beatDescription: beat.description,
        beatFocus: beat.focus,
        targetWords: String(adjustedTarget),
        conductorSignal: signal.beatInstruction,
        beatIndex: String(beat.index),
        totalBeats: String(beats.length),
      });

      let userPrompt = template.buildUser({
        beatDescription: beat.description,
        targetWords: String(adjustedTarget),
        beatIndex: String(beat.index),
        totalBeats: String(beats.length),
        nextBeat: beats[beat.index + 1]?.description ?? '',
      });

      // Append soft landing hint if needed
      if (signal.isFinalBeat && wordsUsed > WORDS_PER_CHAPTER_TARGET * 0.8) {
        userPrompt += '\n\n篇幅已充分展开。请完成本章计划中的关键行动及其后果，简化重复描写和过渡，不要用突然中断替代应有的因果收束。';
      }

      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt,
        userPrompt,
        temperature: 0.75,
        maxTokens: 12288,
        thinking: true,
      };

      this.emit('beat_start', {
        chapter: chapterIndex,
        beatIndex: beat.index,
        focus: beat.focus,
        targetWords: adjustedTarget,
        phase: signal.phase,
      });

      const beatContent = await collectNovelStreamText(maxTokens => providerRouter.stream({ ...request, maxTokens }), {
        initialBudget: request.maxTokens,
        signal: abortSignal,
        onText: text => {
          const now = Date.now();
          if (text && now - lastFlushTime <= 120) return;
          lastFlushTime = now;
          const runningContent = chapterContent && text ? `${chapterContent}\n\n${text}` : chapterContent || text;
          this.emit('chapter_progress', { chapter: chapterIndex, chapterId, wordCount: runningContent.length, content: runningContent });
        },
      });

      if (abortSignal?.aborted) return chapterContent;
      if (!beatContent.trim()) throw new Error('模型未返回本节拍的正文，已保留此前写完的节拍。');

      // Track overspend debt
      const actualWords = beatContent.length;
      if (actualWords > beat.targetWords) {
        overspendDebt += actualWords - beat.targetWords;
      } else if (overspendDebt > 0) {
        overspendDebt = Math.max(0, overspendDebt - (beat.targetWords - actualWords));
      }

      chapterContent += (chapterContent ? '\n\n' : '') + beatContent;
      if (readContent() !== savedContent) throw new Error('本章正文在生成期间已改变，已保留当前正文。');
      this.repo.saveCustomData<ChapterWritingDraft>(CHAPTER_WRITING_DRAFT, {
        chapterId, beats, nextBeat: beat.index + 1, content: chapterContent,
        previousFingerprint: textFingerprint(savedContent), overspendDebt,
      });
      this.config.onUpdateChapter(chapterId, { content: chapterContent, wordCount: chapterContent.length, status: 'drafting' });
      savedContent = chapterContent;

      this.emit('beat_complete', {
        chapter: chapterIndex,
        beatIndex: beat.index,
        wordCount: actualWords,
        totalWords: chapterContent.length,
        phase: signal.phase,
      });

      // Update state
      this.state.currentBeatIndex = beat.index;
    }

    // Final flush
    this.config.onUpdateChapter(chapterId, {
      content: chapterContent,
      wordCount: chapterContent.length,
      status: 'drafting',
    });
    this.repo.saveCustomData(CHAPTER_WRITING_DRAFT, null);

    this.emit('chapter_progress', {
      chapter: chapterIndex,
      chapterId,
      wordCount: chapterContent.length,
    });

    return chapterContent;
  }

  /**
   * Build per-beat context budget with all registered slots.
   */
  private buildBeatContext(chapterIndex: number, currentChapterContent: string, sceneFocus: string): void {
    const continuation = currentChapterContent
      ? '【本章已写正文，接续末句，不要重写、复述或重新开场】\n' + currentChapterContent
      : '';
    const available = NOVEL_PROSE_CONTEXT_BUDGET - this.estimateTokens(continuation);
    const fits = (text: string) => this.estimateTokens(text) <= available;
    const fullContext = this.readingContext(chapterIndex, sceneFocus);
    const readingContext = fits(fullContext) ? fullContext
      : this.reviewer.buildContext(chapterIndex, this.reviewContext(chapterIndex), 'writing', sceneFocus, fits);
    this.budget.registerSlot({ name: 'EDITORIAL_CONTINUITY', tier: 'T0', content: readingContext,
      estimatedTokens: this.estimateTokens(readingContext), priority: 140, minTokens: 0 });
    if (continuation) {
      this.budget.registerSlot({ name: 'CURRENT_CHAPTER_PROSE', tier: 'T0', content: continuation,
        estimatedTokens: this.estimateTokens(continuation), priority: 139, minTokens: 0 });
    }
  }

  private estimateTokens(text: string): number {
    const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    return Math.ceil(chinese * 1.5 + (text.length - chinese) * 0.3);
  }

  private async doQualityGateRewrite(chapterIndex: number, content: string, chapterId: string): Promise<string> {
    const signal = this.abortController?.signal;
    let current = content;
    this.config.onUpdateChapter(chapterId, { status: 'revising' });
    try {
      const currentTarget = () => {
        const context = this.reviewContext(chapterIndex);
        const chapter = context.chapters.find(c => c.id === chapterId);
        return chapter && { chapter, context };
      };
      const target = currentTarget();
      if (!target || target.chapter.content !== content) throw new Error('正文已改变，请重新审读。');
      const result = await this.reviewer.reviewDraft(target, {
        current: currentTarget, reuseReview: true, maxRevisionPasses: 2, signal,
        applyRevision: revised => this.config.onUpdateChapter(chapterId, { content: revised, wordCount: revised.length, status: 'revising' }),
      });
      current = result.content;
      if (signal?.aborted) return current;
      const review = result.report;
      const passed = review.status === 'reviewed' && isReviewCurrent(review, current, this.reviewer.buildContext(chapterIndex, this.reviewContext(chapterIndex)));
      this.config.onUpdateChapter(chapterId, { status: passed ? 'complete' : 'revising' });
      this.config.onUpdateStoryNode?.(chapterId, { status: passed ? 'complete' : 'revising' });
      this.emit('review_complete', { chapter: chapterIndex, chapterId, review, passed });
      if (!passed) {
        this.updateStatus('paused');
        this.emit('status_change', { status: 'paused', reason: 'editorial_review' });
        this.emit('error', { error: '第' + (chapterIndex + 1) + '章仍有影响阅读的问题，已保留草稿并暂停，等待审读。', unresolvedIssues: review.findings, qualityGateHumanIntervention: true });
      }
    } catch (error) {
      if (signal?.aborted) return current;
      this.config.onUpdateChapter(chapterId, { status: 'revising' });
      this.config.onUpdateStoryNode?.(chapterId, { status: 'revising' });
      this.updateStatus('paused');
      this.emit('status_change', { status: 'paused', reason: 'review_failed' });
      this.emit('error', { error: '审稿或修订未完成，草稿已保留：' + String(error), qualityGateHumanIntervention: true });
    }
    return current;
  }

  private async doAftermath(chapterIndex: number, _content: string, _chapterId: string): Promise<void> {
    // The grounded editorial report already holds continuity notes tied to the manuscript.
    // Do not promote unquoted extraction or heuristic scores to author facts.
    this.state.progress = (chapterIndex + 1) / this.state.targetChapterCount;
    this.saveCheckpoint(chapterIndex, 0);
    this.emit('chapter_complete', { chapter: chapterIndex, narrative: this.getNarrativeData(), progress: this.state.progress });
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
    this.emit('stage_change', { stage, chapter: this.state.currentChapterNumber, progress: this.state.progress });
  }

  private updateStatus(status: AutopilotStatus): void {
    this.state.status = status;
    this.state.lastRunAt = new Date().toISOString();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Narrative data extraction for UI ---

  /**
   * Check if there's a resumable checkpoint.
   */
  hasCheckpoint(): boolean {
    return this.checkpoint.hasCheckpoint();
  }

  /**
   * Get checkpoint summary for UI display.
   */
  getCheckpointSummary() {
    return this.checkpoint.getSummary();
  }

  /**
   * Get tension history for chart visualization.
   */
  getTensionHistory() {
    return this.tension.getTensionHistory();
  }

  /**
   * Get knowledge graph for visualization.
   */
  getKnowledgeGraph() {
    return this.knowledgeGraph.getFullGraph();
  }

  /**
   * Get the governance engine for contract management.
   */
  getGovernance(): GovernanceEngine {
    return this.governance;
  }

  /**
   * Get the narrative repository for CRUD operations.
   */
  getRepository(): NarrativeRepository {
    return this.repo;
  }

  // --- Internal: restore from repository ---

  /**
   * Restore engine state from persisted NarrativeRepository data.
   * This runs BEFORE checkpoint restore, so checkpoints take priority.
   */
  private restoreFromRepository(): void {
    // 1. Sync MemoryEngine from persisted Story Bible characters
    const bible = this.repo.loadBible();
    if (bible.characters.length > 0) {
      this.memory.syncFromBible(bible.characters);
    }

    // 2. Restore persisted triples into fact lock
    const persistedTriples = this.repo.loadTriples();
    if (persistedTriples.length > 0) {
      this.memory.mergeTriples(persistedTriples);
    }

    // 3. Restore persisted completed beats into beat lock
    const persistedBeats = this.repo.loadCompletedBeats();
    if (persistedBeats.length > 0) {
      const mem = this.memory.serialize();
      const existingIds = new Set(mem.beatLock.completedBeats.map((b) => b.beatId));
      for (const beat of persistedBeats) {
        if (!existingIds.has(beat.beatId)) {
          mem.beatLock.completedBeats.push(beat);
        }
      }
      this.memory = MemoryEngine.deserialize(mem, this.config.novelId);
    }

    // 4. Restore persisted foreshadowing
    const persistedForeshadowing = this.repo.loadForeshadowing();
    if (persistedForeshadowing.length > 0) {
      this.foreshadowing = ForeshadowingTracker.deserialize(persistedForeshadowing);
    }

    // 5. Restore timeline anchors
    const persistedAnchors = this.repo.loadTimelineAnchors();
    if (persistedAnchors.length > 0) {
      const mem = this.memory.serialize();
      const existingChapters = new Set(mem.factLock.timelineAnchors.map((a) => a.chapter));
      for (const anchor of persistedAnchors) {
        if (!existingChapters.has(anchor.chapter)) {
          mem.factLock.timelineAnchors.push(anchor);
        }
      }
      this.memory = MemoryEngine.deserialize(mem, this.config.novelId);
    }

    // 7. Restore global plan
    const savedPlan = this.repo.loadGlobalPlan();
    if (savedPlan) {
      this.globalPlan = savedPlan;
    }
  }

  // --- Internal: checkpoint save/restore ---

  private restoreFromCheckpoint(): void {
    const restored = this.checkpoint.restore();
    if (!restored) return;
    const firstUnfinished = this.firstUnfinishedChapter(this.config.getChapters());
    const resumeFrom = firstUnfinished === undefined ? restored.resumeFromChapter : Math.min(firstUnfinished, restored.resumeFromChapter);

    // Restore autopilot state (but keep status as idle — user must explicitly resume)
    this.state = {
      ...restored.autopilotState,
      currentChapterNumber: resumeFrom,
      targetChapterCount: this.config.targetChapterCount,
      targetWordCount: this.config.targetWordCount,
      progress: Math.min(1, resumeFrom / Math.max(1, this.config.targetChapterCount)),
      status: 'idle',
      currentStage: 'idle',
    };
    this.breaker = restored.breakerState;

    // Restore memory engine
    const mem = MemoryEngine.deserialize(restored.memorySnapshot, this.state.novelId);
    this.memory = mem;

    // Restore foreshadowing tracker
    this.foreshadowing = ForeshadowingTracker.deserialize(restored.foreshadowing);

  }

  private saveCheckpoint(chapterIndex: number, beatIndex: number): void {
    const mem = this.memory.serialize();
    this.checkpoint.save({
      autopilotState: this.state,
      breakerState: this.breaker,
      factLock: mem.factLock,
      beatLock: mem.beatLock,
      clueLock: mem.clueLock,
      foreshadowing: this.repo.loadForeshadowing(),
      chapterIndex,
      beatIndex,
      nextChapterIndex: chapterIndex + 1,
    });
  }

  // --- Narrative data extraction for UI ---

  getNarrativeData() {
    return {
      triples: this.repo.loadTriples(),
      anchors: this.repo.loadTimelineAnchors(),
      beats: this.repo.loadCompletedBeats(),
      foreshadowing: this.repo.loadForeshadowing(),
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
      tensionHistory: this.tension.getTensionHistory(),
      knowledgeGraph: this.knowledgeGraph.getFullGraph(),
      governance: this.governance.loadContract(),
    };
  }
}

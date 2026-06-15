import type {
  AutopilotState,
  AutopilotStatus,
  NovelStage,
  CircuitBreakerState,
} from '@/types/pipeline';
import type { StoryPhaseState, Foreshadowing, ChapterAftermathResult, Beat, GlobalPlan, StoryNode } from '@/types/narrative';
import type { NovelChapter, NovelMetadata } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { MemoryEngine } from './memory-engine';
import { ContextBudgetAllocator } from './context-budget';
import { ForeshadowingTracker } from './foreshadowing-tracker';
import { ChapterAftermathPipeline } from './chapter-aftermath';
import { CheckpointManager } from './checkpoint-manager';
import { TensionScoringService } from './tension-scorer';
import { KnowledgeGraphEngine } from './knowledge-graph';
import { GovernanceEngine } from './governance-engine';
import { NarrativeRepository } from './narrative-repository';
import { PropManager } from './prop-manager';
import { EvolutionEngine } from './evolution-engine';
import { parseLLMJson } from './llm-json';
import { VoiceFingerprintService } from './voice-fingerprint';
import { AntiAIAuditor } from './cliche-scanner';
import { ChapterContinuityLedger } from './chapter-continuity-ledger';
import { ChapterSummarizer } from './chapter-summarizer';
import { AutoBibleGenerator } from './auto-bible-generator';
import { ConflictDetector } from './conflict-detector';
import { QualityGateService } from './quality-gate';
import type { QualityGateResult } from './quality-gate';
import {
  magnifyOutlineToBeats,
  getConductorSignal,
  adjustBeatTargetWords,
  WORDS_PER_CHAPTER_TARGET,
} from './chapter-conductor';
import { smartTruncate, buildSoftLandingPrompt } from './smart-truncation';
import { runMiddlewareChain } from './beat-middleware';
import { getTemplate, getSensoryHint } from './prompt-templates';

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

export class AutopilotEngine {
  private state: AutopilotState;
  private breaker: CircuitBreakerState;
  private memory: MemoryEngine;
  private budget: ContextBudgetAllocator;
  private foreshadowing: ForeshadowingTracker;
  private aftermath: ChapterAftermathPipeline;
  private checkpoint: CheckpointManager;
  private tension: TensionScoringService;
  private knowledgeGraph: KnowledgeGraphEngine;
  private governance: GovernanceEngine;
  private propManager: PropManager;
  private evolution: EvolutionEngine;
  private voiceFingerprint: VoiceFingerprintService;
  private antiAIAuditor: AntiAIAuditor;
  private continuityLedger: ChapterContinuityLedger;
  private chapterSummarizer: ChapterSummarizer;
  private autoBibleGenerator: AutoBibleGenerator;
  private conflictDetector: ConflictDetector;
  private qualityGate: QualityGateService;
  private repo: NarrativeRepository;
  private abortController: AbortController | null = null;
  private handlers: Set<AutopilotEventHandler> = new Set();
  private config: AutopilotConfig;
  private storyPhase: StoryPhaseState | null = null;
  private lastTensionScore: number = 5;
  private globalPlan: GlobalPlan | null = null;

  constructor(config: AutopilotConfig) {
    this.config = config;
    this.repo = new NarrativeRepository(config.novelId);
    this.checkpoint = new CheckpointManager(config.novelId);
    this.tension = new TensionScoringService(config.novelId);
    this.knowledgeGraph = new KnowledgeGraphEngine(config.novelId);
    this.governance = new GovernanceEngine(config.novelId);
    this.propManager = new PropManager(config.novelId);
    this.evolution = new EvolutionEngine(config.novelId);
    this.voiceFingerprint = new VoiceFingerprintService(config.novelId);
    this.antiAIAuditor = new AntiAIAuditor(config.novelId);
    this.continuityLedger = new ChapterContinuityLedger(config.novelId);
    this.chapterSummarizer = new ChapterSummarizer(config.novelId);
    this.autoBibleGenerator = new AutoBibleGenerator(config.novelId);
    this.conflictDetector = new ConflictDetector();
    this.qualityGate = new QualityGateService(config.novelId);
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

    this.abortController = new AbortController();
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
        this.globalPlan = plan;
        await this.executeGlobalPlan(plan);
      }

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
      if (this.state.status === 'paused') return;
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
        this.state.currentWordCount = this.config.getChapters().reduce(
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
        try {
          const store = await import('@/stores/autopilotStore').then(m => m.useAutopilotStore.getState());
          store.setAutopilotState(this.state.novelId, { lastError: `第${ch + 1}章失败: ${this.state.lastError}` });
        } catch { /* store not available */ }
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

    // Stage 3: Chapter generation (beat loop)
    this.setStage('chapter_generation');
    let content = await this.doChapterGeneration(chapterIndex, outline, chapterId);

    // Stage 4: Chapter review
    this.setStage('chapter_review');
    await this.doChapterReview(chapterIndex, content, chapterId);

    // Stage 5: Quality gate with targeted rewrite loop
    content = await this.doQualityGateRewrite(chapterIndex, content, chapterId);

    // Post-chapter aftermath
    await this.doAftermath(chapterIndex, content, chapterId);
  }

  // --- Stage implementations ---

  private async doMacroPlanning(chapterIndex: number): Promise<{ title: string; direction: string }> {
    this.emit('stage_change', { stage: 'macro_planning', chapter: chapterIndex });

    const prevChapters = this.config.getChapters()
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

    // Inject global plan context for richer per-chapter planning
    let globalPlanContext = '';
    if (this.globalPlan) {
      const plannedChapter = this.globalPlan.chapters.find((c) => c.order === chapterIndex);
      const vol = plannedChapter ? this.globalPlan.volumes[plannedChapter.volumeIndex] : null;
      globalPlanContext = `【全局规划上下文】
主线：${this.globalPlan.mainPlot}
核心冲突：${this.globalPlan.coreConflict}
主题：${this.globalPlan.themeMessage}${plannedChapter ? `
本章规划标题：${plannedChapter.title}
本章大纲：${plannedChapter.outline}
本章关键事件：${plannedChapter.keyEvents.join('、')}
本章张力目标：${plannedChapter.tensionHint}/10` : ''}${vol ? `
当前卷：${vol.title}（${vol.theme}）` : ''}`;
    }

    const template = getTemplate('macro-planning');
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: template!.buildSystem({
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

    const response = await providerRouter.generate(request);
    try {
      const data = parseLLMJson<{ direction?: string; conflictCore?: string; endingHook?: string; title?: string }>(response.content);
      if (!data) return { title: `第${chapterIndex + 1}章`, direction: '' };
      // Build richer direction that includes conflict and hook
      const parts: string[] = [];
      if (data.direction) parts.push(data.direction);
      if (data.conflictCore) parts.push(`核心冲突: ${data.conflictCore}`);
      if (data.endingHook) parts.push(`结尾钩子: ${data.endingHook}`);
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

    // Load wizard plot outline if available
    const plotNote = bible.timelineNotes?.find((n) => n.id === 'plot-outline');
    const plotOutlineStages = plotNote?.significance || '';

    const template = getTemplate('global-planning');
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: template!.buildSystem({
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
      maxTokens: 4096,
    };

    const response = await providerRouter.generate(request);
    try {
      const data = parseLLMJson<Record<string, any>>(response.content);
      if (!data) throw new Error('global plan parse failed');
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
      this.repo.saveGlobalPlan(plan);
      return plan;
    } catch {
      // Fallback: create a simple single-volume plan
      const fallbackPlan: GlobalPlan = {
        mainPlot: '',
        coreConflict: '',
        themeMessage: '',
        volumes: [{ title: '卷一', startChapter: 0, endChapter: this.config.targetChapterCount - 1, theme: '' }],
        chapters: Array.from({ length: this.config.targetChapterCount }, (_, i) => ({
          order: i,
          title: `第${i + 1}章`,
          outline: '',
          volumeIndex: 0,
          keyEvents: [],
          tensionHint: 5,
        })),
        ending: '',
      };
      this.repo.saveGlobalPlan(fallbackPlan);
      return fallbackPlan;
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

    const factLockText = this.memory.buildFactLockText();
    const beatLockText = this.memory.buildBeatLockText();
    const clueLockText = this.memory.buildClueLockText();

    const template = getTemplate('act-beat-planning');
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: template!.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        factLock: factLockText,
        beatLock: beatLockText,
        clueLock: clueLockText,
      }),
      userPrompt: template!.buildUser({
        prevSummary,
        macroDirection: macroPlan.direction,
        chapterNumber: String(chapterIndex + 1),
        chapterTitle: macroPlan.title,
      }),
      temperature: 0.8,
      maxTokens: 1024,
    };

    const response = await providerRouter.generate(request);
    return response.content;
  }

  // --- Beat-based Chapter Generation (core upgrade) ---

  private async doChapterGeneration(chapterIndex: number, outline: string, chapterId: string): Promise<string> {
    this.emit('stage_change', { stage: 'chapter_generation', chapter: chapterIndex });

    // Notify UI to switch to this chapter
    this.emit('chapter_progress', { chapter: chapterIndex, chapterId, wordCount: 0 });

    // Step 1: Magnify outline into beats
    const beats = await magnifyOutlineToBeats(outline, WORDS_PER_CHAPTER_TARGET, chapterIndex);
    this.emit('beat_plan', {
      chapter: chapterIndex,
      chapterId,
      beats: beats.map((b) => ({ index: b.index, description: b.description, targetWords: b.targetWords, focus: b.focus })),
    });

    // Step 2: Beat loop
    let chapterContent = '';
    let prevBeatContent = '';
    let overspendDebt = 0;
    let lastFlushTime = 0;
    let pendingMiddlewareInstruction: string | undefined;

    for (const beat of beats) {
      if (this.abortController?.signal.aborted) break;

      const wordsUsed = chapterContent.length;
      const signal = getConductorSignal(beat.index, beats.length, wordsUsed, WORDS_PER_CHAPTER_TARGET);
      const adjustedTarget = adjustBeatTargetWords(beat, signal, overspendDebt);

      // Build context for this beat
      this.budget = new ContextBudgetAllocator();
      this.buildBeatContext(chapterIndex, outline, beat, signal);

      const { prompt: contextPrompt } = this.budget.allocate();

      // Build beat prompt using template
      const template = getTemplate('beat-generation')!;
      const systemPrompt = template.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        phaseDirective: this.storyPhase ? ContextBudgetAllocator.buildPhaseDirective(this.storyPhase) : '',
        context: contextPrompt,
        outline,
        beatDescription: beat.description,
        beatFocus: beat.focus,
        targetWords: String(adjustedTarget),
        conductorSignal: signal.beatInstruction,
        beatIndex: String(beat.index),
        totalBeats: String(beats.length),
        sensoryHint: getSensoryHint(beat.index),
      });

      let userPrompt = template.buildUser({
        outline,
        beatDescription: beat.description,
        targetWords: String(adjustedTarget),
      });

      // Append middleware instruction from previous beat
      if (pendingMiddlewareInstruction) {
        userPrompt += `\n\n${pendingMiddlewareInstruction}`;
        pendingMiddlewareInstruction = undefined;
      }

      // Append soft landing hint if needed
      const landingHint = buildSoftLandingPrompt(wordsUsed, WORDS_PER_CHAPTER_TARGET, chapterContent);
      if (landingHint) {
        userPrompt += `\n\n${landingHint}`;
      }

      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt,
        userPrompt,
        temperature: 0.75,
        maxTokens: Math.min(4096, Math.ceil(adjustedTarget * 1.5)),
      };

      this.emit('beat_start', {
        chapter: chapterIndex,
        beatIndex: beat.index,
        focus: beat.focus,
        targetWords: adjustedTarget,
        phase: signal.phase,
      });

      // Stream this beat
      let beatContent = '';
      for await (const chunk of providerRouter.stream(request)) {
        if (this.abortController?.signal.aborted) break;
        beatContent += chunk.delta;

        const now = Date.now();
        if (now - lastFlushTime > 120) {
          lastFlushTime = now;
          const runningContent = chapterContent + beatContent;
          this.config.onUpdateChapter(chapterId, {
            content: runningContent,
            wordCount: runningContent.length,
            status: 'drafting',
          });
          this.emit('chapter_progress', {
            chapter: chapterIndex,
            chapterId,
            wordCount: runningContent.length,
            content: runningContent,
          });
        }
      }

      // Smart truncation if beat exceeded target
      if (beatContent.length > adjustedTarget) {
        beatContent = smartTruncate(beatContent, adjustedTarget);
      }

      // Run middleware chain
      const mwResult = runMiddlewareChain(beat, beatContent, signal, prevBeatContent);
      beatContent = mwResult.content;
      if (mwResult.instruction) {
        pendingMiddlewareInstruction = mwResult.instruction;
      }

      // Track overspend debt
      const actualWords = beatContent.length;
      if (actualWords > beat.targetWords) {
        overspendDebt += actualWords - beat.targetWords;
      } else if (overspendDebt > 0) {
        overspendDebt = Math.max(0, overspendDebt - (beat.targetWords - actualWords));
      }

      chapterContent += beatContent;
      prevBeatContent = beatContent;

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
  private buildBeatContext(chapterIndex: number, outline: string, beat: Beat, signal: { phase: string }): void {
    const factLockText = this.memory.buildFactLockText();
    const beatLockText = this.memory.buildBeatLockText();
    const clueLockText = this.memory.buildClueLockText();
    const foreshadowingText = this.foreshadowing.buildForeshadowingContext(
      chapterIndex,
      this.storyPhase ?? ContextBudgetAllocator.computeStoryPhase(chapterIndex, this.state.targetChapterCount),
    );

    // T0 slots
    this.budget.registerLifecycleDirective(
      this.storyPhase?.currentPhase ?? 'development',
      chapterIndex,
      this.state.targetChapterCount,
    );
    this.budget.registerStoryAnchor(`小说: ${this.config.title} | 类型: ${this.config.genre} | 风格: ${this.config.style}`);
    if (factLockText) this.budget.registerFactLock(factLockText);
    if (beatLockText) this.budget.registerBeatLock(beatLockText);
    if (clueLockText) this.budget.registerClueLock(clueLockText);
    if (foreshadowingText) this.budget.registerActiveForeshadowing(foreshadowingText);
    this.budget.registerEditorBrief(this.config.style, this.config.genre);

    // T1 slots
    this.budget.registerChapterOutline(outline);

    // T2 slots — previous chapter content (last 1500 chars)
    const prevContent = this.config.getChapters()
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-1)
      .map((c) => c.content.slice(-1500))
      .join('\n');
    if (prevContent) this.budget.registerPreviousChapter(prevContent);

    // T0: Previously On — last chapter summary
    const prevChapterSummary = this.config.getChapters()
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-1)
      .map((c) => `第${c.order + 1}章 "${c.title}": ${c.outline || c.content.slice(0, 300)}`)
      .join('\n');
    if (prevChapterSummary) this.budget.registerPreviouslyOn(prevChapterSummary);

    // T0: Multi-chapter recap — last 3-5 chapters' summaries for continuity
    const recentChapters = this.config.getChapters()
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-5);
    if (recentChapters.length > 1) {
      const recapLines = recentChapters.map((c) =>
        `第${c.order + 1}章 "${c.title}": ${c.outline || c.content.slice(0, 150)}`
      );
      this.budget.registerMultiChapterRecap(`【近期剧情回顾（最近${recapLines.length}章）】\n${recapLines.join('\n')}`);
    }

    // T0: Character states from aftermath — location, emotion, knowledge
    const charStates = this.repo.loadCharacterStates();
    if (charStates.length > 0) {
      const stateLines = charStates.slice(0, 8).map((cs) => {
        const parts = [cs.characterId];
        if (cs.emotionalState) parts.push(`情绪:${cs.emotionalState}`);
        if (cs.location) parts.push(`位于:${cs.location}`);
        if (cs.knowledge && cs.knowledge.length > 0) parts.push(`已知:${cs.knowledge.slice(0, 3).join(',')}`);
        return `- ${parts.join(' | ')}`;
      });
      this.budget.registerCharacterStates(`【角色当前状态】\n${stateLines.join('\n')}`);
    }

    // T0: Recent relationship triples — who knows whom, how they relate
    const triples = this.repo.loadTriples();
    if (triples.length > 0) {
      const tripleLines = triples.slice(-15).map((t) => `${t.subject}—${t.predicate}→${t.object}`);
      this.budget.registerRelationshipTriples(`【人物关系】\n${tripleLines.join('\n')}`);
    }

    // T0: Debt Due — inject due foreshadows/debts as [MUST_RESOLVE] blocks
    const topDue = this.foreshadowing.getTopDue(chapterIndex, 2, 3);
    if (topDue.length > 0) {
      const debtText = [
        '【必须处理的叙事债务】',
        ...topDue.map((f) => `❗ [Ch${f.plantedInChapter}] ${f.description}（建议第${f.suggestedResolveChapter}章闭合）`),
        '本章必须推进或闭合以上伏笔/债务。',
      ].join('\n');
      this.budget.registerDebtDue(debtText);
    } else {
      // Also inject general narrative debts
      const debts = this.repo.loadNarrativeDebts();
      const openDebts = debts.filter((d) => d.status === 'open').slice(0, 3);
      if (openDebts.length > 0) {
        const debtText = [
          '【待解决叙事债务】',
          ...openDebts.map((d) => `- ${d.description}（第${d.plantedInChapter}章产生）`),
        ].join('\n');
        this.budget.registerDebtDue(debtText);
      }
    }

    // T0: Scars & Motivations — character motivations from bible + recent states
    const bible = this.repo.loadBible();
    const activeMotivations = bible.characters
      .filter((c) => c.importance === 'protagonist' || c.importance === 'major')
      .slice(0, 5)
      .map((c) => {
        const state = charStates.find((s) => s.characterId === c.name);
        const stateStr = state?.emotionalState ? ` [当前:${state.emotionalState}]` : '';
        return `${c.name}${stateStr}: ${c.backstory || c.description}`;
      })
      .join('\n');
    if (activeMotivations) {
      this.budget.registerScarsAndMotivations(`【角色驱动力】\n${activeMotivations}`);
    }

    // T0: Voice style constraints — enforce consistent writing style
    const voiceFp = this.voiceFingerprint.getFingerprint();
    if (voiceFp) {
      const styleConstraint = this.voiceFingerprint.buildStyleConstraint(voiceFp);
      if (styleConstraint.directives.length > 0) {
        const voiceLines = [
          '【文风约束 — 必须遵守】',
          ...styleConstraint.directives.map((d) => `✦ ${d}`),
        ];
        if (styleConstraint.bannedPatterns.length > 0) {
          voiceLines.push(`禁止使用: ${styleConstraint.bannedPatterns.join('、')}`);
        }
        this.budget.registerVoiceConstraints(voiceLines.join('\n'));
      }
    }

    // T1: Prop context injection
    const propContext = this.propManager.buildContextForChapter(chapterIndex);
    if (propContext.factLock) {
      this.budget.registerSlot({
        name: 'PROP_FACT_LOCK', tier: 'T1', content: propContext.factLock,
        estimatedTokens: this.estimateTokens(propContext.factLock),
        maxTokens: 600, minTokens: 0, priority: 30,
      });
    }
    if (propContext.warnings) {
      this.budget.registerSlot({
        name: 'PROP_WARNINGS', tier: 'T1', content: propContext.warnings,
        estimatedTokens: this.estimateTokens(propContext.warnings),
        maxTokens: 300, minTokens: 0, priority: 20,
      });
    }

    // T0: Evolution continuity context
    const continuityContext = this.evolution.buildContinuityContext(chapterIndex);
    if (continuityContext) {
      this.budget.registerSlot({
        name: 'EVOLUTION_CONTINUITY', tier: 'T0', content: continuityContext,
        estimatedTokens: this.estimateTokens(continuityContext),
        maxTokens: 500, minTokens: 200, priority: 40,
      });
    }

    // T0: Chapter continuity ledger context (inter-chapter promises/handoffs)
    const ledgerContext = this.continuityLedger.buildContinuityContext(chapterIndex);
    if (ledgerContext) {
      this.budget.registerSlot({
        name: 'CONTINUITY_LEDGER', tier: 'T0', content: ledgerContext,
        estimatedTokens: this.estimateTokens(ledgerContext),
        maxTokens: 600, minTokens: 100, priority: 35,
      });
    }

    // T0: Quality gate corrective directives (highest priority)
    const qualityDirectives = this.qualityGate.getPendingDirectives();
    if (qualityDirectives.length > 0) {
      const directiveText = qualityDirectives.join('\n');
      this.budget.registerSlot({
        name: 'QUALITY_GATE_DIRECTIVES', tier: 'T0', content: directiveText,
        estimatedTokens: this.estimateTokens(directiveText),
        maxTokens: 800, minTokens: 100, priority: 50,
      });
      this.qualityGate.clearDirectives();
    }
  }

  private async applyVoiceCorrection(content: string, chapterIndex: number, chapterId: string): Promise<string | null> {
    try {
      const fp = this.voiceFingerprint.getFingerprint();
      if (!fp) return null;
      const constraint = this.voiceFingerprint.buildStyleConstraint(fp);
      if (constraint.directives.length === 0) return null;

      const rewritePrompt = [
        `请将以下文本重写，严格遵循原始文风。`,
        `文风要求：${constraint.directives.join('；')}`,
        constraint.bannedPatterns.length > 0 ? `绝对禁止：${constraint.bannedPatterns.join('、')}` : '',
        `参考指标 — 平均句长:${fp.features.avgSentenceLength}字 对话占比:${(fp.features.dialogueRatio * 100).toFixed(0)}% 情感基调:${fp.features.emotionalTone}`,
        `只输出重写后的文本，不要任何解释。保持剧情和角色完全不变，只调整文风。`,
      ].filter(Boolean).join('\n');

      const request: LLMGenerateRequest = {
        taskType: 'rewrite',
        systemPrompt: rewritePrompt,
        userPrompt: content,
        temperature: 0.5,
        maxTokens: content.length + 500,
      };

      const response = await providerRouter.generate(request);
      const corrected = response.content.trim();
      if (corrected.length > content.length * 0.7) {
        this.config.onUpdateChapter(chapterId, {
          content: corrected,
          wordCount: corrected.length,
          status: 'drafting',
        });
        return corrected;
      }
    } catch (err) {
      console.warn('AutopilotEngine: voice correction failed', err);
    }
    return null;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3);
  }

  private async doChapterReview(chapterIndex: number, content: string, chapterId: string): Promise<void> {
    this.emit('stage_change', { stage: 'chapter_review', chapter: chapterIndex });

    const factLockText = this.memory.buildFactLockText();
    const beatLockText = this.memory.buildBeatLockText();

    const template = getTemplate('chapter-review')!;
    const request: LLMGenerateRequest = {
      taskType: 'review',
      systemPrompt: template.buildSystem({ factLock: factLockText, beatLock: beatLockText }),
      userPrompt: content,
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 1024,
    };

    try {
      const response = await providerRouter.generate(request);
      const review = parseLLMJson<{ pass?: boolean; overall?: number }>(response.content);
      if (!review) throw new Error('review parse failed');
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
      this.config.onUpdateChapter(chapterId, { status: 'complete' });
    }
  }

  /**
   * Quality gate with targeted rewrite loop (PlotPilot-style 定向修写).
   * Runs after chapter review. If quality issues are detected,
   * triggers an immediate targeted rewrite of the current chapter
   * before proceeding to aftermath.
   */
  private async doQualityGateRewrite(
    chapterIndex: number,
    content: string,
    chapterId: string,
  ): Promise<string> {
    const chapterNumber = chapterIndex + 1;
    let currentContent = content;

    try {
      this.emit('stage_change', { stage: 'chapter_review', chapter: chapterIndex, substage: 'quality_gate' });

      const rewriteResult = await this.qualityGate.evaluateAndRewrite(
        chapterNumber,
        content,
        (attempt, score, rewritten) => {
          this.emit('chapter_progress', {
            chapter: chapterIndex,
            chapterId,
            qualityGateRewrite: { attempt, score, rewritten },
          });
        },
      );

      if (rewriteResult.improved) {
        currentContent = rewriteResult.rewrittenContent;

        // Update chapter with rewritten content
        this.config.onUpdateChapter(chapterId, {
          content: currentContent,
          wordCount: currentContent.length,
          status: 'complete',
        });

        this.config.onUpdateStoryNode?.(chapterId, {
          status: 'complete',
        });

        this.emit('chapter_progress', {
          chapter: chapterIndex,
          chapterId,
          wordCount: currentContent.length,
          rewritten: true,
          rewriteAttempts: rewriteResult.attempts,
          qualityScore: rewriteResult.finalScore,
        });
      }

      // Exhausted retries but still below threshold → pause engine for human intervention
      if (rewriteResult.needsHumanIntervention) {
        this.config.onUpdateChapter(chapterId, {
          content: currentContent,
          wordCount: currentContent.length,
          status: 'revising',
        });

        this.config.onUpdateStoryNode?.(chapterId, {
          status: 'revising',
        });

        this.updateStatus('paused');
        this.emit('status_change', { status: 'paused' });
        this.emit('error', {
          error: `质量门: 第${chapterNumber}章经${rewriteResult.attempts}次定向修写仍不达标(${rewriteResult.finalScore}/100)，引擎已暂停，请人工审核`,
          qualityGateHumanIntervention: true,
          chapterNumber,
          finalScore: rewriteResult.finalScore,
          unresolvedIssues: rewriteResult.unresolvedIssues,
          rewrittenContent: currentContent,
        });

        return currentContent;
      }

      if (!rewriteResult.improved) {
        this.config.onUpdateChapter(chapterId, { status: 'complete' });
      }
    } catch (err) {
      console.warn('AutopilotEngine: quality gate rewrite failed, using original content', err);
      this.config.onUpdateChapter(chapterId, { status: 'complete' });
    }

    return currentContent;
  }

  private async doAftermath(chapterIndex: number, content: string, chapterId: string): Promise<void> {
    const chapterNumber = chapterIndex + 1;

    // 1. Memory update (three locks)
    try {
      await this.memory.updateFromChapter(chapterNumber, content);
    } catch (err) {
      console.warn('AutopilotEngine: memory update failed', err);
    }

    // 2. Chapter aftermath (triples, foreshadowing, debts)
    let aftermathResult: ChapterAftermathResult | null = null;
    try {
      aftermathResult = await this.aftermath.process(
        this.state.novelId,
        chapterNumber,
        content,
        this.foreshadowing.serialize(),
      );

      if (aftermathResult.triples?.length) {
        this.memory.mergeTriples(aftermathResult.triples);
      }

      // V9 Reform: plant foreshadowings with budget enforcement
      if (aftermathResult.foreshadowings.planted.length > 0) {
        const budgetResult = this.foreshadowing.plantWithBudget(
          aftermathResult.foreshadowings.planted,
          chapterNumber,
        );
        if (budgetResult.rejected > 0) {
          console.info(`AutopilotEngine: foreshadowing budget rejected ${budgetResult.rejected} new items (pending: ${this.foreshadowing.getPlanted().length}/${15})`);
        }
      }

      // Resolve foreshadowings that the LLM detected as consumed
      for (const resolved of aftermathResult.foreshadowings.resolved) {
        const matched = this.foreshadowing.resolveByDescription(
          resolved.description,
          resolved.resolvedInChapter ?? chapterNumber,
        );
        if (!matched) {
          this.foreshadowing.resolve(resolved.id, resolved.resolvedInChapter ?? chapterNumber);
        }
      }

      // Auto-abandon very old unresolved foreshadows
      const abandoned = this.foreshadowing.autoAbandonOld(chapterNumber);
      if (abandoned > 0) {
        console.info(`AutopilotEngine: auto-abandoned ${abandoned} foreshadows older than 30 chapters`);
      }

      // Persist foreshadowing to repository so ForeshadowLedgerPanel can read it
      this.repo.saveForeshadowing(this.foreshadowing.serialize());

      // Resolve narrative debts that are overdue or approaching deadline
      if (aftermathResult.narrativeDebts?.length) {
        const existingDebts = this.repo.loadNarrativeDebts();
        // Mark debts resolved by this chapter
        const updatedDebts = existingDebts.map((d) => {
          if (d.status !== 'open') return d;
          // Auto-resolve debts whose deadline has passed and this chapter addresses them
          if (d.suggestedResolveBy <= chapterNumber) {
            return { ...d, status: 'resolved' as const };
          }
          return d;
        });
        // Add new debts but cap total open debts
        const openCount = updatedDebts.filter((d) => d.status === 'open').length;
        const newDebtsToAdd = openCount < 6
          ? aftermathResult.narrativeDebts.slice(0, 6 - openCount)
          : [];
        this.repo.saveNarrativeDebts([...updatedDebts, ...newDebtsToAdd]);
      } else {
        // Even without new debts, auto-resolve overdue ones
        const existingDebts = this.repo.loadNarrativeDebts();
        const updatedDebts = existingDebts.map((d) => {
          if (d.status === 'open' && d.suggestedResolveBy <= chapterNumber) {
            return { ...d, status: 'resolved' as const };
          }
          return d;
        });
        this.repo.saveNarrativeDebts(updatedDebts);
      }

      // Persist character states
      if (aftermathResult.characterStates?.length) {
        this.repo.saveCharacterStates(aftermathResult.characterStates);
      }
    } catch (err) {
      console.warn('AutopilotEngine: aftermath pipeline failed', err);
    }

    // 3. Tension scoring (PlotPilot's multi-dimensional analysis)
    try {
      const tensionPoint = await this.tension.scoreChapter(content, chapterNumber, this.lastTensionScore);
      this.lastTensionScore = tensionPoint.score;
    } catch (err) {
      console.warn('AutopilotEngine: tension scoring failed', err);
    }

    // 4. Knowledge graph inference
    try {
      if (aftermathResult?.triples?.length) {
        this.knowledgeGraph.addTriplesAndInfer(aftermathResult.triples);
      }
    } catch (err) {
      console.warn('AutopilotEngine: knowledge graph inference failed', err);
    }

    // 5. Governance report
    try {
      const governanceReport = this.governance.generateReport({
        chapterNumber,
        totalChapters: this.state.targetChapterCount,
        storyPhase: this.storyPhase?.currentPhase ?? 'development',
        chapterContent: content,
        foreshadowing: this.foreshadowing.serialize(),
        debts: this.repo.loadNarrativeDebts(),
        newForeshadowing: aftermathResult?.foreshadowings.planted.length ?? 0,
        newCharacters: aftermathResult?.characterStates.length ?? 0,
        newSubplots: aftermathResult?.narrativeDebts.filter((d) => d.type === 'storyline').length ?? 0,
      });

      if (governanceReport.suggestions.length > 0 && governanceReport.governanceScore < 70) {
        this.emit('error', {
          error: `叙事治理警告: ${governanceReport.suggestions.join('; ')}`,
          governanceScore: governanceReport.governanceScore,
        });
      }
    } catch (err) {
      console.warn('AutopilotEngine: governance report failed', err);
    }

    // 6. Prop extraction from chapter content
    try {
      await this.propManager.extractEventsFromChapter(chapterNumber, content);
    } catch (err) {
      console.warn('AutopilotEngine: prop extraction failed', err);
    }

    // 7. Evolution tracking (character state changes, relationship changes, continuity)
    try {
      if (aftermathResult) {
        const violations = this.evolution.recordChapterEvents(
          chapterNumber,
          aftermathResult.characterStates,
          aftermathResult.triples,
          { resolved: aftermathResult.foreshadowings.resolved },
        );
        if (violations.length > 0) {
          this.emit('error', {
            error: `连续性警告: ${violations.map((v) => v.description).join('; ')}`,
            continuityViolations: violations,
          });
        }
      }
    } catch (err) {
      console.warn('AutopilotEngine: evolution tracking failed', err);
    }

    // 8. Save checkpoint after successful chapter
    this.saveCheckpoint(chapterIndex, 0);

    // 9. Voice fingerprint & drift detection
    try {
      const driftReport = await this.voiceFingerprint.detectDrift(content, chapterNumber);
      this.voiceFingerprint.saveDriftReport(driftReport);
      if (driftReport.driftDetected && driftReport.similarity < 0.5) {
        // Severe drift — trigger voice-corrected rewrite
        this.emit('error', {
          error: `文风严重漂移(相似度${(driftReport.similarity * 100).toFixed(0)}%)，正在修正...`,
          voiceDrift: driftReport,
        });
        const corrected = await this.applyVoiceCorrection(content, chapterIndex, chapterId);
        if (corrected) {
          content = corrected;
        }
      } else if (driftReport.driftDetected) {
        this.emit('error', {
          error: `文风漂移警告(相似度${(driftReport.similarity * 100).toFixed(0)}%): ${driftReport.suggestedFix ?? '建议检查文风一致性'}`,
          voiceDrift: driftReport,
        });
      } else {
        // Update fingerprint baseline with current chapter's style
        const fp = await this.voiceFingerprint.computeFingerprint(content, chapterNumber);
        this.repo.saveVoiceFingerprint(fp);
      }
    } catch (err) {
      console.warn('AutopilotEngine: voice drift detection failed', err);
    }

    // 10. Anti-AI cliche audit
    try {
      const auditReport = this.antiAIAuditor.auditChapter(content, chapterNumber);
      if (auditReport.severity === 'severe') {
        this.emit('error', {
          error: `AI痕迹过重(得分${auditReport.score}/100): ${auditReport.criticalCount}个严重俗套模式`,
          auditReport,
        });
      }
    } catch (err) {
      console.warn('AutopilotEngine: cliche audit failed', err);
    }

    // 11. Update continuity ledger
    try {
      const continuityData = await this.continuityLedger.extractFromAftermath(content, chapterIndex);
      this.continuityLedger.updateAfterChapter(chapterIndex, {
        summary: continuityData.lastBeatSummary,
        promises: continuityData.promises,
        currentLocation: continuityData.currentLocation,
        timeOfDay: continuityData.timeOfDay,
        characterStates: aftermathResult?.characterStates,
        unresolvedThreads: aftermathResult?.narrativeDebts?.map((d) => d.description),
        mood: undefined,
      });
    } catch (err) {
      console.warn('AutopilotEngine: continuity ledger update failed', err);
    }

    // 12. Conflict detection
    try {
      const bible = this.repo.loadBible();
      const conflicts = this.conflictDetector.detectConflicts(content, bible, {
        factLock: this.memory.serialize().factLock,
      });
      if (conflicts.length > 0) {
        this.emit('error', {
          error: `检测到 ${conflicts.length} 个冲突`,
          conflicts,
        });
      }
    } catch (err) {
      console.warn('AutopilotEngine: conflict detection failed', err);
    }

    // 13. Chapter summarization
    try {
      await this.chapterSummarizer.summarize(chapterIndex, content);
    } catch (err) {
      console.warn('AutopilotEngine: chapter summarization failed', err);
    }

    // 14. Auto-extract bible entities
    try {
      await this.autoBibleGenerator.extractFromChapter(chapterIndex, content);
    } catch (err) {
      console.warn('AutopilotEngine: auto bible extraction failed', err);
    }

    // 15. Emit completion
    const narrative = this.getNarrativeData();
    this.emit('chapter_complete', {
      chapter: chapterIndex,
      narrative,
      tensionScore: this.lastTensionScore,
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

    // 6. Restore last tension score
    const tensionHistory = this.tension.getTensionHistory();
    if (tensionHistory.length > 0) {
      this.lastTensionScore = tensionHistory[tensionHistory.length - 1].score;
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

    // Restore autopilot state (but keep status as idle — user must explicitly resume)
    this.state = {
      ...restored.autopilotState,
      status: 'idle',
      currentStage: 'idle',
    };
    this.breaker = restored.breakerState;

    // Restore memory engine
    const mem = MemoryEngine.deserialize(restored.memorySnapshot, this.state.novelId);
    this.memory = mem;

    // Restore foreshadowing tracker
    this.foreshadowing = ForeshadowingTracker.deserialize(restored.foreshadowing);

    // Restore last tension score
    const tensionHistory = this.tension.getTensionHistory();
    if (tensionHistory.length > 0) {
      this.lastTensionScore = tensionHistory[tensionHistory.length - 1].score;
    }
  }

  private saveCheckpoint(chapterIndex: number, beatIndex: number): void {
    const mem = this.memory.serialize();
    this.checkpoint.save({
      autopilotState: this.state,
      breakerState: this.breaker,
      factLock: mem.factLock,
      beatLock: mem.beatLock,
      clueLock: mem.clueLock,
      foreshadowing: this.foreshadowing.serialize(),
      chapterIndex,
      beatIndex,
    });
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
      tensionHistory: this.tension.getTensionHistory(),
      knowledgeGraph: this.knowledgeGraph.getFullGraph(),
      governance: this.governance.loadContract(),
    };
  }
}

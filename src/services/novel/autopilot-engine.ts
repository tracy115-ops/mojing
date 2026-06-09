import type {
  AutopilotState,
  AutopilotStatus,
  NovelStage,
  CircuitBreakerState,
} from '@/types/pipeline';
import type { StoryPhaseState, Foreshadowing, ChapterAftermathResult, Beat } from '@/types/narrative';
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
import { VoiceFingerprintService } from './voice-fingerprint';
import { AntiAIAuditor } from './cliche-scanner';
import { ChapterContinuityLedger } from './chapter-continuity-ledger';
import { ChapterSummarizer } from './chapter-summarizer';
import { AutoBibleGenerator } from './auto-bible-generator';
import { ConflictDetector } from './conflict-detector';
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
  onAddChapter: () => string;
  onUpdateMetadata: (updates: Partial<NovelMetadata>) => void;
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
  private repo: NarrativeRepository;
  private abortController: AbortController | null = null;
  private handlers: Set<AutopilotEventHandler> = new Set();
  private config: AutopilotConfig;
  private storyPhase: StoryPhaseState | null = null;
  private lastTensionScore: number = 5;

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

    // Add chapter to store
    const chapterId = this.config.onAddChapter();
    this.config.onUpdateChapter(chapterId, {
      title: macroPlan.title || `第${chapterNumber}章`,
      outline,
      status: 'drafting',
    });

    // Stage 3: Chapter generation (beat loop)
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

    const template = getTemplate('macro-planning');
    const request: LLMGenerateRequest = {
      taskType: 'planning',
      systemPrompt: template!.buildSystem({
        title: this.config.title,
        genre: this.config.genre,
        style: this.config.style,
        phaseDirective,
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
        temperature: 0.85,
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

    // T2 slots
    const prevContent = this.config.existingChapters
      .filter((c) => c.order < chapterIndex && c.content)
      .slice(-1)
      .map((c) => c.content.slice(-1500))
      .join('\n');
    if (prevContent) this.budget.registerPreviousChapter(prevContent);

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
      this.config.onUpdateChapter(chapterId, { status: 'complete' });
    }
  }

  private async doAftermath(chapterIndex: number, content: string): Promise<void> {
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

      for (const planted of aftermathResult.foreshadowings.planted) {
        this.foreshadowing.plant(planted);
      }
      for (const resolved of aftermathResult.foreshadowings.resolved) {
        // LLM returns resolved items with new IDs — match by description instead
        const matched = this.foreshadowing.resolveByDescription(
          resolved.description,
          resolved.resolvedInChapter ?? chapterNumber,
        );
        if (!matched) {
          // Fallback: try exact ID match
          this.foreshadowing.resolve(resolved.id, resolved.resolvedInChapter ?? chapterNumber);
        }
      }
      // Persist foreshadowing to repository so ForeshadowLedgerPanel can read it
      this.repo.saveForeshadowing(this.foreshadowing.serialize());

      // Persist narrative debts
      if (aftermathResult.narrativeDebts?.length) {
        const existingDebts = this.repo.loadNarrativeDebts();
        this.repo.saveNarrativeDebts([...existingDebts, ...aftermathResult.narrativeDebts]);
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
      if (driftReport.driftDetected) {
        this.emit('error', {
          error: `文风漂移警告(相似度${(driftReport.similarity * 100).toFixed(0)}%): ${driftReport.suggestedFix ?? '建议检查文风一致性'}`,
          voiceDrift: driftReport,
        });
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
      const conflicts = this.conflictDetector.detectConflicts(content, bible);
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

// --- Chapter Conductor ---
// Beat magnification + 3-phase word count control + Power Fantasy Engine.
// Inspired by PlotPilot's context_builder.py + word_count_tracker.py.

import type { Beat, BeatFocus, ConductorPhase, ConductorSignal, StoryPhaseState } from '@/types/narrative';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { ContextBudgetAllocator } from './context-budget';
import { parseLLMJson } from './llm-json';
import { generatePlanningResponse } from './planning-generation';

// --- Constants ---

const MAX_BEATS = 5;
const MIN_BEAT_WORDS = 400;
const WORDS_PER_CHAPTER_TARGET = 3000;

const HIGH_ENERGY_FOCUSES: Set<BeatFocus> = new Set(['action', 'hook', 'character_intro', 'suspense']);
const COMPRESSIBLE_FOCUSES: Set<BeatFocus> = new Set(['sensory', 'emotion', 'narration', 'dialogue']);

// --- Conductor Phases ---

const PHASE_THRESHOLDS = {
  unfurl: 0.75,   // 0-75%: expand freely
  converge: 0.92, // 75-92%: tighten rhythm
  // land: 92-100%: must end now
} as const;

const PHASE_INSTRUCTIONS: Record<ConductorPhase, string> = {
  unfurl: '【展开阶段】写清当前场景的目的、阻力和人物选择，不为铺陈而堆细节。',
  converge: '【收束阶段】优先完成已开始的关键行动，缩短无信息变化的重复描写与过渡。',
  land: '【收束阶段】完成当前行动及其后果，停止引入旁支；不要为达到字数而截断关键因果。',
};

// ============================================================
// Beat Magnification
// ============================================================

/**
 * Magnify a chapter outline into 3-6 beats using LLM.
 * Stop on invalid planning rather than inventing a generic plot.
 */
export async function magnifyOutlineToBeats(
  outline: string,
  targetWords: number,
  chapterIndex: number,
  signal?: AbortSignal,
): Promise<Beat[]> {
  const request: LLMGenerateRequest = {
    taskType: 'planning',
    systemPrompt: `你是一个叙事节拍规划师。按大纲的场景与因果拆分为 2-5 个叙事节拍(beat)，不能另外编造事件。

每个 beat 必须指定：
- "description": 节拍内容描述（具体场景/事件，50-100字，含具体动作和对话线索）
- "targetWords": 目标字数（整数，所有beat总和必须等于${targetWords}，单个 beat 至少 ${MIN_BEAT_WORDS} 字）
- "focus": 聚焦类型，必须是以下之一：action, dialogue, sensory, emotion, suspense, hook, character_intro, narration
- "sceneGoal": 这个场景要达到什么目的（一句话）

分配规则：
- hook 类型只能在第一个 beat 使用
- 第一个 beat 负责承接上一章/建立场景
- 最后一个 beat 落实大纲中行动的后果，不另造危机；不能漏掉取得信息、作出选择的关键过程
- 字数由关键选择与场景需要决定，不因动作类型自动获得更多篇幅
- 最多5个beat，分段不得漏掉大纲的关键行动及后果

输出严格JSON对象：
{"beats":[{"description":"...","targetWords":1200,"focus":"action","sceneGoal":"..."}]}`,
    userPrompt: `大纲：\n${outline}\n\n目标总字数：${targetWords}字\n章节序号：第${chapterIndex + 1}章\n请拆分为beats。`,
    responseFormat: 'json',
    temperature: 0.7,
    maxTokens: 2048,
    thinking: false,
  };

  try {
    const response = await generatePlanningResponse(
      maxTokens => providerRouter.generate({ ...request, maxTokens }, signal),
      request.maxTokens,
      signal,
    );
    const parsed = parseLLMJson<unknown>(response.content);
    const raw = Array.isArray(parsed) ? parsed : (parsed as { beats?: unknown[] } | null)?.beats;
    if (!raw || !Array.isArray(raw) || !raw.length) throw new Error('Expected nonempty beat array');

    let beats: Beat[] = raw.map((item: unknown, i: number) => {
      const b = item as Record<string, unknown>;
      return {
        index: i,
        description: String(b.description ?? ''),
        targetWords: Math.max(MIN_BEAT_WORDS, Number(b.targetWords ?? 500)),
        focus: validateFocus(b.focus),
        sceneGoal: String(b.sceneGoal ?? ''),
        expansionHints: Array.isArray(b.expansionHints) ? b.expansionHints.map(String) : undefined,
        transitionFromPrev: i > 0 ? String(b.transitionFromPrev ?? '') : undefined,
      };
    });

    // Cap & merge
    beats = capAndMergeBeats(beats, targetWords);
    // Rescale to target
    beats = rescaleToTarget(beats, targetWords);

    return beats;
  } catch (err) {
    signal?.throwIfAborted();
    throw new Error(`章节节拍规划未完成，已停止写作：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// Conductor Signal
// ============================================================

/**
 * Get the current conductor signal based on writing progress.
 */
export function getConductorSignal(
  beatIndex: number,
  totalBeats: number,
  wordsUsed: number,
  targetWords: number,
  currentBeat?: Beat,
): ConductorSignal {
  const ratio = wordsUsed / targetWords;
  let phase: ConductorPhase;

  if (ratio < PHASE_THRESHOLDS.unfurl) {
    phase = 'unfurl';
  } else if (ratio < PHASE_THRESHOLDS.converge) {
    phase = 'converge';
  } else {
    phase = 'land';
  }

  const remainingBudget = Math.max(0, targetWords - wordsUsed);
  const beatsRemaining = totalBeats - beatIndex;
  const isFinalBeat = beatIndex === totalBeats - 1;

  // Compute hard cap for this beat
  let hardCap = currentBeat?.targetWords ?? Math.ceil(remainingBudget / Math.max(1, beatsRemaining));
  if (phase === 'land') {
    hardCap = Math.min(hardCap, remainingBudget);
  }
  if (phase === 'converge' && !isHighEnergy(currentBeat?.focus)) {
    hardCap = Math.floor(hardCap * 0.85); // Compress non-action beats
  }

  return {
    phase,
    budgetUsedRatio: ratio,
    remainingBudget,
    beatsRemaining,
    isFinalBeat,
    beatInstruction: PHASE_INSTRUCTIONS[phase],
    hardCap,
  };
}

/**
 * Build per-beat target words adjustment based on conductor signal and power fantasy rules.
 */
export function adjustBeatTargetWords(
  beat: Beat,
  signal: ConductorSignal,
  overspendDebt: number,
): number {
  let adjusted = beat.targetWords;

  if (signal.phase === 'converge' || signal.phase === 'land') {
    adjusted = Math.max(MIN_BEAT_WORDS, beat.targetWords - Math.ceil(overspendDebt / Math.max(1, signal.beatsRemaining)));
  }

  return adjusted;
}

// ============================================================
// Phase Directive for Story Phase
// ============================================================

export function buildBeatPhaseDirective(
  storyPhase: StoryPhaseState | null,
  chapterIndex: number,
  totalChapters: number,
): string {
  const phase = storyPhase ?? ContextBudgetAllocator.computeStoryPhase(chapterIndex, totalChapters);
  return ContextBudgetAllocator.buildPhaseDirective(phase);
}

// ============================================================
// Helpers
// ============================================================

function validateFocus(raw: unknown): BeatFocus {
  const valid: BeatFocus[] = ['action', 'dialogue', 'sensory', 'emotion', 'suspense', 'hook', 'character_intro', 'narration'];
  if (typeof raw === 'string' && valid.includes(raw as BeatFocus)) return raw as BeatFocus;
  return 'narration';
}

function isHighEnergy(focus?: BeatFocus): boolean {
  return !!focus && HIGH_ENERGY_FOCUSES.has(focus);
}

function capAndMergeBeats(beats: Beat[], targetWords: number): Beat[] {
  let result = [...beats];

  // Cap at MAX_BEATS by merging smallest adjacent pairs
  while (result.length > MAX_BEATS) {
    let minSum = Infinity;
    let minIdx = 0;
    for (let i = 0; i < result.length - 1; i++) {
      const sum = result[i].targetWords + result[i + 1].targetWords;
      if (sum < minSum) {
        minSum = sum;
        minIdx = i;
      }
    }
    // Merge minIdx and minIdx+1
    const merged: Beat = {
      index: minIdx,
      description: result[minIdx].description + '；' + result[minIdx + 1].description,
      targetWords: result[minIdx].targetWords + result[minIdx + 1].targetWords,
      focus: isHighEnergy(result[minIdx].focus) || isHighEnergy(result[minIdx + 1].focus)
        ? 'action' : result[minIdx].focus,
      sceneGoal: result[minIdx].sceneGoal || result[minIdx + 1].sceneGoal,
    };
    result = [...result.slice(0, minIdx), merged, ...result.slice(minIdx + 2)];
  }

  // Merge adjacent beats that are too small
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].targetWords < MIN_BEAT_WORDS) {
      result[i].targetWords += result[i + 1].targetWords;
      result[i].description += '；' + result[i + 1].description;
      result.splice(i + 1, 1);
      i--;
    }
  }

  // Re-index
  return result.map((b, i) => ({ ...b, index: i }));
}

function rescaleToTarget(beats: Beat[], targetWords: number): Beat[] {
  const total = beats.reduce((s, b) => s + b.targetWords, 0);
  if (total === 0) return beats;

  const ratio = targetWords / total;
  return beats.map((b) => ({
    ...b,
    targetWords: Math.max(MIN_BEAT_WORDS, Math.round(b.targetWords * ratio)),
  }));
}

export { WORDS_PER_CHAPTER_TARGET, HIGH_ENERGY_FOCUSES, COMPRESSIBLE_FOCUSES };

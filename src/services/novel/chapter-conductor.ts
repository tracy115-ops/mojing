// --- Chapter Conductor ---
// Beat magnification + 3-phase word count control + Power Fantasy Engine.
// Inspired by PlotPilot's context_builder.py + word_count_tracker.py.

import type { Beat, BeatFocus, ConductorPhase, ConductorSignal, StoryPhaseState } from '@/types/narrative';
import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { ContextBudgetAllocator } from './context-budget';
import { parseLLMJson } from './llm-json';

// --- Constants ---

const MAX_BEATS = 3;
const MIN_BEAT_WORDS = 1000;
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
  unfurl: '【铺陈阶段】自由展开，充分描写。可以铺陈细节、展开对话、描写环境。',
  converge: '【收束阶段】收紧节奏。不要再开新的情节线。压缩环境和心理描写，保持叙事推进。',
  land: '【着陆阶段】必须结束。不再开新场景。用1-2句收束当前情绪。可以制造悬念结尾。',
};

// ============================================================
// Beat Magnification
// ============================================================

/**
 * Magnify a chapter outline into 3-6 beats using LLM.
 * Falls back to a 4-beat 起承转合 pattern if LLM fails.
 */
export async function magnifyOutlineToBeats(
  outline: string,
  targetWords: number,
  chapterIndex: number,
): Promise<Beat[]> {
  const request: LLMGenerateRequest = {
    taskType: 'planning',
    systemPrompt: `你是一个叙事节拍规划师。将章节大纲拆分为 2-3 个叙事节拍(beat)。

每个 beat 必须指定：
- "description": 节拍内容描述（具体场景/事件，50-100字，含具体动作和对话线索）
- "targetWords": 目标字数（整数，所有beat总和必须等于${targetWords}，单个 beat 至少 ${MIN_BEAT_WORDS} 字）
- "focus": 聚焦类型，必须是以下之一：action, dialogue, sensory, emotion, suspense, hook, character_intro, narration
- "sceneGoal": 这个场景要达到什么目的（一句话）

分配规则：
- hook 类型只能在第一个 beat 使用
- 第一个 beat 负责承接上一章/建立场景
- 最后一个 beat 负责收束或制造悬念
- action/suspense 类型的 beat 分配更多字数
- **最多 3 个 beat**——给每个 beat 充分的展开空间
- 偏好 2-3 个大 beat，而非 4-6 个小 beat

输出严格JSON数组：
[{"description":"...","targetWords":1200,"focus":"action","sceneGoal":"..."}, ...]`,
    userPrompt: `大纲：\n${outline}\n\n目标总字数：${targetWords}字\n章节序号：第${chapterIndex + 1}章\n请拆分为beats。`,
    responseFormat: 'json',
    temperature: 0.7,
    maxTokens: 2048,
  };

  try {
    const response = await providerRouter.generate(request);
    const raw = parseLLMJson<unknown[]>(response.content);
    if (!raw || !Array.isArray(raw)) throw new Error('Expected array');

    let beats: Beat[] = raw.slice(0, MAX_BEATS).map((item: unknown, i: number) => {
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
    console.warn('ChapterConductor: beat magnification failed, using fallback', err);
    return buildFallbackBeats(outline, targetWords, chapterIndex);
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

  // Power fantasy: high energy beats are immune to compression
  if (isHighEnergy(beat.focus)) {
    // Transfer debt to this beat's allocation
    adjusted = Math.max(adjusted, beat.targetWords); // Never compress high energy
  } else if (signal.phase === 'converge' || signal.phase === 'land') {
    // Compressible beats absorb overspend debt
    adjusted = Math.max(MIN_BEAT_WORDS, beat.targetWords - Math.ceil(overspendDebt * 0.5));
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

function buildFallbackBeats(outline: string, targetWords: number, chapterIndex: number): Beat[] {
  const patterns: Beat[][] = [
    // Chapter 1: hook + core event + suspense (3-beat, expanded)
    [
      { index: 0, description: '开篇钩子与主角出场：用强烈的场景冲突抓住读者，建立主角形象', targetWords: Math.round(targetWords * 0.3), focus: 'hook' as BeatFocus, sceneGoal: '抓住注意力并建立主角' },
      { index: 1, description: '核心事件展开：冲突双方正面交锋，揭示关键信息或推进主线', targetWords: Math.round(targetWords * 0.45), focus: 'action' as BeatFocus, sceneGoal: '推进主线、深化冲突' },
      { index: 2, description: '悬念收束与情感落点：留下一根刺，制造继续阅读的动力', targetWords: Math.round(targetWords * 0.25), focus: 'suspense' as BeatFocus, sceneGoal: '制造悬念' },
    ],
    // Chapter 2: sensory + dialogue + suspense (3-beat)
    [
      { index: 0, description: '承接上章悬念，建立新场景：通过角色五感展开环境', targetWords: Math.round(targetWords * 0.25), focus: 'sensory' as BeatFocus, sceneGoal: '场景过渡与铺垫' },
      { index: 1, description: '事件推进与角色互动：核心对话推进，关系深化或冲突升级', targetWords: Math.round(targetWords * 0.5), focus: 'dialogue' as BeatFocus, sceneGoal: '深化角色关系、推进剧情' },
      { index: 2, description: '新的悬念或转折：揭示关键信息或制造意外', targetWords: Math.round(targetWords * 0.25), focus: 'suspense' as BeatFocus, sceneGoal: '悬念收尾' },
    ],
  ];

  // Default: 起承转合 (3-beat — 起+承合并, 转, 合)
  const defaultPattern: Beat[] = [
    { index: 0, description: '起·承：场景建立、承接上章、初步推进', targetWords: Math.round(targetWords * 0.3), focus: 'narration' as BeatFocus, sceneGoal: '建立场景与推进' },
    { index: 1, description: '转：冲突升级或关键转折出现，硬碰硬化解', targetWords: Math.round(targetWords * 0.45), focus: 'action' as BeatFocus, sceneGoal: '制造转折与高潮' },
    { index: 2, description: '合：情感落点与悬念收束', targetWords: Math.round(targetWords * 0.25), focus: 'emotion' as BeatFocus, sceneGoal: '情感落点' },
  ];

  const selected = chapterIndex < patterns.length ? patterns[chapterIndex] : defaultPattern;
  return rescaleToTarget(selected, targetWords);
}

export { WORDS_PER_CHAPTER_TARGET, HIGH_ENERGY_FOCUSES, COMPRESSIBLE_FOCUSES };

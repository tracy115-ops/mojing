// --- Beat Middleware Chain ---
// Low-invasion coherence checks and enhancements applied after each beat.
// Inspired by PlotPilot's beat middleware pattern.

import type { Beat, ConductorSignal, BeatFocus } from '@/types/narrative';

// --- Middleware Types ---

export interface MiddlewareResult {
  content: string;
  instruction?: string; // appended to next beat's context
}

export type BeatMiddleware = (
  beat: Beat,
  content: string,
  signal: ConductorSignal,
  prevBeatContent?: string,
) => MiddlewareResult;

// --- 1. Continuity Check ---

/**
 * Check if the generated content is aligned with the beat description.
 * Uses keyword overlap as a simple heuristic.
 * Returns a correction instruction if content drifts too far.
 */
const continuityCheck: BeatMiddleware = (beat, content, _signal, _prevContent) => {
  const description = beat.description;
  // Extract keywords (Chinese chars/words of 2+ length)
  const keywords = extractKeywords(description);

  if (keywords.length === 0) {
    return { content };
  }

  // Check how many keywords appear in the content
  const matched = keywords.filter((kw) => content.includes(kw));
  const overlap = matched.length / keywords.length;

  if (overlap < 0.2) {
    // Significant drift — return correction instruction for next beat
    return {
      content,
      instruction: `【连贯性修正】上一段偏离了预定节拍"${description}"。请在下一段回归主线，补写：${keywords.slice(0, 3).join('、')}相关内容。`,
    };
  }

  return { content };
};

// --- 2. Transition Smoother ---

/**
 * Check if the transition between beats is smooth.
 * Returns a transition instruction if the previous beat's ending is abrupt.
 */
const transitionSmoother: BeatMiddleware = (beat, content, _signal, prevBeatContent) => {
  if (!prevBeatContent || beat.index === 0) {
    return { content };
  }

  // Check if previous beat ends mid-scene (no sentence-ending punctuation)
  const prevTail = prevBeatContent.trim().slice(-20);
  const endsWithPunctuation = /[。！？…"」』\n]/.test(prevTail.slice(-1));

  if (!endsWithPunctuation) {
    return {
      content,
      instruction: '【过渡指令】上一段结尾较突兀，请在当前段落开头添加一句过渡性描写，让场景衔接自然。',
    };
  }

  // Check if current beat starts abruptly (no transition from previous)
  const currHead = content.trim().slice(0, 30);
  const hasTransitionWord = /^(就在|这时|忽然|然而|不过|此时|就在这时|紧接着|于是|随后|片刻后|不一会儿)/.test(currHead);

  if (!hasTransitionWord && beat.transitionFromPrev) {
    return {
      content,
      instruction: `【过渡指令】请在段落开头加入场景过渡："${beat.transitionFromPrev}"`,
    };
  }

  return { content };
};

// --- 3. Energy Protector ---

const HIGH_ENERGY_FOCUSES: Set<BeatFocus> = new Set(['action', 'hook', 'character_intro', 'suspense']);

/**
 * In CONVERGE/LAND phases, protect high-energy beats from being cut short.
 * Returns a protection instruction.
 */
const energyProtector: BeatMiddleware = (beat, content, signal) => {
  if (signal.phase === 'unfurl') {
    return { content };
  }

  if (HIGH_ENERGY_FOCUSES.has(beat.focus)) {
    // This is a high-energy beat in a compression phase — protect it
    if (content.length < beat.targetWords * 0.7) {
      return {
        content,
        instruction: '【能量保护】当前是高潮场景，不要压缩。请充分展开动作/冲突描写。',
      };
    }
  }

  return { content };
};

// --- Middleware Chain Runner ---

const MIDDLEWARES: BeatMiddleware[] = [
  continuityCheck,
  transitionSmoother,
  energyProtector,
];

/**
 * Run all middlewares in sequence, accumulating instructions.
 */
export function runMiddlewareChain(
  beat: Beat,
  content: string,
  signal: ConductorSignal,
  prevBeatContent?: string,
): MiddlewareResult {
  let currentContent = content;
  const instructions: string[] = [];

  for (const mw of MIDDLEWARES) {
    const result = mw(beat, currentContent, signal, prevBeatContent);
    currentContent = result.content;
    if (result.instruction) {
      instructions.push(result.instruction);
    }
  }

  return {
    content: currentContent,
    instruction: instructions.length > 0 ? instructions.join('\n') : undefined,
  };
}

// --- Helpers ---

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: split by common delimiters, keep 2+ char segments
  const segments = text.split(/[，。、；：！？\s,;:!?\-—…""''「」『』《》（）()【】\[\]]+/);
  return segments.filter((s) => s.length >= 2 && s.length <= 8);
}

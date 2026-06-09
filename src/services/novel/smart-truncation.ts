// --- Smart Truncation ---
// Inspired by PlotPilot's smart_truncate() + build_soft_landing_prompt().
// Sentence-boundary-aware, emotion-aware, Chinese-quote-balanced truncation.

// --- Rising Tension Keywords ---

const RISING_TENSION_KEYWORDS = [
  '突然', '猛地', '骤然', '陡然', '瞬间', '刹那',
  '冲向', '扑向', '暴起', '暴怒', '怒吼', '咆哮',
  '一声', '一击', '一刀', '一拳', '一掌',
  '炸裂', '碎裂', '崩塌', '断裂', '撕裂',
  '血', '刀光', '剑影', '杀意', '战意',
  '不可置信', '震惊', '惊骇', '恐惧', '绝望',
  '终于', '就在这时', '就在此刻', '千钧一发',
];

// --- Chinese Paired Punctuation ---

const PAIRED_OPEN = new Set(['「', '『', '"', '（', '【', '《']);
const PAIRED_CLOSE = new Set(['」', '』', '"', '）', '】', '》']);
const PAIR_MAP: Record<string, string> = {
  '「': '」', '『': '』', '"': '"', '（': '）', '【': '】', '《': '》',
};

// --- Sentence Endings ---

const SENTENCE_ENDINGS = new Set(['。', '！', '？', '…', '”', '」', '』', '\n']);

/**
 * Smart truncation that respects sentence boundaries, Chinese quote pairing,
 * and emotional tension.
 */
export function smartTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Step 1: Find all candidate cut points near maxChars
  const searchStart = Math.max(0, maxChars - 200);
  const searchEnd = Math.min(text.length, maxChars + 100);
  const searchRegion = text.slice(searchStart, searchEnd);

  let bestCutPoint = maxChars;
  let bestScore = -Infinity;

  // Check paragraph boundaries first (highest priority)
  for (let i = searchStart; i < searchEnd && i < text.length; i++) {
    if (text[i] === '\n' && i <= maxChars + 50) {
      const score = 100 + (maxChars - Math.abs(i - maxChars));
      if (score > bestScore && i <= maxChars + 50) {
        bestScore = score;
        bestCutPoint = i;
      }
    }
  }

  // If no good paragraph boundary, look for sentence boundaries
  if (bestScore < 100) {
    for (let i = searchStart; i < searchEnd && i < text.length; i++) {
      if (SENTENCE_ENDINGS.has(text[i])) {
        const cutIdx = i + 1;
        if (cutIdx > maxChars + 50) continue;

        // Check quote balance at this cut point
        if (!isQuoteBalanced(text.slice(0, cutIdx))) continue;

        // Score: prefer cut points closer to maxChars
        const distance = Math.abs(cutIdx - maxChars);
        const score = 50 - distance;
        if (score > bestScore) {
          bestScore = score;
          bestCutPoint = cutIdx;
        }
      }
    }
  }

  // If still no good cut point, just cut at maxChars
  if (bestScore < 0) {
    bestCutPoint = maxChars;
  }

  let truncated = text.slice(0, bestCutPoint).trimEnd();

  // Step 2: Detect if we're in rising tension
  const tailText = text.slice(Math.max(0, bestCutPoint - 150), Math.min(text.length, bestCutPoint + 150));
  const isRisingTension = RISING_TENSION_KEYWORDS.some((kw) => tailText.includes(kw));

  // Step 3: Append appropriate ending
  if (isRisingTension) {
    // Use ellipsis to preserve narrative momentum
    truncated += '……';
  } else if (!truncated.endsWith('。') && !truncated.endsWith('！') && !truncated.endsWith('？') && !truncated.endsWith('"') && !truncated.endsWith('」')) {
    truncated += '。';
  }

  return truncated;
}

/**
 * Check if Chinese paired punctuation is balanced in the text.
 */
function isQuoteBalanced(text: string): boolean {
  const stack: string[] = [];
  for (const ch of text) {
    if (PAIRED_OPEN.has(ch)) {
      stack.push(ch);
    } else if (PAIRED_CLOSE.has(ch)) {
      const expectedOpen = Object.entries(PAIR_MAP).find(([, v]) => v === ch)?.[0];
      if (expectedOpen && stack.length > 0 && stack[stack.length - 1] === expectedOpen) {
        stack.pop();
      } else if (stack.length === 0) {
        // Closing without opening — unbalanced
        return false;
      }
    }
  }
  return stack.length === 0;
}

/**
 * Detect emotional tension level in text.
 */
export function detectTension(text: string): 'rising' | 'peak' | 'falling' | 'stable' {
  const tail = text.slice(-300);
  let matchCount = 0;
  for (const kw of RISING_TENSION_KEYWORDS) {
    if (tail.includes(kw)) matchCount++;
  }

  // Check for exclamation marks (emotion indicator)
  const exclamations = (tail.match(/[！!]/g) || []).length;
  const questionMarks = (tail.match(/[？?]/g) || []).length;

  const intensity = matchCount + exclamations * 0.5 + questionMarks * 0.3;

  if (intensity >= 5) return 'peak';
  if (intensity >= 3) return 'rising';

  // Check for falling indicators
  const fallingKeywords = ['松了', '平静', '安宁', '沉默', '叹息', '缓缓', '温和'];
  for (const kw of fallingKeywords) {
    if (tail.includes(kw)) return 'falling';
  }

  return 'stable';
}

/**
 * Build soft landing prompt for chapter/beat ending.
 * Returns an instruction string to guide the LLM toward a natural ending.
 */
export function buildSoftLandingPrompt(
  wordsUsed: number,
  targetWords: number,
  currentContent: string,
): string {
  const tension = detectTension(currentContent);
  const ratio = wordsUsed / targetWords;

  if (ratio >= 0.95) {
    // Emergency landing
    switch (tension) {
      case 'peak':
        return '【紧急收束】定格在最高潮的瞬间。用一句话定格这个画面，制造悬念。不要展开新的情节线。';
      case 'rising':
        return '【紧急收束】张力正在上升，用省略号或悬念句收束在这一刻。不要试图解决冲突。';
      case 'falling':
        return '【紧急收束】情绪正在回落，干净利落地结束本段。给读者一个情感落点。';
      default:
        return '【紧急收束】立即结束当前场景。用一句收束性描写结束。';
    }
  }

  if (ratio >= 0.85) {
    // Soft landing approach
    switch (tension) {
      case 'peak':
        return '【收束提示】高潮场景中，用2-3句话给这个场景一个画面定格。可以制造悬念结尾。';
      case 'rising':
        return '【收束提示】张力上升中，可以在一个关键的未决时刻暂停，制造"且听下回分解"的效果。';
      case 'falling':
        return '【收束提示】自然过渡到情绪回落，用一个安静的收尾画面结束。';
      default:
        return '【收束提示】自然收束当前场景。可以铺垫下一章的悬念。';
    }
  }

  // Still have room
  return '';
}

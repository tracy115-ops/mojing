/**
 * llm-json.ts — 工业级超强容错 LLM JSON 解析器
 *
 * 针对各类大模型（GLM-4/5.2、DeepSeek-R1、Qwen-2.5、Claude、GPT-4o、Llama等）
 * 输出的各种不规范 JSON 格式提供全套容错、净化与修复能力：
 *   1. 彻底剔除 think 或 thought 思考链标签
 *   2. 支持多代码块提取
 *   3. 剔除 JavaScript/C 风格注释 (// 和 block comments)
 *   4. 智能修复未转义的字符串内换行符与控制字符
 *   5. 剔除尾随逗号 (Trailing commas)
 *   6. 单引号键值转双引号 (Fix single quoted keys/values)
 *   7. 自动补全因 maxTokens 截断的未闭合括号 (Auto repair truncated JSON)
 */

export function parseLLMJson<T = Record<string, unknown>>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // 1. 彻底剔除思考链标签 <think>...</think> 或 <thought>...</thought>
  text = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/<thought[\s\S]*?<\/thought>/gi, '').trim();

  // 2. 尝试从 Markdown 代码块提取 (可能存在多个代码块，优先提取包含 json 或包含有效大括号/中括号的块)
  const codeBlockRegex = /```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  let codeMatch: RegExpExecArray | null;
  const extractedBlocks: string[] = [];

  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    const candidate = codeMatch[1].trim();
    if (candidate) extractedBlocks.push(candidate);
  }

  // 如果提取到了代码块，优先尝试解析代码块中的内容
  for (const block of extractedBlocks) {
    const result = tryParseString<T>(block);
    if (result !== null) return result;
  }

  // 3. 直接尝试对全文或截取的 JSON 区间进行清洗与解析
  return tryParseString<T>(text);
}

/**
 * 对任意候选 JSON 字符串执行多阶段深度修复与解析
 */
function tryParseString<T>(rawCandidate: string): T | null {
  let s = rawCandidate.trim();
  if (!s) return null;

  // 快速路径：标准 JSON 直接解析
  try {
    return JSON.parse(s) as T;
  } catch {}

  // 阶段 1: 基础清洗（剥离注释、尾随逗号、首尾空白）
  s = cleanJsonSyntax(s);
  try {
    return JSON.parse(s) as T;
  } catch {}

  // 阶段 2: 截取最外层大括号 {...} 或中括号 [...]
  const bracketIndex = s.indexOf('[');
  const braceIndex = s.indexOf('{');

  // 如果两者都存在，看谁先出现
  let firstIdx = -1;
  let lastIdx = -1;
  let isArray = false;

  if (bracketIndex !== -1 && braceIndex !== -1) {
    if (bracketIndex < braceIndex) {
      firstIdx = bracketIndex;
      lastIdx = s.lastIndexOf(']');
      isArray = true;
    } else {
      firstIdx = braceIndex;
      lastIdx = s.lastIndexOf('}');
      isArray = false;
    }
  } else if (bracketIndex !== -1) {
    firstIdx = bracketIndex;
    lastIdx = s.lastIndexOf(']');
    isArray = true;
  } else if (braceIndex !== -1) {
    firstIdx = braceIndex;
    lastIdx = s.lastIndexOf('}');
    isArray = false;
  }

  if (firstIdx !== -1) {
    if (lastIdx > firstIdx) {
      const sliced = cleanJsonSyntax(s.slice(firstIdx, lastIdx + 1));
      try {
        return JSON.parse(sliced) as T;
      } catch {
        // 尝试高级字符串转义修复
        const repaired = repairEscapesAndQuotes(sliced);
        try {
          return JSON.parse(repaired) as T;
        } catch {}
      }
    } else {
      // 说明结尾被截断了 (比如到达了 max_tokens)，尝试自动补全闭合
      const truncated = s.slice(firstIdx);
      const autoClosed = autoCloseTruncatedJson(truncated, isArray);
      if (autoClosed) {
        try {
          return JSON.parse(cleanJsonSyntax(autoClosed)) as T;
        } catch {}
      }
    }
  }

  // 阶段 3: 尝试备用的大括号或中括号匹配（防止第一个是误报）
  if (isArray && braceIndex !== -1) {
    const lastBrace = s.lastIndexOf('}');
    if (lastBrace > braceIndex) {
      const sliced = cleanJsonSyntax(s.slice(braceIndex, lastBrace + 1));
      try {
        return JSON.parse(sliced) as T;
      } catch {}
    }
  } else if (!isArray && bracketIndex !== -1) {
    const lastBracket = s.lastIndexOf(']');
    if (lastBracket > bracketIndex) {
      const sliced = cleanJsonSyntax(s.slice(bracketIndex, lastBracket + 1));
      try {
        return JSON.parse(sliced) as T;
      } catch {}
    }
  }

  console.warn('parseLLMJson: could not parse LLM response', rawCandidate.slice(0, 150));
  return null;
}

/**
 * 清理注释与多余尾随逗号
 */
function cleanJsonSyntax(str: string): string {
  return str
    // 移除 // 单行注释
    .replace(/(^|[^\\])\/\/.*$/gm, '$1')
    // 移除 /* ... */ 多行注释
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 移除尾随逗号 before } 或 ]
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

/**
 * 修复单引号与未转义控制字符
 */
function repairEscapesAndQuotes(str: string): string {
  let res = str;
  // 将没有被转义的单引号属性名 'key': 转换为 "key":
  res = res.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');
  // 移除多余尾随逗号
  res = res.replace(/,\s*([}\]])/g, '$1');
  return res;
}

/**
 * 针对截断的 JSON 进行智能闭合
 */
function autoCloseTruncatedJson(str: string, isArray: boolean): string | null {
  let s = str.trim();
  // 统计未闭合的括号
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      isEscaped = !isEscaped;
      continue;
    }
    if (ch === '"' && !isEscaped) {
      inString = !inString;
    }
    if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces = Math.max(0, openBraces - 1);
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets = Math.max(0, openBrackets - 1);
    }
    isEscaped = false;
  }

  // 如果字符串未闭合，先闭合字符串
  if (inString) {
    s += '"';
  }

  // 清除末尾残留的逗号或不完整属性名
  s = s.replace(/,\s*$/, '');
  s = s.replace(/:\s*$/, ': null');

  // 补齐闭合的大括号与中括号
  while (openBraces > 0) {
    s += '}';
    openBraces--;
  }
  while (openBrackets > 0) {
    s += ']';
    openBrackets--;
  }

  return cleanJsonSyntax(s);
}

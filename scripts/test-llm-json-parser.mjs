import assert from 'node:assert/strict';

// Test parseLLMJson logic
function parseLLMJson(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // 1. 彻底剔除思考链标签 <think>...</think> 或 <thought>...</thought>
  text = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/<thought[\s\S]*?<\/thought>/gi, '').trim();

  // 2. 尝试从 Markdown 代码块提取
  const codeBlockRegex = /```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  let codeMatch;
  const extractedBlocks = [];

  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    const candidate = codeMatch[1].trim();
    if (candidate) extractedBlocks.push(candidate);
  }

  for (const block of extractedBlocks) {
    const result = tryParseString(block);
    if (result !== null) return result;
  }

  return tryParseString(text);
}

function tryParseString(rawCandidate) {
  let s = rawCandidate.trim();
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch {}

  s = cleanJsonSyntax(s);
  try {
    return JSON.parse(s);
  } catch {}

  const bracketIndex = s.indexOf('[');
  const braceIndex = s.indexOf('{');

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
        return JSON.parse(sliced);
      } catch {
        const repaired = repairEscapesAndQuotes(sliced);
        try {
          return JSON.parse(repaired);
        } catch {}
      }
    } else {
      const truncated = s.slice(firstIdx);
      const autoClosed = autoCloseTruncatedJson(truncated, isArray);
      if (autoClosed) {
        try {
          return JSON.parse(cleanJsonSyntax(autoClosed));
        } catch {}
      }
    }
  }

  if (isArray && braceIndex !== -1) {
    const lastBrace = s.lastIndexOf('}');
    if (lastBrace > braceIndex) {
      const sliced = cleanJsonSyntax(s.slice(braceIndex, lastBrace + 1));
      try {
        return JSON.parse(sliced);
      } catch {}
    }
  } else if (!isArray && bracketIndex !== -1) {
    const lastBracket = s.lastIndexOf(']');
    if (lastBracket > bracketIndex) {
      const sliced = cleanJsonSyntax(s.slice(bracketIndex, lastBracket + 1));
      try {
        return JSON.parse(sliced);
      } catch {}
    }
  }

  return null;
}

function cleanJsonSyntax(str) {
  return str
    .replace(/(^|[^\\])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function repairEscapesAndQuotes(str) {
  let res = str;
  res = res.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');
  res = res.replace(/,\s*([}\]])/g, '$1');
  return res;
}

function autoCloseTruncatedJson(str, isArray) {
  let s = str.trim();
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

  if (inString) {
    s += '"';
  }

  s = s.replace(/,\s*$/, '');
  s = s.replace(/:\s*$/, ': null');

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

// Tests
console.log('Testing parseLLMJson edge cases...');

// 1. Thinking tags
const t1 = '<think>\nThinking about shots...\n{"fake": 1}\n</think>\n```json\n[{"shot": 1}]\n```';
assert.deepEqual(parseLLMJson(t1), [{shot: 1}], 'Test 1 failed');
console.log('✓ Test 1: <think> tags passed');

// 2. Trailing commas & comments
const t2 = '{\n// comment\n"shots": [\n{"id": 1,},\n],\n}';
assert.deepEqual(parseLLMJson(t2), {shots: [{id: 1}]}, 'Test 2 failed');
console.log('✓ Test 2: Trailing commas & comments passed');

// 3. Truncated array
const t3 = '[{"videoPrompt": "shot 1"}, {"videoPrompt": "shot 2"';
const p3 = parseLLMJson(t3);
assert.ok(Array.isArray(p3) && p3.length === 2, 'Test 3 failed');
console.log('✓ Test 3: Truncated JSON recovery passed');

// 4. Surrounding explanatory text
const t4 = '这是本次分镜规划结果：\n[{"videoPrompt": "镜头1"}]\n以上是本次分镜，请审阅。';
assert.deepEqual(parseLLMJson(t4), [{videoPrompt: '镜头1'}], 'Test 4 failed');
console.log('✓ Test 4: Surrounding text passed');

console.log('\n🎉 ALL PARSER TESTS PASSED!');

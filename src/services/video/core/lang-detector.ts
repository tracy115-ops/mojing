// ============================================================================
// LangDetector — 根据文本中英文字符占比智能判定主语言 ('zh' | 'en')
// ============================================================================

/**
 * 根据输入文本的中英文占比判定主要语言：
 * - 统计 CJK 汉字数量与英文字母数量
 * - 如果汉字占比 >= 15% 或 汉字数量 >= 字母数量，判定为中文 'zh'
 * - 纯英文或英文占主导，判定为英文 'en'
 */
export function detectInputLanguage(text: string): 'zh' | 'en' {
  if (!text || !text.trim()) return 'zh';

  const chineseCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishCount = (text.match(/[a-zA-Z]/g) || []).length;

  if (chineseCount === 0 && englishCount > 0) return 'en';
  if (englishCount === 0 && chineseCount > 0) return 'zh';

  const totalLetters = chineseCount + englishCount;
  const chineseRatio = totalLetters > 0 ? chineseCount / totalLetters : 0;

  return chineseRatio >= 0.15 || chineseCount >= englishCount ? 'zh' : 'en';
}

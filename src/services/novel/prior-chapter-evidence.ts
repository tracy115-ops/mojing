import type { NovelChapter } from '@/types';

// Chinese prose needs matches within words, whereas alphabetic prose benefits
// from matching complete words. Frequent short matches carry less weight.
function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const word of text.toLowerCase().match(/\p{Script=Han}+|[a-z0-9]{3,}/gu) ?? []) {
    if (!/^\p{Script=Han}/u.test(word)) {
      result.add(word);
      continue;
    }
    for (const width of [2, 3, 4]) {
      for (let start = 0; start + width <= word.length; start++) result.add(word.slice(start, start + width));
    }
  }
  return result;
}

export function findPriorChapterEvidence(chapters: NovelChapter[], focus: string, alreadyShown: string[]) {
  const query = terms(focus.slice(0, 6000));
  if (!query.size) return [];
  const candidates: Array<{ chapter: NovelChapter; offset: number; quote: string; matches: string[] }> = [];
  const frequency = new Map<string, number>();
  for (const chapter of chapters) {
    for (const match of chapter.content.matchAll(/[^。！？!?\n]+[。！？!?]?/g)) {
      const line = match[0].trim();
      for (let start = 0; start < line.length; start += 320) {
        const quote = line.slice(start, start + 400).trim();
        if (quote.length < 8) continue;
        const matches = [...terms(quote)].filter(term => query.has(term));
        if (!matches.length) continue;
        candidates.push({ chapter, offset: (match.index ?? 0) + start, quote, matches });
        for (const term of matches) frequency.set(term, (frequency.get(term) ?? 0) + 1);
      }
    }
  }
  const ranked = candidates.map(candidate => ({
    ...candidate,
    score: candidate.matches.reduce((score, term) => score + (term.length - 1) / Math.sqrt(frequency.get(term)!), 0),
  })).sort((a, b) => b.score - a.score || a.chapter.order - b.chapter.order || a.offset - b.offset);
  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    if (candidate.score < 2 || selected.length === 6) break;
    if (alreadyShown.some(text => text.includes(candidate.quote))) continue;
    if (selected.some(other => other.quote === candidate.quote ||
      (other.chapter.id === candidate.chapter.id && Math.abs(other.offset - candidate.offset) < 400))) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.chapter.order - b.chapter.order || a.offset - b.offset);
}

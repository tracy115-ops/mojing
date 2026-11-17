import type { NovelChapter } from '@/types';
import type { Foreshadowing } from '@/types/narrative';

// Chapter numbers in the ledger are one-based; planned empty chapters are not progress.
export function lastWrittenChapter(chapters: NovelChapter[]): number {
  return Math.max(0, ...chapters.filter(c => c.content.trim()).map(c => c.order + 1));
}

export function getDueForeshadowing(items: Foreshadowing[], writtenChapter: number): Foreshadowing[] {
  return items.filter(f => f.status === 'planted' && f.plantedInChapter <= writtenChapter
    && f.suggestedResolveChapter !== undefined && f.suggestedResolveChapter <= writtenChapter);
}

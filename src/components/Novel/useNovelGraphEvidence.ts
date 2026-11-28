import { useEffect, useMemo, useState } from 'react';
import type { NovelMetadata } from '@/types';
import { useProjectStore } from '@/stores/projectStore';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { getChapterGraphEvidence, getNovelChapters, type ChapterMemory } from '@/services/novel/writing-context';

export function useNovelGraphEvidence(repo: NarrativeRepository, novelId: string) {
  const project = useProjectStore(state => state.projects.find(item => item.id === novelId));
  const metadata = project?.type === 'novel' ? project.metadata as NovelMetadata : undefined;
  const [revision, refresh] = useState(0);
  useEffect(() => repo.subscribe(['chapter-reviews'], () => refresh(value => value + 1)), [repo]);
  return useMemo(() => metadata ? getChapterGraphEvidence(
    getNovelChapters(metadata),
    repo.loadCustomData<ChapterMemory[]>('chapter-reviews', []),
    true,
  ) : [], [metadata, repo, revision]);
}

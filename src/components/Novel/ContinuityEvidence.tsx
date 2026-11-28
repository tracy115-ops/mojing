import { useEffect, useMemo, useState } from 'react';
import { Button, Collapse, List, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelMetadata } from '@/types';
import type { ChapterReviewReport } from '@/services/novel/chapter-reviewer';
import type { ContinuityNoteKind } from '@/services/novel/editorial-review';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { getNovelChapters, textFingerprint } from '@/services/novel/writing-context';

export default function ContinuityEvidence({ novelId, kind, onRegister, isRegistered }: {
  novelId: string;
  kind?: ContinuityNoteKind;
  onRegister?: (description: string, chapter?: number) => void;
  isRegistered?: (description: string, chapter?: number) => boolean;
}) {
  const { t } = useTranslation();
  const metadata = useProjectStore(state => state.projects.find(project => project.id === novelId)?.metadata as NovelMetadata | undefined);
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const [version, refresh] = useState(0);
  useEffect(() => repo.subscribe(['chapter-reviews', 'bible', 'plot-outline'], () => refresh(value => value + 1)), [repo]);

  const { notes, settings, seeds } = useMemo(() => {
    const chapters = new Map((metadata ? getNovelChapters(metadata) : []).map(chapter => [chapter.order, chapter]));
    const reports = repo.loadCustomData<ChapterReviewReport[]>('chapter-reviews', []);
    const notes = reports.filter(report => report.status === 'reviewed').sort((a, b) => b.chapter - a.chapter).flatMap(report => {
      const chapter = chapters.get(report.chapter);
      if (!chapter || report.contentFingerprint !== textFingerprint(chapter.content)) return [];
      return report.continuityNotes.filter(note => (!kind || note.kind === kind) && note.quote && chapter.content.includes(note.quote))
        .map(note => ({ ...note, chapter: report.chapter + 1 }));
    });
    const settings = kind === 'world' ? repo.loadBible().worldSettings : [];
    const seeds = kind === 'clue' ? (repo.loadWritingReferences().plotOutline?.stages ?? []).flatMap(stage => stage.foreshadowSeeds ?? []) : [];
    return { notes, settings, seeds };
  }, [repo, metadata, kind, version]);

  const items = [];
  const registerAction = (description: string, chapter?: number) => {
    if (!onRegister) return [];
    const registered = isRegistered?.(description, chapter);
    return [<Button key="register" size="small" disabled={registered} onClick={() => onRegister(description, chapter)}>
      {t(registered ? 'workbench.ledger.registered' : 'workbench.ledger.register')}
    </Button>];
  };
  if (settings.length) items.push({ key: 'settings', label: t('workbench.evidence.settings'), children: <List size="small" dataSource={settings} renderItem={setting => <List.Item><div>
    <Typography.Text strong>{setting.name}</Typography.Text>
    <div>{setting.description}</div>
    {setting.constraints?.map((constraint, index) => <div key={index}>{constraint}</div>)}
  </div></List.Item>} /> });
  if (seeds.length) items.push({ key: 'plans', label: t('workbench.evidence.plans'), children: <List size="small" dataSource={[...new Set(seeds)]} pagination={seeds.length > 5 ? { pageSize: 5, size: 'small', showSizeChanger: false } : false} renderItem={seed => <List.Item actions={registerAction(seed)}>{seed}</List.Item>} /> });
  items.push({
    key: 'notes', label: t('workbench.evidence.notes', { count: notes.length }),
    children: <List size="small" dataSource={notes} pagination={notes.length > 5 ? { pageSize: 5, size: 'small', showSizeChanger: false } : false}
      locale={{ emptyText: t('workbench.evidence.empty') }}
      renderItem={note => <List.Item actions={registerAction(note.fact, note.chapter)}><div>
        <Typography.Text strong>{t('novel.chapterOrder', { order: note.chapter })} · {note.fact}</Typography.Text>
        <div><Typography.Text type="secondary">{note.quote}</Typography.Text></div>
      </div></List.Item>} />,
  });
  return <Collapse size="small" data-testid="continuity-evidence" defaultActiveKey={items.length > 1 ? items[0].key : 'notes'} items={items} />;
}

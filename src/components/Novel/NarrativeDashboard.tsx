import React, { useMemo, useState, useEffect } from 'react';
import { Button, Card, Empty, Tag, Typography, Space } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { ChapterReviewer } from '@/services/novel/chapter-reviewer';
import { getNovelChapters, WRITING_REFERENCE_KEYS } from '@/services/novel/writing-context';
import { isReviewCurrent } from '@/services/novel/editorial-review';
import { getDueForeshadowing, lastWrittenChapter } from '@/services/novel/workbench-state';
import type { NovelMetadata } from '@/types';

const { Text } = Typography;

const NarrativeDashboard: React.FC<{
  novelId: string;
  onOpen: (key: 'chapterReview' | 'bible' | 'foreshadow', chapter?: number) => void;
}> = ({ novelId, onOpen }) => {
  const { t } = useTranslation();
  const project = useProjectStore(s => s.projects.find(p => p.id === novelId));
  const meta = project?.metadata as NovelMetadata | undefined;
  const chapters = useMemo(() => meta ? getNovelChapters(meta) : [], [meta]);
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const reviewer = useMemo(() => new ChapterReviewer(novelId), [novelId]);
  const [, refresh] = useState(0);
  useEffect(() => repo.subscribe(WRITING_REFERENCE_KEYS, () => refresh(n => n + 1)), [repo]);
  const written = chapters.filter(c => c.content.trim());
  const history = reviewer.loadHistory();
  const reports = written.map(chapter => {
    const report = history.find(r => r.chapter === chapter.order);
    const current = !!report && !!project && !!meta && isReviewCurrent(report, chapter.content, reviewer.buildContext(chapter.order, {
      source: { title: project.title, description: project.description, genre: meta.genre, style: meta.style, language: meta.language }, chapters, outline: chapter.outline,
    }));
    return { chapter, report, current };
  });
  const needsRevision = reports.filter(r => r.current && r.report?.status === 'needs-revision');
  const waiting = reports.filter(r => !r.current);
  const due = getDueForeshadowing(repo.loadForeshadowing(), lastWrittenChapter(chapters));
  const characters = repo.getCharacters();

  return (
    <div data-testid="narrative-dashboard" style={{ height: '100%', overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Text strong>{t('workbench.manuscript.title')}</Text>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        <Card size="small"><Text type="secondary">{t('workbench.manuscript.written')}</Text><div><Text strong>{written.length}</Text> / {chapters.length}</div></Card>
        <Card size="small"><Text type="secondary">{t('workbench.manuscript.characters')}</Text><div><Text strong>{written.reduce((n, c) => n + c.content.length, 0).toLocaleString()}</Text></div></Card>
      </div>
      <Card size="small" title={t('workbench.manuscript.review')} extra={<Button size="small" onClick={() => onOpen('chapterReview')}>{t('workbench.manuscript.openReview')}</Button>}>
        <Space wrap><Tag>{t('workbench.manuscript.waiting', { count: waiting.length })}</Tag><Tag color={needsRevision.length ? 'warning' : 'default'}>{t('workbench.manuscript.revision', { count: needsRevision.length })}</Tag></Space>
        <p><Text type="secondary">{t('novel.editor.reviewLimit')}</Text></p>
        {!written.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workbench.manuscript.empty')} /> : reports.map(({ chapter, report, current }) => (
          <div key={chapter.id} style={{ borderTop: '1px solid var(--border-secondary)', padding: '8px 0' }}>
            <Button type="link" size="small" onClick={() => onOpen('chapterReview', chapter.order)} style={{ padding: 0, maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', height: 'auto' }}>
              {t('novel.chapterOrder', { order: chapter.order + 1 })} · {chapter.title}
            </Button>
            <p style={{ margin: '6px 0' }}><Tag>{t(!report ? 'workbench.manuscript.unreviewed' : !current ? 'novel.editor.reviewStale' : report.status === 'needs-revision' ? 'novel.editor.needsRevision' : 'novel.editor.reviewed')}</Tag></p>
            {current && report && <Text style={{ fontSize: 12 }}>{report.findings[0]?.problem || report.summary}</Text>}
          </div>
        ))}
      </Card>
      <Card size="small" title={t('workbench.manuscript.reference')}>
        <p><Text>{t('workbench.manuscript.bibleCount', { count: characters.length })}</Text></p>
        <p><Text type="secondary">{t('workbench.manuscript.referenceHint')}</Text></p>
        <Button size="small" onClick={() => onOpen('bible')}>{t('workbench.tab.bible')}</Button>
      </Card>
      <Card size="small" title={t('workbench.manuscript.foreshadow')} extra={<Button size="small" onClick={() => onOpen('foreshadow')}>{t('workbench.manuscript.openLedger')}</Button>}>
        {due.length ? due.map(f => <p key={f.id}>{f.description}</p>) : <Text type="secondary">{t('workbench.manuscript.noDue')}</Text>}
        <p><Text type="secondary">{t('workbench.manuscript.dueHint')}</Text></p>
      </Card>
    </div>
  );
};
export default NarrativeDashboard;

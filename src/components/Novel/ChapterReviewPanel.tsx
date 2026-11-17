import React, { useEffect, useMemo, useState } from 'react';
import { Typography, Card, Empty, Button, Tag, Select, message } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { ChapterReviewer, type ChapterReviewReport } from '@/services/novel/chapter-reviewer';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { isReviewCurrent } from '@/services/novel/editorial-review';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelMetadata } from '@/types';
import { getNovelChapters, WRITING_REFERENCE_KEYS } from '@/services/novel/writing-context';

const { Text } = Typography;

const ChapterReviewPanel: React.FC<{ novelId: string; chapterIndex?: number; onSelectChapter?: (index: number) => void }> = ({ novelId, chapterIndex, onSelectChapter }) => {
  const { t } = useTranslation();
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const reviewer = useMemo(() => new ChapterReviewer(novelId), [novelId]);
  const [history, setHistory] = useState<ChapterReviewReport[]>(() => reviewer.loadHistory());
  const [, refreshReference] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState(chapterIndex);
  useEffect(() => { setSelectedChapter(chapterIndex); }, [chapterIndex]);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === novelId));
  const novelMeta = project?.metadata as NovelMetadata | undefined;
  const chapters = useMemo(() => novelMeta ? getNovelChapters(novelMeta) : [], [novelMeta]);
  const contentChapters = chapters.filter(c => c.content.trim());
  const selected = chapters.find(c => c.order === selectedChapter) ?? contentChapters[contentChapters.length - 1];
  const latestReview = history.find(r => r.chapter === selected?.order);
  const selectChapter = (index: number) => { setSelectedChapter(index); onSelectChapter?.(index); };

  useEffect(() => {
    setHistory(reviewer.loadHistory());
    return repo.subscribe(WRITING_REFERENCE_KEYS, () => {
      setHistory(reviewer.loadHistory());
      refreshReference(value => value + 1);
    });
  }, [repo, reviewer]);

  const contextFor = (chapter: typeof chapters[number]) => ({
    source: { title: project!.title, description: project!.description, genre: novelMeta!.genre, style: novelMeta!.style, language: novelMeta!.language },
    chapters, outline: chapter.outline,
  });
  const isCurrent = (report: ChapterReviewReport) => {
    const chapter = chapters.find(c => c.order === report.chapter);
    return !!chapter && !!project && !!novelMeta && isReviewCurrent(report, chapter.content, reviewer.buildContext(chapter.order, contextFor(chapter)));
  };
  const statusLabel = (report: ChapterReviewReport) => !isCurrent(report) ? 'novel.editor.reviewStale'
    : report.status === 'needs-revision' ? 'novel.editor.needsRevision' : 'novel.editor.reviewed';

  const handleReview = async () => {
    const chapter = selected;
    if (!chapter || !project || !novelMeta) return;
    setLoading(true);
    try {
      await reviewer.reviewChapter(chapter.order, chapter.content, contextFor(chapter));
    } catch (error) { message.error(t('novel.editor.reviewFailed') + ': ' + String(error)); }
    finally { setLoading(false); }
  };

  return (
    <div data-testid="chapter-review-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><AuditOutlined style={{ marginRight: 6 }} />{t('chapterReview.title')}</span>
        <Button size="small" type="primary" onClick={handleReview} loading={loading} disabled={!selected?.content.trim()}>
          {t('chapterReview.runReview')}
        </Button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <Select aria-label={t('workbench.review.selectChapter')} value={selected?.order} onChange={selectChapter} disabled={loading}
          style={{ width: '100%' }} options={chapters.map(c => ({ value: c.order, label: t('novel.chapterOrder', { order: c.order + 1 }) + ' · ' + c.title }))} />
        <p><Text type="secondary">{t('novel.editor.reviewLimit')}</Text></p>
        {!latestReview ? <Empty description={t('chapterReview.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Text>{t('chapterReview.chapterN', { chapter: latestReview.chapter + 1 })}</Text>
              <p style={{ margin: '6px 0' }}><Tag color={isCurrent(latestReview) && latestReview.status === 'needs-revision' ? 'warning' : 'default'}>{t(statusLabel(latestReview))}</Tag></p>
            </div>
            <Card size="small"><Text>{latestReview.summary}</Text></Card>
            {latestReview.findings.map((finding, index) => (
              <Card size="small" key={index}>
                <Tag color={finding.severity === 'critical' ? 'error' : finding.severity === 'major' ? 'warning' : 'default'}>{t('novel.editor.severity.' + finding.severity)}</Tag>
                <p><strong>{finding.problem}</strong></p>
                <blockquote style={{ margin: '8px 0', borderLeft: '2px solid var(--border-secondary)', paddingLeft: 10, whiteSpace: 'pre-wrap' }}>{finding.quote}</blockquote>
                {finding.referenceQuote && <p><Text type="secondary">{t('novel.editor.reference')}: {finding.referenceQuote}</Text></p>}
                <p>{finding.suggestion}</p>
              </Card>
            ))}
            {history.length > 1 && <Card size="small" title={t('chapterReview.history')}>
              {[...history].sort((a, b) => a.chapter - b.chapter).slice(-10).map(report => (
                <p key={report.chapter}><Button type="link" size="small" onClick={() => selectChapter(report.chapter)}>{t('novel.chapterOrder', { order: report.chapter + 1 })}</Button> · {t(statusLabel(report))}</p>
              ))}
            </Card>}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChapterReviewPanel;

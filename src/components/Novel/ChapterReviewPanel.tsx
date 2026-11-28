import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Typography, Card, Collapse, Empty, Button, Tag, Select, Space, Input } from 'antd';
import { AuditOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { ChapterReviewer, type ChapterReviewReport, type ChapterReviewStage } from '@/services/novel/chapter-reviewer';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { isReviewCurrent } from '@/services/novel/editorial-review';
import { readSavedChapterForReview, useProjectStore } from '@/stores/projectStore';
import { useProviderStore } from '@/stores/providerStore';
import type { NovelMetadata } from '@/types';
import { getNovelChapters, WRITING_REFERENCE_KEYS } from '@/services/novel/writing-context';

const { Text } = Typography;

const ChapterReviewPanel: React.FC<{ novelId: string; chapterIndex?: number; onSelectChapter?: (index: number) => void }> = ({ novelId, chapterIndex, onSelectChapter }) => {
  const { t } = useTranslation();
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const reviewer = useMemo(() => new ChapterReviewer(novelId), [novelId]);
  const [history, setHistory] = useState<ChapterReviewReport[]>(() => reviewer.loadHistory());
  const [, refreshReference] = useState(0);
  const [stage, setStage] = useState<ChapterReviewStage | null>(null);
  const [notice, setNotice] = useState<{ text: string; type: 'success' | 'warning' }>();
  const [revisionFocus, setRevisionFocus] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const hasEndpoint = useProviderStore(s => s.endpoints.some(e => e.enabled && e.category === 'llm'));
  const loading = stage !== null;
  const [selectedChapter, setSelectedChapter] = useState(chapterIndex);
  useEffect(() => { setSelectedChapter(chapterIndex); setNotice(undefined); }, [chapterIndex]);
  const project = useProjectStore((s) => s.projects.find((p) => p.id === novelId));
  const novelMeta = project?.metadata as NovelMetadata | undefined;
  const chapters = useMemo(() => novelMeta ? getNovelChapters(novelMeta) : [], [novelMeta]);
  const contentChapters = chapters.filter(c => c.content.trim());
  const selected = chapters.find(c => c.order === selectedChapter) ?? contentChapters[contentChapters.length - 1];
  const selectedId = selected?.id;
  useEffect(() => { setRevisionFocus(''); }, [selectedId]);
  const latestReview = history.find(r => r.chapter === selected?.order);
  const selectChapter = (index: number) => { setSelectedChapter(index); onSelectChapter?.(index); };

  useEffect(() => {
    setHistory(reviewer.loadHistory());
    return repo.subscribe(WRITING_REFERENCE_KEYS, () => {
      setHistory(reviewer.loadHistory());
      refreshReference(value => value + 1);
    });
  }, [repo, reviewer]);

  useEffect(() => {
    if (selectedId) return repo.subscribe([
      'chapter-revision-candidate:' + selectedId,
      'chapter-revision-pending:' + selectedId,
    ], () => refreshReference(value => value + 1));
  }, [repo, selectedId]);

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
  const selectedReference = selected && project && novelMeta ? reviewer.buildContext(selected.order, contextFor(selected)) : undefined;
  const pendingRevision = selected && selectedReference !== undefined
    ? reviewer.loadPendingRevision(selected.id, selected.content, selectedReference) : null;
  const candidateReview = selected && selectedReference !== undefined
    ? reviewer.loadCurrentRevisionCandidate(selected.id, selected.content, selectedReference)?.review : undefined;
  const hasPendingCandidate = candidateReview?.status === 'needs-revision';
  const renderFindings = (report: ChapterReviewReport) => report.findings.map((finding, index) => (
    <Card size="small" key={index}>
      <Tag color={finding.basis === 'uncertain' ? 'default' : finding.severity === 'critical' ? 'error' : finding.severity === 'major' ? 'warning' : 'default'}>
        {t(finding.basis === 'uncertain' ? 'novel.editor.evidencePending' : 'novel.editor.severity.' + finding.severity)}
      </Tag>
      <p><strong>{finding.problem}</strong></p>
      <blockquote style={{ margin: '8px 0', borderLeft: '2px solid var(--border-secondary)', paddingLeft: 10, whiteSpace: 'pre-wrap' }}>{finding.quote}</blockquote>
      {finding.referenceQuote && <p><Text type="secondary">{t('novel.editor.reference')}: {finding.referenceQuote}</Text></p>}
      <p>{finding.suggestion}</p>
    </Card>
  ));

  const stopReview = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStage(null);
  };

  const handleReview = async (revise: boolean, resume = false) => {
    if (!selected || controllerRef.current) return;
    const current = () => readSavedChapterForReview(novelId, selected.id);
    const target = current();
    if (!target?.chapter.content.trim()) return;
    if (resume && !reviewer.loadPendingRevision(selected.id, target.chapter.content, reviewer.buildContext(target.chapter.order, target.context))) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    let currentStage: ChapterReviewStage = 'reviewingProse';
    setNotice(undefined);
    setStage(currentStage);
    try {
      const result = await reviewer.reviewDraft(target, {
        current, reuseReview: revise, signal: controller.signal,
        revisionFocus: revise && !resume ? revisionFocus : undefined,
        onStage: next => { currentStage = next; setStage(next); },
        applyRevision: revise ? content => useProjectStore.getState().updateStoryNode(novelId, selected.id,
          { content, wordCount: content.length, status: 'drafting' }) : undefined,
      });
      if (controller.signal.aborted) return;
      if (result.revised) setNotice({ type: 'success', text: t('novel.editor.autoRevisionApplied') });
      else if (revise && result.report.status === 'needs-revision') setNotice({ type: 'warning', text: t('novel.editor.autoRevisionRetained') });
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        setNotice({ type: 'warning', text: t(currentStage === 'reviewingProse' ? 'novel.editor.proseReviewRetry' : 'novel.editor.autoRevisionFailed', { detail }) });
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setStage(null);
      }
    }
  };

  return (
    <div data-testid="chapter-review-panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><AuditOutlined style={{ marginRight: 6 }} />{t('chapterReview.title')}</span>
        {loading ? <Space wrap>
          <Text type="secondary" role="status">{t('novel.editor.' + stage)}</Text>
          <Button size="small" onClick={stopReview}>{t('novel.stopGeneration')}</Button>
        </Space> : <Space wrap>
          <Button size="small" onClick={() => void handleReview(false)} disabled={!hasEndpoint || !selected?.content.trim()}>
            {t('chapterReview.runReview')}
          </Button>
          <Button size="small" type="primary" onClick={() => void handleReview(true)} disabled={!hasEndpoint || !selected?.content.trim()}>
            {t('chapterReview.reviewAndRevise')}
          </Button>
        </Space>}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <Select aria-label={t('workbench.review.selectChapter')} value={selected?.order} onChange={selectChapter} disabled={loading}
          style={{ width: '100%' }} options={chapters.map(c => ({ value: c.order, label: t('novel.chapterOrder', { order: c.order + 1 }) + ' · ' + c.title }))} />
        {pendingRevision && !loading && <Alert showIcon type="info" style={{ marginTop: 8 }}
          message={t('chapterReview.revisionReady')}
          action={<Button size="small" disabled={!hasEndpoint} onClick={() => void handleReview(true, true)}>{t('chapterReview.resumeRevision')}</Button>} />}
        <p><Text type="secondary">{t('novel.editor.reviewLimit')}</Text></p>
        {selected?.content.trim() && <Collapse size="small" style={{ marginBottom: 8 }} items={[{
          key: 'focus', label: t('chapterReview.revisionFocus'),
          children: <Input.TextArea data-testid="chapter-revision-focus" aria-label={t('chapterReview.revisionFocus')}
            value={revisionFocus} onChange={event => setRevisionFocus(event.target.value)} disabled={loading}
            maxLength={1500} autoSize={{ minRows: 2, maxRows: 6 }} />,
        }]} />}
        {notice && <Alert showIcon type={notice.type} message={notice.text} />}
        {!latestReview ? <Empty description={t('chapterReview.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {hasPendingCandidate && <Collapse size="small" key={selectedId} defaultActiveKey={['candidate']} items={[{
              key: 'candidate', label: t('chapterReview.pendingCandidate'),
              children: <div data-testid="chapter-revision-findings" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Text type="secondary">{t('chapterReview.pendingCandidateHelp')}</Text>
                {renderFindings(candidateReview)}
              </div>,
            }]} />}
            <div>
              <Text>{t('chapterReview.chapterN', { chapter: latestReview.chapter + 1 })}</Text>
              <p style={{ margin: '6px 0' }}><Tag color={isCurrent(latestReview) && latestReview.status === 'needs-revision' ? 'warning' : 'default'}>{t(statusLabel(latestReview))}</Tag></p>
            </div>
            <Card size="small"><Text>{latestReview.summary}</Text></Card>
            {renderFindings(latestReview)}
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

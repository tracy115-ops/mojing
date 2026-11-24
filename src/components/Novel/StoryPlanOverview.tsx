import React, { useEffect, useMemo, useState } from 'react';
import { Card, Collapse, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { AuthorPlotOutline } from '@/services/novel/writing-context';
import type { NovelReference } from '@/services/novel/novel-reference';

const { Paragraph, Text } = Typography;

const StoryPlanOverview: React.FC<{ novelId: string }> = ({ novelId }) => {
  const { t } = useTranslation();
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const load = (): AuthorPlotOutline | null => {
    const plot = repo.loadCustomData<AuthorPlotOutline | null>('plot-outline', null);
    if (plot) return plot;
    const global = repo.loadGlobalPlan();
    if (global) return { ...global, stages: (global.chapters || []).map(chapter => ({ name: chapter.title,
      chapterRange: t('novel.chapterOrder', { order: chapter.order + 1 }), description: chapter.outline,
      coreEvent: (chapter.keyEvents || []).join('；') })) };
    const legacy = repo.loadBible().timelineNotes.find(note => note.id === 'plot-outline');
    return legacy ? { mainPlot: legacy.event, coreConflict: legacy.significance } : null;
  };
  const [plot, setPlot] = useState<AuthorPlotOutline | null>(load);
  const [reference, setReference] = useState<NovelReference | null>(() => repo.loadCustomData('novel-reference', null));
  useEffect(() => {
    const refresh = () => { setPlot(load()); setReference(repo.loadCustomData('novel-reference', null)); };
    refresh();
    return repo.subscribe(['plot-outline', 'novel-reference', 'global-plan', 'bible'], refresh);
  }, [repo, t]);
  return <>
    {reference && <Collapse size="small" data-testid="story-plan-reference" style={{ marginTop: 8 }} items={[{
      key: 'reference', label: t('novelReference.guide'),
      children: <>
        <Text type="secondary">{reference.sourceName && `${reference.sourceName} · `}
          {t(reference.mode === 'style' ? 'novelReference.style' : 'novelReference.rewrite')} · {t('novel.wordCount', { count: reference.sourceCharacters.toLocaleString() })}</Text>
        <Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{reference.guide}</Paragraph>
      </>,
    }]} />}
    {plot && <Card data-testid="story-plan-overview" size="small" title={t('storyPlan.title')} style={{ marginTop: 8 }}>
    <Paragraph type="secondary">{t('storyPlan.note')}</Paragraph>
    <Collapse size="small" defaultActiveKey={['main']} items={[
      { key: 'main', label: t('wizard.mainPlot'), children: <>
        <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{plot.mainPlot}</Paragraph>
        {plot.coreConflict && <Paragraph><Text strong>{t('storyPlan.conflict')}：</Text>{plot.coreConflict}</Paragraph>}
        {plot.themeMessage && <Paragraph><Text strong>{t('storyPlan.theme')}：</Text>{plot.themeMessage}</Paragraph>}
      </> },
      { key: 'stages', label: t('storyPlan.stages', { count: plot.stages?.length || 0 }), children: plot.stages?.length
        ? plot.stages.map((stage, index) => <Card size="small" key={index} title={`${stage.name || t('storyPlan.stage', { index: index + 1 })} ${stage.chapterRange || ''}`} style={{ marginBottom: 8 }}>
          <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{stage.description}</Paragraph>
          {stage.coreEvent && <Paragraph><Text strong>{t('storyPlan.event')}：</Text>{stage.coreEvent}</Paragraph>}
          {!!stage.foreshadowSeeds?.length && <Paragraph><Text strong>{t('storyPlan.seeds')}：</Text>{stage.foreshadowSeeds.join('；')}</Paragraph>}
        </Card>) : <Text type="secondary">{t('storyPlan.legacy')}</Text> },
      { key: 'ending', label: t('wizard.ending'), children: <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{plot.ending || t('storyPlan.legacy')}</Paragraph> },
    ]} />
    </Card>}
  </>;
};

export default StoryPlanOverview;

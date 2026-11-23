import React, { useEffect, useMemo, useState } from 'react';
import { Card, Collapse, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { AuthorPlotOutline } from '@/services/novel/writing-context';

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
  useEffect(() => { setPlot(load()); return repo.subscribe(['plot-outline', 'global-plan', 'bible'], () => setPlot(load())); }, [repo, t]);
  if (!plot) return null;
  return <Card data-testid="story-plan-overview" size="small" title={t('storyPlan.title')} style={{ marginTop: 8 }}>
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
  </Card>;
};

export default StoryPlanOverview;

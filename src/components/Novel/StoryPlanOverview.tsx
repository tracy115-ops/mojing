import React, { useEffect, useMemo, useState } from 'react';
import { Card, Collapse, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { buildWritingContext, getNovelChapters, type AuthorPlotOutline, type ChapterMemory } from '@/services/novel/writing-context';
import { readStoryPlanSection, writeStoryPlanSection, type StoryPlanSectionId, type StoryPlanText } from '@/services/novel/story-plan-section';
import type { NovelReference } from '@/services/novel/novel-reference';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelMetadata } from '@/types';
import StoryPlanSectionEditor from './StoryPlanSectionEditor';

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

  const reviewContext = (id: StoryPlanSectionId, draft: StoryPlanText) => {
    const project = useProjectStore.getState().projects.find(item => item.id === novelId && item.type === 'novel');
    const current = load();
    const text = current && readStoryPlanSection(current, id);
    if (!project || !current || !text) throw new Error(t('storyPlan.changed'));
    const meta = project.metadata as NovelMetadata;
    const chapters = getNovelChapters(meta);
    const nextChapter = (chapters[chapters.length - 1]?.order ?? -1) + 1;
    const omitted = Object.fromEntries(Object.keys(text).map(field => [field, '']));
    return buildWritingContext({
      title: project.title, description: project.description, genre: meta.genre, style: meta.style, language: meta.language,
    }, repo.loadBible(), chapters, nextChapter, repo.loadCustomData<ChapterMemory[]>('chapter-reviews', []), 'review', {
      ...repo.loadWritingReferences(), plotOutline: writeStoryPlanSection(current, id, omitted),
    }, Object.values(draft).join('\n'));
  };

  const saveSection = (id: StoryPlanSectionId, before: StoryPlanText, after: StoryPlanText) => {
    const current = load();
    if (!current || JSON.stringify(readStoryPlanSection(current, id)) !== JSON.stringify(before)) throw new Error(t('storyPlan.changed'));
    const next = writeStoryPlanSection(current, id, after);
    repo.saveCustomData('plot-outline', next);
    if (JSON.stringify(repo.loadCustomData('plot-outline', null)) !== JSON.stringify(next)) throw new Error(t('storyPlan.saveFailed'));
  };

  const editSection = (id: StoryPlanSectionId, title: string, body: React.ReactNode) => {
    const text = plot && readStoryPlanSection(plot, id);
    return text && <StoryPlanSectionEditor title={title} text={text} readContext={draft => reviewContext(id, draft)}
      save={(before, after) => saveSection(id, before, after)}>{body}</StoryPlanSectionEditor>;
  };

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
      { key: 'main', label: t('wizard.mainPlot'), children: editSection('main', t('wizard.mainPlot'), <>
        <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{plot.mainPlot}</Paragraph>
        {plot.coreConflict && <Paragraph><Text strong>{t('storyPlan.conflict')}：</Text>{plot.coreConflict}</Paragraph>}
        {plot.themeMessage && <Paragraph><Text strong>{t('storyPlan.theme')}：</Text>{plot.themeMessage}</Paragraph>}
      </>) },
      { key: 'stages', label: t('storyPlan.stages', { count: plot.stages?.length || 0 }), children: plot.stages?.length
        ? plot.stages.map((stage, index) => {
          const title = stage.name || t('storyPlan.stage', { index: index + 1 });
          return <Card size="small" key={index + ':' + title + ':' + (stage.chapterRange || '')} title={[title, stage.chapterRange].filter(Boolean).join(' ')} className="story-plan__stage">
            {editSection(index, title, <>
              <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{stage.description}</Paragraph>
              {stage.coreEvent && <Paragraph><Text strong>{t('storyPlan.event')}：</Text>{stage.coreEvent}</Paragraph>}
              {!!stage.foreshadowSeeds?.length && <Paragraph><Text strong>{t('storyPlan.seeds')}：</Text>{stage.foreshadowSeeds.join('；')}</Paragraph>}
            </>)}
          </Card>;
        }) : <Text type="secondary">{t('storyPlan.legacy')}</Text> },
      { key: 'ending', label: t('wizard.ending'), children: editSection('ending', t('wizard.ending'),
        <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{plot.ending || t('storyPlan.legacy')}</Paragraph>) },
    ]} />
    </Card>}
  </>;
};

export default StoryPlanOverview;

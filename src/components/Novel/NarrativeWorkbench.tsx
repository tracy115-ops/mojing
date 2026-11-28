import React, { useMemo, useState, useEffect } from 'react';
import { Button, Tabs } from 'antd';
import {
  DashboardOutlined, BookOutlined, AimOutlined, ToolOutlined,
  MessageOutlined, GlobalOutlined, BranchesOutlined, TeamOutlined,
  AuditOutlined, HistoryOutlined, NodeIndexOutlined, AppstoreOutlined,
  UsergroupDeleteOutlined, RocketOutlined, SettingOutlined,
  FullscreenOutlined, FullscreenExitOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';
import NarrativeDashboard from './NarrativeDashboard';
import StoryBiblePanel from './StoryBiblePanel';
import ForeshadowLedgerPanel from './ForeshadowLedgerPanel';
import PropsPanel from './PropsPanel';
import AntiAIDashboard from './AntiAIDashboard';
import DialogueGeneratorPanel from './DialogueGeneratorPanel';
import WorldbuildingPanel from './WorldbuildingPanel';
import StorylinePanel from './StorylinePanel';
import CastPanel from './CastPanel';
import CheckpointTimeline from './CheckpointTimeline';
import CharacterRelationGraph from './CharacterRelationGraph';
import KnowledgeGraphView from './KnowledgeGraphView';
import ChapterReviewPanel from './ChapterReviewPanel';
import AutopilotPipelineView from './AutopilotPipelineView';

interface NarrativeWorkbenchProps {
  novelId: string;
  totalChapters: number;
  chapterIndex: number;
  expanded: boolean;
  narrow: boolean;
  onToggleExpanded: () => void;
  onSelectChapter: (index: number) => void;
}

type Category = 'overview' | 'characters' | 'plot' | 'quality' | 'tools';
const CATEGORY_ICONS = {
  overview: <AppstoreOutlined />, characters: <TeamOutlined />, plot: <BranchesOutlined />,
  quality: <AuditOutlined />, tools: <SettingOutlined />,
};

const NarrativeWorkbench: React.FC<NarrativeWorkbenchProps> = ({
  novelId, totalChapters, chapterIndex, onSelectChapter, expanded, narrow, onToggleExpanded,
}) => {
  const { t } = useTranslation();
  const [category, setCategory] = useState<Category>('overview');
  const [subTab, setSubTab] = useState('dashboard');
  const autopilotStatus = useAutopilotStore(s => s.states[novelId]?.status);
  useEffect(() => {
    if (autopilotStatus === 'running') { setCategory('tools'); setSubTab('autopilotPipeline'); }
  }, [autopilotStatus]);

  const open = (key: 'chapterReview' | 'bible' | 'foreshadow', index?: number) => {
    if (index !== undefined) onSelectChapter(index);
    setCategory(key === 'chapterReview' ? 'quality' : key === 'bible' ? 'overview' : 'plot');
    setSubTab(key);
  };

  const categoryTabs = useMemo(() => ({
    overview: [
      { key: 'dashboard', icon: <DashboardOutlined />, content: <NarrativeDashboard novelId={novelId} onOpen={open} /> },
      { key: 'bible', icon: <BookOutlined />, content: <StoryBiblePanel novelId={novelId} /> },
    ],
    characters: [
      { key: 'cast', icon: <TeamOutlined />, content: <CastPanel novelId={novelId} totalChapters={totalChapters} currentChapter={chapterIndex} onOpenBible={() => open('bible')} /> },
      { key: 'relationGraph', icon: <UsergroupDeleteOutlined />, content: <CharacterRelationGraph novelId={novelId} /> },
      { key: 'dialogue', icon: <MessageOutlined />, content: <DialogueGeneratorPanel novelId={novelId} chapterIndex={chapterIndex} /> },
    ],
    plot: [
      { key: 'storyline', icon: <BranchesOutlined />, content: <StorylinePanel novelId={novelId} totalChapters={totalChapters} /> },
      { key: 'foreshadow', icon: <AimOutlined />, content: <ForeshadowLedgerPanel novelId={novelId} chapterIndex={chapterIndex} /> },
      { key: 'worldbuilding', icon: <GlobalOutlined />, content: <WorldbuildingPanel novelId={novelId} /> },
      { key: 'props', icon: <ToolOutlined />, content: <PropsPanel novelId={novelId} /> },
      { key: 'knowledgeGraph', icon: <NodeIndexOutlined />, content: <KnowledgeGraphView novelId={novelId} /> },
    ],
    quality: [
      { key: 'chapterReview', icon: <AuditOutlined />, content: <ChapterReviewPanel novelId={novelId} chapterIndex={chapterIndex} onSelectChapter={onSelectChapter} /> },
      { key: 'audit', icon: <BookOutlined />, content: <AntiAIDashboard novelId={novelId} chapterIndex={chapterIndex} /> },
    ],
    tools: [
      { key: 'checkpoint', icon: <HistoryOutlined />, content: <CheckpointTimeline novelId={novelId} /> },
      { key: 'autopilotPipeline', icon: <RocketOutlined />, content: <AutopilotPipelineView novelId={novelId} /> },
    ],
  }), [novelId, totalChapters, chapterIndex, onSelectChapter]);
  const currentTabs = categoryTabs[category];
  const activeKey = currentTabs.some(tab => tab.key === subTab) ? subTab : currentTabs[0].key;

  return (
    <div data-testid="narrative-workbench" style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="narrative-workbench__toolbar">
        <div className="narrative-workbench__categories">
        {(Object.keys(categoryTabs) as Category[]).map(key => (
          <button key={key} data-workbench-category={key} aria-pressed={category === key}
            onClick={() => { setCategory(key); setSubTab(''); }}
            style={{ padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer',
              fontWeight: category === key ? 600 : 400, color: category === key ? 'var(--accent-primary)' : 'var(--text-secondary)',
              background: category === key ? 'var(--bg-active)' : 'transparent', border: 'none',
              borderBottom: `2px solid ${category === key ? 'var(--accent-primary)' : 'transparent'}` }}>
            {CATEGORY_ICONS[key]} {t('workbench.category.' + key)}
          </button>
        ))}
        </div>
        <Button size="small" data-testid="novel-workbench-expand"
          aria-pressed={narrow ? undefined : expanded}
          icon={expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          onClick={onToggleExpanded}>
          {t(narrow ? 'novel.backToChapterEditor' : expanded ? 'workbench.restoreSplit' : 'workbench.expand')}
        </Button>
      </div>
      <Tabs className="narrative-workbench-tabs" activeKey={activeKey} onChange={setSubTab}
        items={currentTabs.map(tab => ({ key: tab.key, label: <span>{tab.icon} {t('workbench.tab.' + tab.key)}</span>, children: tab.content }))}
        size="small" style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
        tabBarStyle={{ padding: '0 8px', marginBottom: 0 }} tabBarGutter={12} />
    </div>
  );
};

export default NarrativeWorkbench;

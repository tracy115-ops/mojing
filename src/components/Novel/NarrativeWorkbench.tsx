// ============================================================================
// Narrative Workbench — Grouped tab container for all narrative engine panels
// Tabs organized into 5 categories for better discoverability
// ============================================================================

import React, { useMemo, useState, useEffect } from 'react';
import { Tabs, Typography, Space, Button, Select, Tooltip } from 'antd';
import {
  DashboardOutlined, BookOutlined, LineChartOutlined,
  AimOutlined, SafetyCertificateOutlined, ToolOutlined,
  ExperimentOutlined, FlagOutlined, SafetyOutlined,
  MessageOutlined, GlobalOutlined, BranchesOutlined, TeamOutlined,
  AuditOutlined, SoundOutlined, HistoryOutlined, ControlOutlined,
  ApartmentOutlined, EyeOutlined, EditOutlined, BulbOutlined,
  UserOutlined, NodeIndexOutlined, AppstoreOutlined,
  UsergroupDeleteOutlined, RocketOutlined, SettingOutlined,
  ExpandOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';
import NarrativeDashboard from './NarrativeDashboard';
import StoryBiblePanel from './StoryBiblePanel';
import TensionChartPanel from './TensionChartPanel';
import ForeshadowLedgerPanel from './ForeshadowLedgerPanel';
import GovernanceCockpit from './GovernanceCockpit';
import PropsPanel from './PropsPanel';
import StoryPhaseEvolutionPanel from './StoryPhaseEvolutionPanel';
import AntiAIDashboard from './AntiAIDashboard';
import DialogueGeneratorPanel from './DialogueGeneratorPanel';
import WorldbuildingPanel from './WorldbuildingPanel';
import StorylinePanel from './StorylinePanel';
import CastPanel from './CastPanel';
import QualityGuardrailPanel from './QualityGuardrailPanel';
import ConsistencyReportPanel from './ConsistencyReportPanel';
import VoiceDriftIndicator from './VoiceDriftIndicator';
import CheckpointTimeline from './CheckpointTimeline';
import HolographicChronicles from './HolographicChronicles';
import WorldlineDAG from './WorldlineDAG';
import AuditPipeline from './AuditPipeline';
import WritingStream from './WritingStream';
import PromptPlaza from './PromptPlaza';
import CharacterRelationGraph from './CharacterRelationGraph';
import KnowledgeGraphView from './KnowledgeGraphView';
import ReaderSimulationPanel from './ReaderSimulationPanel';
import ChapterReviewPanel from './ChapterReviewPanel';
import AutopilotPipelineView from './AutopilotPipelineView';

const { Text } = Typography;

interface NarrativeWorkbenchProps {
  novelId: string;
  totalChapters: number;
  currentChapter: number;
}

// Category definitions
type Category = 'overview' | 'characters' | 'plot' | 'quality' | 'tools';

const CATEGORY_META: Record<Category, { icon: React.ReactNode; color: string }> = {
  overview: { icon: <AppstoreOutlined />, color: '#3b82f6' },
  characters: { icon: <TeamOutlined />, color: '#f59e0b' },
  plot: { icon: <RocketOutlined />, color: '#ef4444' },
  quality: { icon: <SafetyCertificateOutlined />, color: '#22c55e' },
  tools: { icon: <SettingOutlined />, color: '#8b5cf6' },
};

const NarrativeWorkbench: React.FC<NarrativeWorkbenchProps> = ({
  novelId, totalChapters, currentChapter,
}) => {
  const { t } = useTranslation();
  const [category, setCategory] = useState<Category>('overview');
  const [subTab, setSubTab] = useState<string>('');

  // Auto-switch to Pipeline tab when autopilot starts running
  const autopilotState = useAutopilotStore((s) => s.states[novelId]);
  useEffect(() => {
    if (autopilotState?.status === 'running') {
      setCategory('tools');
      setSubTab('autopilotPipeline');
    }
  }, [autopilotState?.status]);

  const sharedProps = { novelId, totalChapters, currentChapter };

  // All sub-tabs organized by category
  const categoryTabs: Record<Category, { key: string; label: string; icon: React.ReactNode; content: React.ReactNode }[]> = useMemo(() => ({
    overview: [
      { key: 'dashboard', label: t('workbench.tab.dashboard'), icon: <DashboardOutlined />, content: <NarrativeDashboard {...sharedProps} /> },
      { key: 'bible', label: t('workbench.tab.bible'), icon: <BookOutlined />, content: <StoryBiblePanel novelId={novelId} /> },
      { key: 'governance', label: t('workbench.tab.governance'), icon: <SafetyCertificateOutlined />, content: <GovernanceCockpit novelId={novelId} /> },
      { key: 'phase', label: t('workbench.tab.phase'), icon: <FlagOutlined />, content: <StoryPhaseEvolutionPanel {...sharedProps} /> },
    ],
    characters: [
      { key: 'cast', label: t('workbench.tab.cast'), icon: <TeamOutlined />, content: <CastPanel {...sharedProps} /> },
      { key: 'relationGraph', label: t('workbench.tab.relationGraph'), icon: <UsergroupDeleteOutlined />, content: <CharacterRelationGraph novelId={novelId} /> },
      { key: 'dialogue', label: t('workbench.tab.dialogue'), icon: <MessageOutlined />, content: <DialogueGeneratorPanel novelId={novelId} /> },
    ],
    plot: [
      { key: 'tension', label: t('workbench.tab.tension'), icon: <LineChartOutlined />, content: <TensionChartPanel novelId={novelId} /> },
      { key: 'foreshadow', label: t('workbench.tab.foreshadow'), icon: <AimOutlined />, content: <ForeshadowLedgerPanel novelId={novelId} /> },
      { key: 'storyline', label: t('workbench.tab.storyline'), icon: <BranchesOutlined />, content: <StorylinePanel {...sharedProps} /> },
      { key: 'worldbuilding', label: t('workbench.tab.worldbuilding'), icon: <GlobalOutlined />, content: <WorldbuildingPanel novelId={novelId} /> },
      { key: 'props', label: t('workbench.tab.props'), icon: <ToolOutlined />, content: <PropsPanel novelId={novelId} /> },
      { key: 'knowledgeGraph', label: t('workbench.tab.knowledgeGraph'), icon: <NodeIndexOutlined />, content: <KnowledgeGraphView novelId={novelId} /> },
    ],
    quality: [
      { key: 'consistency', label: t('workbench.tab.consistency'), icon: <AuditOutlined />, content: <ConsistencyReportPanel novelId={novelId} /> },
      { key: 'guardrail', label: t('workbench.tab.guardrail'), icon: <ControlOutlined />, content: <QualityGuardrailPanel novelId={novelId} /> },
      { key: 'drift', label: t('workbench.tab.drift'), icon: <SoundOutlined />, content: <VoiceDriftIndicator novelId={novelId} /> },
      { key: 'readerSim', label: t('workbench.tab.readerSim'), icon: <UserOutlined />, content: <ReaderSimulationPanel novelId={novelId} /> },
      { key: 'chapterReview', label: t('workbench.tab.chapterReview'), icon: <AuditOutlined />, content: <ChapterReviewPanel novelId={novelId} /> },
      { key: 'audit', label: t('workbench.tab.audit'), icon: <SafetyOutlined />, content: <AntiAIDashboard novelId={novelId} /> },
    ],
    tools: [
      { key: 'writing', label: t('workbench.tab.writing'), icon: <EditOutlined />, content: <WritingStream novelId={novelId} /> },
      { key: 'checkpoint', label: t('workbench.tab.checkpoint'), icon: <HistoryOutlined />, content: <CheckpointTimeline novelId={novelId} /> },
      { key: 'chronicles', label: t('workbench.tab.chronicles'), icon: <HistoryOutlined />, content: <HolographicChronicles novelId={novelId} /> },
      { key: 'worldline', label: t('workbench.tab.worldline'), icon: <ApartmentOutlined />, content: <WorldlineDAG novelId={novelId} /> },
      { key: 'pipeline', label: t('workbench.tab.pipeline'), icon: <EyeOutlined />, content: <AuditPipeline novelId={novelId} /> },
      { key: 'autopilotPipeline', label: t('workbench.tab.autopilotPipeline'), icon: <RocketOutlined />, content: <AutopilotPipelineView novelId={novelId} /> },
      { key: 'prompts', label: t('workbench.tab.prompts'), icon: <BulbOutlined />, content: <PromptPlaza novelId={novelId} /> },
    ],
  }), [novelId, totalChapters, currentChapter, t]);

  const currentTabs = categoryTabs[category];
  const activeKey = subTab || (currentTabs.length > 0 ? currentTabs[0].key : '');

  const tabItems = currentTabs.map((tab) => ({
    key: tab.key,
    label: (
      <span style={{ fontSize: 11 }}>
        {tab.icon} {tab.label}
      </span>
    ),
    children: tab.content,
  }));

  const categories: { key: Category; label: string }[] = [
    { key: 'overview', label: t('workbench.category.overview') },
    { key: 'characters', label: t('workbench.category.characters') },
    { key: 'plot', label: t('workbench.category.plot') },
    { key: 'quality', label: t('workbench.category.quality') },
    { key: 'tools', label: t('workbench.category.tools') },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Category bar */}
      <div style={{
        display: 'flex', gap: 2, padding: '6px 8px 0',
        borderBottom: '1px solid var(--border-secondary)',
        overflowX: 'auto', flexShrink: 0,
      }}>
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat.key];
          const isActive = category === cat.key;
          return (
            <button
              key={cat.key}
              onClick={() => { setCategory(cat.key); setSubTab(''); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', fontSize: 11, fontWeight: isActive ? 600 : 400,
                color: isActive ? meta.color : 'var(--text-secondary)',
                background: isActive ? meta.color + '12' : 'transparent',
                border: 'none', borderBottom: isActive ? `2px solid ${meta.color}` : '2px solid transparent',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {meta.icon} {cat.label}
              <span style={{
                fontSize: 9, background: isActive ? meta.color + '20' : 'var(--bg-tertiary, rgba(0,0,0,0.04))',
                padding: '0 4px', borderRadius: 6, color: isActive ? meta.color : 'var(--text-tertiary)',
              }}>
                {categoryTabs[cat.key]?.length ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Sub-tab content */}
      <Tabs
        className="narrative-workbench-tabs"
        activeKey={activeKey}
        onChange={(k) => setSubTab(k)}
        items={tabItems}
        size="small"
        style={{ height: '100%', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}
        tabBarStyle={{ padding: '0 8px', marginBottom: 0, flexShrink: 0 }}
        tabBarGutter={12}
      />
    </div>
  );
};

export default NarrativeWorkbench;

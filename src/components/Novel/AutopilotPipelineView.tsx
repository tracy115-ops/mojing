// ============================================================================
// Autopilot Pipeline View — Visual stage pipeline with status indicators
// Shows the generation pipeline as connected nodes with progress animation
// ============================================================================

import React, { useMemo, useRef } from 'react';
import { Typography, Tag, Space, Empty, Badge, Tooltip, Button } from 'antd';
import {
  RocketOutlined, GlobalOutlined, FileTextOutlined, EditOutlined,
  CheckCircleOutlined, SyncOutlined, ThunderboltOutlined,
  SafetyCertificateOutlined, ReloadOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';
import type { AutopilotState } from '@/types/pipeline';
import { useChartTheme } from '@/hooks/useChartTheme';
import { useEchartsReady } from '@/hooks/useEchartsReady';

interface AutopilotPipelineViewProps {
  novelId: string;
}

interface StageDef {
  key: string;
  labelKey: string;
  icon: React.ReactNode;
  color: string;
}

const STAGES: StageDef[] = [
  { key: 'global_planning', labelKey: 'autopilotPipeline.stage.globalPlanning', icon: <GlobalOutlined />, color: '#8b5cf6' },
  { key: 'macro_planning', labelKey: 'autopilotPipeline.stage.macroPlanning', icon: <FileTextOutlined />, color: '#3b82f6' },
  { key: 'act_beat_planning', labelKey: 'autopilotPipeline.stage.beatPlanning', icon: <ThunderboltOutlined />, color: '#06b6d4' },
  { key: 'chapter_generation', labelKey: 'autopilotPipeline.stage.generation', icon: <EditOutlined />, color: '#22c55e' },
  { key: 'chapter_review', labelKey: 'autopilotPipeline.stage.review', icon: <SafetyCertificateOutlined />, color: '#f59e0b' },
];

const STAGE_ORDER = STAGES.map((s) => s.key);

function getStageStatus(stageKey: string, currentStage: string | undefined, status: string): 'idle' | 'active' | 'done' | 'error' {
  if (status === 'error' && stageKey === currentStage) return 'error';
  if (!currentStage || currentStage === 'idle') return 'idle';
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  const thisIdx = STAGE_ORDER.indexOf(stageKey);
  if (thisIdx < currentIdx) return 'done';
  if (thisIdx === currentIdx) return 'active';
  return 'idle';
}

const AutopilotPipelineView: React.FC<AutopilotPipelineViewProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();
  const autopilotState = useAutopilotStore((s) => s.states[novelId]);
  const beatProgress = useAutopilotStore((s) => s.beatProgress[novelId]);

  const status = autopilotState?.status || 'idle';
  const currentStage = autopilotState?.currentStage;
  const progress = autopilotState?.progress ?? 0;
  const currentChapter = autopilotState?.currentChapterNumber ?? 0;
  const targetChapters = autopilotState?.targetChapterCount ?? 0;
  const wordCount = autopilotState?.currentWordCount ?? 0;

  const beatInfo = useMemo(() => {
    if (!beatProgress) return null;
    return {
      total: beatProgress.totalBeats,
      current: beatProgress.currentBeatIndex + 1,
      focus: beatProgress.currentFocus,
      phase: beatProgress.currentPhase,
      beatWords: beatProgress.beatWordCount,
      chapterWords: beatProgress.chapterWordCount,
    };
  }, [beatProgress]);

  // ECharts pipeline visualization
  const chartOption = useMemo(() => {
    const categories = STAGES.map((s, i) => ({
      name: t(s.labelKey),
      itemStyle: { color: s.color },
    }));

    const nodes = STAGES.map((s, i) => {
      const stageStatus = getStageStatus(s.key, currentStage, status);
      let borderColor = '#9ca3af';
      let borderWidth = 1;
      let shadowBlur = 0;
      let opacity = 0.4;

      if (stageStatus === 'done') {
        borderColor = '#22c55e';
        borderWidth = 2;
        opacity = 1;
      } else if (stageStatus === 'active') {
        borderColor = s.color;
        borderWidth = 3;
        shadowBlur = 12;
        opacity = 1;
      } else if (stageStatus === 'error') {
        borderColor = '#ef4444';
        borderWidth = 3;
        opacity = 1;
      }

      return {
        id: s.key,
        name: t(s.labelKey),
        x: i * 160,
        y: 60,
        symbolSize: stageStatus === 'active' ? 40 : 30,
        itemStyle: {
          color: stageStatus === 'active' ? s.color : stageStatus === 'done' ? '#22c55e18' : '#f3f4f6',
          borderColor,
          borderWidth,
          shadowBlur,
          shadowColor: stageStatus === 'active' ? s.color + '60' : 'transparent',
        },
        label: {
          show: true,
          formatter: t(s.labelKey),
          fontSize: stageStatus === 'active' ? 11 : 10,
          fontWeight: stageStatus === 'active' ? 'bold' : 'normal',
          color: stageStatus === 'active' ? '#fff' : chartTheme.textPrimary,
          position: 'inside',
        },
        category: i,
      };
    });

    const links = STAGES.slice(0, -1).map((s, i) => {
      const nextStage = getStageStatus(STAGES[i + 1].key, currentStage, status);
      const thisStage = getStageStatus(s.key, currentStage, status);
      const isActive = thisStage === 'done' || thisStage === 'active';
      return {
        source: s.key,
        target: STAGES[i + 1].key,
        lineStyle: {
          color: isActive ? chartTheme.accent : chartTheme.border,
          width: isActive ? 2.5 : 1.5,
          curveness: 0,
        },
        symbol: ['none', 'arrow'],
        symbolSize: [0, 8],
      };
    });

    return {
      grid: { top: 10, right: 10, bottom: 30, left: 10 },
      xAxis: { show: false, min: -40, max: STAGES.length * 160 - 120 },
      yAxis: { show: false, min: 0, max: 120 },
      series: [{
        type: 'graph',
        coordinateSystem: 'cartesian2d',
        layout: 'none',
        symbolSize: 30,
        data: nodes,
        links,
        categories,
        roam: false,
        animation: true,
        animationDuration: 500,
        emphasis: {
          focus: 'adjacency',
          itemStyle: { borderWidth: 3 },
        },
      }],
    };
  }, [currentStage, status, chartTheme, t]);

  const pipelineChartRef = useRef<ReactECharts | null>(null);
  useEchartsReady(pipelineChartRef, chartOption);

  const isActive = status === 'running' || status === 'paused';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><RocketOutlined style={{ marginRight: 6 }} />{t('autopilotPipeline.title')}</span>
        <Space size={4}>
          <Tag color={status === 'running' ? 'processing' : status === 'paused' ? 'warning' : status === 'completed' ? 'success' : 'default'} style={{ fontSize: 10 }}>
            {t(`autopilotPipeline.status.${status}`)}
          </Tag>
          {isActive && (
            <Badge status="processing" />
          )}
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {!isActive && status !== 'completed' ? (
          <Empty description={t('autopilotPipeline.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Pipeline chart */}
            <div style={{ height: 100, border: '1px solid var(--border-secondary)', borderRadius: 8, overflow: 'hidden' }}>
              <ReactECharts
                ref={(e) => { pipelineChartRef.current = e; }}
                option={chartOption}
                style={{ height: '100%', width: '100%' }}
                opts={{ renderer: 'svg' }}
                notMerge
              />
            </div>

            {/* Progress stats */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6,
            }}>
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                border: '1px solid var(--border-secondary)',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>{t('autopilotPipeline.chapters')}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#3b82f6' }}>
                  {currentChapter}/{targetChapters}
                </div>
              </div>
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                border: '1px solid var(--border-secondary)',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>{t('autopilotPipeline.wordCount')}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e' }}>
                  {wordCount.toLocaleString()}
                </div>
              </div>
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                border: '1px solid var(--border-secondary)',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>{t('autopilotPipeline.progress')}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#6366f1' }}>
                  {Math.round(progress)}%
                </div>
              </div>
            </div>

            {/* Beat progress */}
            {beatInfo && (
              <div style={{
                padding: '8px 12px', borderRadius: 6,
                border: '1px solid var(--border-secondary)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>
                  {t('autopilotPipeline.beatProgress', { current: beatInfo.current, total: beatInfo.total })}
                </div>
                <div style={{
                  height: 4, borderRadius: 2,
                  background: 'var(--bg-tertiary, rgba(0,0,0,0.04))',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${beatInfo.total > 0 ? (beatInfo.current / beatInfo.total) * 100 : 0}%`,
                    height: '100%', background: '#3b82f6',
                    transition: 'width 0.3s',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: 'var(--text-tertiary)' }}>
                  <span>{beatInfo.focus && t(`autopilotPipeline.focus.${beatInfo.focus}`)}</span>
                  <span>{beatInfo.phase && t(`autopilotPipeline.phase.${beatInfo.phase}`)}</span>
                  <span>{beatInfo.chapterWords} {t('autopilotPipeline.words')}</span>
                </div>
              </div>
            )}

            {/* Error display */}
            {autopilotState?.lastError && (
              <div style={{
                padding: '8px 12px', borderRadius: 6,
                border: '1px solid #ef444440',
                background: '#ef444408',
                fontSize: 11, color: '#ef4444',
              }}>
                {autopilotState.lastError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AutopilotPipelineView;

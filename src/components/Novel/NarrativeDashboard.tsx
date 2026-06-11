// ============================================================================
// Narrative Dashboard — Visual dashboard with mini charts
// PlotPilot-inspired: metric cards, sparklines, gauge, status chips
// ============================================================================

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Tag, Space, Typography, Empty, Button } from 'antd';
import {
  DashboardOutlined, UserOutlined, AimOutlined,
  WarningOutlined, ThunderboltOutlined,
  ExperimentOutlined, SafetyCertificateOutlined,
  ReloadOutlined, BookOutlined, ToolOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from '@/i18n';
import { useInView } from '@/hooks/useInView';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { TensionScoringService } from '@/services/novel/tension-scorer';
import { KnowledgeGraphEngine } from '@/services/novel/knowledge-graph';
import { GovernanceEngine } from '@/services/novel/governance-engine';
import { PropManager } from '@/services/novel/prop-manager';
import { EvolutionEngine } from '@/services/novel/evolution-engine';
import { ContextBudgetAllocator } from '@/services/novel/context-budget';
import type { Foreshadowing } from '@/types/narrative';
import { useChartTheme } from '@/hooks/useChartTheme';

const { Text } = Typography;

interface NarrativeDashboardProps {
  novelId: string;
  totalChapters: number;
  currentChapter: number;
}

const URGENCY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const STATUS_CHIP: Record<string, { color: string; bg: string }> = {
  planted: { color: '#f59e0b', bg: '#f59e0b18' },
  resolved: { color: '#22c55e', bg: '#22c55e18' },
  abandoned: { color: '#9ca3af', bg: '#9ca3af18' },
};

function MetricTile({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 8,
      border: '1px solid var(--border-secondary)',
      background: 'var(--bg-primary, #fff)',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8,
        background: (color || '#3b82f6') + '14',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: color || '#3b82f6', fontSize: 16,
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--text-primary)', lineHeight: 1.2 }}>{value}</span>
          {sub && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{sub}</span>}
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, icon, children }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--border-secondary)',
      background: 'var(--bg-primary, #fff)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 14px', fontSize: 12, fontWeight: 600,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', alignItems: 'center', gap: 6,
        color: 'var(--text-secondary)',
      }}>
        {icon}
        {title}
      </div>
      <div style={{ padding: '6px 10px 10px' }}>
        {children}
      </div>
    </div>
  );
}

const NarrativeDashboard: React.FC<NarrativeDashboardProps> = ({
  novelId, totalChapters, currentChapter,
}) => {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();
  const [tick, setTick] = useState(0);
  const [tensionRef, tensionInView] = useInView();
  const [gaugeRef, gaugeInView] = useInView();
  const [foreshadowChartRef, foreshadowChartInView] = useInView();
  const [phaseChartRef, phaseChartInView] = useInView();

  const refresh = useCallback(() => setTick((v) => v + 1), []);

  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const characters = useMemo(() => repo.loadBible().characters, [repo, tick]);
  const foreshadowing = useMemo(() => repo.loadForeshadowing(), [repo, tick]);
  const triples = useMemo(() => repo.loadTriples(), [repo, tick]);
  const tensionPoints = useMemo(() => new TensionScoringService(novelId).getTensionHistory(), [novelId, tick]);
  const debts = useMemo(() => repo.loadNarrativeDebts(), [repo, tick]);
  const characterStates = useMemo(() => repo.loadCharacterStates(), [repo, tick]);
  const graph = useMemo(() => new KnowledgeGraphEngine(novelId).getFullGraph(), [novelId, tick]);
  const propsData = useMemo(() => new PropManager(novelId).loadAll(), [novelId, tick]);
  const violations = useMemo(() => new EvolutionEngine(novelId).getViolations(), [novelId, tick]);
  const govScore = useMemo(() => {
    try {
      const engine = new GovernanceEngine(novelId);
      const contract = engine.loadContract();
      const debts = repo.loadNarrativeDebts();
      const resolved = foreshadowing.filter((f) => f.status === 'resolved').length;
      const total = foreshadowing.length;
      const hitRate = total > 0 ? resolved / total : 0;
      const openDebtCount = debts.filter((d) => d.status === 'open').length;
      const score = Math.max(0, Math.min(100, Math.round(hitRate * 60 + (1 - openDebtCount / Math.max(debts.length, 1)) * 40)));
      return { score, hitRate };
    } catch {
      return { score: 0, hitRate: 0 };
    }
  }, [novelId, tick, foreshadowing, repo]);

  const plantedCount = foreshadowing.filter((f) => f.status === 'planted').length;
  const resolvedCount = foreshadowing.filter((f) => f.status === 'resolved').length;
  const overdueCount = foreshadowing.filter(
    (f) => f.status === 'planted' && f.suggestedResolveChapter !== undefined && f.suggestedResolveChapter <= currentChapter,
  ).length;
  const lastTension = tensionPoints.length > 0 ? tensionPoints[tensionPoints.length - 1].score : null;
  const activeChars = characters.filter((c) => c.status === 'active').length;
  const deadChars = characters.filter((c) => c.status === 'deceased').length;
  const activeProps = propsData.filter((p) => p.lifecycleState === 'active').length;
  const openDebts = debts.filter((d) => d.status === 'open').length;
  const phaseState = ContextBudgetAllocator.computeStoryPhase(currentChapter, totalChapters);

  const phaseValue = phaseState?.currentPhase === 'opening' ? t('dashboard.phase.opening')
    : phaseState?.currentPhase === 'development' ? t('dashboard.phase.development')
    : phaseState?.currentPhase === 'convergence' ? t('dashboard.phase.convergence')
    : t('dashboard.phase.finale');

  const phaseProgress = phaseState?.progress ?? 0;

  // Chart: tension sparkline — full width
  const tensionSparkline = useMemo(() => {
    if (tensionPoints.length < 2) return null;
    const lineColor = lastTension && lastTension >= 7 ? '#ef4444' : '#3b82f6';
    return {
      grid: { top: 10, right: 8, bottom: 22, left: 30 },
      xAxis: {
        type: 'category', data: tensionPoints.map((p) => p.chapter),
        axisLine: { lineStyle: { color: 'var(--border-secondary)' } },
        axisTick: { show: false },
        axisLabel: { fontSize: 9, color: 'var(--text-tertiary)', interval: Math.max(0, Math.floor(tensionPoints.length / 8)) },
      },
      yAxis: {
        type: 'value', min: 0, max: 10, splitNumber: 5,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { fontSize: 9, color: 'var(--text-tertiary)' },
        splitLine: { lineStyle: { color: 'var(--border-secondary)', type: 'dashed' } },
      },
      tooltip: { trigger: 'axis', textStyle: { fontSize: 11 } },
      series: [{
        type: 'line', data: tensionPoints.map((p) => p.score),
        smooth: true, symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 2.5, color: lineColor },
        itemStyle: { color: lineColor },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: lineColor + '30' }, { offset: 1, color: 'transparent' }] } },
      }],
    };
  }, [tensionPoints, lastTension]);

  // Chart: foreshadowing pie
  const foreshadowPie = useMemo(() => {
    if (foreshadowing.length === 0) return null;
    return {
      grid: { top: 4, right: 4, bottom: 4, left: 4 },
      legend: {
        bottom: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 10, color: 'var(--text-secondary)' },
      },
      series: [{
        type: 'pie', radius: ['40%', '65%'], center: ['50%', '45%'],
        label: { show: false },
        data: [
          { value: plantedCount, name: t('foreshadow.status.planted'), itemStyle: { color: '#f59e0b' } },
          { value: resolvedCount, name: t('foreshadow.status.resolved'), itemStyle: { color: '#22c55e' } },
          { value: foreshadowing.filter((f) => f.status === 'abandoned').length, name: t('foreshadow.status.abandoned'), itemStyle: { color: '#9ca3af' } },
        ],
        emphasis: { scale: true, scaleSize: 4 },
        itemStyle: { borderRadius: 4, borderColor: 'var(--bg-primary, #fff)', borderWidth: 2 },
      }],
      tooltip: { trigger: 'item', confine: true, textStyle: { fontSize: 11 } },
    };
  }, [foreshadowing, plantedCount, resolvedCount]);

  // Chart: governance gauge
  const govGauge = useMemo(() => ({
    series: [{
      type: 'gauge', startAngle: 200, endAngle: -20, min: 0, max: 100,
      radius: '90%', center: ['50%', '55%'],
      axisLine: { lineStyle: { width: 12, color: [[0.4, '#ef4444'], [0.7, '#f59e0b'], [1, '#22c55e']] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false },
      detail: {
        valueAnimation: true, fontSize: 24, fontWeight: 'bold',
        offsetCenter: [0, '10%'],
        color: govScore.score >= 70 ? '#22c55e' : govScore.score >= 40 ? '#f59e0b' : '#ef4444',
        formatter: '{value}',
      },
      data: [{ value: govScore.score }],
    }],
  }), [govScore.score]);

  // Progress bar for phase
  const phaseBar = useMemo(() => ({
    grid: { top: 8, right: 10, bottom: 8, left: 40 },
    xAxis: {
      type: 'value', max: 100,
      axisLabel: { fontSize: 9, color: 'var(--text-tertiary)', formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'var(--border-secondary)', type: 'dashed' } },
    },
    yAxis: {
      type: 'category', data: [''],
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { fontSize: 10, color: 'var(--text-secondary)' },
    },
    series: [{
      type: 'bar', data: [{ value: Math.round(phaseProgress * 100), itemStyle: { color: chartTheme.accent, borderRadius: [0, 4, 4, 0] } }],
      barWidth: 20, showBackground: true,
      backgroundStyle: { color: 'var(--bg-tertiary, rgba(0,0,0,0.04))', borderRadius: 4 },
      label: { show: true, position: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', formatter: '{c}%' },
    }],
  }), [phaseProgress]);

  const isEmpty = characters.length === 0 && foreshadowing.length === 0 && triples.length === 0 && debts.length === 0 && characterStates.length === 0 && tensionPoints.length === 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><DashboardOutlined style={{ marginRight: 6 }} />{t('dashboard.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {isEmpty ? (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <DashboardOutlined style={{ fontSize: 48, color: 'var(--text-tertiary, #bbb)', marginBottom: 16 }} />
            <Typography.Title level={5} style={{ color: 'var(--text-secondary)' }}>{t('dashboard.emptyTitle')}</Typography.Title>
            <Typography.Paragraph style={{ color: 'var(--text-tertiary)', fontSize: 12, maxWidth: 320, margin: '0 auto' }}>
              {t('dashboard.emptyGuide')}
            </Typography.Paragraph>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Metric tiles — 2 columns, 3 rows = 6 metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              <MetricTile
                icon={<BookOutlined />}
                label={t('dashboard.phase')}
                value={phaseValue}
                sub={`${t('dashboard.chapterProgress', { current: currentChapter, total: totalChapters })}`}
                color="#3b82f6"
              />
              <MetricTile
                icon={<ThunderboltOutlined />}
                label={t('dashboard.tension')}
                value={lastTension ?? '-'}
                sub={lastTension ? '/10' : ''}
                color={lastTension && lastTension >= 7 ? '#ef4444' : '#3b82f6'}
              />
              <MetricTile
                icon={<SafetyCertificateOutlined />}
                label={t('dashboard.governance')}
                value={govScore.score}
                sub={t('dashboard.governance.hitRate', { rate: Math.round(govScore.hitRate * 100) })}
                color={govScore.score >= 70 ? '#22c55e' : govScore.score >= 40 ? '#f59e0b' : '#ef4444'}
              />
              <MetricTile
                icon={<AimOutlined />}
                label={t('dashboard.foreshadow')}
                value={plantedCount}
                sub={t('dashboard.foreshadow.resolved', { count: resolvedCount })}
                color={overdueCount > 0 ? '#ef4444' : '#f59e0b'}
              />
              <MetricTile
                icon={<UserOutlined />}
                label={t('dashboard.characters')}
                value={`${activeChars}/${characters.length}`}
                sub={deadChars > 0 ? t('dashboard.characters.dead', { count: deadChars }) : undefined}
                color="#6366f1"
              />
              <MetricTile
                icon={<ToolOutlined />}
                label={t('dashboard.props')}
                value={activeProps}
                sub={violations.length > 0 ? t('dashboard.props.violations', { count: violations.length }) : undefined}
                color="#8b5cf6"
              />
            </div>

            {/* Tension chart — full width */}
            {tensionSparkline && (
              <ChartCard title={t('dashboard.tension')} icon={<ThunderboltOutlined />}>
                <div ref={tensionRef} style={{ height: 160 }}>
                  {tensionInView && <ReactECharts option={tensionSparkline} style={{ height: '100%', width: '100%' }} opts={{ renderer: 'svg' }} notMerge />}
                </div>
              </ChartCard>
            )}

            {/* Governance gauge + Phase progress — side by side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <ChartCard title={t('dashboard.governance')} icon={<SafetyCertificateOutlined />}>
                <div ref={gaugeRef} style={{ height: 120 }}>
                  {gaugeInView && <ReactECharts option={govGauge} style={{ height: '100%', width: '100%' }} opts={{ renderer: 'svg' }} notMerge />}
                </div>
              </ChartCard>
              <ChartCard title={t('dashboard.phase')} icon={<BookOutlined />}>
                <div ref={phaseChartRef} style={{ height: 120 }}>
                  {phaseChartInView && <ReactECharts option={phaseBar} style={{ height: '100%', width: '100%' }} opts={{ renderer: 'svg' }} notMerge />}
                </div>
              </ChartCard>
            </div>

            {/* Foreshadowing pie — full width */}
            {foreshadowPie && (
              <ChartCard
                title={plantedCount > 0 ? t('dashboard.activeForeshadow.title', { count: plantedCount }) : t('dashboard.foreshadow')}
                icon={<AimOutlined />}
              >
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <div ref={foreshadowChartRef} style={{ height: 120, flex: 1 }}>
                    {foreshadowChartInView && <ReactECharts option={foreshadowPie} style={{ height: '100%', width: '100%' }} opts={{ renderer: 'svg' }} notMerge />}
                  </div>
                  {overdueCount > 0 && (
                    <Tag color="red" style={{ fontSize: 10, margin: 0, padding: '0 6px', flexShrink: 0 }}>
                      {overdueCount} {t('dashboard.foreshadow.overdueLabel')}
                    </Tag>
                  )}
                </div>
              </ChartCard>
            )}

            {/* Narrative Debts */}
            {openDebts > 0 && (
              <div style={{
                borderRadius: 8, border: '1px solid var(--border-secondary)',
                overflow: 'hidden',
              }}>
                <div style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                  background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                  borderBottom: '1px solid var(--border-secondary)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <Space size={6}>
                    <WarningOutlined style={{ color: '#f59e0b' }} />
                    {t('dashboard.debts.title', { count: openDebts })}
                  </Space>
                  {debts.filter((d) => d.status === 'open' && d.priority >= 7).length > 0 && (
                    <Tag color="red" style={{ fontSize: 10, margin: 0, padding: '0 6px' }}>
                      {debts.filter((d) => d.status === 'open' && d.priority >= 7).length} {t('dashboard.debts.critical')}
                    </Tag>
                  )}
                </div>
                <div style={{ padding: '6px 14px' }}>
                  {debts.filter((d) => d.status === 'open').slice(0, 5).map((debt) => (
                    <div key={debt.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 0', fontSize: 12,
                      borderBottom: '1px solid var(--border-secondary)',
                    }}>
                      <div style={{
                        width: 7, height: 7, borderRadius: 4,
                        background: debt.priority >= 7 ? '#ef4444' : debt.priority >= 4 ? '#f59e0b' : '#3b82f6',
                        flexShrink: 0,
                      }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {debt.description}
                      </span>
                      <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>Ch{debt.plantedInChapter}</Text>
                      {debt.suggestedResolveBy > 0 && (
                        <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>→Ch{debt.suggestedResolveBy}</Text>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Active Foreshadowing list */}
            {plantedCount > 0 && (
              <div style={{
                borderRadius: 8, border: '1px solid var(--border-secondary)',
                overflow: 'hidden',
              }}>
                <div style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                  background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                  borderBottom: '1px solid var(--border-secondary)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <Space size={6}>
                    <AimOutlined style={{ color: '#f59e0b' }} />
                    {t('dashboard.activeForeshadow.title', { count: plantedCount })}
                  </Space>
                  {overdueCount > 0 && (
                    <Tag color="red" style={{ fontSize: 10, margin: 0, padding: '0 6px' }}>
                      {overdueCount} {t('dashboard.foreshadow.overdueLabel')}
                    </Tag>
                  )}
                </div>
                <div style={{ padding: '6px 14px' }}>
                  {foreshadowing
                    .filter((f) => f.status === 'planted')
                    .sort((a, b) => (URGENCY_ORDER[b.urgency] ?? 0) - (URGENCY_ORDER[a.urgency] ?? 0))
                    .slice(0, 6)
                    .map((f) => {
                      const isOverdue = f.suggestedResolveChapter !== undefined && f.suggestedResolveChapter <= currentChapter;
                      const chip = STATUS_CHIP[f.status] || STATUS_CHIP.planted;
                      return (
                        <div key={f.id} style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 0', fontSize: 12,
                          borderLeft: isOverdue ? '3px solid #ef4444' : '3px solid transparent',
                          paddingLeft: isOverdue ? 11 : 14,
                        }}>
                          <span style={{
                            fontSize: 10, padding: '2px 6px', borderRadius: 4,
                            color: chip.color, background: chip.bg, fontWeight: 500,
                          }}>
                            {f.urgency}
                          </span>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.description.slice(0, 80)}
                          </span>
                          <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>Ch{f.plantedInChapter}</Text>
                          {f.suggestedResolveChapter && (
                            <Text type="secondary" style={{ fontSize: 10, flexShrink: 0 }}>→Ch{f.suggestedResolveChapter}</Text>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Character States */}
            {characterStates.length > 0 && (
              <div style={{
                borderRadius: 8, border: '1px solid var(--border-secondary)',
                overflow: 'hidden',
              }}>
                <div style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                  background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                  borderBottom: '1px solid var(--border-secondary)',
                }}>
                  <Space size={6}><UserOutlined />{t('dashboard.charStates.title')}</Space>
                </div>
                <div style={{ padding: '6px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {characterStates.slice(0, 8).map((cs) => (
                    <div key={cs.characterId} style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11,
                      border: '1px solid var(--border-secondary)',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <Text strong style={{ fontSize: 12 }}>{cs.characterId}</Text>
                      <span style={{ color: 'var(--text-tertiary)' }}>{cs.emotionalState}</span>
                      {cs.location && <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>📍{cs.location}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Knowledge Graph Summary */}
            {triples.length > 0 && (
              <div style={{
                borderRadius: 8, border: '1px solid var(--border-secondary)',
                overflow: 'hidden',
              }}>
                <div style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                  background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                  borderBottom: '1px solid var(--border-secondary)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <Space size={6}><ExperimentOutlined />{t('dashboard.triples.title', { count: triples.length })}</Space>
                  <Space size={4}>
                    <Tag color="blue" style={{ fontSize: 10, margin: 0, padding: '0 5px' }}>{t('dashboard.graph.nodes', { count: graph.nodes.length })}</Tag>
                    <Tag color="green" style={{ fontSize: 10, margin: 0, padding: '0 5px' }}>{t('dashboard.graph.edges', { count: graph.edges.length })}</Tag>
                  </Space>
                </div>
                <div style={{ padding: '6px 14px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {triples.slice(0, 10).map((tr, idx) => (
                    <span key={idx} style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 4,
                      background: 'var(--bg-tertiary, rgba(0,0,0,0.04))',
                      color: 'var(--text-secondary)',
                    }}>
                      {tr.subject} → {tr.predicate} → {tr.object}
                    </span>
                  ))}
                  {triples.length > 10 && (
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>+{triples.length - 10}…</span>
                  )}
                </div>
              </div>
            )}

            {foreshadowing.length === 0 && triples.length === 0 && characterStates.length === 0 && (
              <Empty description={t('dashboard.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default NarrativeDashboard;

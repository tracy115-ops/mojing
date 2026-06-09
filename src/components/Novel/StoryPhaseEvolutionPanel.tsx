// ============================================================================
// Story Phase Panel + Evolution Engine Log
// Inspired by PlotPilot's StoryPhasePanel + StoryEvolutionPanel + ConsistencyReportPanel
// ============================================================================

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Card, Tag, Space, Typography, Progress, Timeline, List, Badge, Tooltip, Empty, Tabs, Button } from 'antd';
import {
  DashboardOutlined, ThunderboltOutlined, WarningOutlined,
  CheckCircleOutlined, ClockCircleOutlined, FlagOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { ContextBudgetAllocator } from '@/services/novel/context-budget';
import { EvolutionEngine, type EvolutionEvent, type ContinuityViolation } from '@/services/novel/evolution-engine';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { StoryPhase, Foreshadowing } from '@/types/narrative';

const { Text } = Typography;

interface StoryPhaseEvolutionPanelProps {
  novelId: string;
  totalChapters: number;
  currentChapter: number;
}

// --- Component ---

const StoryPhaseEvolutionPanel: React.FC<StoryPhaseEvolutionPanelProps> = ({
  novelId, totalChapters, currentChapter,
}) => {
  const { t } = useTranslation();

  // Story phase computation
  const progress = totalChapters > 0 ? currentChapter / totalChapters : 0;
  const phaseState = useMemo(
    () => ContextBudgetAllocator.computeStoryPhase(currentChapter, totalChapters),
    [currentChapter, totalChapters],
  );
  const currentPhase = phaseState?.currentPhase ?? 'opening';

  // Phase info — i18n driven
  const PHASES = useMemo(() => [
    { key: 'opening' as StoryPhase, icon: '🌱', color: '#22c55e', range: '0-25%' },
    { key: 'development' as StoryPhase, icon: '⚡', color: '#3b82f6', range: '25-75%' },
    { key: 'convergence' as StoryPhase, icon: '🎯', color: '#f59e0b', range: '75-90%' },
    { key: 'finale' as StoryPhase, icon: '🔥', color: '#ef4444', range: '90-100%' },
  ], []);

  const phaseInfo = PHASES.find((p) => p.key === currentPhase) ?? PHASES[0];

  const phaseLabel = (key: StoryPhase) => t(`phase.${key}`);
  const phaseDesc = (key: StoryPhase) => t(`phase.${key}.desc`);

  function getPhaseRules(phase: StoryPhase) {
    switch (phase) {
      case 'opening': return { allowSubplots: true, allowChars: true, foreshadowPressure: t('phase.pressure.low'), convergence: t('phase.convergence.free') };
      case 'development': return { allowSubplots: true, allowChars: true, foreshadowPressure: t('phase.pressure.medium'), convergence: t('phase.convergence.normal') };
      case 'convergence': return { allowSubplots: false, allowChars: false, foreshadowPressure: t('phase.pressure.high'), convergence: t('phase.convergence.force') };
      case 'finale': return { allowSubplots: false, allowChars: false, foreshadowPressure: t('phase.pressure.veryHigh'), convergence: t('phase.convergence.mustClose') };
    }
  }

  const rules = getPhaseRules(currentPhase);

  // Auto-refresh
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  // Evolution data
  const [evolution] = useState(() => new EvolutionEngine(novelId));
  const evoEvents = useMemo(() => evolution.getEvents(), [evolution, tick]);
  const violations = useMemo(() => evolution.getViolations(), [evolution, tick]);
  const timeline = useMemo(() => evolution.getTimeline(), [evolution, tick]);

  // Foreshadowing for context
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const foreshadowing = useMemo(() => repo.loadForeshadowing(), [repo, tick]);
  const plantedForeshadowing = foreshadowing.filter((f) => f.status === 'planted');
  const overdueForeshadowing = foreshadowing.filter(
    (f) => f.status === 'planted' && f.suggestedResolveChapter !== undefined && f.suggestedResolveChapter <= currentChapter,
  );

  const tabItems = [
    {
      key: 'phase',
      label: t('phase.tab.phase'),
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Phase progress track */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {PHASES.map((p, idx) => {
              const isActive = p.key === currentPhase;
              const isPast = PHASES.indexOf(PHASES.find((pp) => pp.key === currentPhase)!) > idx;
              return (
                <React.Fragment key={p.key}>
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    padding: '4px 8px', borderRadius: 6,
                    background: isActive ? `${p.color}18` : isPast ? 'rgba(34,197,94,0.06)' : 'transparent',
                    border: isActive ? `2px solid ${p.color}` : '2px solid transparent',
                    minWidth: 60,
                  }}>
                    <span style={{ fontSize: 16 }}>{p.icon}</span>
                    <Text style={{ fontSize: 10, fontWeight: isActive ? 600 : 400, color: isActive ? p.color : 'var(--text-secondary, #666)' }}>
                      {phaseLabel(p.key)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 9 }}>{p.range}</Text>
                  </div>
                  {idx < PHASES.length - 1 && (
                    <div style={{
                      flex: 1, height: 2, borderRadius: 1,
                      background: isPast ? '#22c55e' : 'var(--border-secondary, #e5e7eb)',
                    }} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Current phase info */}
          <Card size="small" style={{ borderLeft: `3px solid ${phaseInfo.color}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong style={{ fontSize: 13 }}>{phaseInfo.icon} {phaseLabel(currentPhase)}</Text>
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #666)', marginTop: 2 }}>
                  {phaseDesc(currentPhase)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <Progress
                  type="circle"
                  size={50}
                  percent={Math.round(progress * 100)}
                  strokeColor={phaseInfo.color}
                  format={(p) => <span style={{ fontSize: 11 }}>{p}%</span>}
                />
              </div>
            </div>
          </Card>

          {/* Phase rules */}
          <Card size="small" title={<Space><FlagOutlined style={{ fontSize: 12 }} />{t('phase.rules')}</Space>}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11 }}>
              <div>
                <Text type="secondary">{t('phase.rules.subplots')}</Text>
                <Tag color={rules.allowSubplots ? 'green' : 'red'} style={{ fontSize: 9, marginLeft: 4 }}>
                  {rules.allowSubplots ? t('phase.rules.allowed') : t('phase.rules.forbidden')}
                </Tag>
              </div>
              <div>
                <Text type="secondary">{t('phase.rules.newChars')}</Text>
                <Tag color={rules.allowChars ? 'green' : 'red'} style={{ fontSize: 9, marginLeft: 4 }}>
                  {rules.allowChars ? t('phase.rules.allowed') : t('phase.rules.forbidden')}
                </Tag>
              </div>
              <div>
                <Text type="secondary">{t('phase.rules.foreshadowPressure')}</Text>
                <Tag color={
                  rules.foreshadowPressure === t('phase.pressure.veryHigh') ? 'red'
                    : rules.foreshadowPressure === t('phase.pressure.high') ? 'orange' : 'blue'
                } style={{ fontSize: 9, marginLeft: 4 }}>
                  {rules.foreshadowPressure}
                </Tag>
              </div>
              <div>
                <Text type="secondary">{t('phase.rules.convergence')}</Text>
                <Text style={{ fontSize: 11, marginLeft: 4 }}>{rules.convergence}</Text>
              </div>
            </div>
          </Card>

          {/* Foreshadowing pressure */}
          <Card size="small" title={t('phase.foreshadow.title')}>
            <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
              <div><Tag color="blue">{t('phase.foreshadow.pending', { count: plantedForeshadowing.length })}</Tag></div>
              <div>{overdueForeshadowing.length > 0 && <Tag color="red">{t('phase.foreshadow.overdue', { count: overdueForeshadowing.length })}</Tag>}</div>
            </div>
            {overdueForeshadowing.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {overdueForeshadowing.slice(0, 5).map((f) => (
                  <div key={f.id} style={{ fontSize: 10, color: '#ef4444', marginBottom: 2 }}>
                    {t('phase.foreshadow.warning', { chapter: f.plantedInChapter, desc: f.description.slice(0, 40) })}
                    {f.description.length > 40 ? '...' : ''}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ),
    },
    {
      key: 'evolution',
      label: <Badge count={violations.length} size="small" offset={[4, -2]}>{t('phase.tab.evolution')}</Badge>,
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Continuity violations */}
          {violations.length > 0 && (
            <Card size="small" title={t('phase.violations.title')}>
              <Timeline
                items={violations.slice(0, 10).map((v) => ({
                  color: v.severity === 'critical' ? 'red' : v.severity === 'error' ? 'red' : 'orange',
                  children: (
                    <div style={{ fontSize: 11 }}>
                      <Tag color={v.severity === 'critical' ? 'red' : 'orange'} style={{ fontSize: 9 }}>
                        {v.severity}
                      </Tag>
                      <Tag style={{ fontSize: 9 }}>Ch{v.chapterNumber}</Tag>
                      <div style={{ marginTop: 2 }}>{v.description}</div>
                    </div>
                  ),
                }))}
              />
            </Card>
          )}

          {/* Event timeline */}
          {timeline.length === 0 ? (
            <Empty description={t('phase.evolution.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Timeline
              items={timeline.flatMap((tl) =>
                tl.events.map((e) => ({
                  color: e.eventType === 'character_death' ? 'red' :
                         e.eventType === 'knowledge_reveal' ? 'green' : 'blue',
                  children: (
                    <div style={{ fontSize: 11 }}>
                      <Space>
                        <Tag style={{ fontSize: 9 }}>Ch{tl.chapter}</Tag>
                        <Tag color={
                          e.eventType === 'character_death' ? 'red' :
                          e.eventType === 'relationship_change' ? 'blue' :
                          e.eventType === 'knowledge_reveal' ? 'green' : 'default'
                        } style={{ fontSize: 9 }}>
                          {e.eventType}
                        </Tag>
                      </Space>
                      <div style={{ marginTop: 2 }}>{e.description}</div>
                    </div>
                  ),
                })),
              )}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><FlagOutlined style={{ marginRight: 6 }} />{t('phase.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        <Tabs items={tabItems} size="small" defaultActiveKey="phase" />
      </div>
    </div>
  );
};

export default StoryPhaseEvolutionPanel;

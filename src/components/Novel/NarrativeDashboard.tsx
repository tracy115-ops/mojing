// ============================================================================
// Narrative Dashboard — One-glance overview of all narrative engine state
// ============================================================================

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Card, Row, Col, Tag, Space, Typography, Statistic, List, Tooltip, Empty, Button, Spin } from 'antd';
import {
  DashboardOutlined, UserOutlined, AimOutlined,
  WarningOutlined, CheckCircleOutlined, ThunderboltOutlined,
  ExperimentOutlined, SafetyCertificateOutlined, ClockCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { TensionScoringService } from '@/services/novel/tension-scorer';
import { KnowledgeGraphEngine } from '@/services/novel/knowledge-graph';
import { GovernanceEngine } from '@/services/novel/governance-engine';
import { PropManager } from '@/services/novel/prop-manager';
import { EvolutionEngine } from '@/services/novel/evolution-engine';
import { ContextBudgetAllocator } from '@/services/novel/context-budget';
import type { CharacterState, Foreshadowing, NarrativeDebt, RelationshipTriple } from '@/types/narrative';

const { Text } = Typography;

interface NarrativeDashboardProps {
  novelId: string;
  totalChapters: number;
  currentChapter: number;
}

const NarrativeDashboard: React.FC<NarrativeDashboardProps> = ({
  novelId, totalChapters, currentChapter,
}) => {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((v) => v + 1), []);

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Load all data from repository (real data, no fakes)
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

  // Computed stats
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
  const criticalDebts = debts.filter((d) => d.status === 'open' && d.priority >= 7).length;
  const phaseState = ContextBudgetAllocator.computeStoryPhase(currentChapter, totalChapters);

  const phaseValue = phaseState?.currentPhase === 'opening' ? t('dashboard.phase.opening')
    : phaseState?.currentPhase === 'development' ? t('dashboard.phase.development')
    : phaseState?.currentPhase === 'convergence' ? t('dashboard.phase.convergence')
    : t('dashboard.phase.finale');

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header with refresh */}
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><DashboardOutlined style={{ marginRight: 6 }} />{t('dashboard.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Completely empty state for new novels */}
          {characters.length === 0 && foreshadowing.length === 0 && triples.length === 0 && debts.length === 0 && characterStates.length === 0 && tensionPoints.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <DashboardOutlined style={{ fontSize: 48, color: 'var(--text-tertiary, #bbb)', marginBottom: 16 }} />
              <Typography.Title level={5} style={{ color: 'var(--text-secondary)' }}>{t('dashboard.emptyTitle')}</Typography.Title>
              <Typography.Paragraph style={{ color: 'var(--text-tertiary)', fontSize: 12, maxWidth: 320, margin: '0 auto' }}>
                {t('dashboard.emptyGuide')}
              </Typography.Paragraph>
            </div>
          ) : (
            <>
          {/* Top metrics row */}
          <Row gutter={[8, 8]}>
            <Col span={4}>
              <Card size="small" style={{ textAlign: 'center', padding: '4px 0' }}>
                <Statistic title={t('dashboard.phase')} value={phaseValue} valueStyle={{ fontSize: 14 }} />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small" style={{ textAlign: 'center', padding: '4px 0' }}>
                <Statistic title={t('dashboard.tension')} value={lastTension ?? '-'} suffix={lastTension ? '/10' : ''} valueStyle={{ fontSize: 16, color: lastTension && lastTension >= 7 ? '#ef4444' : '#3b82f6' }} />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small" style={{ textAlign: 'center', padding: '4px 0' }}>
                <Statistic title={t('dashboard.characters')} value={`${activeChars}/${characters.length}`} prefix={<UserOutlined style={{ fontSize: 12 }} />} valueStyle={{ fontSize: 14 }} />
                {deadChars > 0 && <div style={{ fontSize: 9, color: '#ef4444' }}>{t('dashboard.characters.dead', { count: deadChars })}</div>}
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small" style={{ textAlign: 'center', padding: '4px 0' }}>
                <Statistic title={t('dashboard.foreshadow')} value={t('dashboard.foreshadow.pending', { count: plantedCount, resolved: resolvedCount })} valueStyle={{ fontSize: 14 }} />
                {overdueCount > 0 && <Tag color="red" style={{ fontSize: 9 }}>{t('dashboard.foreshadow.overdue', { count: overdueCount })}</Tag>}
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small" style={{ textAlign: 'center', padding: '4px 0' }}>
                <Statistic title={t('dashboard.graph')} value={t('dashboard.graph.nodes', { count: graph.nodes.length })} prefix={<ExperimentOutlined style={{ fontSize: 12 }} />} valueStyle={{ fontSize: 14 }} />
                <div style={{ fontSize: 9, color: 'var(--text-tertiary, #999)' }}>{t('dashboard.graph.edges', { count: graph.edges.length })}</div>
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small" style={{ textAlign: 'center', padding: '4px 0' }}>
                <Statistic title={t('dashboard.props')} value={t('dashboard.props.active', { count: activeProps })} valueStyle={{ fontSize: 14 }} />
                {violations.length > 0 && <Tag color="red" style={{ fontSize: 9 }}>{t('dashboard.props.violations', { count: violations.length })}</Tag>}
              </Card>
            </Col>
          </Row>

          {/* Narrative Debts */}
          {openDebts > 0 && (
            <Card size="small" title={<Space><WarningOutlined style={{ color: '#f59e0b' }} />{t('dashboard.debts.title', { count: openDebts })}</Space>}>
              <List
                size="small"
                dataSource={debts.filter((d) => d.status === 'open').slice(0, 5)}
                renderItem={(debt) => (
                  <List.Item style={{ padding: '3px 0', fontSize: 11 }}>
                    <Space>
                      <Tag color={debt.priority >= 7 ? 'red' : debt.priority >= 4 ? 'orange' : 'blue'} style={{ fontSize: 9 }}>
                        P{debt.priority}
                      </Tag>
                      <Tag style={{ fontSize: 9 }}>Ch{debt.plantedInChapter}</Tag>
                      <span>{debt.description}</span>
                      {debt.suggestedResolveBy > 0 && (
                        <Text type="secondary" style={{ fontSize: 9 }}>{t('dashboard.debts.resolveBy', { chapter: debt.suggestedResolveBy })}</Text>
                      )}
                    </Space>
                  </List.Item>
                )}
              />
              {openDebts > 5 && <Text type="secondary" style={{ fontSize: 10 }}>{t('dashboard.debts.more', { count: openDebts - 5 })}</Text>}
            </Card>
          )}

          {/* Character States */}
          {characterStates.length > 0 && (
            <Card size="small" title={<Space><UserOutlined />{t('dashboard.charStates.title')}</Space>}>
              <List
                size="small"
                dataSource={characterStates.slice(0, 8)}
                renderItem={(cs) => (
                  <List.Item style={{ padding: '3px 0', fontSize: 11 }}>
                    <Space>
                      <Text strong>{cs.characterId}</Text>
                      <Tag style={{ fontSize: 9 }}>{cs.physicalState}</Tag>
                      <Tag color="blue" style={{ fontSize: 9 }}>{cs.emotionalState}</Tag>
                      {cs.location && <Text type="secondary" style={{ fontSize: 9 }}>📍{cs.location}</Text>}
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* Active Foreshadowing */}
          {plantedCount > 0 && (
            <Card size="small" title={<Space><AimOutlined />{t('dashboard.activeForeshadow.title', { count: plantedCount })}</Space>}>
              <List
                size="small"
                dataSource={foreshadowing.filter((f) => f.status === 'planted')
                  .sort((a, b) => {
                    const w = { critical: 4, high: 3, medium: 2, low: 1 };
                    return (w[b.urgency] ?? 0) - (w[a.urgency] ?? 0);
                  })
                  .slice(0, 6)}
                renderItem={(f) => {
                  const isOverdue = f.suggestedResolveChapter !== undefined && f.suggestedResolveChapter <= currentChapter;
                  return (
                    <List.Item style={{
                      padding: '3px 0', fontSize: 11,
                      borderLeft: isOverdue ? '3px solid #ef4444' : '3px solid transparent',
                    }}>
                      <Space>
                        {isOverdue && <WarningOutlined style={{ color: '#ef4444', fontSize: 10 }} />}
                        <Tag color={{ critical: 'red', high: 'orange', medium: 'blue', low: 'default' }[f.urgency]} style={{ fontSize: 9 }}>
                          {f.urgency}
                        </Tag>
                        <span>{f.description.slice(0, 50)}{f.description.length > 50 ? '...' : ''}</span>
                        <Text type="secondary" style={{ fontSize: 9 }}>Ch{f.plantedInChapter}</Text>
                        {f.suggestedResolveChapter && (
                          <Text type="secondary" style={{ fontSize: 9 }}>→Ch{f.suggestedResolveChapter}</Text>
                        )}
                      </Space>
                    </List.Item>
                  );
                }}
              />
              {plantedCount > 6 && <Text type="secondary" style={{ fontSize: 10 }}>{t('dashboard.activeForeshadow.more', { count: plantedCount - 6 })}</Text>}
            </Card>
          )}

          {/* Knowledge Triples */}
          {triples.length > 0 && (
            <Card size="small" title={<Space><ExperimentOutlined />{t('dashboard.triples.title', { count: triples.length })}</Space>}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {triples.slice(0, 12).map((tr, idx) => (
                  <Tag key={idx} style={{ fontSize: 9 }}>
                    {tr.subject} → {tr.predicate} → {tr.object}
                  </Tag>
                ))}
                {triples.length > 12 && <Tag style={{ fontSize: 9 }}>+{triples.length - 12}...</Tag>}
              </div>
            </Card>
          )}

          {/* Empty state for partial data */}
          {foreshadowing.length === 0 && triples.length === 0 && characterStates.length === 0 && (
            <Empty description={t('dashboard.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default NarrativeDashboard;

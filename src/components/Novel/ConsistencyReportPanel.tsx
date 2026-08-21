// ============================================================================
// Consistency Report Panel — Cross-chapter consistency audit
// Shows issues/warnings/suggestions with severity levels
// ============================================================================

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Typography, Tag, List, Space, Empty, Collapse, Badge, Button } from 'antd';
import {
  CheckCircleOutlined, WarningOutlined, CloseCircleOutlined,
  AuditOutlined, BulbOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';

const { Text } = Typography;

interface ConsistencyReportPanelProps {
  novelId: string;
}

interface ConsistencyItem {
  severity: 'critical' | 'important' | 'minor';
  category: string;
  description: string;
  location?: string;
  suggestion: string;
}

const severityConfig: Record<string, { color: string; icon: React.ReactNode }> = {
  critical: { color: 'error', icon: <CloseCircleOutlined /> },
  important: { color: 'warning', icon: <WarningOutlined /> },
  minor: { color: 'default', icon: <CheckCircleOutlined /> },
};

const ConsistencyReportPanel: React.FC<ConsistencyReportPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);

  const report = useMemo(() => {
    const characters = repo.loadBible().characters;
    const foreshadowing = repo.loadForeshadowing();
    const debts = repo.loadNarrativeDebts();
    const tensions = repo.loadTensionPoints();
    const states = repo.loadCharacterStates();

    const items: ConsistencyItem[] = [];

    // 1. Dead characters appearing in later chapters
    const deadChars = characters.filter((c) => c.status === 'deceased');
    for (const dc of deadChars) {
      for (const cs of states) {
        if (cs.characterId === dc.name && cs.chapter > (dc.lastUpdateChapter ?? 0)) {
          items.push({
            severity: 'critical',
            category: t('consistency.characterStatus'),
            description: t('consistency.deadCharAppears', { name: dc.name, chapter: cs.chapter }),
            location: `Ch.${cs.chapter}`,
            suggestion: t('consistency.checkDeath'),
          });
        }
      }
    }

    // 2. Overdue foreshadowing
    const overdue = foreshadowing.filter(
      (f) => f.status === 'planted' && f.suggestedResolveChapter !== undefined,
    );
    for (const f of overdue) {
      items.push({
        severity: f.urgency === 'critical' ? 'critical' : 'important',
        category: t('consistency.foreshadowing'),
        description: t('consistency.overdueForeshadow', { desc: f.description.slice(0, 40), chapter: f.suggestedResolveChapter! }),
        location: `Ch.${f.plantedInChapter} → ${f.suggestedResolveChapter}`,
        suggestion: t('consistency.resolveOrExtend'),
      });
    }

    // 3. Open narrative debts with high priority
    const openDebts = debts.filter((d) => d.status === 'open' && d.priority >= 7);
    for (const d of openDebts) {
      items.push({
        severity: d.priority >= 9 ? 'critical' : 'important',
        category: t('consistency.narrativeDebt'),
        description: d.description,
        location: `Ch.${d.plantedInChapter}`,
        suggestion: t('consistency.addressDebt'),
      });
    }

    // 4. Tension anomalies
    if (tensions.length >= 2) {
      for (let i = 1; i < tensions.length; i++) {
        const diff = tensions[i].score - tensions[i - 1].score;
        if (diff > 5) {
          items.push({
            severity: 'minor',
            category: t('consistency.tensionJump'),
            description: t('consistency.suddenTensionRise', { from: tensions[i - 1].chapter, to: tensions[i].chapter }),
            location: `Ch.${tensions[i].chapter}`,
            suggestion: t('consistency.addTransition'),
          });
        }
      }
      // Flat tension warning
      const last3 = tensions.slice(-3);
      if (last3.length === 3) {
        const avg = last3.reduce((s, tp) => s + tp.score, 0) / 3;
        const variance = last3.reduce((s, tp) => s + (tp.score - avg) ** 2, 0) / 3;
        if (variance < 0.5 && avg < 4) {
          items.push({
            severity: 'important',
            category: t('consistency.tensionFlat'),
            description: t('consistency.lowFlatTension'),
            location: `Ch.${last3[0].chapter}–${last3[2].chapter}`,
            suggestion: t('consistency.addConflictOrTwist'),
          });
        }
      }
    }

    // 5. Characters without any state updates
    const charsInBible = characters.filter((c) => c.importance === 'protagonist' || c.importance === 'major');
    for (const char of charsInBible) {
      const hasState = states.some((s) => s.characterId === char.id || s.characterId === char.name);
      if (!hasState && tensions.length > 2) {
        items.push({
          severity: 'minor',
          category: t('consistency.characterState'),
          description: t('consistency.noStateForChar', { name: char.name }),
          suggestion: t('consistency.trackCharState'),
        });
      }
    }

    const issues = items.filter((i) => i.severity === 'critical');
    const warnings = items.filter((i) => i.severity === 'important');
    const suggestions = items.filter((i) => i.severity === 'minor');

    return { issues, warnings, suggestions, total: items.length };
  }, [repo, t, tick]);

  const sections = [
    {
      key: 'issues',
      label: (
        <Space>
          <CloseCircleOutlined style={{ color: '#ef4444' }} />
          <span>{t('consistency.issues')} ({report.issues.length})</span>
        </Space>
      ),
      children: report.issues.length > 0 ? (
        <ConsistencyList items={report.issues} />
      ) : (
        <Empty description={t('consistency.noIssues')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ),
    },
    {
      key: 'warnings',
      label: (
        <Space>
          <WarningOutlined style={{ color: '#f59e0b' }} />
          <span>{t('consistency.warnings')} ({report.warnings.length})</span>
        </Space>
      ),
      children: report.warnings.length > 0 ? (
        <ConsistencyList items={report.warnings} />
      ) : (
        <Empty description={t('consistency.noWarnings')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ),
    },
    {
      key: 'suggestions',
      label: (
        <Space>
          <BulbOutlined style={{ color: '#3b82f6' }} />
          <span>{t('consistency.suggestions')} ({report.suggestions.length})</span>
        </Space>
      ),
      children: report.suggestions.length > 0 ? (
        <ConsistencyList items={report.suggestions} />
      ) : (
        <Empty description={t('consistency.noSuggestions')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
        <span><AuditOutlined style={{ marginRight: 6 }} />{t('consistency.title')}</span>
        <Space>
          <Badge count={report.issues.length} style={{ backgroundColor: '#ef4444' }} />
          <Badge count={report.warnings.length} style={{ backgroundColor: '#f59e0b' }} />
          <Badge count={report.suggestions.length} style={{ backgroundColor: '#3b82f6' }} />
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px' }}>
        {report.total === 0 ? (
          <div style={{ padding: 20 }}>
            <Empty description={t('consistency.allClear')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          <Collapse items={sections} size="small" defaultActiveKey={['issues']} />
        )}
      </div>
    </div>
  );
};

const ConsistencyList: React.FC<{ items: ConsistencyItem[] }> = ({ items }) => (
  <List
    size="small"
    dataSource={items}
    renderItem={(item) => {
      const cfg = severityConfig[item.severity] ?? severityConfig.minor;
      return (
        <List.Item style={{ padding: '4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', fontSize: 11 }}>
            <Tag color={cfg.color} icon={cfg.icon} style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>
              <div><Text style={{ fontSize: 11 }}>{item.description}</Text></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                {item.location && <Text type="secondary" style={{ fontSize: 10 }}>{item.location}</Text>}
                <Tag style={{ fontSize: 9 }}>{item.category}</Tag>
              </div>
              {item.suggestion && (
                <div style={{ marginTop: 2 }}>
                  <BulbOutlined style={{ fontSize: 10, color: '#3b82f6', marginRight: 4 }} />
                  <Text type="secondary" style={{ fontSize: 10 }}>{item.suggestion}</Text>
                </div>
              )}
            </div>
          </div>
        </List.Item>
      );
    }}
  />
);

export default ConsistencyReportPanel;

// ============================================================================
// Quality Guardrail Panel — 6-dimension quality assessment with weighted scores
// ============================================================================

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Typography, Card, Tag, List, Space, Badge, Tooltip, Empty, Row, Col, Button } from 'antd';
import {
  ControlOutlined, ReloadOutlined, CheckCircleOutlined, WarningOutlined,
  CloseCircleOutlined, ExperimentOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { ClicheScanner } from '@/services/novel/cliche-scanner';

const { Text } = Typography;

interface QualityGuardrailPanelProps {
  novelId: string;
}

type DimensionKey = 'consistency' | 'voice' | 'pacing' | 'dialogue' | 'description' | 'tension';

interface DimensionScore {
  key: DimensionKey;
  score: number;
  weight: number;
  violations: Violation[];
}

interface Violation {
  dimension: string;
  severity: 'critical' | 'important' | 'minor';
  description: string;
  suggestion: string;
}

const DIMENSION_WEIGHTS: Record<DimensionKey, number> = {
  consistency: 0.25,
  voice: 0.15,
  pacing: 0.2,
  dialogue: 0.15,
  description: 0.1,
  tension: 0.15,
};

const QualityGuardrailPanel: React.FC<QualityGuardrailPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(v => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);

  const assessment = useMemo(() => {
    const bible = repo.loadBible();
    const tensions = repo.loadTensionPoints();
    const foreshadowing = repo.loadForeshadowing();
    const triples = repo.loadTriples();
    const debts = repo.loadNarrativeDebts();

    const dims: DimensionScore[] = [];

    // 1. Consistency (based on debts, contradictions)
    const openDebts = debts.filter((d) => d.status === 'open');
    const consistencyViolations: Violation[] = openDebts.slice(0, 5).map((d) => ({
      dimension: 'consistency',
      severity: d.priority >= 7 ? 'critical' : d.priority >= 4 ? 'important' : 'minor',
      description: d.description,
      suggestion: t('guardrail.resolveDebt'),
    }));
    const consistencyScore = Math.max(0, 100 - openDebts.length * 8 - openDebts.filter((d) => d.priority >= 7).length * 15);
    dims.push({ key: 'consistency', score: consistencyScore, weight: DIMENSION_WEIGHTS.consistency, violations: consistencyViolations });

    // 2. Voice (based on cliche patterns)
    const voiceViolations: Violation[] = [];
    let voiceScore = 100;
    // Check recent audit history if available
    try {
      const raw = localStorage.getItem(`mojing-narrative:${novelId}:audit-history`);
      if (raw) {
        const history = JSON.parse(raw);
        if (history.length > 0) {
          const latest = history[history.length - 1];
          voiceScore = latest.score;
          for (const hit of (latest.hits ?? []).slice(0, 3)) {
            voiceViolations.push({
              dimension: 'voice',
              severity: hit.severity === 'critical' ? 'critical' : hit.severity === 'warning' ? 'important' : 'minor',
              description: `${hit.label} (x${hit.count})`,
              suggestion: hit.suggestion,
            });
          }
        }
      }
    } catch { /* no audit data */ }
    dims.push({ key: 'voice', score: voiceScore, weight: DIMENSION_WEIGHTS.voice, violations: voiceViolations });

    // 3. Pacing (based on tension variance)
    const pacingViolations: Violation[] = [];
    let pacingScore = 75;
    if (tensions.length >= 3) {
      const recent = tensions.slice(-5);
      const scores = recent.map((tp) => tp.score);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / scores.length;
      pacingScore = Math.min(100, Math.round(50 + Math.sqrt(variance) * 20));
      if (variance < 1) {
        pacingViolations.push({
          dimension: 'pacing', severity: 'important',
          description: t('guardrail.flatPacing'),
          suggestion: t('guardrail.varyTension'),
        });
      }
      const lowCount = scores.filter((s) => s < 3).length;
      if (lowCount >= 3) {
        pacingViolations.push({
          dimension: 'pacing', severity: 'critical',
          description: t('guardrail.consecutiveLow'),
          suggestion: t('guardrail.addConflict'),
        });
      }
    }
    dims.push({ key: 'pacing', score: pacingScore, weight: DIMENSION_WEIGHTS.pacing, violations: pacingViolations });

    // 4. Dialogue — analyze actual character voice anchors from bible
    const dialogueViolations: Violation[] = [];
    let dialogueScore = 50; // base score
    const charsWithVoice = bible.characters.filter(
      (c) => c.voiceAnchor?.speechStyle || c.voiceAnchor?.verbalTic || c.psyche?.coreBelief,
    );
    // More characters with defined voices = better dialogue infrastructure
    dialogueScore = Math.min(100, 40 + charsWithVoice.length * 15);
    if (bible.characters.length > 0 && charsWithVoice.length === 0) {
      dialogueViolations.push({
        dimension: 'dialogue', severity: 'important',
        description: t('guardrail.noVoiceAnchors'),
        suggestion: t('guardrail.addVoiceAnchors'),
      });
      dialogueScore = Math.min(dialogueScore, 40);
    }
    dims.push({ key: 'dialogue', score: dialogueScore, weight: DIMENSION_WEIGHTS.dialogue, violations: dialogueViolations });

    // 5. Description — based on world settings completeness
    const descViolations: Violation[] = [];
    let descScore = 50;
    const settingsWithConstraints = bible.worldSettings.filter((s) => s.constraints && s.constraints.length > 0);
    descScore = Math.min(100, 40 + settingsWithConstraints.length * 15 + (bible.locations.length > 0 ? 15 : 0));
    if (bible.worldSettings.length === 0 && bible.locations.length === 0) {
      descViolations.push({
        dimension: 'description', severity: 'important',
        description: t('guardrail.noWorldSettings'),
        suggestion: t('guardrail.addWorldSettings'),
      });
      descScore = Math.min(descScore, 35);
    }
    dims.push({ key: 'description', score: descScore, weight: DIMENSION_WEIGHTS.description, violations: descViolations });

    // 6. Tension balance — based on real tension data
    const tensionBalViolations: Violation[] = [];
    let tensionScore = 50;
    if (tensions.length >= 2) {
      const avg = tensions.reduce((s, tp) => s + tp.score, 0) / tensions.length;
      const maxT = Math.max(...tensions.map((tp) => tp.score));
      const minT = Math.min(...tensions.map((tp) => tp.score));
      // Good tension = average around 5-7, with variation
      const range = maxT - minT;
      tensionScore = Math.min(100, Math.round(
        30 + // base
        Math.min(30, avg * 5) + // reward moderate avg tension
        Math.min(20, range * 5) + // reward variation
        Math.min(20, (1 - Math.abs(avg - 6) / 6) * 20), // penalty for extreme avg
      ));
      if (avg < 3) {
        tensionBalViolations.push({
          dimension: 'tension', severity: 'critical',
          description: t('guardrail.lowTensionAvg'),
          suggestion: t('guardrail.addConflict'),
        });
      }
    }
    dims.push({ key: 'tension', score: tensionScore, weight: DIMENSION_WEIGHTS.tension, violations: tensionBalViolations });

    // Overall weighted score
    const overall = dims.reduce((sum, d) => sum + d.score * d.weight, 0);
    const allViolations = dims.flatMap((d) => d.violations);

    return { dimensions: dims, overall: Math.round(overall), allViolations };
  }, [repo, novelId, t, tick]);

  const { dimensions, overall, allViolations } = assessment;

  const scoreColor = (s: number) => s >= 80 ? '#22c55e' : s >= 60 ? '#3b82f6' : s >= 40 ? '#f59e0b' : '#ef4444';

  const severityIcon = (sev: string) => {
    if (sev === 'critical') return <CloseCircleOutlined style={{ color: '#ef4444' }} />;
    if (sev === 'important') return <WarningOutlined style={{ color: '#f59e0b' }} />;
    return <CheckCircleOutlined style={{ color: '#22c55e' }} />;
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><ControlOutlined style={{ marginRight: 6 }} />{t('guardrail.title')}</span>
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={refresh} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {/* Overall Score Gauge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <svg width="100" height="100" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border-secondary, #e5e7eb)" strokeWidth="6" />
            <circle
              cx="50" cy="50" r="40" fill="none"
              stroke={scoreColor(overall)} strokeWidth="6"
              strokeDasharray={`${2 * Math.PI * 40}`}
              strokeDashoffset={2 * Math.PI * 40 * (1 - overall / 100)}
              strokeLinecap="round"
              transform="rotate(-90 50 50)"
              style={{ transition: 'stroke-dashoffset 0.5s ease' }}
            />
            <text x="50" y="46" textAnchor="middle" style={{ fontSize: 22, fontWeight: 700, fill: scoreColor(overall) }}>{overall}</text>
            <text x="50" y="62" textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text-secondary, #666)' }}>/100</text>
          </svg>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('guardrail.overallScore')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {t('guardrail.violationCount', { count: allViolations.length })}
            </div>
          </div>
        </div>

        {/* Dimension breakdown */}
        <Row gutter={[6, 6]} style={{ marginBottom: 16 }}>
          {dimensions.map((dim) => (
            <Col span={8} key={dim.key}>
              <div style={{
                padding: '6px 8px', borderRadius: 6, textAlign: 'center',
                background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                border: '1px solid var(--border-secondary)',
              }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>
                  {t(`guardrail.dim.${dim.key}`)}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: scoreColor(dim.score) }}>
                  {dim.score}
                </div>
                <div style={{ height: 3, borderRadius: 2, background: 'var(--border-secondary)', marginTop: 4 }}>
                  <div style={{ width: `${dim.score}%`, height: '100%', borderRadius: 2, background: scoreColor(dim.score) }} />
                </div>
              </div>
            </Col>
          ))}
        </Row>

        {/* Violations */}
        {allViolations.length > 0 ? (
          <div>
            <Text strong style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
              {t('guardrail.violations')}
            </Text>
            <List
              size="small"
              dataSource={allViolations}
              renderItem={(v) => (
                <List.Item style={{ padding: '4px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    {severityIcon(v.severity)}
                    <Tag style={{ fontSize: 9 }}>{v.dimension}</Tag>
                    <span style={{ fontSize: 11, flex: 1 }}>{v.description}</span>
                    <Tooltip title={v.suggestion}>
                      <Text type="secondary" style={{ fontSize: 10, maxWidth: 150 }} ellipsis>{v.suggestion}</Text>
                    </Tooltip>
                  </div>
                </List.Item>
              )}
            />
          </div>
        ) : (
          <Empty description={t('guardrail.noViolations')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </div>
    </div>
  );
};

export default QualityGuardrailPanel;

// ============================================================================
// Reader Simulation Panel — Three-reader quality simulation display
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Typography, Card, Tag, Space, Empty, Button, Progress, Spin, List } from 'antd';
import {
  UserOutlined, SmileOutlined, FireOutlined, BugOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { ReaderSimulator, READER_PERSONAS, type ReaderSimulationResult, type ReaderScore } from '@/services/novel/reader-simulator';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelMetadata } from '@/types';

const { Text } = Typography;

interface ReaderSimulationPanelProps {
  novelId: string;
}

const PERSONA_CONFIG: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  hardcore: { icon: <FireOutlined />, color: '#ef4444', bg: 'rgba(239,68,68,0.06)' },
  casual: { icon: <SmileOutlined />, color: '#f59e0b', bg: 'rgba(245,158,11,0.06)' },
  nitpicker: { icon: <BugOutlined />, color: '#8b5cf6', bg: 'rgba(139,92,246,0.06)' },
};

const ReaderSimulationPanel: React.FC<ReaderSimulationPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [simulator] = useState(() => new ReaderSimulator(novelId));
  const [latestResult, setLatestResult] = useState<ReaderSimulationResult | null>(simulator.getLatestSimulation());
  const [loading, setLoading] = useState(false);

  // Get real chapter content from project store
  const project = useProjectStore((s) => s.projects.find((p) => p.id === novelId));
  const novelMeta = project?.metadata as NovelMetadata | undefined;
  const chapters = novelMeta?.chapters ?? [];
  const contentChapters = useMemo(() => chapters.filter((c) => c.content && c.content.length > 50), [chapters]);

  const handleSimulate = async () => {
    if (contentChapters.length === 0) return;
    setLoading(true);
    const lastChapter = contentChapters[contentChapters.length - 1];
    const result = await simulator.simulate(lastChapter.order, lastChapter.content);
    if (result) setLatestResult(result);
    setLoading(false);
  };

  const renderScoreCard = (score: ReaderScore) => {
    const cfg = PERSONA_CONFIG[score.persona.id] || PERSONA_CONFIG.hardcore;
    const avgScore = (score.suspenseRetention + score.thrillLevel + (10 - score.churnRisk) + score.emotionalResonance) / 4;

    return (
      <Card
        key={score.persona.id}
        size="small"
        style={{ background: cfg.bg, borderColor: cfg.color + '30', flex: 1, minWidth: 180 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: cfg.color }}>{cfg.icon}</span>
            <span style={{ fontWeight: 600 }}>{score.persona.name}</span>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: cfg.color }}>
              {avgScore.toFixed(1)}
            </div>
            <Text type="secondary" style={{ fontSize: 9 }}>{t('readerSim.average')}</Text>
          </div>

          {[
            { label: t('readerDim.suspense'), value: score.suspenseRetention },
            { label: t('readerDim.thrill'), value: score.thrillLevel },
            { label: t('readerDim.churn'), value: 10 - score.churnRisk },
            { label: t('readerDim.emotion'), value: score.emotionalResonance },
          ].map((dim) => (
            <div key={dim.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <Text style={{ fontSize: 10 }}>{dim.label}</Text>
                <Text style={{ fontSize: 10, fontWeight: 600, color: cfg.color }}>{dim.value}/10</Text>
              </div>
              <Progress
                percent={dim.value * 10}
                size="small"
                strokeColor={cfg.color}
                showInfo={false}
              />
            </div>
          ))}

          {score.highlights.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Text style={{ fontSize: 10, fontWeight: 600, color: '#22c55e' }}>{t('readerSim.highlights')}</Text>
              {score.highlights.slice(0, 3).map((h, i) => (
                <div key={i} style={{ fontSize: 10, color: 'var(--text-secondary)', paddingLeft: 8 }}>• {h}</div>
              ))}
            </div>
          )}

          {score.painPoints.length > 0 && (
            <div>
              <Text style={{ fontSize: 10, fontWeight: 600, color: '#ef4444' }}>{t('readerSim.painPoints')}</Text>
              {score.painPoints.slice(0, 3).map((p, i) => (
                <div key={i} style={{ fontSize: 10, color: 'var(--text-secondary)', paddingLeft: 8 }}>• {p}</div>
              ))}
            </div>
          )}
        </div>
      </Card>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><UserOutlined style={{ marginRight: 6 }} />{t('readerSim.title')}</span>
        <Space>
          <Button size="small" type="primary" onClick={handleSimulate} loading={loading} disabled={chapters.length === 0}>
            {t('readerSim.runSimulation')}
          </Button>
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {!latestResult ? (
          <Empty description={t('readerSim.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Overall score */}
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 36, fontWeight: 700, color: '#3b82f6' }}>
                {latestResult.averageScore.toFixed(1)}
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {t('readerSim.chapterScore', { chapter: latestResult.chapter + 1 })}
              </Text>
            </div>

            {/* Three reader cards */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {latestResult.scores.map(renderScoreCard)}
            </div>

            {/* Suggestions */}
            {latestResult.scores.some((s) => s.suggestions.length > 0) && (
              <Card size="small" title={t('readerSim.suggestions')}>
                <List
                  size="small"
                  dataSource={latestResult.scores.filter((s) => s.suggestions.length > 0)}
                  renderItem={(score) => (
                    <List.Item style={{ padding: '4px 0' }}>
                      <div>
                        <Tag color={PERSONA_CONFIG[score.persona.id]?.color} style={{ fontSize: 9 }}>{score.persona.name}</Tag>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {score.suggestions.join('; ')}
                        </div>
                      </div>
                    </List.Item>
                  )}
                />
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReaderSimulationPanel;

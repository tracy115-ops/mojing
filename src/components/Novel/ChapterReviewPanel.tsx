// ============================================================================
// Chapter Review Panel — Multi-dimension chapter quality review display
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Typography, Card, Tag, Space, Empty, Button, Progress, List } from 'antd';
import {
  AuditOutlined, CheckCircleOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { ChapterReviewer, type ChapterReviewReport } from '@/services/novel/chapter-reviewer';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelMetadata } from '@/types';

const { Text } = Typography;

interface ChapterReviewPanelProps {
  novelId: string;
}

const DIMENSION_LABELS: Record<string, string> = {
  character_consistency: 'readerDim.characterConsistency',
  timeline_consistency: 'readerDim.timelineConsistency',
  plot_coherence: 'readerDim.plotCoherence',
  foreshadowing_usage: 'readerDim.foreshadowUsage',
  voice_quality: 'readerDim.voiceQuality',
};

const ChapterReviewPanel: React.FC<ChapterReviewPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [reviewer] = useState(() => new ChapterReviewer(novelId));
  const [latestReview, setLatestReview] = useState<ChapterReviewReport | null>(reviewer.getLatestReview());
  const [history, setHistory] = useState<ChapterReviewReport[]>(reviewer.loadHistory());
  const [loading, setLoading] = useState(false);

  // Get real chapter content from project store
  const project = useProjectStore((s) => s.projects.find((p) => p.id === novelId));
  const novelMeta = project?.metadata as NovelMetadata | undefined;
  const chapters = novelMeta?.chapters ?? [];
  const contentChapters = useMemo(() => chapters.filter((c) => c.content && c.content.length > 50), [chapters]);

  const handleReview = async () => {
    if (contentChapters.length === 0) return;
    setLoading(true);
    const lastChapter = contentChapters[contentChapters.length - 1];
    const report = await reviewer.reviewChapter(lastChapter.order, lastChapter.content);
    if (report) {
      setLatestReview(report);
      setHistory(reviewer.loadHistory());
    }
    setLoading(false);
  };

  const scoreColor = (score: number) => {
    if (score >= 80) return '#22c55e';
    if (score >= 60) return '#f59e0b';
    return '#ef4444';
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><AuditOutlined style={{ marginRight: 6 }} />{t('chapterReview.title')}</span>
        <Space>
          <Button size="small" type="primary" onClick={handleReview} loading={loading} disabled={chapters.length === 0}>
            {t('chapterReview.runReview')}
          </Button>
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {!latestReview ? (
          <Empty description={t('chapterReview.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Overall score gauge */}
            <div style={{ textAlign: 'center' }}>
              <svg width="120" height="120" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border-secondary)" strokeWidth="8" />
                <circle
                  cx="60" cy="60" r="50" fill="none"
                  stroke={scoreColor(latestReview.overallScore)}
                  strokeWidth="8"
                  strokeDasharray={`${(latestReview.overallScore / 100) * 314} 314`}
                  transform="rotate(-90 60 60)"
                  strokeLinecap="round"
                />
                <text x="60" y="55" textAnchor="middle" style={{ fontSize: 24, fontWeight: 700, fill: scoreColor(latestReview.overallScore) }}>
                  {latestReview.overallScore}
                </text>
                <text x="60" y="75" textAnchor="middle" style={{ fontSize: 10, fill: 'var(--text-secondary)' }}>
                  {t('chapterReview.overallScore')}
                </text>
              </svg>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('chapterReview.chapterN', { chapter: latestReview.chapter + 1 })}
                </Text>
              </div>
            </div>

            {/* Summary */}
            {latestReview.summary && (
              <Card size="small" style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}>
                <Text style={{ fontSize: 12 }}>{latestReview.summary}</Text>
              </Card>
            )}

            {/* Dimension scores */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {latestReview.dimensions.map((dim) => {
                const label = t(DIMENSION_LABELS[dim.name] ?? dim.name);
                const color = scoreColor(dim.score);
                return (
                  <Card key={dim.name} size="small" style={{ padding: '6px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ fontSize: 12, fontWeight: 500 }}>{label}</Text>
                      <Text style={{ fontSize: 12, fontWeight: 700, color }}>{dim.score}/100</Text>
                    </div>
                    <Progress
                      percent={dim.score}
                      strokeColor={color}
                      size="small"
                      showInfo={false}
                    />
                    {dim.issues.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        {dim.issues.map((issue, i) => (
                          <div key={i} style={{ fontSize: 10, color: 'var(--text-secondary)', display: 'flex', gap: 4, marginTop: 2 }}>
                            <WarningOutlined style={{ color: '#f59e0b', fontSize: 9, marginTop: 2 }} />
                            <span>{issue}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>

            {/* Suggestions */}
            {latestReview.suggestions.length > 0 && (
              <Card size="small" title={t('chapterReview.suggestions')}>
                {latestReview.suggestions.map((s, i) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                    {i + 1}. {s}
                  </div>
                ))}
              </Card>
            )}

            {/* History trend */}
            {history.length > 1 && (
              <Card size="small" title={t('chapterReview.history')}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 60 }}>
                  {history.slice(-10).map((h, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                      <div style={{
                        width: '100%', maxWidth: 24,
                        height: Math.max(4, (h.overallScore / 100) * 50),
                        background: scoreColor(h.overallScore),
                        borderRadius: 2,
                      }} />
                      <Text style={{ fontSize: 8, color: 'var(--text-tertiary)' }}>Ch{h.chapter + 1}</Text>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChapterReviewPanel;

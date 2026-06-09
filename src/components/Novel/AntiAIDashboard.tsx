// ============================================================================
// Anti-AI Dashboard — Post-generation quality audit visualization
// Shows: audit score gauge, cross-chapter trend, cliche hit list, fix suggestions
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import { Typography, Tag, List, Button, Space, Tooltip, Empty, Badge } from 'antd';
import {
  SafetyCertificateOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { AntiAIAuditor, ClicheScanner, type AuditReport, type PatternHit } from '@/services/novel/cliche-scanner';

const { Text } = Typography;

interface AntiAIDashboardProps {
  novelId: string;
}

// --- Score Gauge (pure SVG) ---

const ScoreGauge: React.FC<{ score: number; severity: string }> = ({ score, severity }) => {
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const progress = score / 100;
  const dashOffset = circumference * (1 - progress);

  const colorMap: Record<string, string> = {
    pure: '#22c55e',
    mild: '#3b82f6',
    moderate: '#f59e0b',
    severe: '#ef4444',
  };
  const color = colorMap[severity] ?? '#6b7280';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--border-secondary, #e5e7eb)" strokeWidth="8" />
        <circle
          cx="60" cy="60" r={radius} fill="none"
          stroke={color} strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
        <text x="60" y="55" textAnchor="middle" style={{ fontSize: 24, fontWeight: 700, fill: color }}>
          {score}
        </text>
        <text x="60" y="72" textAnchor="middle" style={{ fontSize: 10, fill: 'var(--text-secondary, #666)' }}>
          / 100
        </text>
      </svg>
    </div>
  );
};

// --- Trend Sparkline ---

const TrendSparkline: React.FC<{ scores: { chapter: number; score: number }[] }> = ({ scores }) => {
  if (scores.length < 2) return null;
  const width = 160;
  const height = 40;
  const stepX = width / (scores.length - 1);

  const pathD = scores.map((s, i) => {
    const x = i * stepX;
    const y = height - (s.score / 100) * height;
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');

  const areaD = `${pathD} L ${((scores.length - 1) * stepX).toFixed(1)} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="auditGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#auditGrad)" />
      <path d={pathD} fill="none" stroke="#22c55e" strokeWidth="1.5" />
      {scores.map((s, i) => (
        <circle key={`s-${s.chapter}`} cx={i * stepX} cy={height - (s.score / 100) * height} r={2} fill="#22c55e" />
      ))}
    </svg>
  );
};

// --- Severity tag ---

const SeverityTag: React.FC<{ severity: string }> = ({ severity }) => {
  const config: Record<string, { color: string; icon: React.ReactNode }> = {
    critical: { color: 'error', icon: <CloseCircleOutlined /> },
    warning: { color: 'warning', icon: <WarningOutlined /> },
    info: { color: 'default', icon: <InfoCircleOutlined /> },
  };
  const c = config[severity] ?? config.info;
  return <Tag color={c.color} icon={c.icon} style={{ fontSize: 11 }}>{severity}</Tag>;
};

// --- Main Component ---

const AntiAIDashboard: React.FC<AntiAIDashboardProps> = ({ novelId }) => {
  const { t } = useTranslation();

  const [auditHistory, setAuditHistory] = useState<AuditReport[]>([]);
  const [latestReport, setLatestReport] = useState<AuditReport | null>(null);
  const [trend, setTrend] = useState<{ avgScore: number; trend: string; chapterScores: { chapter: number; score: number }[] }>({
    avgScore: 100,
    trend: 'stable',
    chapterScores: [],
  });

  useEffect(() => {
    if (novelId) {
      const auditor = new AntiAIAuditor(novelId);
      const history = auditor.getAuditHistory();
      setAuditHistory(history);
      setTrend(auditor.getAuditTrend());
      if (history.length > 0) {
        setLatestReport(history[history.length - 1]);
      }
    }
  }, [novelId]);

  const severityLabel = useMemo(() => {
    if (!latestReport) return '-';
    const map: Record<string, string> = {
      pure: t('audit.severity.pure'),
      mild: t('audit.severity.mild'),
      moderate: t('audit.severity.moderate'),
      severe: t('audit.severity.severe'),
    };
    return map[latestReport.severity] ?? latestReport.severity;
  }, [latestReport, t]);

  const trendLabel = useMemo(() => {
    const map: Record<string, string> = {
      improving: '↑ ' + t('audit.trend.improving'),
      degrading: '↓ ' + t('audit.trend.degrading'),
      stable: '— ' + t('audit.trend.stable'),
    };
    return map[trend.trend] ?? t('audit.trend.stable');
  }, [trend, t]);

  if (auditHistory.length === 0) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <Empty
          image={<ExperimentOutlined style={{ fontSize: 32, color: 'var(--text-tertiary)' }} />}
          description={t('audit.empty')}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 16px' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SafetyCertificateOutlined style={{ fontSize: 16, color: 'var(--accent-primary, #3b82f6)' }} />
          <Text strong style={{ fontSize: 14 }}>{t('audit.title')}</Text>
        </div>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {t('audit.chaptersAudited', { count: auditHistory.length })}
        </Text>
      </div>

      {/* Score + Trend row */}
      {latestReport && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: 12, borderRadius: 8,
          background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
          border: '1px solid var(--border-secondary)',
          marginBottom: 12,
        }}>
          <ScoreGauge score={latestReport.score} severity={latestReport.severity} />
          <div style={{ flex: 1 }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 13 }}>
                {t('audit.latestChapter', { chapter: latestReport.chapterNumber })}
              </Text>
              <Tag
                color={latestReport.severity === 'pure' ? 'success' : latestReport.severity === 'mild' ? 'processing' : latestReport.severity === 'moderate' ? 'warning' : 'error'}
                style={{ marginLeft: 8, fontSize: 11 }}
              >
                {severityLabel}
              </Tag>
            </div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                <CloseCircleOutlined style={{ color: '#ef4444', marginRight: 4 }} />
                {t('audit.critical', { count: latestReport.criticalCount })}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                <WarningOutlined style={{ color: '#f59e0b', marginRight: 4 }} />
                {t('audit.warning', { count: latestReport.warningCount })}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                <InfoCircleOutlined style={{ marginRight: 4 }} />
                {t('audit.info', { count: latestReport.infoCount })}
              </Text>
            </div>
            {/* Trend */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <TrendSparkline scores={trend.chapterScores} />
              <div>
                <Text type="secondary" style={{ fontSize: 10 }}>{t('audit.trendLabel')}</Text>
                <div>
                  <Text style={{ fontSize: 11 }}>{trendLabel}</Text>
                </div>
                <Text type="secondary" style={{ fontSize: 10 }}>
                  {t('audit.avgScore', { score: trend.avgScore })}
                </Text>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cliche hit list */}
      {latestReport && latestReport.hits.length > 0 && (
        <div>
          <Text strong style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
            {t('audit.hitList')}
          </Text>
          <List
            size="small"
            dataSource={latestReport.hits}
            renderItem={(hit: PatternHit) => (
              <List.Item style={{ padding: '6px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <SeverityTag severity={hit.severity} />
                    <Text style={{ fontSize: 12 }}>{hit.label}</Text>
                    <Badge count={hit.count} style={{ backgroundColor: hit.severity === 'critical' ? '#ef4444' : hit.severity === 'warning' ? '#f59e0b' : '#6b7280' }} />
                  </div>
                  <Tooltip title={hit.suggestion}>
                    <Text type="secondary" style={{ fontSize: 10, maxWidth: 200 }} ellipsis>
                      {hit.suggestion}
                    </Text>
                  </Tooltip>
                </div>
              </List.Item>
            )}
          />
        </div>
      )}
    </div>
  );
};

export default AntiAIDashboard;

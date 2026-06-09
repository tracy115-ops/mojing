// ============================================================================
// Voice Drift Indicator — Monitors writing style consistency across chapters
// Shows circular drift gauge, safe/warning/danger states, drift history
// ============================================================================

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Typography, Card, Tag, List, Space, Empty, Tooltip, Badge, Button } from 'antd';
import {
  SoundOutlined, CheckCircleOutlined, WarningOutlined,
  CloseCircleOutlined, LineChartOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { VoiceFingerprintService } from '@/services/novel/voice-fingerprint';

const { Text } = Typography;

interface VoiceDriftIndicatorProps {
  novelId: string;
}

const VoiceDriftIndicator: React.FC<VoiceDriftIndicatorProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((prev) => prev + 1), []);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const timer = setInterval(() => setTick((prev) => prev + 1), 10_000);
    return () => clearInterval(timer);
  }, []);

  const service = useMemo(() => new VoiceFingerprintService(novelId), [novelId]);

  const fingerprint = useMemo(() => service['repo'].loadVoiceFingerprint(), [service, tick]);
  const driftHistory = useMemo(() => service.loadDriftHistory(), [service, tick]);

  const latestDrift = driftHistory.length > 0 ? driftHistory[driftHistory.length - 1] : null;

  // Status determination
  const driftScore = latestDrift ? Math.round((1 - latestDrift.similarity) * 10) : 0;
  const status: 'safe' | 'warning' | 'danger' = latestDrift
    ? (latestDrift.similarity >= 0.7 ? 'safe' : latestDrift.similarity >= 0.4 ? 'warning' : 'danger')
    : 'safe';

  const statusConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    safe: { color: '#22c55e', icon: <CheckCircleOutlined />, label: t('drift.status.safe') },
    warning: { color: '#f59e0b', icon: <WarningOutlined />, label: t('drift.status.warning') },
    danger: { color: '#ef4444', icon: <CloseCircleOutlined />, label: t('drift.status.danger') },
  };

  const currentStatus = statusConfig[status];

  // SVG circular gauge
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(driftScore, 10) / 10;
  const dashOffset = circumference * (1 - progress);

  // Sparkline for drift history
  const sparklineSvg = useMemo(() => {
    if (driftHistory.length < 2) return null;
    const width = 200;
    const height = 40;
    const stepX = width / (driftHistory.length - 1);
    const scores = driftHistory.map((d) => Math.round((1 - d.similarity) * 10));

    const pathD = scores.map((s, i) => {
      const x = i * stepX;
      const y = height - (s / 10) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');

    const areaD = `${pathD} L ${((scores.length - 1) * stepX).toFixed(1)} ${height} L 0 ${height} Z`;

    return (
      <svg width={width} height={height} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="driftGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={currentStatus.color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={currentStatus.color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#driftGrad)" />
        <path d={pathD} fill="none" stroke={currentStatus.color} strokeWidth="1.5" />
        {/* Threshold line at 0.6 similarity = 4 drift score */}
        <line x1={0} y1={height - (4 / 10) * height} x2={width} y2={height - (4 / 10) * height}
          stroke="#f59e0b" strokeWidth={0.5} strokeDasharray="3,3" />
      </svg>
    );
  }, [driftHistory, currentStatus.color, tick]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--border-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><SoundOutlined style={{ marginRight: 6 }} />{t('drift.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {!fingerprint ? (
          <Empty description={t('drift.noData')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            {/* Gauge + Status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
              <svg width="120" height="120" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--border-secondary, #e5e7eb)" strokeWidth="8" />
                <circle
                  cx="60" cy="60" r={radius} fill="none"
                  stroke={currentStatus.color} strokeWidth="8"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                  transform="rotate(-90 60 60)"
                  style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                />
                <text x="60" y="55" textAnchor="middle" style={{ fontSize: 24, fontWeight: 700, fill: currentStatus.color }}>
                  {driftScore}
                </text>
                <text x="60" y="72" textAnchor="middle" style={{ fontSize: 10, fill: 'var(--text-secondary, #666)' }}>
                  /10
                </text>
              </svg>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  {currentStatus.icon}
                  <Text strong style={{ fontSize: 13, color: currentStatus.color }}>{currentStatus.label}</Text>
                </div>
                {latestDrift && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {t('drift.similarity')}: {(latestDrift.similarity * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {t('drift.chapter')}: {latestDrift.chapter}
                    </div>
                  </>
                )}
                {latestDrift?.suggestedFix && (
                  <div style={{ marginTop: 4, padding: '4px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', fontSize: 11 }}>
                    {latestDrift.suggestedFix}
                  </div>
                )}
              </div>
            </div>

            {/* Fingerprint Features */}
            <Card
              size="small"
              style={{ marginBottom: 12, background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
              title={<span style={{ fontSize: 12 }}>{t('drift.baselineFeatures')}</span>}
            >
              <Space wrap size={[4, 4]}>
                <Tag style={{ fontSize: 10 }}>{t('drift.avgSentLen')}: {fingerprint.features.avgSentenceLength}</Tag>
                <Tag style={{ fontSize: 10 }}>{t('drift.dialogRatio')}: {(fingerprint.features.dialogueRatio * 100).toFixed(0)}%</Tag>
                <Tag style={{ fontSize: 10 }}>{t('drift.vocabLevel')}: {fingerprint.features.vocabularyLevel}/10</Tag>
                <Tag style={{ fontSize: 10 }}>{t('drift.emotionalTone')}: {fingerprint.features.emotionalTone}</Tag>
                {fingerprint.features.syntacticPatterns.map((p) => (
                  <Tag key={p} color="blue" style={{ fontSize: 10 }}>{p}</Tag>
                ))}
              </Space>
            </Card>

            {/* Drift History Sparkline */}
            {driftHistory.length >= 2 && (
              <Card
                size="small"
                style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
                title={<span style={{ fontSize: 12 }}><LineChartOutlined /> {t('drift.historyTrend')}</span>}
              >
                {sparklineSvg}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                  <span>Ch.{driftHistory[0].chapter}</span>
                  <span>Ch.{driftHistory[driftHistory.length - 1].chapter}</span>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default VoiceDriftIndicator;

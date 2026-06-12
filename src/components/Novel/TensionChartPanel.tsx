// ============================================================================
// Tension Chart Panel — Multi-dimensional tension curve + stats
// Uses ECharts for interactive chart rendering
// ============================================================================

import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Card, Row, Col, Tag, Space, Typography, Statistic, Tooltip, Button, Empty, Select, message } from 'antd';
import {
  LineChartOutlined, FireOutlined, ThunderboltOutlined,
  DashboardOutlined, WarningOutlined, ReloadOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from '@/i18n';
import { TensionScoringService, type TensionTrend } from '@/services/novel/tension-scorer';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelMetadata } from '@/types';
import type { TensionPoint, TensionDimensions } from '@/types/narrative';
import { useChartTheme } from '@/hooks/useChartTheme';
import { useEchartsReady } from '@/hooks/useEchartsReady';

const { Text } = Typography;

interface TensionChartPanelProps {
  novelId: string;
}

// --- Color coding ---

function tensionColor(score: number): string {
  if (score >= 8) return '#ef4444';
  if (score >= 6) return '#f59e0b';
  if (score >= 3.5) return '#3b82f6';
  return '#6b7280';
}

// --- Stats computation ---

interface TensionStats {
  avg: number;
  max: number;
  maxChapter: number;
  min: number;
  minChapter: number;
  variance: number;
  consecutiveLow: number;
  isFlat: boolean;
  trend: TensionTrend;
}

function computeStats(points: TensionPoint[]): TensionStats {
  if (points.length === 0) {
    return { avg: 0, max: 0, maxChapter: 0, min: 0, minChapter: 0, variance: 0, consecutiveLow: 0, isFlat: true, trend: 'stable' };
  }
  const scores = points.map((p) => p.score);
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  const max = Math.max(...scores);
  const maxIdx = scores.indexOf(max);
  const min = Math.min(...scores);
  const minIdx = scores.indexOf(min);
  const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / scores.length;

  let consecutiveLow = 0;
  let temp = 0;
  for (const s of scores) {
    if (s < 3.5) { temp++; consecutiveLow = Math.max(consecutiveLow, temp); }
    else { temp = 0; }
  }

  return {
    avg: Math.round(avg * 10) / 10,
    max: Math.round(max * 10) / 10,
    maxChapter: points[maxIdx].chapter,
    min: Math.round(min * 10) / 10,
    minChapter: points[minIdx].chapter,
    variance: Math.round(variance * 100) / 100,
    consecutiveLow,
    isFlat: variance < 0.5,
    trend: 'stable',
  };
}

// --- Component ---

const TensionChartPanel: React.FC<TensionChartPanelProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();

  const [service] = useState(() => new TensionScoringService(novelId));
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [points, setPoints] = useState<TensionPoint[]>(() => service.getTensionHistory());
  const [scoring, setScoring] = useState(false);
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);

  // Get real chapter content from project store
  const project = useProjectStore((s) => s.projects.find((p) => p.id === novelId));
  const novelMeta = project?.metadata as NovelMetadata | undefined;
  const chapters = novelMeta?.chapters ?? [];
  const contentChapters = useMemo(
    () => chapters.filter((c) => c.content && c.content.length > 50),
    [chapters],
  );

  // Build scored set for marking which chapters already have scores
  const scoredChapters = useMemo(() => new Set(points.map((p) => p.chapter)), [points]);

  const refresh = useCallback(() => {
    setPoints(service.getTensionHistory());
  }, [service]);

  // Auto-refresh every 10s when autopilot may be running
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Auto-select last unscored chapter
  useEffect(() => {
    if (selectedChapter !== null) return;
    const lastContent = contentChapters[contentChapters.length - 1];
    if (lastContent && !scoredChapters.has(lastContent.order)) {
      setSelectedChapter(lastContent.order);
    } else if (contentChapters.length > 0) {
      setSelectedChapter(contentChapters[contentChapters.length - 1].order);
    }
  }, [contentChapters, scoredChapters, selectedChapter]);

  const trend = useMemo(() => service.getTensionTrend(), [service, points]);
  const stats = useMemo(() => {
    const s = computeStats(points);
    s.trend = trend;
    return s;
  }, [points, trend]);

  // Score a specific chapter
  const handleScore = async () => {
    if (selectedChapter === null) return;
    const chapter = contentChapters.find((c) => c.order === selectedChapter);
    if (!chapter?.content) {
      message.warning(t('tension.noChapterContent'));
      return;
    }
    setScoring(true);
    const prevScore = points.length > 0 ? points[points.length - 1].score : 5;
    await service.scoreChapter(chapter.content, chapter.order, prevScore);
    refresh();
    setScoring(false);
    message.success(t('tension.scoreSuccess', { chapter: selectedChapter }));
  };

  // Score all chapters
  const handleScoreAll = async () => {
    if (contentChapters.length === 0) return;
    setScoring(true);
    let prevScore = 5;
    for (const ch of contentChapters) {
      if (!scoredChapters.has(ch.order)) {
        await service.scoreChapter(ch.content, ch.order, prevScore);
      }
      prevScore = points.find((p) => p.chapter === ch.order)?.score ?? prevScore;
      refresh();
    }
    setScoring(false);
    message.success(t('tension.scoreAllSuccess'));
  };

  // i18n-aware tension label
  const tensionLabel = (score: number): string => {
    if (score >= 8) return t('tension.label.climax');
    if (score >= 6) return t('tension.label.conflict');
    if (score >= 3.5) return t('tension.label.flow');
    return t('tension.label.flat');
  };

  // ECharts options
  const chartOption = useMemo(() => {
    if (points.length === 0) return null;

    const chapters_labels = points.map((p) => `Ch${p.chapter}`);
    const scores = points.map((p) => p.score);
    const dimPlot = points.map((p) => p.dimensions?.plot ?? 0);
    const dimEmotional = points.map((p) => p.dimensions?.emotional ?? 0);
    const dimAction = points.map((p) => p.dimensions?.action ?? 0);

    return {
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: any) => {
          const p = points[params[0].dataIndex];
          if (!p) return '';
          const dims = p.dimensions;
          return `<div style="font-size:12px">
            <b>${t('tension.chart.chapter', { chapter: p.chapter })}</b> — ${t('tension.chart.overall')}: ${p.score}<br/>
            <span style="color:#ef4444">●</span> ${t('tension.chart.plot')}: ${dims?.plot ?? '-'}
            <span style="color:#8b5cf6">●</span> ${t('tension.chart.emotional')}: ${dims?.emotional ?? '-'}
            <span style="color:#f59e0b">●</span> ${t('tension.chart.action')}: ${dims?.action ?? '-'}
          </div>`;
        },
      },
      legend: {
        data: [t('tension.chart.overall'), t('tension.chart.plot'), t('tension.chart.emotional'), t('tension.chart.action')],
        bottom: 0,
        textStyle: { fontSize: 11, color: chartTheme.textSecondary },
      },
      grid: { left: 40, right: 20, top: 15, bottom: 35 },
      xAxis: {
        type: 'category' as const,
        data: chapters_labels,
        axisLabel: { fontSize: 10, color: chartTheme.textTertiary },
        axisLine: { lineStyle: { color: chartTheme.border } },
      },
      yAxis: {
        type: 'value' as const,
        min: 0, max: 10,
        splitNumber: 5,
        axisLabel: { fontSize: 10, color: chartTheme.textTertiary },
        splitLine: { lineStyle: { color: chartTheme.border } },
      },
      series: [
        {
          name: t('tension.chart.overall'),
          type: 'line' as const,
          data: scores,
          smooth: true,
          lineStyle: { width: 2.5, color: '#8b5cf6' },
          itemStyle: { color: '#8b5cf6' },
          areaStyle: {
            color: {
              type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(139,92,246,0.25)' },
                { offset: 1, color: 'rgba(139,92,246,0.02)' },
              ],
            },
          },
          markLine: {
            silent: true,
            data: [
              { yAxis: 3.5, lineStyle: { color: '#3b82f6', type: 'dashed', width: 1 }, label: { show: true, formatter: t('tension.chart.flowLine'), fontSize: 9, color: '#3b82f6' } },
              { yAxis: 6, lineStyle: { color: '#f59e0b', type: 'dashed', width: 1 }, label: { show: true, formatter: t('tension.chart.conflictLine'), fontSize: 9, color: '#f59e0b' } },
              { yAxis: 8, lineStyle: { color: '#ef4444', type: 'dashed', width: 1 }, label: { show: true, formatter: t('tension.chart.climaxLine'), fontSize: 9, color: '#ef4444' } },
            ],
          },
        },
        {
          name: t('tension.chart.plot'),
          type: 'line' as const,
          data: dimPlot,
          smooth: true,
          lineStyle: { width: 1.5, color: '#ef4444', type: 'dashed' },
          itemStyle: { color: '#ef4444' },
        },
        {
          name: t('tension.chart.emotional'),
          type: 'line' as const,
          data: dimEmotional,
          smooth: true,
          lineStyle: { width: 1.5, color: '#8b5cf6', type: 'dashed' },
          itemStyle: { color: '#8b5cf6' },
        },
        {
          name: t('tension.chart.action'),
          type: 'line' as const,
          data: dimAction,
          smooth: true,
          lineStyle: { width: 1.5, color: '#f59e0b', type: 'dashed' },
          itemStyle: { color: '#f59e0b' },
        },
      ],
    };
  }, [points, chartTheme, t]);

  const tensionChartRef = useRef<ReactECharts | null>(null);
  useEchartsReady(tensionChartRef, chartOption);

  // Empty state with chapter selector
  if (contentChapters.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          padding: '4px 12px', fontWeight: 600, fontSize: 13,
          borderBottom: '1px solid var(--border-secondary)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span><LineChartOutlined style={{ marginRight: 6 }} />{t('tension.title')}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Empty description={t('tension.noChapters')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header with actions */}
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><LineChartOutlined style={{ marginRight: 6 }} />{t('tension.title')}</span>
        <Space size={4}>
          <Select
            size="small"
            value={selectedChapter ?? undefined}
            onChange={setSelectedChapter}
            style={{ width: 120 }}
            placeholder={t('tension.selectChapter')}
          >
            {contentChapters.map((ch) => (
              <Select.Option key={ch.order} value={ch.order}>
                Ch{ch.order} {scoredChapters.has(ch.order) ? '✓' : ''}
              </Select.Option>
            ))}
          </Select>
          <Button size="small" type="primary" onClick={handleScore} loading={scoring}>
            {t('tension.scoreChapter')}
          </Button>
          <Button size="small" onClick={handleScoreAll} loading={scoring} disabled={contentChapters.length === 0}>
            {t('tension.scoreAll')}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {points.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Empty
              image={<LineChartOutlined style={{ fontSize: 36, color: 'var(--text-tertiary, #bbb)' }} />}
              description={
                <Space direction="vertical" size={4}>
                  <Text type="secondary">{t('tension.noData')}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {t('tension.noDataHint')}
                  </Text>
                </Space>
              }
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Stats row */}
            <Row gutter={8}>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <Statistic
                    title={t('tension.chart.avg')}
                    value={stats.avg}
                    suffix={`/10`}
                    valueStyle={{ color: tensionColor(stats.avg), fontSize: 20 }}
                  />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <Statistic
                    title={t('tension.chart.max')}
                    value={stats.max}
                    suffix={`/10`}
                    valueStyle={{ color: '#ef4444', fontSize: 20 }}
                    prefix={<FireOutlined />}
                  />
                  <Text type="secondary" style={{ fontSize: 10 }}>Ch{stats.maxChapter}</Text>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <Statistic
                    title={t('tension.chart.min')}
                    value={stats.min}
                    suffix={`/10`}
                    valueStyle={{ color: '#6b7280', fontSize: 20 }}
                  />
                  <Text type="secondary" style={{ fontSize: 10 }}>Ch{stats.minChapter}</Text>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <Statistic
                    title={t('tension.chart.trend')}
                    value={t(`tension.trend.${stats.trend}`)}
                    valueStyle={{ fontSize: 16 }}
                  />
                  {stats.consecutiveLow > 2 && (
                    <Tooltip title={t('tension.chart.consecutiveLow', { count: stats.consecutiveLow })}>
                      <Tag color="warning" style={{ fontSize: 9 }}>{t('tension.chart.lowWarning')}</Tag>
                    </Tooltip>
                  )}
                  {stats.isFlat && (
                    <Tag color="default" style={{ fontSize: 9 }}>{t('tension.chart.flatWarning')}</Tag>
                  )}
                </Card>
              </Col>
            </Row>

            {/* Chart */}
            <Card size="small" style={{ padding: 0 }}>
              {chartOption && (
                <ReactECharts
                  ref={(e) => { tensionChartRef.current = e; }}
                  option={chartOption}
                  style={{ height: 220 }}
                  opts={{ renderer: 'svg' }}
                />
              )}
            </Card>

            {/* Latest tension */}
            {points.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px' }}>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('tension.chart.latest')}</Text>
                <Tag color={tensionColor(points[points.length - 1].score)} style={{ fontSize: 11 }}>
                  {t('tension.chart.latestDetail', {
                    chapter: points[points.length - 1].chapter,
                    score: points[points.length - 1].score,
                    label: tensionLabel(points[points.length - 1].score),
                  })}
                </Tag>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('tension.chart.totalScores', { count: points.length })}
                </Text>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default TensionChartPanel;

// ============================================================================
// Checkpoint Timeline — Version control timeline for autopilot checkpoints
// Shows checkpoint events, supports resume/display
// ============================================================================

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Typography, Card, Tag, Space, Empty, Badge, Button } from 'antd';
import {
  HistoryOutlined, ClockCircleOutlined, PlayCircleOutlined,
  CheckCircleOutlined, ThunderboltOutlined, FlagOutlined,
  SaveOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { CheckpointManager } from '@/services/novel/checkpoint-manager';
import { NarrativeRepository } from '@/services/novel/narrative-repository';

const { Text } = Typography;

interface CheckpointTimelineProps {
  novelId: string;
}

const triggerIcon: Record<string, React.ReactNode> = {
  chapter_complete: <CheckCircleOutlined />,
  act_change: <FlagOutlined />,
  milestone: <ThunderboltOutlined />,
  manual: <SaveOutlined />,
};

const triggerColor: Record<string, string> = {
  chapter_complete: 'green',
  act_change: 'blue',
  milestone: 'gold',
  manual: 'purple',
};

const CheckpointTimeline: React.FC<CheckpointTimelineProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [cpManager] = useState(() => new CheckpointManager(novelId));
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(v => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  const checkpoint = useMemo(() => cpManager.load(), [cpManager, tick]);
  const summary = useMemo(() => cpManager.getSummary(), [cpManager, tick]);

  // Build timeline events from available data
  const timeline = useMemo(() => {
    const events: TimelineEvent[] = [];

    // Current checkpoint
    if (checkpoint) {
      events.push({
        id: 'current',
        timestamp: checkpoint.timestamp,
        type: 'checkpoint',
        trigger: 'manual',
        chapterIndex: checkpoint.chapterIndex,
        beatIndex: checkpoint.beatIndex,
        details: {
          status: checkpoint.autopilotState.status,
          stage: checkpoint.autopilotState.currentStage,
          progress: checkpoint.autopilotState.progress,
          totalChapters: checkpoint.autopilotState.targetChapterCount,
          foreshadowingCount: checkpoint.foreshadowingSnapshot.filter((f) => f.status === 'planted').length,
          tripleCount: checkpoint.memorySnapshot.factLock.relationshipGraph.length,
          beatCount: checkpoint.memorySnapshot.beatLock.completedBeats.length,
        },
        isHead: true,
      });
    }

    // Add beat completion events from completed beats
    const beats = repo.loadCompletedBeats();
    const beatByChapter = new Map<number, number>();
    for (const beat of beats) {
      const count = beatByChapter.get(beat.chapter) ?? 0;
      beatByChapter.set(beat.chapter, count + 1);
    }
    for (const [chapter, count] of beatByChapter) {
      if (!events.some((e) => e.chapterIndex === chapter)) {
        events.push({
          id: `beat-${chapter}`,
          timestamp: '',
          type: 'chapter_complete',
          trigger: 'chapter_complete',
          chapterIndex: chapter,
          beatIndex: count,
          details: { beatCount: count },
          isHead: false,
        });
      }
    }

    // Sort by chapter index
    events.sort((a, b) => b.chapterIndex - a.chapterIndex);
    return events;
  }, [checkpoint, repo, tick]);

  const formatDate = (iso: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return iso;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><HistoryOutlined style={{ marginRight: 6 }} />{t('checkpointTimeline.title')}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {summary && (
            <Tag color="blue" style={{ fontSize: 10 }}>HEAD: Ch.{summary.chapterIndex + 1}</Tag>
          )}
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={refresh} />
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {timeline.length === 0 ? (
          <Empty description={t('checkpointTimeline.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ position: 'relative', paddingLeft: 20 }}>
            {/* Timeline line */}
            <div style={{
              position: 'absolute', left: 8, top: 0, bottom: 0, width: 2,
              background: 'var(--border-secondary)',
            }} />

            {timeline.map((event) => {
              const isCheckpoint = event.type === 'checkpoint';
              const dotColor = isCheckpoint ? '#3b82f6' : '#22c55e';

              return (
                <div
                  key={event.id}
                  style={{
                    position: 'relative', paddingBottom: 16,
                    borderLeft: event.isHead ? '2px solid #3b82f6' : 'none',
                    marginLeft: -20,
                    paddingLeft: 28,
                  }}
                >
                  {/* Dot */}
                  <div style={{
                    position: 'absolute', left: -7, top: 4,
                    width: 12, height: 12, borderRadius: '50%',
                    background: dotColor,
                    border: `2px solid ${isCheckpoint ? '#3b82f6' : '#22c55e'}`,
                    boxShadow: event.isHead ? `0 0 6px ${dotColor}` : 'none',
                  }} />

                  {/* Event card */}
                  <Card
                    size="small"
                    style={{
                      background: event.isHead ? 'rgba(59,130,246,0.04)' : 'var(--bg-secondary, rgba(0,0,0,0.02))',
                      border: event.isHead ? '1px solid rgba(59,130,246,0.2)' : '1px solid var(--border-secondary)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <Space>
                        <Tag color={triggerColor[event.trigger] ?? 'default'} style={{ fontSize: 10 }}>
                          {triggerIcon[event.trigger]} {t(`checkpointTimeline.trigger.${event.trigger}`)}
                        </Tag>
                        {event.isHead && <Badge status="processing" />}
                        <Text strong style={{ fontSize: 12 }}>
                          {t('checkpointTimeline.chapterN', { chapter: event.chapterIndex + 1 })}
                        </Text>
                      </Space>
                      {event.timestamp && (
                        <Text type="secondary" style={{ fontSize: 10 }}>
                          <ClockCircleOutlined /> {formatDate(event.timestamp)}
                        </Text>
                      )}
                    </div>

                    {/* Details */}
                    {event.details && (
                      <Space wrap size={[4, 4]}>
                        {event.details.progress !== undefined && (
                          <Tag style={{ fontSize: 9 }}>
                            {t('checkpointTimeline.progress')}: {Math.round(event.details.progress * 100)}%
                          </Tag>
                        )}
                        {event.details.foreshadowingCount !== undefined && (
                          <Tag style={{ fontSize: 9 }}>
                            {t('checkpointTimeline.foreshadowing')}: {event.details.foreshadowingCount}
                          </Tag>
                        )}
                        {event.details.tripleCount !== undefined && (
                          <Tag style={{ fontSize: 9 }}>
                            {t('checkpointTimeline.triples')}: {event.details.tripleCount}
                          </Tag>
                        )}
                        {event.details.beatCount !== undefined && (
                          <Tag style={{ fontSize: 9 }}>
                            {t('checkpointTimeline.beats')}: {event.details.beatCount}
                          </Tag>
                        )}
                      </Space>
                    )}
                  </Card>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

interface TimelineEvent {
  id: string;
  timestamp: string;
  type: 'checkpoint' | 'chapter_complete' | 'act_change';
  trigger: string;
  chapterIndex: number;
  beatIndex: number;
  details: Record<string, any>;
  isHead: boolean;
}

export default CheckpointTimeline;

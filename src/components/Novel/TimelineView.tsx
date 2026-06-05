import React, { useMemo } from 'react';
import { Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FlagOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import type { TimelineAnchor, CompletedBeat, Foreshadowing } from '@/types/narrative';

const { Text } = Typography;

interface TimelineViewProps {
  anchors: TimelineAnchor[];
  beats: CompletedBeat[];
  foreshadowing: Foreshadowing[];
  totalChapters: number;
  width?: number;
  height?: number;
}

const EVENT_COLORS: Record<string, string> = {
  battle: '#ef4444',
  death: '#1f2937',
  revelation: '#8b5cf6',
  love: '#ec4899',
  betrayal: '#f97316',
  powerup: '#f59e0b',
  travel: '#06b6d4',
  meeting: '#22c55e',
  default: '#3b82f6',
};

const TimelineView: React.FC<TimelineViewProps> = ({
  anchors,
  beats,
  foreshadowing,
  totalChapters,
  width,
  height = 360,
}) => {
  const { t } = useTranslation();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ active: boolean; startX: number; scrollLeft: number }>({ active: false, startX: 0, scrollLeft: 0 });

  // Merge all events into chapter buckets — only include chapters that have data
  const chapters = useMemo(() => {
    const map: Record<number, {
      anchor?: TimelineAnchor;
      beats: CompletedBeat[];
      planted: Foreshadowing[];
      resolved: Foreshadowing[];
    }> = {};

    const ensureChapter = (ch: number) => {
      if (!map[ch]) map[ch] = { beats: [], planted: [], resolved: [] };
    };

    for (const a of anchors) {
      ensureChapter(a.chapter);
      map[a.chapter].anchor = a;
    }

    for (const b of beats) {
      ensureChapter(b.chapter);
      map[b.chapter].beats.push(b);
    }

    for (const f of foreshadowing) {
      ensureChapter(f.plantedInChapter);
      map[f.plantedInChapter].planted.push(f);
      if (f.resolvedInChapter) {
        ensureChapter(f.resolvedInChapter);
        map[f.resolvedInChapter].resolved.push(f);
      }
    }

    return Object.entries(map)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([ch, data]) => ({ chapter: Number(ch), ...data }));
  }, [anchors, beats, foreshadowing]);

  if (chapters.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height }}>
        <Text type="secondary">{t('common.noData')}</Text>
      </div>
    );
  }

  const getEventColor = (event: string): string => {
    const lower = event.toLowerCase();
    for (const [key, color] of Object.entries(EVENT_COLORS)) {
      if (lower.includes(key)) return color;
    }
    return EVENT_COLORS.default;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!scrollRef.current) return;
    dragRef.current = { active: true, startX: e.clientX, scrollLeft: scrollRef.current.scrollLeft };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current.active || !scrollRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    scrollRef.current.scrollLeft = dragRef.current.scrollLeft - dx;
  };

  const handleMouseUp = () => {
    dragRef.current.active = false;
  };

  const contentWidth = chapters.length * 160;

  return (
    <div style={{ position: 'relative', height }}>
      {/* Drag-to-scroll hint */}
      {contentWidth > (width ?? 600) && (
        <div style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 40,
          background: 'linear-gradient(to right, transparent, var(--bg-secondary, rgba(0,0,0,0.04)))',
          pointerEvents: 'none', zIndex: 1,
        }} />
      )}
      <div
        ref={scrollRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          overflowX: 'auto',
          overflowY: 'auto',
          height: '100%',
          cursor: dragRef.current.active ? 'grabbing' : 'grab',
        }}
      >
        <div style={{ minWidth: Math.max(contentWidth, width ?? 600), padding: '12px 0' }}>
          {/* Chapter columns */}
          <div style={{ display: 'flex', gap: 0 }}>
            {chapters.map((ch) => (
              <div
                key={ch.chapter}
                style={{
                  minWidth: 150,
                  maxWidth: 200,
                  borderRight: '1px solid var(--border-secondary, #e5e7eb)',
                  padding: '0 10px',
                  position: 'relative',
                }}
              >
                {/* Chapter header */}
                <div style={{
                  textAlign: 'center',
                  padding: '4px 0 8px',
                  borderBottom: '2px solid var(--accent-primary, #3b82f6)',
                  marginBottom: 8,
                }}>
                  <Text strong style={{ fontSize: 12 }}>
                    {t('novel.chapterOrder', { order: ch.chapter })}
                  </Text>
                  {ch.anchor?.inStoryTime && (
                    <div>
                      <Text type="secondary" style={{ fontSize: 10 }}>{ch.anchor.inStoryTime}</Text>
                    </div>
                  )}
                </div>

                {/* Events from anchor */}
                {ch.anchor?.events.map((event, i) => (
                  <Tooltip key={`e-${i}`} title={event}>
                    <div style={{
                      padding: '3px 6px',
                      marginBottom: 3,
                      borderRadius: 4,
                      background: `${getEventColor(event)}18`,
                      borderLeft: `3px solid ${getEventColor(event)}`,
                      fontSize: 11,
                      lineHeight: '16px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      <FlagOutlined style={{ color: getEventColor(event), fontSize: 9, marginRight: 4 }} />
                      {event}
                    </div>
                  </Tooltip>
                ))}

                {/* Completed beats */}
                {ch.beats.map((beat) => (
                  <Tooltip key={beat.beatId} title={beat.summary}>
                    <div style={{
                      padding: '3px 6px',
                      marginBottom: 3,
                      borderRadius: 4,
                      background: 'rgba(59,130,246,0.08)',
                      borderLeft: '3px solid #3b82f6',
                      fontSize: 11,
                      lineHeight: '16px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      <ThunderboltOutlined style={{ fontSize: 9, marginRight: 4, color: '#3b82f6' }} />
                      {beat.summary}
                    </div>
                  </Tooltip>
                ))}

                {/* Planted foreshadowing */}
                {ch.planted.map((f) => (
                  <Tooltip key={`p-${f.id}`} title={f.description}>
                    <div style={{
                      padding: '3px 6px',
                      marginBottom: 3,
                      borderRadius: 4,
                      background: 'rgba(139,92,246,0.08)',
                      borderLeft: '3px solid #8b5cf6',
                      fontSize: 11,
                      lineHeight: '16px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      <ExclamationCircleOutlined style={{ fontSize: 9, marginRight: 4, color: '#8b5cf6' }} />
                      {f.description}
                    </div>
                  </Tooltip>
                ))}

                {/* Resolved foreshadowing */}
                {ch.resolved.map((f) => (
                  <Tooltip key={`r-${f.id}`} title={f.description}>
                    <div style={{
                      padding: '3px 6px',
                      marginBottom: 3,
                      borderRadius: 4,
                      background: 'rgba(34,197,94,0.08)',
                      borderLeft: '3px solid #22c55e',
                      fontSize: 11,
                      lineHeight: '16px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      <CheckCircleOutlined style={{ fontSize: 9, marginRight: 4, color: '#22c55e' }} />
                      {f.description}
                    </div>
                  </Tooltip>
                ))}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, padding: '12px 10px 0', borderTop: '1px solid var(--border-secondary, #e5e7eb)', marginTop: 8 }}>
            <Tag style={{ fontSize: 10 }}><FlagOutlined /> {t('timeline.event')}</Tag>
            <Tag color="blue" style={{ fontSize: 10 }}><ThunderboltOutlined /> {t('timeline.beat')}</Tag>
            <Tag color="purple" style={{ fontSize: 10 }}><ExclamationCircleOutlined /> {t('timeline.planted')}</Tag>
            <Tag color="green" style={{ fontSize: 10 }}><CheckCircleOutlined /> {t('timeline.resolved')}</Tag>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimelineView;

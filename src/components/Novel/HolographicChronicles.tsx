// ============================================================================
// Holographic Chronicles — Dual-helix timeline: story events vs snapshots
// Left column: story-world events, Right column: checkpoints/snapshots
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Typography, Tag, List, Space, Empty, Tabs, Badge } from 'antd';
import {
  HistoryOutlined, ClockCircleOutlined, EyeOutlined,
  UnorderedListOutlined, AppstoreOutlined, BookOutlined,
  CameraOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { CheckpointManager } from '@/services/novel/checkpoint-manager';

const { Text } = Typography;

interface HolographicChroniclesProps {
  novelId: string;
}

const HolographicChronicles: React.FC<HolographicChroniclesProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [cpManager] = useState(() => new CheckpointManager(novelId));

  const storyEvents = useMemo(() => {
    const bible = repo.loadBible();
    const foreshadowing = repo.loadForeshadowing();
    const tensions = repo.loadTensionPoints();
    const beats = repo.loadCompletedBeats();
    const anchors = repo.loadTimelineAnchors();

    const events: ChronicleEvent[] = [];

    // Timeline anchors from Bible
    for (const anchor of anchors) {
      for (const evt of anchor.events) {
        events.push({
          chapter: anchor.chapter,
          type: 'story_event',
          label: evt,
          time: anchor.inStoryTime,
        });
      }
    }

    // Foreshadowing events
    for (const f of foreshadowing) {
      events.push({
        chapter: f.plantedInChapter,
        type: 'foreshadow_plant',
        label: f.description.slice(0, 60),
        significance: f.urgency,
      });
      if (f.resolvedInChapter !== undefined) {
        events.push({
          chapter: f.resolvedInChapter,
          type: 'foreshadow_resolve',
          label: f.description.slice(0, 60),
          significance: 'resolved',
        });
      }
    }

    // Tension peaks
    for (const tp of tensions) {
      if (tp.score >= 7) {
        events.push({
          chapter: tp.chapter,
          type: 'tension_peak',
          label: `Tension ${tp.score}/10`,
          significance: 'high',
        });
      }
    }

    // Completed beats as chapter markers
    const chapterBeats = new Map<number, number>();
    for (const beat of beats) {
      chapterBeats.set(beat.chapter, (chapterBeats.get(beat.chapter) ?? 0) + 1);
    }
    for (const [ch, count] of chapterBeats) {
      if (!events.some((e) => e.chapter === ch && e.type === 'story_event')) {
        events.push({
          chapter: ch,
          type: 'chapter_event',
          label: `${count} beats completed`,
          significance: 'normal',
        });
      }
    }

    events.sort((a, b) => a.chapter - b.chapter);
    return events;
  }, [repo]);

  const snapshots = useMemo(() => {
    const checkpoint = cpManager.load();
    const snapshotList: SnapshotEntry[] = [];

    if (checkpoint) {
      snapshotList.push({
        id: 'cp-current',
        chapter: checkpoint.chapterIndex,
        timestamp: checkpoint.timestamp,
        trigger: 'manual',
        beatIndex: checkpoint.beatIndex,
        foreshadowCount: checkpoint.foreshadowingSnapshot.filter((f) => f.status === 'planted').length,
        tripleCount: checkpoint.memorySnapshot.factLock.relationshipGraph.length,
      });
    }

    // Build synthetic snapshots from beat data
    const beats = repo.loadCompletedBeats();
    const chaptersDone = new Set(beats.map((b) => b.chapter));
    for (const ch of chaptersDone) {
      if (!snapshotList.some((s) => s.chapter === ch)) {
        snapshotList.push({
          id: `snap-${ch}`,
          chapter: ch,
          timestamp: '',
          trigger: 'chapter_complete',
          beatIndex: beats.filter((b) => b.chapter === ch).length,
        });
      }
    }

    snapshotList.sort((a, b) => a.chapter - b.chapter);
    return snapshotList;
  }, [cpManager, repo]);

  const maxChapter = Math.max(
    storyEvents.length > 0 ? storyEvents[storyEvents.length - 1].chapter : 0,
    snapshots.length > 0 ? snapshots[snapshots.length - 1].chapter : 0,
    1,
  );

  const typeColor: Record<string, string> = {
    story_event: 'blue',
    foreshadow_plant: 'orange',
    foreshadow_resolve: 'green',
    tension_peak: 'red',
    chapter_event: 'default',
  };

  const typeIcon: Record<string, React.ReactNode> = {
    story_event: <BookOutlined />,
    foreshadow_plant: <EyeOutlined />,
    foreshadow_resolve: <EyeOutlined />,
    tension_peak: <HistoryOutlined />,
    chapter_event: <ClockCircleOutlined />,
  };

  // Helix view
  const helixView = useMemo(() => {
    const rows: React.ReactNode[] = [];
    for (let ch = 0; ch <= maxChapter; ch++) {
      const leftEvents = storyEvents.filter((e) => e.chapter === ch);
      const rightSnaps = snapshots.filter((s) => s.chapter === ch);
      const hasContent = leftEvents.length > 0 || rightSnaps.length > 0;

      if (!hasContent) continue;

      rows.push(
        <div key={`ch-${ch}`} style={{
          display: 'grid', gridTemplateColumns: '1fr 40px 1fr', gap: 0,
          padding: '6px 0', borderBottom: '1px solid var(--border-secondary)',
        }}>
          {/* Left: Story events */}
          <div style={{ paddingRight: 8, textAlign: 'right' }}>
            {leftEvents.map((evt, idx) => (
              <div key={idx} style={{ marginBottom: 2 }}>
                <Tag color={typeColor[evt.type]} icon={typeIcon[evt.type]} style={{ fontSize: 9 }}>
                  {evt.label.length > 35 ? evt.label.slice(0, 35) + '...' : evt.label}
                </Tag>
              </div>
            ))}
          </div>
          {/* Center: Chapter marker */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column',
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              background: leftEvents.some((e) => e.type === 'tension_peak') ? '#ef4444' : '#3b82f6',
              color: '#fff', fontSize: 10, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {ch + 1}
            </div>
          </div>
          {/* Right: Snapshots */}
          <div style={{ paddingLeft: 8 }}>
            {rightSnaps.map((snap, idx) => (
              <div key={idx} style={{ marginBottom: 2 }}>
                <Tag color={snap.trigger === 'manual' ? 'purple' : 'cyan'} style={{ fontSize: 9 }}>
                  <CameraOutlined /> {snap.trigger === 'manual' ? 'Save' : 'Auto'}
                  {snap.foreshadowCount !== undefined && ` · ${snap.foreshadowCount}F`}
                </Tag>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return rows;
  }, [storyEvents, snapshots, maxChapter]);

  // List view
  const listView = (
    <List
      size="small"
      dataSource={storyEvents}
      renderItem={(evt) => (
        <List.Item style={{ padding: '4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <Tag color={typeColor[evt.type]} icon={typeIcon[evt.type]} style={{ fontSize: 9, minWidth: 60 }} />
            <Badge count={evt.chapter + 1} style={{ backgroundColor: '#3b82f6' }} />
            <Text style={{ fontSize: 11, flex: 1 }}>{evt.label}</Text>
            {evt.time && <Text type="secondary" style={{ fontSize: 9 }}>{evt.time}</Text>}
          </div>
        </List.Item>
      )}
    />
  );

  const tabItems = [
    {
      key: 'helix',
      label: <span><AppstoreOutlined /> {t('chronicles.helixView')}</span>,
      children: storyEvents.length === 0 ? (
        <Empty description={t('chronicles.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : <div style={{ overflow: 'auto' }}>{helixView}</div>,
    },
    {
      key: 'list',
      label: <span><UnorderedListOutlined /> {t('chronicles.listView')}</span>,
      children: storyEvents.length === 0 ? (
        <Empty description={t('chronicles.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : listView,
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><HistoryOutlined style={{ marginRight: 6 }} />{t('chronicles.title')}</span>
        <Space>
          <Badge count={storyEvents.length} style={{ backgroundColor: '#3b82f6' }} />
          <Badge count={snapshots.length} style={{ backgroundColor: '#22c55e' }} />
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        <Tabs items={tabItems} size="small" />
      </div>
    </div>
  );
};

interface ChronicleEvent {
  chapter: number;
  type: string;
  label: string;
  time?: string;
  significance?: string;
}

interface SnapshotEntry {
  id: string;
  chapter: number;
  timestamp: string;
  trigger: string;
  beatIndex: number;
  foreshadowCount?: number;
  tripleCount?: number;
}

export default HolographicChronicles;

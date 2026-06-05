import React, { useMemo } from 'react';
import { Tabs, Typography, Empty } from 'antd';
import { ApartmentOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import RelationshipGraph from './RelationshipGraph';
import TimelineView from './TimelineView';
import type { RelationshipTriple, TimelineAnchor, CompletedBeat, Foreshadowing } from '@/types/narrative';

const { Text } = Typography;

interface NarrativePanelProps {
  triples: RelationshipTriple[];
  anchors: TimelineAnchor[];
  beats: CompletedBeat[];
  foreshadowing: Foreshadowing[];
  totalChapters: number;
}

const NarrativePanel: React.FC<NarrativePanelProps> = ({
  triples,
  anchors,
  beats,
  foreshadowing,
  totalChapters,
}) => {
  const { t } = useTranslation();

  const hasData = triples.length > 0 || anchors.length > 0 || beats.length > 0 || foreshadowing.length > 0;

  if (!hasData) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Empty description={t('narrative.noData')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  return (
    <Tabs
      size="small"
      style={{ height: '100%' }}
      items={[
        {
          key: 'graph',
          label: <span><ApartmentOutlined /> {t('narrative.relationshipGraph')}</span>,
          children: (
            <div style={{ padding: '8px', display: 'flex', justifyContent: 'center' }}>
              <RelationshipGraph triples={triples} />
            </div>
          ),
        },
        {
          key: 'timeline',
          label: <span><ClockCircleOutlined /> {t('narrative.timeline')}</span>,
          children: (
            <TimelineView
              anchors={anchors}
              beats={beats}
              foreshadowing={foreshadowing}
              totalChapters={totalChapters}
            />
          ),
        },
      ]}
    />
  );
};

export default NarrativePanel;

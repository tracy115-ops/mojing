import React, { useMemo, useState, useEffect } from 'react';
import { Card, Empty, Typography, Descriptions } from 'antd';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';

const { Text } = Typography;

const CheckpointTimeline: React.FC<{ novelId: string }> = ({ novelId }) => {
  const { t } = useTranslation();
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const [, refresh] = useState(0);
  useEffect(() => repo.subscribe(['checkpoint'], () => refresh(n => n + 1)), [repo]);
  const checkpoint = repo.loadCheckpoint();
  const next = checkpoint?.nextChapterIndex;
  return (
    <div data-testid="novel-checkpoint" style={{ height: '100%', overflow: 'auto', padding: 12 }}>
      <Text strong>{t('checkpointTimeline.title')}</Text>
      <p><Text type="secondary">{t('workbench.checkpoint.hint')}</Text></p>
      {!checkpoint ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('checkpointTimeline.empty')} /> : (
        <Card size="small">
          <Descriptions column={1} size="small" items={[
            { key: 'time', label: t('checkpoint.savedAt', { time: '' }), children: new Date(checkpoint.timestamp).toLocaleString() },
            { key: 'chapter', label: t('workbench.checkpoint.savedChapter'), children: t('novel.chapterOrder', { order: checkpoint.chapterIndex + 1 }) },
            { key: 'resume', label: t('workbench.checkpoint.next'), children: next === undefined ? t('workbench.checkpoint.legacy') : next >= checkpoint.autopilotState.targetChapterCount ? t('workbench.checkpoint.finished') : t('novel.chapterOrder', { order: next + 1 }) },
          ]} />
        </Card>
      )}
    </div>
  );
};
export default CheckpointTimeline;

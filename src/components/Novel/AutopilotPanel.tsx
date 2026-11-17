import React, { useMemo, useState, useEffect } from 'react';
import { Alert, Button, Progress, Tag, Space, Typography } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, StopOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { NarrativeRepository } from '@/services/novel/narrative-repository';

const { Text } = Typography;

interface AutopilotPanelProps {
  novelId: string;
  novelTitle: string;
  genre: string;
  targetWordCount: number;
  currentWordCount: number;
  chapterCount: number;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const AutopilotPanel: React.FC<AutopilotPanelProps> = ({
  novelId, novelTitle, genre, targetWordCount, currentWordCount, onStart, onPause, onResume, onStop,
}) => {
  const { t } = useTranslation();
  const state = useAutopilotStore(s => s.states[novelId]);
  const beat = useAutopilotStore(s => s.beatProgress[novelId]);
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const [, refresh] = useState(0);
  useEffect(() => repo.subscribe(['checkpoint'], () => refresh(n => n + 1)), [repo]);
  const checkpoint = repo.loadCheckpoint();
  const status = state?.status || 'idle';
  const running = status === 'running';
  const paused = status === 'paused';
  const stages: Record<string, string> = {
    global_planning: 'globalPlanning', macro_planning: 'macroPlanning', act_beat_planning: 'actBeatPlanning',
    chapter_generation: 'chapterGeneration', chapter_review: 'chapterReview',
  };
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-base)', background: 'var(--bg-container)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Text strong>{t('novel.engine.autopilot')}</Text> <Tag>{t('novel.engine.autopilot.' + status)}</Tag>
          <div><Text type="secondary" style={{ fontSize: 12 }}>{t('autopilot.desc', {
            title: novelTitle, genre: t('novel.genre.' + genre), chapters: state?.targetChapterCount || Math.max(1, Math.ceil(targetWordCount / 3000)),
          })}</Text></div>
        </div>
        <Space>
          {running ? <Button size="small" icon={<PauseCircleOutlined />} onClick={onPause}>{t('autopilot.pause')}</Button>
            : <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={paused ? onResume : onStart}>{t(paused ? 'autopilot.resume' : 'autopilot.start')}</Button>}
          {(running || paused) && <Button size="small" danger icon={<StopOutlined />} onClick={onStop}>{t('autopilot.stop')}</Button>}
        </Space>
      </div>
      {status === 'idle' && checkpoint && <div style={{ marginTop: 8 }}>
        <Text type="secondary">{t('workbench.checkpoint.savedChapter')}: {t('novel.chapterOrder', { order: checkpoint.chapterIndex + 1 })}. {t('workbench.checkpoint.hint')}</Text>
      </div>}
      {(running || paused || status === 'completed') && <div style={{ marginTop: 8 }}>
        <Text type="secondary">{t('workbench.pipeline.currentStage')}: {stages[state?.currentStage || ''] ? t('novel.engine.stage.' + stages[state!.currentStage]) : t('autopilotPipeline.status.idle')}</Text>
        {state && <Progress percent={Math.round(Math.max(0, Math.min(1, state.progress)) * 100)} size="small" status={running ? 'active' : 'normal'} />}
        {running && beat && <Text type="secondary">{t('autopilotPipeline.beatProgress', { current: beat.currentBeatIndex + 1, total: beat.totalBeats })} · {beat.chapterWordCount} {t('autopilot.words')}</Text>}
        {status === 'completed' && <Text type="secondary">{t('workbench.pipeline.finishedHint', { count: currentWordCount })}</Text>}
      </div>}
      {state?.lastError && <Alert style={{ marginTop: 8 }} type={status === 'error' ? 'error' : 'warning'} showIcon message={state.lastError} />}
    </div>
  );
};
export default AutopilotPanel;

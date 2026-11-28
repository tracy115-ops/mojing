import React from 'react';
import { Alert, Card, Empty, Progress, Tag, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';

const { Text } = Typography;

// Render actual runtime state. Stage order does not prove a stage completed successfully.
const AutopilotPipelineView: React.FC<{ novelId: string }> = ({ novelId }) => {
  const { t } = useTranslation();
  const state = useAutopilotStore(s => s.states[novelId]);
  const beat = useAutopilotStore(s => s.beatProgress[novelId]);
  const status = state?.status || 'idle';
  const stages: Record<string, string> = {
    global_planning: 'globalPlanning', macro_planning: 'macroPlanning',
    act_beat_planning: 'beatPlanning', chapter_generation: 'generation', chapter_review: 'review',
  };
  return (
    <div data-testid="autopilot-runtime" style={{ height: '100%', overflow: 'auto', padding: 12 }}>
      <Text strong>{t('autopilotPipeline.title')}</Text>
      <p><Text type="secondary">{t('workbench.pipeline.hint')}</Text></p>
      {!state ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('autopilotPipeline.empty')} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Tag color={status === 'error' ? 'error' : status === 'paused' ? 'warning' : 'default'}>{t('autopilotPipeline.status.' + status)}</Tag>
          {state.lastError && <Alert type={status === 'error' ? 'error' : 'warning'} showIcon message={state.lastError} />}
          <Card size="small">
            <p>{t('novel.chapterOrder', { order: Math.min(state.currentChapterNumber + 1, state.targetChapterCount || 1) })} / {state.targetChapterCount}</p>
            <p>{t('workbench.pipeline.currentStage')}: {stages[state.currentStage] ? t('autopilotPipeline.stage.' + stages[state.currentStage]) : t('autopilotPipeline.status.idle')}</p>
            <Progress percent={Math.round(Math.max(0, Math.min(1, state.progress)) * 100)} status={status === 'error' ? 'exception' : status === 'running' ? 'active' : 'normal'} />
            {state.currentStage === 'chapter_generation' && beat && <p>{t('autopilotPipeline.beatProgress', { current: beat.currentBeatIndex + 1, total: beat.totalBeats })}</p>}
          </Card>
          {state.currentChapterContent && <Card size="small" title={t('workbench.pipeline.draft')}>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{state.currentChapterContent}</div>
          </Card>}
        </div>
      )}
    </div>
  );
};
export default AutopilotPipelineView;

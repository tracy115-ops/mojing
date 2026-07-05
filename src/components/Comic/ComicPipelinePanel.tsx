import React, { useState, useMemo } from 'react';
import { Button, Card, Empty, Tag, Typography, Progress, message, Tooltip, Space } from 'antd';
import { PlayCircleOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import { runComicPipeline, runSingleStage, runFromStage } from '@/services/comic/core/pipeline-runner';
import { COMIC_PIPELINE_STAGES, COMIC_STAGE_INPUT_FIELDS } from '@/types/comic';
import type { ComicStage, ComicStageState, ComicTrackedStage } from '@/types/comic';
import { logger } from '@/services/log';

const { Text, Paragraph, Title } = Typography;

interface ComicPipelinePanelProps {
  projectId: string;
}

const STAGE_LABEL_KEYS: Record<ComicTrackedStage, string> = {
  character_anchor: 'comic.pipeline.character_anchor',
  panel_script: 'comic.pipeline.panel_script',
  panel_image: 'comic.pipeline.panel_image',
};

const ComicPipelinePanel: React.FC<ComicPipelinePanelProps> = ({ projectId }) => {
  const { t } = useTranslation();
  const project = useComicStore((s) => s.projects[projectId]);
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    try {
      const ok = await runComicPipeline(projectId, {
        onError: (msg) => message.error(msg),
      });
      if (!ok) {
        message.error(t('comic.pipeline.runFailed'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(msg);
      void logger.error(`[comic-panel] runComicPipeline 抛错: ${msg}`, 'comic');
    } finally {
      setRunning(false);
    }
  };

  const handleRerunSingle = async (stage: ComicTrackedStage) => {
    if (running) return;
    setRunning(true);
    try {
      const ok = await runSingleStage(projectId, stage);
      if (ok) message.success(t('comic.pipeline.rerunSingleDone'));
      else message.error(t('comic.pipeline.rerunFailed'));
    } finally {
      setRunning(false);
    }
  };

  const handleRerunFrom = async (stage: ComicTrackedStage) => {
    if (running) return;
    setRunning(true);
    try {
      const ok = await runFromStage(projectId, stage);
      if (ok) message.success(t('comic.pipeline.rerunFromDone'));
      else message.error(t('comic.pipeline.rerunFailed'));
    } finally {
      setRunning(false);
    }
  };

  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description={t('comic.pipeline.notFound')} />
      </div>
    );
  }

  const isComplete = project.currentStage === 'complete';
  const finalPages = project.finalPageUrls ?? [];

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* 左侧:stage 列表 */}
      <div
        style={{
          width: 220,
          borderRight: '1px solid var(--border-secondary)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--border-secondary)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Text strong style={{ fontSize: 13 }}>
            {t('comic.pipeline.title')}
          </Text>
          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            onClick={handleRun}
            loading={running}
            disabled={running}
          >
            {isComplete ? t('comic.pipeline.rerunAll') : t('comic.pipeline.run')}
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
          {COMIC_PIPELINE_STAGES.map((stage) => {
            const state = project.stages[stage];
            if (!state) return null;
            return (
              <StageRow
                key={stage}
                stage={stage}
                state={state}
                label={t(STAGE_LABEL_KEYS[stage])}
                running={running}
                onRerunSingle={() => handleRerunSingle(stage)}
                onRerunFrom={() => handleRerunFrom(stage)}
              />
            );
          })}
        </div>
      </div>

      {/* 右侧:产物展示 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* 项目信息卡 */}
          <Card size="small" title={project.title}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="blue">
                {t('comic.style')}: {project.style}
              </Tag>
              <Tag>{t('comic.panelLayout')}: {project.panelLayout}</Tag>
              <Tag>{t('comic.aspectRatio')}: {project.aspectRatio}</Tag>
              <Tag>{t('comic.panelCount')}: {project.panelCount}</Tag>
            </div>
            {project.sourceText && (
              <Paragraph
                style={{ marginTop: 8, color: 'var(--text-secondary)', marginBottom: 0 }}
                ellipsis={{ rows: 3, expandable: true, symbol: t('common.expand') }}
              >
                {project.sourceText}
              </Paragraph>
            )}
          </Card>

          {/* 最终产物:分镜网格 */}
          <Card
            size="small"
            title={
              <span>
                <ThunderboltOutlined /> {t('comic.pipeline.panels')}
              </span>
            }
          >
            {finalPages.length === 0 ? (
              <Empty description={t('comic.pipeline.noPanelsYet')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 12,
                }}
              >
                {project.spec.panels.map((panel) => (
                  <PanelCard key={panel.id} panel={panel} />
                ))}
              </div>
            )}
          </Card>
        </Space>
      </div>
    </div>
  );
};

// --- 单个 stage 行 ---

interface StageRowProps {
  stage: ComicTrackedStage;
  state: ComicStageState;
  label: string;
  running: boolean;
  onRerunSingle: () => void;
  onRerunFrom: () => void;
}

const StageRow: React.FC<StageRowProps> = ({
  stage,
  state,
  label,
  running,
  onRerunSingle,
  onRerunFrom,
}) => {
  const { t } = useTranslation();
  const statusColor = {
    pending: 'default',
    running: 'processing',
    completed: 'success',
    skipped: 'default',
    error: 'error',
  }[state.status];

  const fieldDef = COMIC_STAGE_INPUT_FIELDS[stage];
  const hasInput = !!fieldDef && fieldDef.length > 0;

  return (
    <div
      style={{
        padding: '6px 8px',
        margin: '2px 0',
        borderRadius: 4,
        background: state.status === 'running' ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text strong style={{ fontSize: 12 }}>
          {label}
        </Text>
        <Tag color={statusColor} style={{ fontSize: 11, margin: 0 }}>
          {t(`comic.pipeline.status.${state.status}`)}
        </Tag>
      </div>
      {state.status === 'running' && (
        <Progress percent={Math.round((state.progress ?? 0) * 100)} size="small" style={{ marginTop: 4 }} />
      )}
      {state.error && (
        <Tooltip title={state.error}>
          <Text type="danger" style={{ fontSize: 11 }}>
            {state.error.slice(0, 40)}...
          </Text>
        </Tooltip>
      )}
      {state.status !== 'running' && (
        <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            onClick={onRerunSingle}
            disabled={running || !hasInput}
            title={t('comic.pipeline.rerunSingle')}
            style={{ fontSize: 11, padding: '0 4px' }}
          >
            {t('comic.pipeline.rerunSingle')}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<ThunderboltOutlined />}
            onClick={onRerunFrom}
            disabled={running}
            title={t('comic.pipeline.rerunFromHere')}
            style={{ fontSize: 11, padding: '0 4px' }}
          >
            {t('comic.pipeline.rerunFromHere')}
          </Button>
        </div>
      )}
    </div>
  );
};

// --- 单个分镜卡 ---

interface PanelCardProps {
  panel: import('@/types/comic').ComicPanelSpec;
}

const PanelCard: React.FC<PanelCardProps> = ({ panel }) => {
  const { t } = useTranslation();
  return (
    <Card
      size="small"
      hoverable
      cover={
        panel.imageUrl ? (
          <img
            src={panel.imageUrl}
            alt={`panel ${panel.index + 1}`}
            style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              aspectRatio: '1 / 1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--bg-secondary)',
            }}
          >
            <Text type="secondary">{t('comic.pipeline.noPanelImage')}</Text>
          </div>
        )
      }
    >
      <Text strong style={{ fontSize: 12 }}>
        #{panel.index + 1}
      </Text>{' '}
      <Text type="secondary" style={{ fontSize: 11 }}>
        {panel.shotType}
      </Text>
      {panel.dialogue && (
        <Paragraph
          style={{ marginTop: 4, marginBottom: 0, fontSize: 12, color: 'var(--text-secondary)' }}
          ellipsis={{ rows: 2 }}
        >
          「{panel.dialogue}」
        </Paragraph>
      )}
    </Card>
  );
};

export default ComicPipelinePanel;

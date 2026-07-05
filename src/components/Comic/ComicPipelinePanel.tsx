import React, { useState, useMemo, useEffect } from 'react';
import { Button, Card, Empty, Tag, Typography, Progress, message, Tooltip, Space } from 'antd';
import { PlayCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import { runComicPipeline } from '@/services/comic/core/pipeline-runner';
import { COMIC_PIPELINE_STAGES } from '@/types/comic';
import type { ComicStageState, ComicTrackedStage } from '@/types/comic';
import { logger } from '@/services/log';
import ComicStageInputEditor from './ComicStageInputEditor';

const { Text, Paragraph } = Typography;

interface ComicPipelinePanelProps {
  projectId: string;
}

const STAGE_LABEL_KEYS: Record<ComicTrackedStage, string> = {
  character_anchor: 'comic.pipeline.character_anchor',
  panel_script: 'comic.pipeline.panel_script',
  panel_image: 'comic.pipeline.panel_image',
  dialogue_burn: 'comic.pipeline.dialogue_burn',
};

const ComicPipelinePanel: React.FC<ComicPipelinePanelProps> = ({ projectId }) => {
  const { t } = useTranslation();
  const project = useComicStore((s) => s.projects[projectId]);
  const [running, setRunning] = useState(false);
  const [selectedStage, setSelectedStage] = useState<ComicTrackedStage>('panel_image');

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

  // 自动选中"当前活跃 stage"或最后一个完成的 stage
  useEffect(() => {
    if (!project) return;
    const running = COMIC_PIPELINE_STAGES.find(
      (s) => project.stages[s]?.status === 'running',
    );
    if (running) {
      setSelectedStage(running);
      return;
    }
    // 默认聚焦到第一个未完成的 stage;若全部完成,聚焦最后一个
    const firstIncomplete = COMIC_PIPELINE_STAGES.find(
      (s) => project.stages[s]?.status !== 'completed',
    );
    if (firstIncomplete) {
      setSelectedStage(firstIncomplete);
    } else {
      setSelectedStage(COMIC_PIPELINE_STAGES[COMIC_PIPELINE_STAGES.length - 1]);
    }
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description={t('comic.pipeline.notFound')} />
      </div>
    );
  }

  const isComplete = project.currentStage === 'complete';

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
                selected={selectedStage === stage}
                onSelect={() => setSelectedStage(stage)}
              />
            );
          })}
        </div>
      </div>

      {/* 右侧:选中 stage 的详情 + 全局产物 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* 项目信息卡(紧凑) */}
          <Card size="small" title={project.title}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="blue">
                {t('comic.style')}: {project.style}
              </Tag>
              <Tag>{t('comic.aspectRatio')}: {project.aspectRatio}</Tag>
              <Tag>{t('comic.panelCount')}: {project.panelCount}</Tag>
            </div>
            {project.sourceText && (
              <Paragraph
                style={{ marginTop: 8, color: 'var(--text-secondary)', marginBottom: 0, fontSize: 12 }}
                ellipsis={{ rows: 2, expandable: true, symbol: t('common.expand') }}
              >
                {project.sourceText}
              </Paragraph>
            )}
          </Card>

          {/* 选中 stage 详情 */}
          <Card
            size="small"
            title={
              <span>
                <ThunderboltOutlined /> {t('comic.pipeline.stageDetail')}:{' '}
                {t(STAGE_LABEL_KEYS[selectedStage])}
              </span>
            }
          >
            <ComicStageInputEditor stage={selectedStage} project={project} />
          </Card>

          {/* 选中 stage 的产物 */}
          <StageArtifacts stage={selectedStage} project={project} />
        </Space>
      </div>
    </div>
  );
};

// --- 单个 stage 行(可选中) ---

interface StageRowProps {
  stage: ComicTrackedStage;
  state: ComicStageState;
  label: string;
  selected: boolean;
  onSelect: () => void;
}

const StageRow: React.FC<StageRowProps> = ({ stage, state, label, selected, onSelect }) => {
  const { t } = useTranslation();
  const statusColor = {
    pending: 'default',
    running: 'processing',
    completed: 'success',
    skipped: 'default',
    error: 'error',
  }[state.status];

  return (
    <div
      onClick={onSelect}
      style={{
        padding: '6px 8px',
        margin: '2px 0',
        borderRadius: 4,
        cursor: 'pointer',
        background: selected
          ? 'var(--bg-active, rgba(59,130,246,0.16))'
          : state.status === 'running'
            ? 'var(--bg-active, rgba(59,130,246,0.08))'
            : 'transparent',
        borderLeft: selected ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
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
          <Text type="danger" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
            {state.error.slice(0, 40)}
            {state.error.length > 40 ? '...' : ''}
          </Text>
        </Tooltip>
      )}
    </div>
  );
};

// --- 选中 stage 的产物 ---

interface StageArtifactsProps {
  stage: ComicTrackedStage;
  project: import('@/types/comic').ComicPipelineProject;
}

const StageArtifacts: React.FC<StageArtifactsProps> = ({ stage, project }) => {
  const { t } = useTranslation();

  if (stage === 'character_anchor') {
    const characters = project.spec.characters;
    return (
      <Card size="small" title={t('comic.characters')}>
        {characters.length === 0 ? (
          <Empty description={t('comic.pipeline.noPanelsYet')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: 8,
            }}
          >
            {characters.map((c) => (
              <Card
                key={c.id}
                size="small"
                hoverable
                cover={
                  c.portraitImage ? (
                    <img
                      src={c.portraitImage}
                      alt={c.name}
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
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {t('comic.pipeline.noPanelImage')}
                      </Text>
                    </div>
                  )
                }
              >
                <Text strong style={{ fontSize: 12 }} ellipsis>
                  {c.name}
                </Text>
                {c.turnaroundImage && (
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 10 }}>
                      ✓ turnaround
                    </Text>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Card>
    );
  }

  if (stage === 'panel_script') {
    const panels = project.spec.panels;
    return (
      <Card size="small" title={t('comic.pipeline.panels')}>
        {panels.length === 0 ? (
          <Empty description={t('comic.pipeline.noPanelsYet')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 8,
            }}
          >
            {panels.map((p, i) => (
              <div
                key={p.id}
                style={{
                  padding: 8,
                  borderRadius: 4,
                  border: '1px solid var(--border-secondary)',
                  background: 'var(--bg-secondary, transparent)',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 12 }}>
                    #{i + 1}
                  </Text>
                  {p.shotType && (
                    <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>{p.shotType}</Tag>
                  )}
                </div>
                <Paragraph
                  style={{ marginBottom: 4, fontSize: 12, color: 'var(--text-primary)' }}
                  ellipsis={{ rows: 3 }}
                >
                  {p.description}
                </Paragraph>
                {p.dialogue && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    「{p.dialogue}」
                  </Text>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    );
  }

  // panel_image / dialogue_burn:都显示分镜图(dialogue_burn 烧录后 imageUrl 已替换)
  const panels = project.spec.panels;
  return (
    <Card size="small" title={t('comic.pipeline.panels')}>
      {panels.length === 0 ? (
        <Empty description={t('comic.pipeline.noPanelsYet')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          {panels.map((panel) => (
            <PanelCard key={panel.id} panel={panel} />
          ))}
        </div>
      )}
    </Card>
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

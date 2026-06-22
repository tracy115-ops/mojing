// ============================================================================
// VideoPipelinePanel — 视频流水线常驻面板
// ----------------------------------------------------------------------------
// 从 VideoGeneratorModal.RunningPane + DonePane 抽出来的执行过程视图。
// VideoView 主区域 Tabs 的"执行过程"页。pipelineId 由 videoStore.activePipelineId
// 决定(由 VideoGeneratorModal/DirectVideoModal 启动时写入)。
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  Typography, Tag, Steps, Card, Spin, Empty, Divider, Button, Space, Dropdown, Menu, Alert, Popconfirm, Tooltip,
} from 'antd';
import {
  VideoCameraOutlined, PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, EyeOutlined, DownOutlined, DownloadOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoStage, StoryboardShot } from '@/types/video';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';
import StageArtifactsModal, { renderStageContent, Section } from './StageArtifactsModal';
import ExportVideoModal from './ExportVideoModal';

const { Text, Title } = Typography;

const STAGE_ICONS: Record<VideoStage, React.ReactNode> = {
  idle: <CheckCircleOutlined />,
  script_slicing: <VideoCameraOutlined />,
  storyboard_prompt: <VideoCameraOutlined />,
  extraction: <VideoCameraOutlined />,
  voice_assignment: <VideoCameraOutlined />,
  character_anchor: <VideoCameraOutlined />,
  scene_image: <VideoCameraOutlined />,
  tts: <VideoCameraOutlined />,
  keyframe_image: <VideoCameraOutlined />,
  video_generation: <PlayCircleOutlined />,
  audio_merge: <VideoCameraOutlined />,
  composing: <VideoCameraOutlined />,
  complete: <CheckCircleOutlined />,
  error: <CloseCircleOutlined />,
};

function getShotStatus(
  clips: { shotId: string }[],
  currentStage: VideoStage | undefined,
  shot: StoryboardShot,
): 'pending' | 'running' | 'done' | 'error' {
  const clip = clips.find((c) => c.shotId === shot.id);
  if (clip) return 'done';
  if (currentStage === 'video_generation') return 'running';
  return 'pending';
}

function stageStatusColor(s: string): string {
  switch (s) {
    case 'completed': return 'success';
    case 'running': return 'processing';
    case 'error': return 'error';
    case 'skipped': return 'default';
    default: return 'default';
  }
}

const ShotRow: React.FC<{
  shot: StoryboardShot;
  status: 'pending' | 'running' | 'done' | 'error';
}> = ({ shot, status }) => {
  const { t } = useTranslation();
  return (
    <Card size="small" style={{ marginBottom: 6 }} bodyStyle={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Tag color={status === 'done' ? 'success' : status === 'running' ? 'processing' : 'default'}>
          {t('video.gen.shot')} {shot.index + 1}
        </Tag>
        <Text style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }} ellipsis>
          {shot.videoPrompt || shot.sourceText.slice(0, 100)}
        </Text>
      </div>
    </Card>
  );
};

interface VideoPipelinePanelProps {
  pipelineId: string | null;
}

const VideoPipelinePanel: React.FC<VideoPipelinePanelProps> = ({ pipelineId }) => {
  const { t } = useTranslation();
  // 拆细 selector:每条只订阅一个字段,避免 appendInvocation/setStageStatus 的高频更新
  // 触发整面板(Steps + Shots 列表)重渲——这是之前"执行过程中卡住点不动"的根因。
  const exists = useVideoStore((s) => !!(pipelineId && s.projects[pipelineId]));
  const currentStage = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.currentStage : undefined));
  const stages = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.stages : undefined));
  const shots = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.shots : undefined));
  const clips = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.clips : undefined));
  const sceneSpec = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.sceneSpec : undefined));
  const project = useVideoStore((s) => (pipelineId ? s.projects[pipelineId] : undefined));
  const finalVideoUrl = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.finalVideoUrl : undefined));
  const finalMeta = useVideoStore(useShallow((s) => {
    if (!pipelineId) return { dur: undefined, size: undefined };
    const p = s.projects[pipelineId];
    return { dur: p?.finalDurationSeconds, size: p?.finalSizeBytes };
  }));
  const errorMsg = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.error : undefined));
  const resetProject = useVideoStore((s) => s.resetProject);
  const setActivePipelineId = useVideoStore((s) => s.setActivePipelineId);
  const [artifactStage, setArtifactStage] = useState<VideoStage | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // 用户点 Steps 上某个已完成步骤时,切换内联产物视图到该步骤。
  // null = 自动跟随(currentStage 优先,否则最近完成的步骤)。
  const [focusStage, setFocusStage] = useState<VideoStage | null>(null);

  // 如果 pipelineId 关联到小说项目,显示小说标题;否则按 Direct 处理
  const novelTitle = useProjectStore((s) => {
    if (!pipelineId || !exists) return undefined;
    if (pipelineId.startsWith('direct_')) return undefined;
    const np = s.projects.find((p) => p.id === pipelineId);
    return np?.title;
  });

  const headerLabel = useMemo(() => {
    if (!exists) return '';
    if (pipelineId?.startsWith('direct_')) return t('video.pipeline.directLabel');
    if (novelTitle) return t('video.pipeline.fromNovelLabel', { title: novelTitle });
    return t('video.pipeline.title');
  }, [exists, pipelineId, novelTitle, t]);

  if (!pipelineId || !exists || !stages || !shots || !clips) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Empty description={t('video.pipeline.empty')} />
      </div>
    );
  }

  const visibleStages = VIDEO_PIPELINE_STAGES.filter((s) => !DEFAULT_SKIPPED_STAGES.has(s));
  const activeStageIdx = currentStage ? VIDEO_PIPELINE_STAGES.indexOf(currentStage) : -1;

  const completedStages = visibleStages.filter((s) => stages[s]?.status === 'completed');

  // 整体状态
  const overall: 'idle' | 'running' | 'complete' | 'error' = (() => {
    if (currentStage === 'complete') return 'complete';
    if (currentStage === 'error' || errorMsg) return 'error';
    if (currentStage === 'idle') return 'idle';
    return 'running';
  })();
  const statusColor = { idle: 'default', running: 'processing', complete: 'success', error: 'error' }[overall];
  const statusLabel = t(`video.pipeline.status.${overall}`);

  // 内联产物展示聚焦的 stage:
  // - 用户点了 Steps 上某个 stage → 用那个
  // - 否则:如果当前在运行,聚焦当前 stage(看实时进度)
  // - 否则:聚焦最近完成的 stage(看上一步产物)
  // - 都没有:聚焦第一个 visible stage(占位)
  const inlineStage: VideoStage = focusStage
    ?? (currentStage && currentStage !== 'complete' && currentStage !== 'error' && currentStage !== 'idle'
      ? currentStage
      : null)
    ?? completedStages[completedStages.length - 1]
    ?? visibleStages[0];

  const sizeLabel = finalMeta.size
    ? `${(finalMeta.size / 1024 / 1024).toFixed(1)} MB`
    : undefined;
  const durLabel = finalMeta.dur
    ? `${finalMeta.dur.toFixed(1)}s`
    : undefined;
  const metaLabel = [durLabel, sizeLabel].filter(Boolean).join(' · ');

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 12, flexWrap: 'wrap', gap: 8,
      }}>
        <Space size={8} align="center">
          <Title level={5} style={{ margin: 0 }}>{headerLabel}</Title>
          <Tag color={statusColor}>{statusLabel}</Tag>
          {errorMsg && (
            <Text type="danger" style={{ fontSize: 12 }} ellipsis>
              {errorMsg}
            </Text>
          )}
        </Space>
        <Space>
          <Dropdown
            overlay={(
              <Menu
                onClick={(e) => setArtifactStage(e.key as VideoStage)}
                items={completedStages.map((s) => ({ key: s, label: t(`video.gen.stage.${s}`) }))}
              />
            )}
          >
            <Button icon={<EyeOutlined />} disabled={completedStages.length === 0}>
              {t('video.artifacts.viewStage')} <DownOutlined />
            </Button>
          </Dropdown>
          {finalVideoUrl && (
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>
              {t('video.export.button')}
            </Button>
          )}
          <Popconfirm
            title={t('video.pipeline.resetConfirm')}
            onConfirm={() => {
              if (pipelineId) resetProject(pipelineId);
              setActivePipelineId(undefined);
            }}
          >
            <Button icon={<ReloadOutlined />} danger>
              {t('video.pipeline.reset')}
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {/* 错误展示:整条 pipeline 报错,或任一 stage 报错,都展示在这里,让用户能再次查看 */}
      {(() => {
        const stageErrors = visibleStages
          .map((s) => ({ stage: s, err: stages[s]?.error }))
          .filter((x): x is { stage: VideoStage; err: string } => !!x.err);
        const topErr = errorMsg;
        if (!topErr && stageErrors.length === 0) return null;
        return (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}
            message={topErr ?? t('video.pipeline.stageErrorTitle')}
            description={
              topErr ? null : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                  {stageErrors.map((x) => (
                    <li key={x.stage}>
                      <strong>{t(`video.gen.stage.${x.stage}`)}</strong>: {x.err}
                    </li>
                  ))}
                </ul>
              )
            }
          />
        );
      })()}

      {/* Stage steps */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Steps
          current={Math.max(0, activeStageIdx)}
          size="small"
          direction="horizontal"
          responsive
          items={visibleStages.map((stage) => {
            const state = stages[stage];
            const skipped = DEFAULT_SKIPPED_STAGES.has(stage);
            const completed = state?.status === 'completed';
            let icon: React.ReactNode = STAGE_ICONS[stage];
            let status: 'wait' | 'process' | 'finish' | 'error' = 'wait';
            if (skipped) {
              status = 'wait';
              icon = <CloseCircleOutlined style={{ opacity: 0.3 }} />;
            } else if (completed) {
              status = 'finish';
            } else if (state?.status === 'running') {
              status = 'process';
              icon = <LoadingOutlined />;
            } else if (state?.status === 'error') {
              status = 'error';
            }
            return {
              title: (
                <span
                  style={completed ? { cursor: 'pointer', color: 'var(--accent-primary)' } : undefined}
                  onClick={() => completed && setFocusStage(stage)}
                >
                  {t(`video.gen.stage.${stage}`)}
                  {completed && (
                    <Tooltip title={t('video.pipeline.clickToView')}>
                      <EyeOutlined
                        style={{ marginLeft: 4, fontSize: 11 }}
                        onClick={(e) => { e.stopPropagation(); setFocusStage(stage); }}
                      />
                    </Tooltip>
                  )}
                </span>
              ),
              description: state?.progress !== undefined && state.progress > 0 && state.status === 'running'
                ? `${Math.round(state.progress * 100)}%`
                : undefined,
              status,
              icon,
            };
          })}
        />
      </Card>

      {/* Final video preview when complete */}
      {overall === 'complete' && (
        <>
          {finalVideoUrl ? (
            <>
              <video
                src={finalVideoUrl}
                controls
                style={{ width: '100%', maxHeight: 400, background: '#000', borderRadius: 6 }}
              />
              {metaLabel && (
                <div style={{ marginTop: 6, marginBottom: 6 }}>
                  <Tag color="blue" style={{ fontSize: 11 }}>{metaLabel}</Tag>
                </div>
              )}
            </>
          ) : (
            <Empty description={t('video.gen.noVideoYet')} />
          )}
          <Divider style={{ margin: '12px 0' }} />
        </>
      )}

      {/* ── 当前步骤产物(内联展示,不再需要点 Modal) ── */}
      {/* 用户在 Steps 上点击已完成/进行中的步骤可切换 focus;默认跟随当前 stage */}
      {project && (
        <Card
          size="small"
          style={{ marginBottom: 12 }}
          title={
            <Space size={6} wrap>
              <Text strong>{t('video.pipeline.inlineArtifacts')}</Text>
              <Tag color="blue">{t(`video.gen.stage.${inlineStage}`)}</Tag>
              {stages[inlineStage]?.status && (
                <Tag color={stageStatusColor(stages[inlineStage]!.status!)}>
                  {t(`video.artifacts.status.${stages[inlineStage]!.status}`)}
                </Tag>
              )}
              {/* 步骤切换器:点击 Steps 上任意完成/进行中的步骤即可切换内联视图 */}
              {visibleStages
                .filter((s) => stages[s]?.status === 'completed' || s === currentStage)
                .map((s) => (
                  <Tag
                    key={s}
                    style={{
                      cursor: 'pointer',
                      fontSize: 10,
                      background: s === inlineStage ? 'var(--accent-primary)' : undefined,
                      color: s === inlineStage ? '#fff' : undefined,
                      borderColor: 'transparent',
                    }}
                    onClick={() => setFocusStage(s)}
                  >
                    {t(`video.gen.stage.${s}`)}
                  </Tag>
                ))}
            </Space>
          }
        >
          <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
            {renderStageContent(inlineStage, project, sceneSpec, t)}
          </div>
        </Card>
      )}

      {/* Shots list */}
      <Title level={5}>
        {t('video.gen.shots')} ({overall === 'complete' ? clips.length : 0}/{shots.length})
      </Title>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {shots.length === 0 ? (
          overall === 'running' ? <Spin tip="..." /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          shots.map((shot) => (
            <ShotRow
              key={shot.id}
              shot={shot}
              status={getShotStatus(clips, currentStage, shot)}
            />
          ))
        )}
      </div>

      <StageArtifactsModal
        open={!!artifactStage}
        onClose={() => setArtifactStage(null)}
        stage={artifactStage}
        pipelineId={pipelineId}
      />

      {finalVideoUrl && (
        <ExportVideoModal
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          sourcePath={finalVideoUrl}
          suggestedName={`mojing-${pipelineId}`}
        />
      )}
    </div>
  );
};

export default VideoPipelinePanel;

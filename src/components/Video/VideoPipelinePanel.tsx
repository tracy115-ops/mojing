// ============================================================================
// VideoPipelinePanel — 视频流水线常驻面板
// ----------------------------------------------------------------------------
// 布局:左侧 Steps 导航(垂直,可点击切换) + 右侧产物预览(弹性) + 底部 Shots。
// pipelineId 由 videoStore.activePipelineId 决定(由 VideoGeneratorModal/
// DirectVideoModal 启动时写入)。
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  Typography, Tag, Card, Spin, Empty, Divider, Button, Space, Dropdown, Menu,
  Alert, Popconfirm, Tooltip,
} from 'antd';
import {
  VideoCameraOutlined, PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, EyeOutlined, DownOutlined, DownloadOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoStage, StoryboardShot } from '@/types/video';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';
import StageArtifactsModal, { renderStageContent } from './StageArtifactsModal';
import ExportVideoModal from './ExportVideoModal';

const { Text, Title } = Typography;

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
  // 拆细 selector:每条只订阅一个字段,避免高频更新触发整面板重渲
  const exists = useVideoStore((s) => !!(pipelineId && s.projects[pipelineId]));
  const currentStage = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.currentStage : undefined));
  const stages = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.stages : undefined));
  const shots = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.shots : undefined));
  const clips = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.clips : undefined));
  const sceneSpec = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.sceneSpec : undefined));
  const project = useVideoStore((s) => (pipelineId ? s.projects[pipelineId] : undefined));
  const finalVideoUrl = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.finalVideoUrl : undefined));
  const errorMsg = useVideoStore((s) => (pipelineId ? s.projects[pipelineId]?.error : undefined));
  const resetProject = useVideoStore((s) => s.resetProject);
  const setActivePipelineId = useVideoStore((s) => s.setActivePipelineId);
  const [exportOpen, setExportOpen] = useState(false);
  // 用户点 Steps 上某个步骤时,切换产物视图到该步骤。
  // null = 自动跟随(currentStage 优先,否则最近完成的步骤)。
  const [focusStage, setFocusStage] = useState<VideoStage | null>(null);

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

  // 产物聚焦的 stage:
  // - 用户点了 Steps 上某个 stage → 用那个
  // - 否则:运行中聚焦当前 stage;否则聚焦最近完成的 stage;都没有 → 第一个 visible stage
  const inlineStage: VideoStage = focusStage
    ?? (currentStage && currentStage !== 'complete' && currentStage !== 'error' && currentStage !== 'idle'
      ? currentStage
      : null)
    ?? completedStages[completedStages.length - 1]
    ?? visibleStages[0];

  const finalMeta = project
    ? { dur: project.finalDurationSeconds, size: project.finalSizeBytes }
    : { dur: undefined, size: undefined };
  const sizeLabel = finalMeta.size ? `${(finalMeta.size / 1024 / 1024).toFixed(1)} MB` : undefined;
  const durLabel = finalMeta.dur ? `${finalMeta.dur.toFixed(1)}s` : undefined;
  const metaLabel = [durLabel, sizeLabel].filter(Boolean).join(' · ');

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ── Header bar ── */}
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: 8, flexShrink: 0,
        background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
      }}>
        <Space size={8} align="center" wrap>
          <Title level={5} style={{ margin: 0 }}>{headerLabel}</Title>
          <Tag color={statusColor}>{statusLabel}</Tag>
          {errorMsg && (
            <Tooltip title={errorMsg}>
              <Text type="danger" style={{ fontSize: 12, maxWidth: 400 }} ellipsis>
                {errorMsg}
              </Text>
            </Tooltip>
          )}
        </Space>
        <Space size={4}>
          {finalVideoUrl && (
            <Button type="primary" size="small" icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>
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
            <Button size="small" icon={<ReloadOutlined />} danger>
              {t('video.pipeline.reset')}
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {/* ── 主区域:左 Steps + 右产物 ── */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* 左侧 Steps 导航 - 垂直列表,点击切换 */}
        <div style={{
          width: 200, flexShrink: 0,
          borderRight: '1px solid var(--border-secondary)',
          overflowY: 'auto', padding: '8px 0',
          background: 'var(--bg-elevated, transparent)',
        }}>
          {visibleStages.map((stage) => {
            const state = stages[stage];
            const skipped = DEFAULT_SKIPPED_STAGES.has(stage);
            const completed = state?.status === 'completed';
            const running = state?.status === 'running';
            const errored = state?.status === 'error';
            const isFocused = stage === inlineStage;
            const clickable = completed || running || errored;

            // 进度数字/图标
            let leftIcon: React.ReactNode;
            if (skipped) leftIcon = <CloseCircleOutlined style={{ opacity: 0.3 }} />;
            else if (errored) leftIcon = <CloseCircleOutlined style={{ color: '#ef4444' }} />;
            else if (running) leftIcon = <LoadingOutlined />;
            else if (completed) leftIcon = <CheckCircleOutlined style={{ color: '#22c55e' }} />;
            else leftIcon = <span style={{ fontSize: 11, opacity: 0.5 }}>·</span>;

            return (
              <div
                key={stage}
                onClick={() => clickable && setFocusStage(stage)}
                style={{
                  padding: '8px 12px',
                  display: 'flex', alignItems: 'center', gap: 8,
                  cursor: clickable ? 'pointer' : 'default',
                  background: isFocused ? 'var(--accent-primary-faded, rgba(0, 100, 255, 0.1))' : 'transparent',
                  borderLeft: isFocused ? '3px solid var(--accent-primary)' : '3px solid transparent',
                  opacity: skipped ? 0.4 : 1,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (clickable && !isFocused) {
                    e.currentTarget.style.background = 'var(--bg-hover, rgba(128,128,128,0.08))';
                  }
                }}
                onMouseLeave={(e) => {
                  if (clickable && !isFocused) {
                    e.currentTarget.style.background = 'transparent';
                  }
                }}
              >
                <span style={{ fontSize: 14, width: 16, textAlign: 'center', flexShrink: 0 }}>
                  {leftIcon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12,
                    fontWeight: isFocused ? 600 : 400,
                    color: isFocused ? 'var(--accent-primary)' : 'var(--text-primary)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {t(`video.gen.stage.${stage}`)}
                  </div>
                  {(running || state?.progress) && running && state?.progress !== undefined && state.progress > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                      {Math.round(state.progress * 100)}%
                    </div>
                  )}
                  {errored && state?.error && (
                    <div style={{
                      fontSize: 10, color: '#ef4444',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      ⚠ {state.error}
                    </div>
                  )}
                </div>
                {completed && (
                  <Tooltip title={t('video.pipeline.clickToView')}>
                    <EyeOutlined style={{ fontSize: 10, color: 'var(--text-tertiary)' }} />
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>

        {/* 右侧产物区:上方产物预览(弹性) + 下方 Shots(固定高度) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {/* 产物预览 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
            {/* 错误提示(放在产物区顶部,紧凑) */}
            {(() => {
              const stageErrors = visibleStages
                .map((s) => ({ stage: s, err: stages[s]?.error }))
                .filter((x): x is { stage: VideoStage; err: string } => !!x.err);
              if (!errorMsg && stageErrors.length === 0) return null;
              return (
                <Alert
                  type="error" showIcon
                  style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}
                  message={errorMsg ?? t('video.pipeline.stageErrorTitle')}
                  description={
                    errorMsg ? null : (
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                        {stageErrors.map((x) => (
                          <li key={x.stage}>
                            <a onClick={() => setFocusStage(x.stage)}>
                              <strong>{t(`video.gen.stage.${x.stage}`)}</strong>
                            </a>: {x.err}
                          </li>
                        ))}
                      </ul>
                    )
                  }
                />
              );
            })()}

            {/* 最终视频(完成时显示在产物区顶部) */}
            {overall === 'complete' && finalVideoUrl && (
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
                <Divider style={{ margin: '12px 0' }} />
              </>
            )}

            {/* 当前聚焦步骤的产物 */}
            {project && (
              <div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 8, padding: '6px 0',
                }}>
                  <Text strong style={{ fontSize: 13 }}>
                    {t(`video.gen.stage.${inlineStage}`)}
                  </Text>
                  {stages[inlineStage]?.status && (
                    <Tag style={{ fontSize: 10 }}>
                      {t(`video.artifacts.status.${stages[inlineStage]!.status}`)}
                    </Tag>
                  )}
                </div>
                {renderStageContent(inlineStage, project, sceneSpec, t)}
              </div>
            )}
          </div>

          {/* Shots 列表(底部固定高度,可折叠) */}
          {shots.length > 0 && (
            <div style={{
              height: 180, flexShrink: 0,
              borderTop: '1px solid var(--border-secondary)',
              display: 'flex', flexDirection: 'column',
              background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
            }}>
              <div style={{
                padding: '4px 12px', fontSize: 12, fontWeight: 600,
                color: 'var(--text-secondary)',
                borderBottom: '1px solid var(--border-secondary)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>
                  {t('video.gen.shots')} ({overall === 'complete' ? clips.length : 0}/{shots.length})
                </span>
                {overall === 'running' && <Spin size="small" />}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
                {shots.map((shot) => (
                  <ShotRow
                    key={shot.id}
                    shot={shot}
                    status={getShotStatus(clips, currentStage, shot)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Export modal(完成时使用) */}
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

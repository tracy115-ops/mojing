// ============================================================================
// VideoPipelinePanel — 视频流水线常驻面板
// ----------------------------------------------------------------------------
// 布局:左侧 Steps 导航(垂直,可点击切换) + 右侧产物预览(弹性) + 底部 Shots。
// pipelineId 由 videoStore.activePipelineId 决定(由 VideoGeneratorModal/
// DirectVideoModal 启动时写入)。
// ============================================================================

import React, { useState, useMemo, useEffect } from 'react';
import {
  Typography, Tag, Card, Spin, Empty, Divider, Button, Space, Dropdown, Menu,
  Alert, Popconfirm, Tooltip, Steps, Input, message, Select, Modal,
} from 'antd';
import {
  VideoCameraOutlined, PlayCircleOutlined, StopOutlined,
  LoadingOutlined, DownOutlined, DownloadOutlined, ReloadOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoStage, StoryboardShot } from '@/types/video';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';
import StageArtifactsModal, { renderStageContent } from './StageArtifactsModal';
import StageInputEditor from './StageInputEditor';
import ExportVideoModal from './ExportVideoModal';
import { VideoPipeline } from '@/services/video/pipeline';
import { runFromFirstFailedStage, runFromStage, abortPipeline } from '@/services/video/core/pipeline-runner';
import { logger } from '@/services/log';
import { getProjectAssetStats, cleanProjectAssets, formatBytes } from '@/services/video/asset-store';

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
  pid: string;
  shot: StoryboardShot;
  status: 'pending' | 'running' | 'done' | 'error';
}> = ({ pid, shot, status }) => {
  const { t } = useTranslation();
  const updateSceneSpecShot = useVideoStore((s) => s.updateSceneSpecShot);
  const [editing, setEditing] = useState(false);
  const [promptText, setPromptText] = useState(shot.videoPrompt || shot.sourceText);
  const [rerunning, setRerunning] = useState(false);

  const handleSavePrompt = () => {
    updateSceneSpecShot(pid, shot.id, { videoPrompt: promptText.trim() });
    setEditing(false);
    message.success(t('common.saved'));
  };

  const handleRerun = async () => {
    setRerunning(true);
    try {
      const { rerunSingleShot } = await import('@/services/video/core/pipeline-runner');
      const res = await rerunSingleShot(pid, shot.id);
      if (res) {
        message.success(t('video.pipeline.rerunDone'));
      } else {
        message.error(t('video.pipeline.rerunFailed'));
      }
    } catch (err) {
      message.error(String(err));
    } finally {
      setRerunning(false);
    }
  };

  return (
    <Card size="small" style={{ marginBottom: 6 }} bodyStyle={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Tag color={status === 'done' ? 'success' : status === 'running' ? 'processing' : status === 'error' ? 'error' : 'default'}>
          {t('video.gen.shot')} {shot.index + 1}
        </Tag>

        {editing ? (
          <div style={{ flex: 1, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              size="small"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onPressEnter={handleSavePrompt}
              style={{ flex: 1, minWidth: 200 }}
            />
            <Select
              size="small"
              placeholder="运镜"
              style={{ width: 120 }}
              allowClear
              onChange={(moveVal) => {
                if (!moveVal) return;
                import('@/types/video').then(({ CAMERA_MOVEMENTS }) => {
                  const item = CAMERA_MOVEMENTS.find((m) => m.value === moveVal);
                  if (item) {
                    setPromptText((prev) => `${prev.trim()}, ${item.prompt}`);
                  }
                });
              }}
              options={[
                { value: 'zoom_in', label: '🔍 缓慢推进' },
                { value: 'zoom_out', label: '🔍 缓慢拉远' },
                { value: 'pan_left', label: '⬅️ 左摇镜头' },
                { value: 'pan_right', label: '➡️ 右摇镜头' },
                { value: 'orbit', label: '🔄 360° 环绕' },
                { value: 'crane_up', label: '⬆️ 摇臂升起' },
                { value: 'tracking', label: '🏃 跟随镜头' },
              ]}
            />
            <Button size="small" type="primary" onClick={handleSavePrompt}>{t('common.save')}</Button>
            <Button size="small" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
          </div>
        ) : (
          <>
            <Text style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }} ellipsis>
              {shot.videoPrompt || shot.sourceText.slice(0, 100)}
            </Text>
            <Space size={4}>
              <Tooltip title={t('video.direct.editPrompt')}>
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined style={{ display: 'none' }} />} // placeholder icon if needed
                  onClick={() => setEditing(true)}
                  style={{ fontSize: 11 }}
                >
                  ✏️
                </Button>
              </Tooltip>
              <Tooltip title={t('video.pipeline.rerunSingleShot')}>
                <Button
                  size="small"
                  type="text"
                  loading={rerunning}
                  disabled={rerunning}
                  onClick={handleRerun}
                  style={{ fontSize: 11 }}
                >
                  🔄
                </Button>
              </Tooltip>
              <Popconfirm
                title="确定删除此镜头分镜？"
                onConfirm={() => useVideoStore.getState().deleteSceneSpecShot(pid, shot.id)}
                okText="确定"
                cancelText="取消"
              >
                <Tooltip title="删除分镜">
                  <Button size="small" type="text" danger style={{ fontSize: 11 }}>
                    🗑️
                  </Button>
                </Tooltip>
              </Popconfirm>
            </Space>
          </>
        )}
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
  /** 断点续跑中标志(禁用重试按钮防重复点击) */
  const [retrying, setRetrying] = useState(false);
  const [addShotModalOpen, setAddShotModalOpen] = useState(false);
  const [newShotPrompt, setNewShotPrompt] = useState('');

  const handleAddShotConfirm = () => {
    if (!pipelineId || !newShotPrompt.trim()) return;
    useVideoStore.getState().addSceneSpecShot(pipelineId, {
      videoPrompt: newShotPrompt.trim(),
      sourceText: newShotPrompt.trim(),
      durationSeconds: 5,
      characters: [],
      characterIds: [],
    });
    setNewShotPrompt('');
    setAddShotModalOpen(false);
    message.success(t('common.success'));
  };
  /** 当前 pipeline 产物占用(字节数),用于显示「已缓存 X MB」 */
  const [assetBytes, setAssetBytes] = useState(0);
  const [cleaningAssets, setCleaningAssets] = useState(false);

  // 拉取产物占用 — pipelineId 变化时拉一次,stage 状态变化时再拉一次
  // (stage 完成会落新文件,数字要刷新)。不必高频,简单挂在 exists/currentStage 变化上。
  useEffect(() => {
    if (!pipelineId) {
      setAssetBytes(0);
      return;
    }
    let cancelled = false;
    void getProjectAssetStats(pipelineId).then((s) => {
      if (!cancelled) setAssetBytes(s.bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, currentStage, exists]);

  const handleCleanAssets = async () => {
    if (!pipelineId || cleaningAssets) return;
    setCleaningAssets(true);
    try {
      const r = await cleanProjectAssets(pipelineId);
      setAssetBytes(0);
      message.success(
        t('video.pipeline.cleanAssetsDone', {
          deleted: r.deletedFiles,
          size: formatBytes(r.deletedBytes),
        }),
      );
    } catch (err) {
      message.error(`清理失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCleaningAssets(false);
    }
  };

  const handleRetryFromFailure = async () => {
    if (!pipelineId || retrying) return;
    const pid = pipelineId;
    setRetrying(true);
    void logger.info(`[panel] retry-from-failure pid=${pid}`, 'panel');
    try {
      const pipeline = VideoPipeline.forResume(pid);
      if (!pipeline) {
        void logger.warn(`[panel] retry: 找不到 novel project ${pid},降级到空状态`, 'panel');
        message.warning(t('video.pipeline.retryNotFound'));
        return;
      }
      // 在 resume 之前,先把"失败 stage 及其之后"的状态/产物清掉,
      // 否则 pipeline-runner 的 isStageLiveCompleted 会跳过它们。
      const proj = useVideoStore.getState().getProject(pid);
      if (proj) {
        // 只扫 runtime stages(从 character_anchor 到 composing)。
        // 不能扫前 4 步(script_slicing/storyboard_prompt/extraction/voice_assignment),
        // 因为它们在 Direct 模式下可能一直 error/skipped 但不影响后续 —
        // 扫到它们会让 reset 从头开始,把已完成的角色立绘/场景图都清掉。
        const runtimeStages = VIDEO_PIPELINE_STAGES.filter(
          (s) => !DEFAULT_SKIPPED_STAGES.has(s) &&
            !['script_slicing', 'storyboard_prompt', 'extraction', 'voice_assignment'].includes(s),
        );
        // 找失败的 stage:优先扫 stages 里的 error 状态(取最早一个)
        let failedStage: VideoStage | undefined = undefined;
        for (const stage of runtimeStages) {
          if (proj.stages[stage]?.status === 'error') {
            failedStage = stage;
            break;
          }
        }
        if (!failedStage) {
          // runtime stages 都没 error,可能是整体抛错只写了 proj.error。
          // 退化为第一个非 completed 的 runtime stage。
          failedStage = runtimeStages.find(
            (s) => proj.stages[s]?.status !== 'completed',
          );
        }
        if (failedStage) {
          void logger.info(`[panel] retry: 重置从 ${failedStage} 起的所有 stage`, 'panel');
          useVideoStore.getState().resetStagesFrom(pid, failedStage);
        }
      }
      await pipeline.resume();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error(`[panel] retry threw: ${msg}`, 'panel');
      message.error(`${t('video.pipeline.retryFailed')}: ${msg}`);
    } finally {
      setRetrying(false);
    }
  };
  // 用户点 Steps 上某个步骤时,切换产物视图到该步骤。
  // null = 自动跟随(currentStage 优先,否则最近完成的步骤)。
  const [focusStage, setFocusStage] = useState<VideoStage | null>(null);

  const novelTitle = useProjectStore((s) => {
    if (!pipelineId || !exists) return undefined;
    if (pipelineId.startsWith('direct_')) return undefined;
    const np = s.projects.find((p) => p.id === pipelineId);
    return np?.title;
  });
  const directTitle = useVideoStore((s) =>
    pipelineId && pipelineId.startsWith('direct_') ? s.projects[pipelineId]?.title : undefined,
  );

  const headerLabel = useMemo(() => {
    if (!exists) return '';
    if (pipelineId?.startsWith('direct_')) {
      return directTitle || t('video.pipeline.directLabel');
    }
    if (novelTitle) return t('video.pipeline.fromNovelLabel', { title: novelTitle });
    return t('video.pipeline.title');
  }, [exists, pipelineId, novelTitle, directTitle, t]);

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
          {overall === 'running' && (
            <Popconfirm
              title="确定要立即强行终止当前视频生成流程吗？"
              okText="终止生成"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => {
                if (!pipelineId) return;
                abortPipeline(pipelineId);
                message.warning('已收到终止请求，正在强行停止当前生成任务...');
              }}
            >
              <Button
                type="primary"
                danger
                size="small"
                icon={<StopOutlined />}
              >
                ⏹️ 强行终止生成
              </Button>
            </Popconfirm>
          )}
          {overall === 'error' && (
            <Button
              type="primary"
              danger
              size="small"
              icon={<ReloadOutlined />}
              onClick={async () => {
                if (!pipelineId) return;
                message.loading('正在从失败处智能恢复生成...', 1.5);
                await runFromFirstFailedStage(pipelineId);
              }}
            >
              🚀 从失败处恢复重试
            </Button>
          )}
          <Popconfirm
            title="确定清空全部产物，一键从第一步重新全流程生成吗？"
            onConfirm={async () => {
              if (!pipelineId) return;
              message.loading('正在重置并从第一步重新生成...', 1.5);
              await runFromStage(pipelineId, 'character_anchor');
            }}
          >
            <Button size="small" icon={<ReloadOutlined />}>
              🔄 一键从头重新生成
            </Button>
          </Popconfirm>
          <Tooltip title="导出 4K 高帧率超分增强版本">
            <Tag color="gold" style={{ cursor: 'pointer', fontSize: 11 }}>
              ⚡ 4K 超分渲染已就绪
            </Tag>
          </Tooltip>
          {finalVideoUrl && (
            <Button type="primary" size="small" icon={<DownloadOutlined />} onClick={() => setExportOpen(true)}>
              {t('video.export.button')}
            </Button>
          )}
          {assetBytes > 0 && (
            <Tooltip title={t('video.pipeline.cleanAssetsConfirm')}>
              <Popconfirm
                title={t('video.pipeline.cleanAssetsConfirm')}
                okText={t('video.pipeline.cleanAssets')}
                okButtonProps={{ danger: true, loading: cleaningAssets }}
                cancelText={t('common.cancel')}
                onConfirm={handleCleanAssets}
              >
                <Button
                  size="small"
                  icon={<DeleteOutlined />}
                  loading={cleaningAssets}
                >
                  {t('video.pipeline.assetStats', { size: formatBytes(assetBytes) })}
                </Button>
              </Popconfirm>
            </Tooltip>
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

      {/* ── 漫剧 SOP 黄金法则 Banner ── */}
      <div style={{
        padding: '6px 12px',
        background: 'linear-gradient(90deg, rgba(24, 144, 255, 0.08), rgba(114, 46, 209, 0.08))',
        borderBottom: '1px solid var(--border-secondary)',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <Space size={6} style={{ flex: 1, overflow: 'hidden' }}>
          <Tag color="purple" style={{ fontWeight: 600 }}>🎬 AI 漫剧 SOP 6 步工作流</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>
            1.剧本(角色/目标/冲突/行动/结局) ➔ 2.分镜(景别/角度/构图) ➔ 3.角色一致(Seed/参考图) ➔ 4.图生视频 ➔ 5.后期配音 ➔ 6.SOP工具箱
          </Text>
        </Space>
        <Text style={{ fontSize: 11, color: '#722ed1', fontWeight: 600, fontStyle: 'italic', whiteSpace: 'nowrap' }}>
          ✨ "AI 是副驾驶，不是方向盘。流程越清楚，结果越稳定。"
        </Text>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* 左侧 Steps 导航 - Antd Steps 竖向时间轴 */}
        <div style={{
          width: 220, flexShrink: 0,
          borderRight: '1px solid var(--border-secondary)',
          overflowY: 'auto', padding: '12px 8px 12px 4px',
          background: 'var(--bg-elevated, transparent)',
        }}>
          <Steps
            direction="vertical"
            size="small"
            current={visibleStages.indexOf(inlineStage)}
            onChange={(current) => {
              const stage = visibleStages[current];
              if (!stage) return;
              const state = stages[stage];
              const clickable = state?.status === 'completed' || state?.status === 'running' || state?.status === 'error';
              if (clickable) setFocusStage(stage);
            }}
            items={visibleStages.map((stage) => {
              const state = stages[stage];
              const skipped = DEFAULT_SKIPPED_STAGES.has(stage);
              const completed = state?.status === 'completed';
              const running = state?.status === 'running';
              const errored = state?.status === 'error';
              const isFocused = stage === inlineStage;

              // Antd Steps 的 status: 'finish' | 'process' | 'wait' | 'error'
              let stepStatus: 'finish' | 'process' | 'wait' | 'error';
              if (skipped) stepStatus = 'wait';
              else if (errored) stepStatus = 'error';
              else if (running) stepStatus = 'process';
              else if (completed) stepStatus = 'finish';
              else stepStatus = 'wait';

              // 进度条 / 百分比 / 错误描述
              let description: React.ReactNode = undefined;
              if (running) {
                const pct = state?.progress !== undefined && state.progress > 0
                  ? Math.round(state.progress * 100)
                  : null;
                description = (
                  <div style={{ marginTop: 2 }}>
                    <div style={{
                      fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3,
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>{t('video.artifacts.status.running')}</span>
                      {pct !== null && <span>{pct}%</span>}
                    </div>
                    {/* 进度条:有 pct 显示真实进度,否则显示脉冲流动条(表示在干活) */}
                    <div style={{
                      height: 3,
                      borderRadius: 2,
                      background: 'var(--bg-secondary, rgba(128,128,128,0.15))',
                      overflow: 'hidden',
                      position: 'relative',
                    }}>
                      {pct !== null ? (
                        <div style={{
                          width: `${pct}%`,
                          height: '100%',
                          background: 'var(--accent-primary)',
                          borderRadius: 2,
                          transition: 'width 0.3s ease',
                        }} />
                      ) : (
                        <div style={{
                          width: '40%',
                          height: '100%',
                          background: 'var(--accent-primary)',
                          borderRadius: 2,
                          animation: 'mojing-pipeline-pulse 1.4s ease-in-out infinite',
                        }} />
                      )}
                    </div>
                  </div>
                );
              } else if (errored && state?.error) {
                description = (
                  <Tooltip title={state.error}>
                    <span style={{
                      fontSize: 10, color: 'var(--accent-danger, #ef4444)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      display: 'inline-block', maxWidth: 160,
                    }}>
                      ⚠ {state.error}
                    </span>
                  </Tooltip>
                );
              } else if (skipped) {
                description = (
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)', opacity: 0.6 }}>
                    {t('video.artifacts.status.skipped')}
                  </span>
                );
              }

              return {
                status: stepStatus,
                title: (
                  <span style={{
                    fontSize: 12,
                    fontWeight: isFocused ? 600 : 400,
                    color: isFocused
                      ? 'var(--accent-primary)'
                      : skipped
                        ? 'var(--text-tertiary)'
                        : 'var(--text-primary)',
                  }}>
                    {t(`video.gen.stage.${stage}`)}
                  </span>
                ),
                description,
                disabled: !(completed || running || errored),
              };
            })}
          />
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
                  action={
                    <Tooltip title={t('video.pipeline.retryFromFailureHint')}>
                      <Button
                        size="small"
                        type="primary"
                        danger
                        icon={retrying ? <LoadingOutlined /> : <ReloadOutlined />}
                        disabled={retrying}
                        onClick={handleRetryFromFailure}
                      >
                        {t('video.pipeline.retryFromFailure')}
                      </Button>
                    </Tooltip>
                  }
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
                {/* 单步重跑:输入参数编辑 + 重跑按钮 */}
                <Divider style={{ margin: '12px 0 8px' }} />
                <StageInputEditor stage={inlineStage} project={project} />
              </div>
            )}
          </div>

          {/* Shots 列表(底部固定高度,可折叠) */}
          {shots.length > 0 && (
            <div style={{
              maxHeight: 260, minHeight: 140, flexShrink: 0,
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
                  {t('video.gen.shots')} ({clips.length}/{shots.length})
                </span>
                <Space size={8}>
                  <Button size="small" type="primary" onClick={() => setAddShotModalOpen(true)}>
                    ➕ 添加分镜
                  </Button>
                  {overall === 'running' && <Spin size="small" />}
                </Space>
              </div>

              <Modal
                title="➕ 手动追加分镜"
                open={addShotModalOpen}
                onOk={handleAddShotConfirm}
                onCancel={() => setAddShotModalOpen(false)}
                okText="追加镜头"
                cancelText="取消"
              >
                <div style={{ marginTop: 8 }}>
                  <Text style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
                    输入新分镜的画面描述 (Video Prompt):
                  </Text>
                  <Input.TextArea
                    rows={4}
                    value={newShotPrompt}
                    onChange={(e) => setNewShotPrompt(e.target.value)}
                    placeholder="例如: 镜头从主角侧面推近，环境光影交织，气势磅礴..."
                  />
                </div>
              </Modal>
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px' }}>
                {shots.map((shot) => (
                  <ShotRow
                    key={shot.id}
                    pid={pipelineId}
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

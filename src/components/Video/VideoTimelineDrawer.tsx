// ============================================================================
// VideoTimelineDrawer — 轻量级可视多轨时间轴剪辑与微调工作台 (Timeline Workspace)
// ============================================================================
// 功能：
//   1. 视频镜头轨 (Video Track)：查看各镜缩略图、拖拽调整顺序、排除/启用镜头、单独修剪。
//   2. 角色配音轨 (Audio Track)：查看/试听每镜角色台词配音、音量调节。
//   3. 背景音乐轨 (BGM Track)：BGM 氛围模式选择、BGM 音量比例调节。
//   4. 字幕预览轨 (Subtitle Track)：对齐时间戳预览各镜头字幕。
//   5. 实时播放预览与基于时间轴快速重新合成（无需消耗 Token 重新生成）。

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Drawer, Typography, Button, Space, Slider, Tag, Tooltip, message,
  Card, Divider, Switch, Empty, Segmented,
} from 'antd';
import {
  PlayCircleOutlined,
  SoundOutlined, VideoCameraOutlined, FileTextOutlined,
  ClockCircleOutlined, ArrowUpOutlined, ArrowDownOutlined,
  DownloadOutlined, RocketOutlined, SearchOutlined,
} from '@ant-design/icons';
import { useVideoStore } from '@/stores/videoStore';
import { useTranslation } from '@/i18n';
import type { ShotSpec, GeneratedClip, VideoProjectState } from '@/types/video';
import { normalizeTimelineState } from '@/services/video/core/timeline-state';
import { runCompose } from '@/services/video/core/step-compose';
import { runFromStage } from '@/services/video/core/pipeline-runner';
import { isShotAssemblyReady } from '@/services/video/core/shot-production-contract';
import { resolveAssemblyQualityRequirements } from '@/services/video/core/quality-policy';
import { toWebviewUrl, resolveLocalPath } from '@/services/video/asset-store';
import ExportVideoModal from './ExportVideoModal';
import './VideoTimelineDrawer.css';

const { Text, Paragraph } = Typography;

interface TimelineShotItem {
  id: string;
  index: number;
  shot: ShotSpec;
  clip?: GeneratedClip;
  enabled: boolean;
  trimStartSeconds: number;
  trimEndSeconds: number;
}

export interface VideoTimelineWorkspaceProps {
  pipelineId?: string;
  project?: VideoProjectState;
  onClose?: () => void;
  onOpenScript?: () => void;
  onOpenShotStudio?: () => void;
}

export const VideoTimelineWorkspace: React.FC<VideoTimelineWorkspaceProps> = ({
  pipelineId,
  project: projectProp,
  onClose,
  onOpenScript,
  onOpenShotStudio,
}) => {
  const { t } = useTranslation();
  const storeProject = useVideoStore((s) => (pipelineId ? s.projects[pipelineId] : undefined));
  const setTimelineState = useVideoStore((s) => s.setTimelineState);
  const project = storeProject || projectProp;
  const rawShots = project?.sceneSpec?.shots || (project?.shots as unknown as ShotSpec[]) || [];
  const rawClips = project?.clips || [];
  const finalVideoUrl = project?.finalVideoUrl;
  const finalPreviewUrl = useMemo(() => {
    if (!finalVideoUrl) return undefined;
    const source = toWebviewUrl(resolveLocalPath(finalVideoUrl));
    if (!/^(?:https?:\/\/asset\.localhost\/|asset:)/i.test(source)) return source;
    // Recomposition overwrites final.mp4. Give each completed render a fresh
    // playback URL so WebView2 cannot reuse cached ranges from the old movie.
    const url = new URL(source);
    url.searchParams.set('revision', project?.stages.composing?.completedAt ?? '');
    return url.href;
  }, [finalVideoUrl, project?.stages.composing?.completedAt]);
  const normalizedTimelineState = useMemo(
    () => normalizeTimelineState(project?.timelineState, rawShots.map((shot) => shot.id)),
    [project?.timelineState, rawShots],
  );

  // 时间轴内部镜头列表状态（支持用户重新排序与启用状态微调）
  const [timelineShots, setTimelineShots] = useState<TimelineShotItem[]>([]);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [dialogueVolume, setDialogueVolume] = useState<number>(100);
  const [isRecomposing, setIsRecomposing] = useState(false);
  const [isBatchRendering, setIsBatchRendering] = useState(false);
  const [previewMode, setPreviewMode] = useState<'master' | 'single'>('master');
  const [exportOpen, setExportOpen] = useState(false);

  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const persistTimeline = (items: TimelineShotItem[], nextDialogueVolume = dialogueVolume) => {
    if (!pipelineId) return;
    setTimelineState(pipelineId, {
      shotOrder: items.map((item) => item.id),
      disabledShotIds: items.filter((item) => !item.enabled).map((item) => item.id),
      trims: Object.fromEntries(items.map((item) => [item.id, {
        startSeconds: item.trimStartSeconds,
        endSeconds: item.trimEndSeconds,
      }])),
      dialogueVolume: nextDialogueVolume / 100,
    });
  };

  // 初始化时间轴数据，优先恢复项目中已保存的非破坏性编辑。
  useEffect(() => {
    const initialItems: TimelineShotItem[] = normalizedTimelineState.shotOrder
      .map((shotId) => rawShots.find((shot) => shot.id === shotId))
      .filter((shot): shot is ShotSpec => !!shot)
      .map((s, idx) => {
      const clip = rawClips.find((c) => c.shotId === s.id);
      const duration = Math.max(1, clip?.durationSeconds || s.durationSeconds || 5);
      const trim = normalizedTimelineState.trims[s.id];
      const trimStartSeconds = Math.min(trim?.startSeconds || 0, Math.max(0, duration - 1));
      const trimEndSeconds = Math.min(
        trim?.endSeconds || 0,
        Math.max(0, duration - trimStartSeconds - 1),
      );
      return {
        id: s.id,
        index: idx,
        shot: s,
        clip,
        enabled: !normalizedTimelineState.disabledShotIds.includes(s.id),
        trimStartSeconds,
        trimEndSeconds,
      };
    });
    setTimelineShots(initialItems);
    setDialogueVolume(Math.round(normalizedTimelineState.dialogueVolume * 100));
    setSelectedShotId((current) => (
      current && initialItems.some((item) => item.id === current)
        ? current
        : initialItems[0]?.id || null
    ));
    if (pipelineId && JSON.stringify(project?.timelineState) !== JSON.stringify(normalizedTimelineState)) {
      setTimelineState(pipelineId, normalizedTimelineState);
    }
  }, [normalizedTimelineState, pipelineId, project?.timelineState, rawClips, rawShots, setTimelineState]);

  // 计算时间轴总时长与已就绪片段统计
  const totalDuration = useMemo(() => {
    return timelineShots
      .filter((item) => item.enabled)
      .reduce((acc, item) => {
        const d = item.clip?.durationSeconds || item.shot.durationSeconds || 5;
        const netDuration = Math.max(1, d - item.trimStartSeconds - item.trimEndSeconds);
        return acc + netDuration;
      }, 0);
  }, [timelineShots]);

  const readyClipsCount = useMemo(() => (
    timelineShots.filter((item) => item.enabled && item.clip?.videoUrl && !item.clip.videoUrl.startsWith('video_')).length
  ), [timelineShots]);

  const totalShotsCount = timelineShots.filter((item) => item.enabled).length;
  const keyframeShotsCount = timelineShots.filter((item) => item.enabled && !!item.shot.keyframeImage).length;
  const allKeyframesReady = totalShotsCount > 0 && keyframeShotsCount === totalShotsCount;
  const canBatchRender = timelineShots.length > 0 && allKeyframesReady && readyClipsCount < totalShotsCount;
  const assemblyRequirements = resolveAssemblyQualityRequirements(project?.options);
  const assemblyReadyCount = timelineShots.filter((item) => item.enabled && isShotAssemblyReady(
    item.shot,
    item.clip,
    assemblyRequirements,
  )).length;
  const canCompose = totalShotsCount > 0 && assemblyReadyCount === totalShotsCount;
  const hasShots = timelineShots.length > 0;
  const openPrerequisite = () => {
    if (!hasShots) onOpenScript?.();
    else onOpenShotStudio?.();
  };

  const currentSelected = useMemo(() => {
    return timelineShots.find((item) => item.id === selectedShotId) || timelineShots[0];
  }, [timelineShots, selectedShotId]);
  const currentSelectedDuration = currentSelected
    ? Math.max(1, currentSelected.clip?.durationSeconds || currentSelected.shot.durationSeconds || 5)
    : 1;
  const currentTrimRange: [number, number] = currentSelected
    ? [
        currentSelected.trimStartSeconds,
        Math.max(currentSelected.trimStartSeconds, currentSelectedDuration - currentSelected.trimEndSeconds),
      ]
    : [0, 1];

  // 上移分镜顺序
  const handleMoveUp = (index: number) => {
    if (index <= 0) return;
    const copy = [...timelineShots];
    const temp = copy[index - 1];
    copy[index - 1] = copy[index];
    copy[index] = temp;
    const next = copy.map((item, itemIndex) => ({ ...item, index: itemIndex }));
    setTimelineShots(next);
    persistTimeline(next);
  };

  // 下移分镜顺序
  const handleMoveDown = (index: number) => {
    if (index >= timelineShots.length - 1) return;
    const copy = [...timelineShots];
    const temp = copy[index + 1];
    copy[index + 1] = copy[index];
    copy[index] = temp;
    const next = copy.map((item, itemIndex) => ({ ...item, index: itemIndex }));
    setTimelineShots(next);
    persistTimeline(next);
  };

  // 切换分镜启用状态
  const handleToggleEnable = (id: string) => {
    const next = timelineShots.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item));
    setTimelineShots(next);
    persistTimeline(next);
  };

  const handleTrimChange = (id: string, range: number[]) => {
    if (range.length < 2) return;
    const item = timelineShots.find((candidate) => candidate.id === id);
    if (!item) return;
    const duration = Math.max(1, item.clip?.durationSeconds || item.shot.durationSeconds || 5);
    const startSeconds = Math.max(0, Math.min(range[0], duration - 1));
    const endSeconds = Math.max(0, Math.min(duration - range[1], duration - startSeconds - 1));
    const next = timelineShots.map((candidate) => (
      candidate.id === id ? { ...candidate, trimStartSeconds: startSeconds, trimEndSeconds: endSeconds } : candidate
    ));
    setTimelineShots(next);
    persistTimeline(next);
  };

  const handleDialogueVolumeChange = (value: number) => {
    setDialogueVolume(value);
    persistTimeline(timelineShots, value);
  };

  // 试听单独配音
  const handlePlayDialogue = (audioUrl?: string) => {
    if (!audioUrl) {
      message.warning(t('video.timeline.dialogueMissing'));
      return;
    }
    if (audioPreviewRef.current) {
      audioPreviewRef.current.src = toWebviewUrl(resolveLocalPath(audioUrl));
      audioPreviewRef.current.play().catch((err) => {
        console.warn('Audio play failed:', err);
      });
      message.info(t('video.timeline.dialoguePlaying'));
    }
  };

  // 批量渲染视频片段并自动执行多轨合成
  const handleBatchRenderAndCompose = async () => {
    if (!pipelineId) return;
    if (!canBatchRender) {
      if (hasShots && onOpenShotStudio) onOpenShotStudio();
      else if (!hasShots && onOpenScript) onOpenScript();
      else message.warning(hasShots ? t('video.timeline.renderPrerequisite') : t('video.timeline.scriptPrerequisite'));
      return;
    }
    setIsBatchRendering(true);
    message.loading(t('video.timeline.batchRenderStarting'), 2.5);
    try {
      await runFromStage(pipelineId, 'video_generation');
      message.success(t('video.timeline.batchRenderSuccess'));
      setPreviewMode('master');
    } catch (err) {
      message.error(t('video.timeline.videoRenderFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBatchRendering(false);
    }
  };

  // 基于当前时间轴重新合成成片
  const handleRecompose = async () => {
    if (!pipelineId || !project) return;
    if (!canCompose) {
      message.warning(t('video.timeline.composePrerequisite'));
      onOpenShotStudio?.();
      return;
    }
    const activeItems = timelineShots.filter((item) => item.enabled && item.clip?.videoUrl);
    if (activeItems.length === 0) {
      message.error(t('video.timeline.validClipRequired'));
      return;
    }

    setIsRecomposing(true);
    message.loading(t('video.timeline.recomposeStarting'), 2);

    try {
      const orderedClips = activeItems.map((item) => item.clip!);
      const orderedShots = activeItems.map((item) => item.shot);

      const composeRes = await runCompose({
        novelProjectId: pipelineId,
        clips: orderedClips,
        shots: orderedShots,
        hardcodeSubtitles: project.spec?.hardcodeSubtitles ?? true,
        timelineState: {
          shotOrder: activeItems.map((item) => item.id),
          disabledShotIds: [],
          trims: Object.fromEntries(activeItems.map((item) => [item.id, {
            startSeconds: item.trimStartSeconds,
            endSeconds: item.trimEndSeconds,
          }])),
          dialogueVolume: dialogueVolume / 100,
        },
        assemblyRequirements,
      });

      if (composeRes?.finalVideoUrl) {
        useVideoStore.getState().setFinalVideo(pipelineId, composeRes.finalVideoUrl, {
          durationSeconds: composeRes.durationSeconds,
          sizeBytes: composeRes.sizeBytes,
        });
        message.success(t('video.timeline.recomposeSuccess'));
        setPreviewMode('master');
      }
    } catch (err) {
      message.error(t('video.timeline.recomposeFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsRecomposing(false);
    }
  };

  return (
    <div className="video-timeline-workspace" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '12px 16px', background: 'var(--bg-secondary, #f8fafc)', gap: 12, overflowY: 'auto', overflowX: 'hidden' }}>
      {/* 隐藏的音频试听播放器 */}
      <audio ref={audioPreviewRef} style={{ display: 'none' }} />

      {/* ── 顶部控制与操作条 ── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--bg-container)',
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid var(--border-secondary, #e2e8f0)',
        flexShrink: 0,
      }}>
        <Space size={8} wrap>
          <VideoCameraOutlined style={{ color: 'var(--accent-primary)' }} />
          <Text strong style={{ fontSize: 14 }}>
            {t('video.timeline.workspaceTitle')}
          </Text>
          <Tag color="blue">{t('video.timeline.totalDuration', { value: totalDuration.toFixed(1) })}</Tag>
          <Tag color="purple">{t('video.timeline.enabledShots', { enabled: totalShotsCount, total: timelineShots.length })}</Tag>
          <Tag color={allKeyframesReady ? 'green' : 'orange'}>
            {t('video.timeline.keyframeCoverage', { ready: keyframeShotsCount, total: totalShotsCount })}
          </Tag>
          {finalVideoUrl ? (
            <Tag color="success">{t('video.timeline.finalReady')}</Tag>
          ) : (
            <Tag color="warning">{t('video.timeline.awaitingCompose')}</Tag>
          )}
        </Space>

        <Space size={8} wrap>
          {!canCompose && (
            <Tooltip title={canBatchRender ? t('video.timeline.renderMissingHint') : hasShots ? t('video.timeline.renderPrerequisite') : t('video.timeline.scriptPrerequisite')}>
              <Button
                type={canBatchRender ? 'primary' : 'default'}
                size="small"
                icon={canBatchRender ? <RocketOutlined /> : <VideoCameraOutlined />}
                loading={isBatchRendering}
                disabled={!canBatchRender && !(hasShots ? onOpenShotStudio : onOpenScript)}
                onClick={handleBatchRenderAndCompose}
              >
                {canBatchRender ? t('video.timeline.renderMissing') : hasShots ? t('video.timeline.goToShots') : t('video.timeline.goToScript')}
              </Button>
            </Tooltip>
          )}
          <Tooltip title={canCompose ? t('video.timeline.composeReadyHint') : t('video.timeline.composePrerequisite')}>
            <span>
              <Button
                data-testid="video-timeline-compose"
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                loading={isRecomposing}
                disabled={!canCompose}
                onClick={handleRecompose}
              >
                {finalVideoUrl ? t('video.timeline.recompose') : t('video.timeline.compose')}
              </Button>
            </span>
          </Tooltip>
          {finalVideoUrl && (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => setExportOpen(true)}
            >
              {t('video.timeline.exportMp4')}
            </Button>
          )}
          {onClose && <Button size="small" onClick={onClose}>{t('video.timeline.close')}</Button>}
        </Space>
      </div>

      {/* ── 顶部：双栏预览与微调控制区 ── */}
      <div className="video-timeline-preview-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 460px) minmax(0, 1fr)', gap: 16, height: 270, flexShrink: 0 }}>
        {/* 左侧：成片大屏监视器 / 单镜片段切换播放器 */}
        <Card
          size="small"
          title={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Segmented
                size="small"
                value={previewMode}
                onChange={(val) => setPreviewMode(val as 'master' | 'single')}
                options={[
                  { label: <><VideoCameraOutlined /> {t('video.timeline.previewMaster')}</>, value: 'master' },
                  { label: <><SearchOutlined /> {t('video.timeline.previewShot', { index: currentSelected ? currentSelected.index + 1 : 1 })}</>, value: 'single' },
                ]}
              />
              {previewMode === 'master' && finalVideoUrl && (
                <Button
                  size="small"
                  type="primary"
                  icon={<DownloadOutlined />}
                  onClick={() => setExportOpen(true)}
                  style={{ fontSize: 11, height: 22 }}
                >
                  {t('video.timeline.exportMp4')}
                </Button>
              )}
            </div>
          }
          style={{ height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 8 }}
          styles={{ body: { flex: 1, padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRadius: 6, overflow: 'hidden' } }}
        >
          {previewMode === 'master' ? (
            finalVideoUrl ? (
              <video
                key={finalPreviewUrl}
                src={finalPreviewUrl}
                controls
                playsInline
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ textAlign: 'center', color: '#94a3b8', padding: 12 }}>
                <VideoCameraOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block', color: '#38bdf8' }} />
                <Text style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  {canCompose
                    ? t('video.timeline.allShotsReady', { ready: readyClipsCount, total: totalShotsCount })
                    : canBatchRender
                      ? t('video.timeline.renderProgress', { ready: readyClipsCount, total: totalShotsCount })
                      : hasShots ? t('video.timeline.renderPrerequisite') : t('video.timeline.scriptPrerequisite')}
                </Text>
                <Text style={{ color: '#94a3b8', fontSize: 11, display: 'block', marginBottom: 12 }}>
                  {canCompose
                    ? t('video.timeline.composeHint')
                    : canBatchRender
                      ? t('video.timeline.renderMissingHint')
                      : hasShots ? t('video.timeline.shotStudioHint') : t('video.timeline.scriptStudioHint')}
                </Text>
                {canCompose ? (
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={isRecomposing}
                    onClick={handleRecompose}
                  >
                    {t('video.timeline.compose')}
                  </Button>
                ) : canBatchRender ? (
                  <Button
                    type="primary"
                    icon={<RocketOutlined />}
                    loading={isBatchRendering}
                    onClick={handleBatchRenderAndCompose}
                  >
                    {t('video.timeline.renderMissing')}
                  </Button>
                ) : (
                  <Button type="primary" icon={<VideoCameraOutlined />} onClick={openPrerequisite} disabled={hasShots ? !onOpenShotStudio : !onOpenScript}>
                    {hasShots ? t('video.timeline.goToShots') : t('video.timeline.goToScript')}
                  </Button>
                )}
              </div>
            )
          ) : (
            currentSelected?.clip?.videoUrl ? (
              <video
                key={currentSelected.clip.videoUrl}
                src={toWebviewUrl(resolveLocalPath(currentSelected.clip.videoUrl))}
                controls
                playsInline
                preload="metadata"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ textAlign: 'center', color: '#94a3b8' }}>
                <VideoCameraOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block' }} />
                <Text style={{ color: '#94a3b8', fontSize: 12 }}>
                  {t('video.timeline.singleClipMissing', { index: currentSelected ? currentSelected.index + 1 : 1 })}
                </Text>
              </div>
            )
          )}
        </Card>

        {/* 右侧：分镜属性微调面板 */}
        <Card
          size="small"
          title={t('video.timeline.selectedShotSettings')}
          style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 8 }}
          styles={{ body: { flex: 1, overflowY: 'auto' } }}
        >
          {currentSelected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>{t('video.timeline.visualPrompt')}:</Text>
                <Paragraph style={{ margin: 0, fontSize: 12, color: 'var(--text-primary)' }} ellipsis={{ rows: 2 }}>
                  {currentSelected.shot.videoPrompt || currentSelected.shot.sourceText || t('video.timeline.noPrompt')}
                </Paragraph>
              </div>

              {currentSelected.shot.sourceText && (
                <div>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>{t('video.timeline.dialogueLabel')}:</Text>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.03)', padding: '4px 8px', borderRadius: 4, marginTop: 2 }}>
                    <Text style={{ fontSize: 12, flex: 1 }}>{currentSelected.shot.sourceText}</Text>
                    {currentSelected.shot.audioTrack && (
                      <Button
                        size="small"
                        type="text"
                        icon={<SoundOutlined />}
                        onClick={() => handlePlayDialogue(currentSelected.shot.audioTrack)}
                        style={{ color: 'var(--accent-primary)' }}
                      >
                        {t('video.timeline.playDialogue')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <Divider style={{ margin: '4px 0' }} />

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <Text>{t('video.timeline.dialogueVolume')}</Text>
                  <Text strong>{dialogueVolume}%</Text>
                </div>
                <Slider
                  min={0}
                  max={150}
                  value={dialogueVolume}
                  onChange={(value) => handleDialogueVolumeChange(Number(value))}
                  style={{ margin: '6px 0 0 0' }}
                />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t('video.timeline.bgmUnavailable')}
                </Text>
              </div>

              <Divider style={{ margin: '4px 0' }} />

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <Text>{t('video.timeline.trim')}</Text>
                  <Text type="secondary">
                    {currentTrimRange[0].toFixed(1)}s - {currentTrimRange[1].toFixed(1)}s / {currentSelectedDuration.toFixed(1)}s
                  </Text>
                </div>
                <Slider
                  range
                  min={0}
                  max={currentSelectedDuration}
                  step={0.1}
                  value={currentTrimRange}
                  onChange={(value) => handleTrimChange(currentSelected.id, Array.isArray(value) ? value : [value, value])}
                  style={{ margin: '8px 0 0 0' }}
                />
                <Space size={12} style={{ fontSize: 11 }}>
                  <Text type="secondary">{t('video.timeline.trimStart', { value: currentSelected.trimStartSeconds.toFixed(1) })}</Text>
                  <Text type="secondary">{t('video.timeline.trimEnd', { value: currentSelected.trimEndSeconds.toFixed(1) })}</Text>
                </Space>
              </div>
            </div>
          ) : (
            <Text type="secondary">{t('video.timeline.noSelectedShot')}</Text>
          )}
        </Card>
      </div>

      {/* ── 中下部：多轨时间轴可视化展示 ── */}
      <div style={{
        flex: 1,
        minHeight: 180,
        background: 'var(--bg-container)',
        border: '1px solid var(--border-secondary, #e2e8f0)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '8px 12px',
          background: 'var(--bg-elevated, #f1f5f9)',
          borderBottom: '1px solid var(--border-secondary, #e2e8f0)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          fontWeight: 600,
        }}>
          <Space>
            <span>{t('video.timeline.tracksTitle')}</span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('video.timeline.tracksHint')}
            </Text>
          </Space>
        </div>

        {/* 轨道横向滚动容器 */}
        <div style={{
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          justifyContent: timelineShots.length === 0 ? 'center' : 'flex-start',
        }}>
          {timelineShots.length === 0 ? (
            <Empty description={t('video.timeline.emptyDescription')} style={{ margin: 'auto' }} />
          ) : (
            timelineShots.map((item, index) => {
            const isSelected = item.id === selectedShotId;
            const duration = item.clip?.durationSeconds || item.shot.durationSeconds || 5;

            return (
              <div
                key={item.id}
                onClick={() => setSelectedShotId(item.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedShotId(item.id);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={t('video.timeline.shotOrder', { index: index + 1 })}
                style={{
                  width: 200,
                  flexShrink: 0,
                  border: isSelected ? '2px solid var(--accent-primary)' : '1px solid var(--border-secondary)',
                  borderRadius: 8,
                  background: item.enabled ? 'var(--bg-container)' : 'var(--bg-secondary)',
                  opacity: item.enabled ? 1 : 0.5,
                  padding: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  boxShadow: isSelected ? '0 2px 8px rgba(59, 130, 246, 0.2)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                {/* 镜头头部标题与操作 */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Space size={4}>
                    <Tag color={isSelected ? 'blue' : 'default'} style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>
                      {t('video.timeline.shotOrder', { index: index + 1 })}
                    </Tag>
                    <Text style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                      <ClockCircleOutlined style={{ marginRight: 2 }} />
                      {duration}s
                    </Text>
                  </Space>
                  <Space size={2} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title={t('video.timeline.moveEarlier')}>
                      <Button
                        size="small"
                        type="text"
                        disabled={index === 0}
                        icon={<ArrowUpOutlined style={{ fontSize: 10 }} />}
                        onClick={() => handleMoveUp(index)}
                        style={{ padding: '0 4px', height: 20 }}
                      />
                    </Tooltip>
                    <Tooltip title={t('video.timeline.moveLater')}>
                      <Button
                        size="small"
                        type="text"
                        disabled={index === timelineShots.length - 1}
                        icon={<ArrowDownOutlined style={{ fontSize: 10 }} />}
                        onClick={() => handleMoveDown(index)}
                        style={{ padding: '0 4px', height: 20 }}
                      />
                    </Tooltip>
                    <Switch
                      size="small"
                      checked={item.enabled}
                      onChange={() => handleToggleEnable(item.id)}
                      aria-label={t('video.timeline.toggleShot', { index: index + 1 })}
                    />
                  </Space>
                </div>

                {/* 关键帧缩略图展示 */}
                <div style={{
                  height: 95,
                  borderRadius: 4,
                  overflow: 'hidden',
                  background: '#000',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  {item.shot.keyframeImage ? (
                    <img
                      src={toWebviewUrl(resolveLocalPath(item.shot.keyframeImage))}
                      alt={t('video.timeline.shotOrder', { index: index + 1 })}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Text style={{ fontSize: 10, color: '#94a3b8' }}>{t('video.timeline.noKeyframe')}</Text>
                  )}
                  {item.clip?.videoUrl && (
                    <Tag
                      color="green"
                      style={{ position: 'absolute', bottom: 4, right: 4, margin: 0, fontSize: 9, lineHeight: '16px', padding: '0 4px' }}
                    >
                      {t('video.timeline.videoReady')}
                    </Tag>
                  )}
                </div>

                {/* 角色与台词摘要 */}
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                    <FileTextOutlined style={{ fontSize: 10 }} />
                    <Text style={{ fontSize: 11, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.shot.sourceText || item.shot.videoPrompt || t('video.timeline.noText')}
                    </Text>
                  </div>
                  {item.shot.audioTrack && (
                    <Tag color="cyan" style={{ fontSize: 9, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                      <SoundOutlined style={{ marginRight: 2 }} />{t('video.timeline.dialogueAligned')}
                    </Tag>
                  )}
                </div>
              </div>
            );
          }))}
        </div>
      </div>

      {/* 导出视频弹窗 */}
      {finalVideoUrl && (
        <ExportVideoModal
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          sourcePath={finalVideoUrl}
          suggestedName={`mojing-${pipelineId || 'video'}`}
        />
      )}
    </div>
  );
};

export interface VideoTimelineDrawerProps {
  open: boolean;
  onClose: () => void;
  pipelineId?: string;
  project?: VideoProjectState;
}

export const VideoTimelineDrawer: React.FC<VideoTimelineDrawerProps> = ({
  open,
  onClose,
  pipelineId,
  project,
}) => {
  if (!open) return null;
  return (
    <Drawer
      title={null}
      placement="bottom"
      height="85vh"
      open={open}
      onClose={onClose}
      styles={{ body: { padding: 0, overflow: 'hidden' } }}
      closable={false}
    >
      <VideoTimelineWorkspace pipelineId={pipelineId} project={project} onClose={onClose} />
    </Drawer>
  );
};

export default VideoTimelineDrawer;

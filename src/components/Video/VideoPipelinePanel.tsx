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
  Alert, Popconfirm, Tooltip, Steps, Input, message, Select, Modal, Image,
  Form, InputNumber,
} from 'antd';
import {
  VideoCameraOutlined, PlayCircleOutlined, StopOutlined,
  LoadingOutlined, DownOutlined, DownloadOutlined, ReloadOutlined,
  DeleteOutlined, SettingOutlined, SafetyCertificateOutlined,
  ForwardOutlined, UserOutlined, EnvironmentOutlined, EditOutlined,
  PictureOutlined, PlusOutlined, RedoOutlined, FileTextOutlined,
  ClockCircleOutlined, EyeOutlined, AppstoreOutlined, CloseCircleOutlined,
  SlidersOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import type { CharacterAnchor, SceneSpec, VideoStage, StoryboardShot, GeneratedClip } from '@/types/video';
import type { VideoMetadata } from '@/types';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';
import { renderStageContent } from './StageArtifactsModal';
import StageInputEditor from './StageInputEditor';
import ExportVideoModal from './ExportVideoModal';
import VideoPromptSettingsModal from './VideoPromptSettingsModal';
import VideoTimelineDrawer from './VideoTimelineDrawer';
import { runFromFirstFailedStage, runFromStage, runSingleStage, abortPipeline } from '@/services/video/core/pipeline-runner';
import { RUNTIME_STAGE_ORDER } from '@/services/video/core/stage-handlers';
import { logger } from '@/services/log';
import { getProjectAssetStats, cleanProjectAssets, formatBytes } from '@/services/video/asset-store';
import { reviewSeriesEpisode } from '@/services/video/series-episode-review';
import { reviewSeriesEpisodeVisuals, type SeriesVisualReview } from '@/services/video/series-visual-review';
import { reviewSeriesStoryContinuity, type SeriesStoryReview } from '@/services/video/series-story-review';

const { Text, Title, Paragraph } = Typography;

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
  specShot?: SceneSpec['shots'][number];
  clip?: GeneratedClip;
  seriesCharacters?: CharacterAnchor[];
  status: 'pending' | 'running' | 'done' | 'error';
}> = ({ pid, shot, specShot, clip, seriesCharacters, status }) => {
  const { t } = useTranslation();
  const updateSceneSpecShot = useVideoStore((s) => s.updateSceneSpecShot);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editVideoPrompt, setEditVideoPrompt] = useState(shot.videoPrompt || '');
  const [editSourceText, setEditSourceText] = useState(shot.sourceText || '');
  const [editCamera, setEditCamera] = useState(shot.cameraMovement || 'static');
  const [editDuration, setEditDuration] = useState(shot.durationSeconds || 5);
  const [editLocation, setEditLocation] = useState(shot.location || specShot?.sceneId || '');
  const [rerunning, setRerunning] = useState(false);
  const [rerunningKeyframe, setRerunningKeyframe] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);

  const costumeChoices = useMemo(() => (specShot?.characterIds ?? []).flatMap((characterId) => {
    const character = seriesCharacters?.find((item) => item.id === characterId);
    return character?.costumeVariants?.length ? [{ character, characterId }] : [];
  }), [specShot?.characterIds, seriesCharacters]);

  const openEditModal = () => {
    setEditVideoPrompt(shot.videoPrompt || '');
    setEditSourceText(shot.sourceText || '');
    setEditCamera(shot.cameraMovement || 'static');
    setEditDuration(shot.durationSeconds || 5);
    setEditLocation(shot.location || specShot?.sceneId || '');
    setEditModalOpen(true);
  };

  const handleSaveShot = () => {
    updateSceneSpecShot(pid, shot.id, {
      videoPrompt: editVideoPrompt.trim(),
      sourceText: editSourceText.trim() || undefined,
      cameraMovement: editCamera || undefined,
      durationSeconds: editDuration || 5,
      location: editLocation.trim() || undefined,
    });
    setEditModalOpen(false);
    message.success('分镜信息已更新！');
  };

  const handleRerun = async () => {
    setRerunning(true);
    try {
      const { rerunSingleShot } = await import('@/services/video/core/pipeline-runner');
      const res = await rerunSingleShot(pid, shot.id);
      if (res) {
        message.success('本镜动态视频已重生成并自动合成！');
      } else {
        message.error(t('video.pipeline.rerunFailed'));
      }
    } catch (err) {
      message.error(String(err));
    } finally {
      setRerunning(false);
    }
  };

  const handleRerunKeyframe = async () => {
    setRerunningKeyframe(true);
    try {
      const { rerunSingleKeyframe } = await import('@/services/video/core/pipeline-runner');
      const res = await rerunSingleKeyframe(pid, shot.id);
      if (res) {
        message.success('关键帧已重新生成！');
      } else {
        message.error('关键帧重新生成失败');
      }
    } catch (err) {
      message.error(String(err));
    } finally {
      setRerunningKeyframe(false);
    }
  };

  const handleCostumeChange = (characterId: string, variantId?: string) => {
    const refs = { ...specShot?.costumeVariantRefs };
    if (variantId) refs[characterId] = variantId;
    else delete refs[characterId];
    updateSceneSpecShot(pid, shot.id, { costumeVariantRefs: Object.keys(refs).length ? refs : undefined });
  };

  return (
    <Card size="small" style={{ marginBottom: 8 }} styles={{ body: { padding: '10px 14px' } }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Tag color={status === 'done' ? 'success' : status === 'running' ? 'processing' : status === 'error' ? 'error' : 'default'} style={{ marginTop: 2 }}>
          {t('video.gen.shot')} {shot.index + 1}
        </Tag>

        {specShot?.keyframeImage && (
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', marginTop: 2 }}>
            <Image
              src={specShot.keyframeImage}
              width={46}
              height={46}
              style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border-secondary)' }}
              preview={{ mask: <EyeOutlined /> }}
            />
          </div>
        )}

        {clip?.videoUrl && (
          <Tooltip title="点击预览此镜生成视频">
            <Button
              size="small"
              type="primary"
              ghost
              icon={<PlayCircleOutlined />}
              onClick={() => setVideoModalOpen(true)}
              style={{ fontSize: 11, padding: '0 6px', height: 24, marginTop: 2 }}
            >
              片段
            </Button>
          </Tooltip>
        )}

        {videoModalOpen && clip?.videoUrl && (
          <Modal
            title={`第 ${shot.index + 1} 镜视频预览 (${clip.durationSeconds || 5}s)`}
            open={videoModalOpen}
            onCancel={() => setVideoModalOpen(false)}
            footer={null}
            width={640}
            centered
            destroyOnClose
          >
            <div style={{ textAlign: 'center', background: '#000', borderRadius: 6, overflow: 'hidden' }}>
              <video
                src={clip.videoUrl}
                controls
                autoPlay
                style={{ maxWidth: '100%', maxHeight: '60vh', display: 'block', margin: '0 auto' }}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>提示词：</strong>{shot.videoPrompt || shot.sourceText}
            </div>
          </Modal>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 画面提示词完整展示 */}
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 11, marginRight: 6, fontWeight: 600 }}>
              <PictureOutlined style={{ marginRight: 4 }} />画面提示词:
            </Text>
            <Paragraph
              style={{ margin: 0, fontSize: 13, color: 'var(--text-primary)', display: 'inline', lineHeight: '1.6' }}
              ellipsis={{ rows: 2, expandable: true, symbol: '【展开查看全文】' }}
            >
              {shot.videoPrompt || shot.sourceText || '无提示词'}
            </Paragraph>
          </div>

          {/* 原剧本台词展示(若与提示词不同) */}
          {shot.sourceText && shot.videoPrompt && shot.sourceText !== shot.videoPrompt && (
            <div style={{ marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 11, marginRight: 6, fontWeight: 600 }}>
                <FileTextOutlined style={{ marginRight: 4 }} />剧本台词/动作:
              </Text>
              <Paragraph
                style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', display: 'inline', lineHeight: '1.5' }}
                ellipsis={{ rows: 1, expandable: true, symbol: '【展开】' }}
              >
                {shot.sourceText}
              </Paragraph>
            </div>
          )}

          {/* 镜头元数据标签 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4, alignItems: 'center' }}>
            {shot.durationSeconds && (
              <Tag style={{ fontSize: 10, lineHeight: '18px', padding: '0 4px', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <ClockCircleOutlined style={{ fontSize: 10 }} />
                {shot.durationSeconds}s
              </Tag>
            )}
            {shot.cameraMovement && (
              <Tag color="geekblue" style={{ fontSize: 10, lineHeight: '18px', padding: '0 4px', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <VideoCameraOutlined style={{ fontSize: 10 }} />
                {shot.cameraMovement}
              </Tag>
            )}
            {specShot?.characterIds?.map((charId) => {
              const char = seriesCharacters?.find((c) => c.id === charId);
              const isSeries = !!char;
              return (
                <Tag key={charId} color={isSeries ? 'blue' : 'default'} style={{ fontSize: 10, lineHeight: '18px', padding: '0 4px', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  <UserOutlined style={{ fontSize: 10 }} />
                  {char?.name || charId} {isSeries ? '(系列)' : ''}
                </Tag>
              );
            })}
            {(specShot?.sceneId || shot.location) && (
              <Tag color="cyan" style={{ fontSize: 10, lineHeight: '18px', padding: '0 4px', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <EnvironmentOutlined style={{ fontSize: 10 }} />
                {shot.location || specShot?.sceneId}
              </Tag>
            )}
          </div>
        </div>

        <Space size={4} style={{ marginLeft: 8 }}>
          <Tooltip title="编辑分镜描述与运镜">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={openEditModal}
            />
          </Tooltip>
          <Tooltip title="单独重新生成此镜头关键帧">
            <Button
              size="small"
              type="text"
              icon={<PictureOutlined />}
              loading={rerunningKeyframe}
              onClick={handleRerunKeyframe}
            />
          </Tooltip>
          <Tooltip title="单独重新生成此镜头视频片段">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              loading={rerunning}
              onClick={handleRerun}
            />
          </Tooltip>
          <Popconfirm
            title="确定删除此镜头分镜？"
            onConfirm={() => useVideoStore.getState().deleteSceneSpecShot(pid, shot.id)}
            okText="确定"
            cancelText="取消"
          >
            <Tooltip title="删除分镜">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ fontSize: 12 }} />
            </Tooltip>
          </Popconfirm>
        </Space>
      </div>

      {/* 专属镜头分镜修改弹窗 */}
      <Modal
        title={`编辑第 ${shot.index + 1} 镜头分镜信息`}
        open={editModalOpen}
        onCancel={() => setEditModalOpen(false)}
        onOk={handleSaveShot}
        okText="保存分镜"
        cancelText="取消"
        width={640}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label="画面生成提示词 (Video Prompt)" tooltip="用于 AI 画面生成和视频运镜的模型提示词">
            <Input.TextArea
              rows={4}
              value={editVideoPrompt}
              onChange={(e) => setEditVideoPrompt(e.target.value)}
              placeholder="输入镜头画面视觉描述、光影、构图与动作..."
            />
          </Form.Item>
          <Form.Item label="原剧本对白与动作 (Script / Source Text)" tooltip="小说/剧本原始对白，用于 TTS 配音与字幕生成">
            <Input.TextArea
              rows={3}
              value={editSourceText}
              onChange={(e) => setEditSourceText(e.target.value)}
              placeholder="角色台词对白或动作描写..."
            />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item label="运镜模式 (Camera Movement)">
              <Select
                value={editCamera}
                allowClear
                placeholder="选择运镜方式"
                onChange={(val) => setEditCamera(val)}
                options={[
                  { value: 'static', label: '固定镜头 (画面平稳微动)' },
                  { value: 'dolly_in', label: '缓慢推进 (特写聚焦)' },
                  { value: 'dolly_out', label: '平稳拉远 (展现全景)' },
                  { value: 'pan_left', label: '平缓左摇 (滑轨平移)' },
                  { value: 'pan_right', label: '平缓右摇 (滑轨平移)' },
                  { value: 'tracking', label: '平稳跟随 (人物跟拍)' },
                ]}
              />
            </Form.Item>
            <Form.Item label="镜头时长 (秒)">
              <InputNumber
                min={2}
                max={15}
                style={{ width: '100%' }}
                value={editDuration}
                onChange={(val) => setEditDuration(val || 5)}
              />
            </Form.Item>
          </div>
          <Form.Item label="场景 / 拍摄地点">
            <Input
              value={editLocation}
              onChange={(e) => setEditLocation(e.target.value)}
              placeholder="例如: 破庙内、雨夜小巷、凌霄大殿..."
            />
          </Form.Item>
        </Form>
      </Modal>
      {costumeChoices.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-secondary)' }}>
          {costumeChoices.map(({ character, characterId }) => (
            <Space key={characterId} size={4}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('video.series.shotCostume', { name: character.name })}</Text>
              <Select
                size="small"
                allowClear
                value={specShot?.costumeVariantRefs?.[characterId]}
                placeholder={t('video.series.defaultCostume')}
                style={{ minWidth: 130 }}
                onChange={(value) => handleCostumeChange(characterId, value)}
                options={character.costumeVariants?.map((variant) => ({ value: variant.id, label: variant.id }))}
              />
            </Space>
          ))}
        </div>
      )}
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
  const [confirmingKeyframes, setConfirmingKeyframes] = useState(false);
  const [reviewingVisuals, setReviewingVisuals] = useState(false);
  const [visualReview, setVisualReview] = useState<SeriesVisualReview | undefined>();
  const [reviewingStory, setReviewingStory] = useState(false);
  const [storyReview, setStoryReview] = useState<SeriesStoryReview | undefined>();
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
      message.loading('正在从失败处智能恢复生成...', 1.5);
      await runFromFirstFailedStage(pid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error(`[panel] retry threw: ${msg}`, 'panel');
      message.error(`${t('video.pipeline.retryFailed')}: ${msg}`);
    } finally {
      setRetrying(false);
    }
  };

  const handleConfirmKeyframes = async () => {
    if (!pipelineId || confirmingKeyframes) return;
    setConfirmingKeyframes(true);
    try {
      const success = await runFromStage(pipelineId, 'video_generation');
      if (!success) message.warning(t('video.pipeline.keyframeReviewContinuePartial'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirmingKeyframes(false);
    }
  };
  const handleVisualReview = async () => {
    if (!sceneSpec || !seriesProject || reviewingVisuals) return;
    setReviewingVisuals(true);
    try {
      const metadata = seriesProject.metadata as VideoMetadata;
      setVisualReview(await reviewSeriesEpisodeVisuals(sceneSpec, {
        characters: metadata.seriesCharacters,
        scenes: metadata.seriesScenes,
      }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('video.pipeline.visualReviewFailed'));
    } finally {
      setReviewingVisuals(false);
    }
  };
  const handleStoryReview = async () => {
    if (!sceneSpec || !pipelineId || reviewingStory) return;
    const episode = useProjectStore.getState().projects.find((item) => item.id === pipelineId);
    const metadata = episode?.metadata as VideoMetadata | undefined;
    if (!metadata?.seriesId) return;
    setReviewingStory(true);
    try {
      setStoryReview(await reviewSeriesStoryContinuity(sceneSpec, metadata.episodeContinuity, metadata.episodeEndingSummary));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('video.pipeline.storyReviewFailed'));
    } finally {
      setReviewingStory(false);
    }
  };

  const handleAddCharacterToSeries = (charName: string) => {
    if (!seriesProject) return;
    const metadata = (seriesProject.metadata || {}) as VideoMetadata;
    const currentChars = metadata.seriesCharacters || [];
    if (currentChars.some((c) => c.name === charName || c.aliases?.includes(charName))) {
      message.info(`角色 "${charName}" 已存在于系列资产库`);
      return;
    }
    const newChar: CharacterAnchor = {
      id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: charName,
      aliases: [charName],
      appearance: `从剧集分镜提取的角色: ${charName}`,
      firstAppearShotIndex: 0,
    };
    const updatedChars = [...currentChars, newChar];
    useProjectStore.getState().updateProjectMetadata(seriesProject.id, {
      seriesCharacters: updatedChars,
    });
    if (pipelineId && sceneSpec) {
      const updatedUnmatched = (sceneSpec.meta?.unmatchedCharacterNames || []).filter((n) => n !== charName);
      const updatedMatched = [...(sceneSpec.meta?.matchedCharacterNames || []), charName];
      useVideoStore.getState().setSceneSpec(pipelineId, {
        ...sceneSpec,
        meta: {
          ...sceneSpec.meta,
          unmatchedCharacterNames: updatedUnmatched,
          matchedCharacterNames: updatedMatched,
        },
      });
    }
    message.success(`已成功将角色 "${charName}" 录入系列资产库！`);
  };

  const handleAddSceneToSeries = (sceneName: string) => {
    if (!seriesProject) return;
    const metadata = (seriesProject.metadata || {}) as VideoMetadata;
    const currentScenes = metadata.seriesScenes || [];
    if (currentScenes.some((s) => s.name === sceneName || s.aliases?.includes(sceneName))) {
      message.info(`场景 "${sceneName}" 已存在于系列资产库`);
      return;
    }
    const newScene = {
      id: `scene_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: sceneName,
      aliases: [sceneName],
      description: `从剧集分镜提取的场景: ${sceneName}`,
      firstAppearShotIndex: 0,
    };
    const updatedScenes = [...currentScenes, newScene];
    useProjectStore.getState().updateProjectMetadata(seriesProject.id, {
      seriesScenes: updatedScenes,
    });
    if (pipelineId && sceneSpec) {
      const updatedUnmatched = (sceneSpec.meta?.unmatchedSceneNames || []).filter((n) => n !== sceneName);
      const updatedMatched = [...(sceneSpec.meta?.matchedSceneNames || []), sceneName];
      useVideoStore.getState().setSceneSpec(pipelineId, {
        ...sceneSpec,
        meta: {
          ...sceneSpec.meta,
          unmatchedSceneNames: updatedUnmatched,
          matchedSceneNames: updatedMatched,
        },
      });
    }
    message.success(`已成功将场景 "${sceneName}" 录入系列场景库！`);
  };

  // 用户点 Steps 上某个步骤时,切换产物视图到该步骤。
  // null = 自动跟随(currentStage 优先,否则最近完成的步骤)。
  const [focusStage, setFocusStage] = useState<VideoStage | null>(null);
  const [promptSettingsOpen, setPromptSettingsOpen] = useState(false);
  const [timelineDrawerOpen, setTimelineDrawerOpen] = useState(false);

  const novelTitle = useProjectStore((s) => {
    if (!pipelineId || !exists) return undefined;
    if (pipelineId.startsWith('direct_')) return undefined;
    const np = s.projects.find((p) => p.id === pipelineId);
    return np?.title;
  });
  const seriesProject = useProjectStore((s) => {
    if (!pipelineId) return undefined;
    const episode = s.projects.find((project) => project.id === pipelineId);
    const seriesId = (episode?.metadata as VideoMetadata | undefined)?.seriesId;
    return seriesId ? s.projects.find((project) => project.id === seriesId) : undefined;
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
  const awaitingKeyframeReview = stages.video_generation?.status === 'awaiting_review';
  const continuityReview = useMemo(() => {
    const metadata = seriesProject?.metadata as VideoMetadata | undefined;
    return reviewSeriesEpisode(sceneSpec, {
      characters: metadata?.seriesCharacters,
      scenes: metadata?.seriesScenes,
    });
  }, [sceneSpec, seriesProject]);

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
          <Button
            size="small"
            icon={<SlidersOutlined />}
            onClick={() => setTimelineDrawerOpen(true)}
            style={{ borderColor: '#10b981', color: '#10b981' }}
          >
            多轨时间轴剪辑
          </Button>
          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={() => setPromptSettingsOpen(true)}
            style={{ borderColor: 'var(--color-primary, #3b82f6)', color: 'var(--color-primary, #3b82f6)' }}
          >
            提示词预设配置
          </Button>
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
                终止生成
              </Button>
            </Popconfirm>
          )}
          {overall === 'error' ? (
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
              从失败处恢复重试
            </Button>
          ) : (
            overall !== 'running' && (
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={async () => {
                  if (!pipelineId) return;
                  const proj = useVideoStore.getState().getProject(pipelineId);
                  const hasStarted = proj?.stages && Object.values(proj.stages).some((s) => s.status === 'completed');
                  if (hasStarted) {
                    message.loading('正在智能继续未完成的流水线生成...', 1.5);
                    await runFromFirstFailedStage(pipelineId);
                  } else {
                    message.loading('正在从第一步启动全流程流水线生成...', 1.5);
                    const firstStage = RUNTIME_STAGE_ORDER[0] || 'script_slicing';
                    await runFromStage(pipelineId, firstStage);
                  }
                }}
              >
                {project?.stages && Object.values(project.stages).some((s) => s.status === 'completed') ? '继续流水线生成' : '开始全流程生成'}
              </Button>
            )
          )}
          <Popconfirm
            title="确定清空全部产物，一键从第一步重新全流程生成吗？"
            onConfirm={async () => {
              if (!pipelineId) return;
              message.loading('正在重置并从第一步【剧本切片】重新生成...', 1.5);
              const firstStage = RUNTIME_STAGE_ORDER[0] || 'script_slicing';
              useVideoStore.getState().resetStagesFrom(pipelineId, firstStage);
              await runFromStage(pipelineId, firstStage);
            }}
          >
            <Button size="small" icon={<RedoOutlined />}>
              从头重新生成
            </Button>
          </Popconfirm>
          <Tooltip title="导出 4K 高帧率超分增强版本">
            <Tag color="gold" style={{ cursor: 'pointer', fontSize: 11 }}>
              4K 超分渲染已就绪
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
            title="确定重置所有步骤与产物，回到待生成状态吗？"
            onConfirm={() => {
              if (pipelineId) {
                const firstStage = RUNTIME_STAGE_ORDER[0] || 'voice_assignment';
                useVideoStore.getState().resetStagesFrom(pipelineId, firstStage);
                message.success('已成功重置流水线进度');
              }
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
          <Tag color="purple" style={{ fontWeight: 600 }}>AI 漫剧 SOP 6 步工作流</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>
            1.剧本(角色/目标/冲突/行动/结局) ➔ 2.分镜(景别/角度/构图) ➔ 3.角色一致(Seed/参考图) ➔ 4.图生视频 ➔ 5.后期配音 ➔ 6.SOP工具箱
          </Text>
        </Space>
        <Text style={{ fontSize: 11, color: '#722ed1', fontWeight: 600, fontStyle: 'italic', whiteSpace: 'nowrap' }}>
          "AI 是副驾驶，不是方向盘。流程越清楚，结果越稳定。"
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
              if (stage) setFocusStage(stage);
            }}
            items={visibleStages.map((stage) => {
              const state = stages[stage];
              const skipped = DEFAULT_SKIPPED_STAGES.has(stage);
              const completed = state?.status === 'completed';
              const running = state?.status === 'running';
              const awaitingReview = state?.status === 'awaiting_review';
              const errored = state?.status === 'error';
              const isFocused = stage === inlineStage;

              // Antd Steps 的 status: 'finish' | 'process' | 'wait' | 'error'
              let stepStatus: 'finish' | 'process' | 'wait' | 'error';
              if (skipped) stepStatus = 'wait';
              else if (errored) stepStatus = 'error';
              else if (running) stepStatus = 'process';
              else if (awaitingReview) stepStatus = 'process';
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
              } else if (awaitingReview) {
                description = (
                  <span style={{ fontSize: 10, color: 'var(--accent-primary)' }}>
                    {t('video.artifacts.status.awaiting_review')}
                  </span>
                );
              } else if (errored && state?.error) {
                description = (
                  <Tooltip title={state.error}>
                    <span style={{
                      fontSize: 10, color: 'var(--accent-danger, #ef4444)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      display: 'inline-block', maxWidth: 160,
                    }}>
                      <CloseCircleOutlined style={{ marginRight: 2 }} />
                      {state.error}
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

            {/* 系列资产匹配与快速收录提示 */}
            {seriesProject && (sceneSpec?.meta?.unmatchedCharacterNames?.length || sceneSpec?.meta?.unmatchedSceneNames?.length) ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="系列资产库匹配与收录提示"
                description={
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {sceneSpec?.meta?.unmatchedCharacterNames && sceneSpec.meta.unmatchedCharacterNames.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        <Text style={{ fontSize: 12 }}>发现本集新增/未匹配角色：</Text>
                        {sceneSpec.meta.unmatchedCharacterNames.map((name) => (
                          <Tag key={name} color="orange" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <UserOutlined /> {name}
                            <Button
                              type="link"
                              size="small"
                              icon={<PlusOutlined style={{ fontSize: 10 }} />}
                              style={{ padding: 0, height: 'auto', fontSize: 11 }}
                              onClick={() => handleAddCharacterToSeries(name)}
                            >
                              加入系列库
                            </Button>
                          </Tag>
                        ))}
                      </div>
                    )}
                    {sceneSpec?.meta?.unmatchedSceneNames && sceneSpec.meta.unmatchedSceneNames.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        <Text style={{ fontSize: 12 }}>发现本集新增/未匹配场景：</Text>
                        {sceneSpec.meta.unmatchedSceneNames.map((name) => (
                          <Tag key={name} color="cyan" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <EnvironmentOutlined /> {name}
                            <Button
                              type="link"
                              size="small"
                              icon={<PlusOutlined style={{ fontSize: 10 }} />}
                              style={{ padding: 0, height: 'auto', fontSize: 11 }}
                              onClick={() => handleAddSceneToSeries(name)}
                            >
                              加入系列库
                            </Button>
                          </Tag>
                        ))}
                      </div>
                    )}
                  </div>
                }
              />
            ) : null}

            {awaitingKeyframeReview && (
              <Alert
                type={continuityReview.ready ? 'success' : 'warning'}
                showIcon
                icon={<SafetyCertificateOutlined />}
                style={{ marginBottom: 12 }}
                message={t('video.pipeline.keyframeReviewTitle')}
                description={
                  <div>
                    <div>{t('video.pipeline.keyframeReviewHint')}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                      <Tag color={continuityReview.missingKeyframeIndexes.length ? 'warning' : 'success'}>
                        {t('video.pipeline.review.keyframes', { done: continuityReview.keyframedShots, total: continuityReview.totalShots })}
                      </Tag>
                      <Tag color={continuityReview.unresolvedCharacterIds.length || continuityReview.libraryCharacterMismatches.length ? 'error' : 'success'}>
                        {t('video.pipeline.review.characters', { count: continuityReview.unresolvedCharacterIds.length + continuityReview.libraryCharacterMismatches.length })}
                      </Tag>
                      <Tag color={continuityReview.unresolvedSceneIds.length || continuityReview.librarySceneMismatches.length ? 'error' : 'success'}>
                        {t('video.pipeline.review.scenes', { count: continuityReview.unresolvedSceneIds.length + continuityReview.librarySceneMismatches.length })}
                      </Tag>
                    </div>
                    {!continuityReview.ready && (
                      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                        {t('video.pipeline.review.blockedHint')}
                      </Text>
                    )}
                    {(continuityReview.charactersWithoutPortrait.length > 0 || continuityReview.scenesWithoutReference.length > 0) && (
                      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                        {t('video.pipeline.review.referenceHint', {
                          characters: continuityReview.charactersWithoutPortrait.length,
                          scenes: continuityReview.scenesWithoutReference.length,
                        })}
                      </Text>
                    )}
                    {visualReview && (
                      <Text type={visualReview.issues.some((item) => !item.passed) ? 'warning' : 'success'} style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                        {t('video.pipeline.visualReviewResult', { reviewed: visualReview.reviewedShots, issues: visualReview.issues.filter((item) => !item.passed).length })}
                        {visualReview.issues.filter((item) => !item.passed).map((item) => ` · #${item.shotIndex} ${item.reason}`).join('')}
                      </Text>
                    )}
                    {storyReview && (
                      <Text type={storyReview.risks.length ? 'warning' : 'success'} style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                        {t('video.pipeline.storyReviewResult', { count: storyReview.risks.length })}{storyReview.risks.map((risk) => ` · ${risk}`).join('')}
                      </Text>
                    )}
                  </div>
                }
                action={
                  <Space direction="vertical" size={6}>
                    <Button size="small" loading={reviewingVisuals} onClick={handleVisualReview}>{t('video.pipeline.visualReview')}</Button>
                    <Button size="small" loading={reviewingStory} onClick={handleStoryReview}>{t('video.pipeline.storyReview')}</Button>
                    <Button
                      type="primary"
                      size="small"
                      loading={confirmingKeyframes}
                      onClick={handleConfirmKeyframes}
                    >
                      {t('video.pipeline.keyframeReviewContinue')}
                    </Button>
                  </Space>
                }
              />
            )}

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
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 8, padding: '6px 0',
                }}>
                  <Space>
                    <Text strong style={{ fontSize: 14 }}>
                      {t(`video.gen.stage.${inlineStage}`)}
                    </Text>
                    {stages[inlineStage]?.status && (
                      <Tag color={stages[inlineStage]?.status === 'completed' ? 'success' : stages[inlineStage]?.status === 'running' ? 'processing' : stages[inlineStage]?.status === 'error' ? 'error' : 'default'} style={{ fontSize: 11 }}>
                        {t(`video.artifacts.status.${stages[inlineStage]!.status}`)}
                      </Tag>
                    )}
                  </Space>
                  <Space>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<PlayCircleOutlined />}
                      onClick={async () => {
                        if (!pipelineId) return;
                        message.loading(`正在执行【${t(`video.gen.stage.${inlineStage}`)}】...`, 1.5);
                        await runSingleStage(pipelineId, inlineStage);
                      }}
                    >
                      立即运行此步
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      icon={<ForwardOutlined />}
                      onClick={async () => {
                        if (!pipelineId) return;
                        message.loading(`正在从【${t(`video.gen.stage.${inlineStage}`)}】向下连续生成...`, 1.5);
                        await runFromStage(pipelineId, inlineStage);
                      }}
                    >
                      从此步向下连续生成
                    </Button>
                  </Space>
                </div>
                {renderStageContent(inlineStage, project, sceneSpec, t)}
                {/* 单步重跑:输入参数编辑 + 重跑按钮 */}
                <Divider style={{ margin: '12px 0 8px' }} />
                <StageInputEditor stage={inlineStage} project={project} />
              </div>
            )}
          </div>

          {/* Shots 列表(底部高度自适应滚动) */}
          {shots.length > 0 && (
            <div style={{
              maxHeight: 380, minHeight: 180, flexShrink: 0,
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
                  <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddShotModalOpen(true)}>
                    添加分镜
                  </Button>
                  {overall === 'running' && <Spin size="small" />}
                </Space>
              </div>

              <Modal
                title="手动追加分镜"
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
                    specShot={sceneSpec?.shots.find((item) => item.id === shot.id)}
                    clip={clips.find((c) => c.shotId === shot.id)}
                    seriesCharacters={(seriesProject?.metadata as VideoMetadata | undefined)?.seriesCharacters}
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

      {/* 视频工坊提示词预设配置 Modal */}
      <VideoPromptSettingsModal
        open={promptSettingsOpen}
        onClose={() => setPromptSettingsOpen(false)}
      />

      {/* 可视化多轨时间轴剪辑与微调工作台 Drawer */}
      <VideoTimelineDrawer
        open={timelineDrawerOpen}
        onClose={() => setTimelineDrawerOpen(false)}
        pipelineId={pipelineId}
        project={project}
      />
    </div>
  );
};

export default VideoPipelinePanel;

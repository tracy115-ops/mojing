// ============================================================================
// VideoGeneratorModal — 从小说章节生成视频的入口
// ============================================================================
// 流程：
//   配置阶段：选小说 → 选章节 → 选规格
//   生成阶段：实时显示 stage 进度 + 分镜列表
//   完成阶段：展示成片 + 重新生成按钮
//
// 由 NovelView 底部工具栏触发。

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Modal, Button, Select, Checkbox, Tag, Alert,
  Typography, Divider, Empty, Progress, Space,
  Dropdown, Menu,
} from 'antd';
import {
  VideoCameraOutlined, ReloadOutlined, DownloadOutlined, EyeOutlined, DownOutlined,
  CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import { getEndpointCategory, useProviderStore } from '@/stores/providerStore';
import { logger } from '@/services/log';
import { VideoPipeline } from '@/services/video/pipeline';
import type {
  VideoProjectState, VideoStage, VideoSpec,
  AspectRatio, ModelTier, CharacterAnchor, SceneAnchor,
} from '@/types/video';
import { DEFAULT_PIPELINE_OPTIONS } from '@/types/video';
import type { PipelinePreflightResult } from '@/services/video/core/pipeline-preflight-rules';
import { collectVideoPipelinePreflight } from '@/services/video/core/pipeline-preflight';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';
import ExportVideoModal from './ExportVideoModal';
import StageArtifactsModal from './StageArtifactsModal';
import ProviderModelsSummary from './ProviderModelsSummary';
import PipelinePreflightAlert from './PipelinePreflightAlert';
import type { NovelMetadata, NovelChapter } from '@/types';

const { Text, Paragraph, Title } = Typography;

interface VideoGeneratorModalProps {
  open: boolean;
  onClose: () => void;
  /** 默认绑定的小说项目 ID（从 NovelView 传入） */
  defaultNovelId?: string;
  /** 系列剧集的运行项目 ID；小说仅提供章节素材。 */
  episodeProjectId?: string;
  /** 系列项目锁定的角色资产。 */
  seriesCharacters?: CharacterAnchor[];
  seriesScenes?: SceneAnchor[];
  seriesStyleGuide?: string;
  seriesContinuityContext?: string;
}

type ModalPhase = 'config' | 'preflight' | 'running' | 'done';

const VideoGeneratorModal: React.FC<VideoGeneratorModalProps> = ({ open, onClose, defaultNovelId, episodeProjectId, seriesCharacters, seriesScenes, seriesStyleGuide, seriesContinuityContext }) => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const providerState = useProviderStore(useShallow((s) => ({ endpoints: s.endpoints, config: s.config })));
  const videoEndpoints = useMemo(
    () => providerState.endpoints.filter((endpoint) => endpoint.enabled && getEndpointCategory(endpoint) === 'video'),
    [providerState.endpoints],
  );

  // Config state
  const [selectedNovelId, setSelectedNovelId] = useState<string | undefined>(defaultNovelId);
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [spec, setSpec] = useState<VideoSpec>({
    aspectRatio: '16:9',
    resolution: '1920x1080',
    fps: 24,
    shotDurationSeconds: 5,
    videoTier: 'value',
    imageTier: 'value',
    ttsTier: 'free',
    hardcodeSubtitles: true,
    bgmStyle: 'cinematic',
  });
  const pipelineProjectId = episodeProjectId ?? selectedNovelId;
  const videoProject = useVideoStore((s) => (pipelineProjectId ? s.projects[pipelineProjectId] : undefined));

  const [phase, setPhase] = useState<ModalPhase>('config');
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);
  const pipelineRef = useRef<VideoPipeline | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedNovelId(defaultNovelId);
    setSelectedChapterIds([]);
    setErrorMsg(undefined);
  }, [open, defaultNovelId, episodeProjectId]);

  // If a video project already exists for this novel, jump to "done" view
  useEffect(() => {
    if (open && videoProject?.currentStage === 'complete') {
      setPhase('done');
    } else if (open && videoProject?.currentStage && (
      videoProject.stages[videoProject.currentStage]?.status === 'running'
      || videoProject.stages[videoProject.currentStage]?.status === 'awaiting_review'
    )) {
      setPhase('running');
    } else if (open) {
      setPhase('config');
    }
  }, [open, videoProject?.currentStage]);

  const novelProjects = useMemo(() => projects.filter((p) => p.type === 'novel'), [projects]);

  const activeNovel = projects.find((p) => p.id === selectedNovelId && p.type === 'novel');
  const novelMeta = activeNovel?.metadata as NovelMetadata | undefined;
  const allChapters: NovelChapter[] = novelMeta?.chapters ?? [];

  // Filter chapters with content
  const chaptersWithContent = useMemo(
    () => allChapters.filter((c) => c.content && c.content.trim().length > 100),
    [allChapters],
  );

  const hasVideoProvider = videoEndpoints.length > 0;

  const pipelinePreflight = useMemo(() => collectVideoPipelinePreflight({
    channel: 'novel',
    sourceMode: 'multishot',
    options: DEFAULT_PIPELINE_OPTIONS,
    startStage: 'script_slicing',
    planningRequired: true,
    hasCharacterReferences: true,
    hasSpeech: selectedChapterIds.length > 0,
  }), [providerState, selectedChapterIds.length, spec.videoTier]);

  // Estimated shot count for hint
  const estimatedShots = useMemo(() => {
    const totalWords = selectedChapterIds
      .map((id) => allChapters.find((c) => c.id === id)?.content.length ?? 0)
      .reduce((s, n) => s + n, 0);
    const perShot = spec.shotDurationSeconds === 10 ? 1200 : 600;
    return Math.max(1, Math.ceil(totalWords / perShot));
  }, [selectedChapterIds, allChapters, spec.shotDurationSeconds]);

  const estimatedMinutes = Math.max(2, Math.ceil(estimatedShots * 1.5)); // ~90s per shot

  const handleToggleChapter = (id: string, checked: boolean) => {
    setSelectedChapterIds((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id),
    );
  };

  const handleSelectNovel = (id: string) => {
    setSelectedNovelId(id);
    setSelectedChapterIds([]);
  };

  const preflight = useMemo(() => {
    const blocking: string[] = [];
    const warnings: string[] = [];
    if (!selectedNovelId) blocking.push(t('video.gen.preflightNovelMissing'));
    if (selectedChapterIds.length === 0) blocking.push(t('video.gen.preflightChaptersMissing'));
    if (selectedChapterIds.some((id) => !allChapters.some((chapter) => chapter.id === id))) {
      blocking.push(t('video.gen.preflightChapterChanged'));
    }
    return { blocking, warnings, pipeline: pipelinePreflight };
  }, [allChapters, pipelinePreflight, selectedChapterIds, selectedNovelId, t]);

  const hasBlockingPreflight = preflight.blocking.length > 0 || !preflight.pipeline.ok;

  const handleSelectAllChapters = () => {
    setSelectedChapterIds(chaptersWithContent.map((c) => c.id));
  };

  const handleClearChapters = () => setSelectedChapterIds([]);

  const handleStart = async () => {
    if (!selectedNovelId || selectedChapterIds.length === 0) return;
    if (hasBlockingPreflight) {
      setPhase('preflight');
      return;
    }

    void logger.info(`[modal] handleStart novel=${selectedNovelId} chapters=${selectedChapterIds.length}`, 'modal');

    const novel = useProjectStore.getState().projects.find((p) => p.id === selectedNovelId);
    if (!novel || novel.type !== 'novel') return;
    const meta = novel.metadata as NovelMetadata;

    const selectedChapters = selectedChapterIds
      .map((id) => meta.chapters.find((c) => c.id === id))
      .filter((c): c is NovelChapter => !!c);

    setErrorMsg(undefined);

    const pipeline = new VideoPipeline(
      {
        novelProjectId: pipelineProjectId!,
        novelTitle: episodeProjectId
          ? useProjectStore.getState().projects.find((project) => project.id === episodeProjectId)?.title || novel.title
          : novel.title,
        genre: meta.genre,
        style: meta.style,
        chapters: selectedChapters.map((c) => ({
          id: c.id, order: c.order, content: c.content,
        })),
        spec,
        seriesCharacters,
        seriesScenes,
        seriesStyleGuide,
        seriesContinuityContext,
      },
      {
        onError: (msg) => setErrorMsg(msg),
      },
    );
    pipelineRef.current = pipeline;

    // 切到主面板的流水线 tab,然后立即关闭 Modal —— 执行过程改由 VideoPipelinePanel 展示。
    useVideoStore.getState().setActivePipelineId(pipelineProjectId);
    setPhase('running');

    // 后台跑流水线;Modal 已关闭,phase 状态不再相关。
    pipeline.run().then((result) => {
      if (result?.currentStage === 'complete') setPhase('done');
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error(`[modal] pipeline.run threw: ${msg}`, 'modal');
      setErrorMsg(msg);
    });
  };

  const handleReset = () => {
    if (pipelineProjectId) {
      useVideoStore.getState().resetProject(pipelineProjectId);
    }
    setPhase('config');
    setErrorMsg(undefined);
  };

  // --- Render ---

  const footer = (() => {
    if (phase === 'done') {
      return [
        <Button key="reset" icon={<ReloadOutlined />} onClick={handleReset}>
          {t('video.gen.start')}
        </Button>,
        <Button key="close" onClick={onClose}>
          {t('common.cancel')}
        </Button>,
      ];
    }
    if (phase === 'preflight') {
      return [
        <Button key="back" onClick={() => setPhase('config')}>{t('video.gen.preflightBack')}</Button>,
        <Button
          key="confirm"
          type="primary"
          icon={<VideoCameraOutlined />}
          disabled={hasBlockingPreflight}
          onClick={handleStart}
        >
          {t('video.gen.preflightConfirm')}
        </Button>,
      ];
    }
    if (phase === 'running') {
      return [
        <Button key="close" onClick={onClose}>{t('video.gen.runningBackground')}</Button>,
      ];
    }
    return [
      <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
      <Button
          key="start"
        type="primary"
        icon={<VideoCameraOutlined />}
        disabled={!selectedNovelId || selectedChapterIds.length === 0}
        onClick={() => setPhase('preflight')}
      >
        {t('video.gen.preflightOpen')}
      </Button>,
    ];
  })();

  return (
    <Modal
      title={t('video.gen.title')}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={820}
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {t('video.gen.description')}
      </Paragraph>

      {!hasVideoProvider && (
        <Alert
          type="warning"
          showIcon
          message={t('video.gen.needProvider')}
          style={{ marginBottom: 16 }}
        />
      )}

      {errorMsg && (
        <Alert
          type="error"
          showIcon
          message={errorMsg}
          closable
          onClose={() => setErrorMsg(undefined)}
          style={{ marginBottom: 16 }}
        />
      )}

      {phase === 'config' && (
        <ConfigPane
          novelProjects={novelProjects}
          selectedNovelId={selectedNovelId}
          onSelectNovel={handleSelectNovel}
          chapters={chaptersWithContent}
          selectedChapterIds={selectedChapterIds}
          onToggleChapter={handleToggleChapter}
          onSelectAll={handleSelectAllChapters}
          onClearAll={handleClearChapters}
          spec={spec}
          onSpecChange={setSpec}
          estimatedShots={estimatedShots}
          estimatedMinutes={estimatedMinutes}
        />
      )}

      {phase === 'preflight' && (
        <PreflightPane
          selectedChapterCount={selectedChapterIds.length}
          estimatedShots={estimatedShots}
          estimatedMinutes={estimatedMinutes}
          pipeline={preflight.pipeline}
          blocking={preflight.blocking}
          warnings={preflight.warnings}
          seriesCharacterCount={seriesCharacters?.length ?? 0}
          seriesSceneCount={seriesScenes?.length ?? 0}
        />
      )}

      {phase === 'running' && (
        <RunningPane project={videoProject} onOpenWorkbench={onClose} />
      )}

      {phase === 'done' && videoProject && (
        <DonePane project={videoProject} />
      )}
    </Modal>
  );
};

// ============================================================================
// Config Pane
// ============================================================================

interface PreflightPaneProps {
  selectedChapterCount: number;
  estimatedShots: number;
  estimatedMinutes: number;
  pipeline: PipelinePreflightResult;
  blocking: string[];
  warnings: string[];
  seriesCharacterCount: number;
  seriesSceneCount: number;
}

const PreflightPane: React.FC<PreflightPaneProps> = ({
  selectedChapterCount,
  estimatedShots,
  estimatedMinutes,
  pipeline,
  blocking,
  warnings,
  seriesCharacterCount,
  seriesSceneCount,
}) => {
  const { t } = useTranslation();
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Title level={5} style={{ margin: 0 }}>{t('video.gen.preflightTitle')}</Title>
        <Text type="secondary">{t('video.gen.preflightDescription')}</Text>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
        <Tag style={{ margin: 0, padding: '8px 10px' }}>{t('video.gen.preflightChapters', { count: selectedChapterCount })}</Tag>
        <Tag style={{ margin: 0, padding: '8px 10px' }}>{t('video.gen.preflightShots', { count: estimatedShots })}</Tag>
        <Tag style={{ margin: 0, padding: '8px 10px' }}>{t('video.gen.preflightTime', { minutes: estimatedMinutes })}</Tag>
      </div>

      <div style={{ padding: 12, border: '1px solid var(--border-secondary)', borderRadius: 6, background: 'var(--bg-tertiary)' }}>
        <Text strong>{t('video.gen.preflightSeriesAssets')}</Text>
        <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
          {t('video.gen.preflightSeriesAssetsValue', { characters: seriesCharacterCount, scenes: seriesSceneCount })}
        </Text>
      </div>

      <PipelinePreflightAlert
        result={pipeline}
        additionalBlocking={blocking}
        additionalWarnings={warnings}
      />
    </Space>
  );
};

const RunningPane: React.FC<{ project?: VideoProjectState; onOpenWorkbench: () => void }> = ({ project, onOpenWorkbench }) => {
  const { t } = useTranslation();
  const stages = VIDEO_PIPELINE_STAGES.filter((stage) => !DEFAULT_SKIPPED_STAGES.has(stage));
  const activeStage = project
    ? stages.find((stage) => project.stages[stage]?.status === 'running' || project.stages[stage]?.status === 'awaiting_review')
      ?? project.currentStage
    : undefined;
  const progress = project
    ? Math.round(stages.reduce((total, stage) => {
      const state = project.stages[stage];
      if (state?.status === 'completed' || state?.status === 'skipped') return total + 1;
      if (state?.status === 'running' || state?.status === 'awaiting_review') return total + Math.max(0, Math.min(1, state.progress || 0));
      return total;
    }, 0) / Math.max(stages.length, 1) * 100)
    : 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div>
        <Title level={5} style={{ margin: 0 }}>{t('video.gen.runningTitle')}</Title>
        <Text type="secondary">{t('video.gen.runningDescription')}</Text>
      </div>
      <Progress percent={progress} status="active" />
      <Alert
        type={project?.error ? 'error' : 'info'}
        showIcon
        icon={project?.error ? <ExclamationCircleOutlined /> : <LoadingOutlined spin />}
        message={project?.error || (activeStage ? t(`video.gen.stage.${activeStage}`) : t('video.gen.runningPreparing'))}
        description={activeStage ? project?.stages[activeStage]?.inputSummary?.headline : undefined}
      />
      <Button type="primary" onClick={onOpenWorkbench}>{t('video.gen.runningOpenWorkbench')}</Button>
    </Space>
  );
};

interface ConfigPaneProps {
  novelProjects: { id: string; title: string }[];
  selectedNovelId?: string;
  onSelectNovel: (id: string) => void;
  chapters: NovelChapter[];
  selectedChapterIds: string[];
  onToggleChapter: (id: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  spec: VideoSpec;
  onSpecChange: (spec: VideoSpec) => void;
  estimatedShots: number;
  estimatedMinutes: number;
}

const ConfigPane: React.FC<ConfigPaneProps> = ({
  novelProjects, selectedNovelId, onSelectNovel,
  chapters, selectedChapterIds, onToggleChapter,
  onSelectAll, onClearAll,
  spec, onSpecChange,
  estimatedShots, estimatedMinutes,
}) => {
  const { t } = useTranslation();

  return (
    <div>
      {/* Novel selector */}
      <div style={{ marginBottom: 16 }}>
        <Text strong>{t('video.gen.selectNovel')}</Text>
        <Select
          value={selectedNovelId}
          onChange={onSelectNovel}
          style={{ width: '100%', marginTop: 6 }}
          placeholder={t('video.gen.selectNovel')}
          showSearch
          optionFilterProp="label"
          options={novelProjects.map((p) => ({ value: p.id, label: p.title }))}
        />
      </div>

      {/* Chapter multi-select */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong>{t('video.gen.selectChapters')}</Text>
          {chapters.length > 0 && (
            <div>
              <Button size="small" type="link" onClick={onSelectAll}>全选</Button>
              <Button size="small" type="link" onClick={onClearAll}>清空</Button>
            </div>
          )}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('video.gen.selectChaptersHint')}
        </Text>
        <div style={{
          marginTop: 8, maxHeight: 180, overflowY: 'auto',
          border: '1px solid var(--border-secondary)', borderRadius: 6, padding: 8,
        }}>
          {chapters.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.gen.noChapters')} />
          ) : (
            chapters.map((c) => (
              <Checkbox
                key={c.id}
                checked={selectedChapterIds.includes(c.id)}
                onChange={(e) => onToggleChapter(c.id, e.target.checked)}
                style={{ display: 'block', margin: 0, padding: '4px 0' }}
              >
                <span>第 {c.order + 1} 章 · {c.title || '无标题'}</span>
                <Tag style={{ marginLeft: 8, fontSize: 11 }}>{(c.wordCount / 1000).toFixed(1)}k</Tag>
              </Checkbox>
            ))
          )}
        </div>
      </div>

      <Divider style={{ margin: '8px 0' }} />

      {/* Spec */}
      <div style={{ marginBottom: 16 }}>
        <Text strong>{t('video.gen.spec')}</Text>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('video.gen.shotDuration')}</Text>
            <Select
              value={spec.shotDurationSeconds}
              onChange={(v) => onSpecChange({ ...spec, shotDurationSeconds: v })}
              style={{ width: '100%', marginTop: 4 }}
              options={[
                { value: 0, label: '智能动态时长 (推荐)' },
                { value: 5, label: t('video.gen.shotDuration.5') },
                { value: 10, label: t('video.gen.shotDuration.10') },
              ]}
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('video.aspectRatio')}</Text>
            <Select
              value={spec.aspectRatio}
              onChange={(v: AspectRatio) => onSpecChange({
                ...spec,
                aspectRatio: v,
                resolution: v === '9:16' ? '1080x1920' : v === '1:1' ? '1080x1080' : '1920x1080',
              })}
              style={{ width: '100%', marginTop: 4 }}
              options={[
                { value: '16:9', label: t('video.aspectRatio.16:9') },
                { value: '9:16', label: t('video.aspectRatio.9:16') },
                { value: '1:1', label: t('video.aspectRatio.1:1') },
              ]}
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('video.gen.videoTier')}</Text>
            <Select
              value={spec.videoTier}
              onChange={(v: ModelTier) => onSpecChange({ ...spec, videoTier: v })}
              style={{ width: '100%', marginTop: 4 }}
              options={[
                { value: 'free', label: t('video.gen.tier.free') },
                { value: 'value', label: t('video.gen.tier.value') },
                { value: 'quality', label: t('video.gen.tier.quality') },
                { value: 'premium', label: t('video.gen.tier.premium') },
              ]}
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('video.gen.hardcodeSubtitles')}</Text>
            <div style={{ marginTop: 8 }}>
              <Checkbox
                checked={spec.hardcodeSubtitles}
                onChange={(e) => onSpecChange({ ...spec, hardcodeSubtitles: e.target.checked })}
              >
                {spec.hardcodeSubtitles ? 'ON' : 'OFF'}
              </Checkbox>
            </div>
          </div>
        </div>
      </div>

      {/* 将使用的 provider/model(读设置) */}
      <div style={{ marginTop: 12 }}>
        <ProviderModelsSummary />
      </div>

      {/* Estimate hint */}
      {selectedChapterIds.length > 0 && (
        <Alert
          type="info"
          showIcon
          message={t('video.gen.startHint', { minutes: estimatedMinutes, shots: estimatedShots })}
          style={{ marginTop: 12 }}
        />
      )}
    </div>
  );
};

// ============================================================================
// Done Pane — 成片预览（用户从历史项目主动打开 Modal 时仍可见）
// ============================================================================

const DonePane: React.FC<{ project: VideoProjectState }> = ({ project }) => {
  const { t } = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  const [artifactStage, setArtifactStage] = useState<VideoStage | null>(null);

  const sizeLabel = project.finalSizeBytes
    ? `${(project.finalSizeBytes / 1024 / 1024).toFixed(1)} MB`
    : undefined;
  const durLabel = project.finalDurationSeconds
    ? `${project.finalDurationSeconds.toFixed(1)}s`
    : undefined;
  const metaLabel = [durLabel, sizeLabel].filter(Boolean).join(' · ');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Title level={5} style={{ margin: 0 }}>{t('video.gen.preview')}</Title>
        <Space>
          <Dropdown
            overlay={(
              <Menu
                onClick={(e) => setArtifactStage(e.key as VideoStage)}
                items={VIDEO_PIPELINE_STAGES
                  .filter((s) => !DEFAULT_SKIPPED_STAGES.has(s) && project.stages[s]?.status === 'completed')
                  .map((s) => ({ key: s, label: t(`video.gen.stage.${s}`) }))}
              />
            )}
          >
            <Button icon={<EyeOutlined />}>
              {t('video.artifacts.viewStage')} <DownOutlined />
            </Button>
          </Dropdown>
          {project.finalVideoUrl && (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => setExportOpen(true)}
            >
              {t('video.export.button')}
            </Button>
          )}
        </Space>
      </div>

      <StageArtifactsModal
        open={!!artifactStage}
        onClose={() => setArtifactStage(null)}
        stage={artifactStage}
        project={project}
      />
      {project.finalVideoUrl ? (
        <>
          <video
            src={project.finalVideoUrl}
            controls
            style={{ width: '100%', maxHeight: 400, background: '#000', borderRadius: 6 }}
          />
          {metaLabel && (
            <div style={{ marginTop: 6 }}>
              <Tag color="blue" style={{ fontSize: 11 }}>{metaLabel}</Tag>
            </div>
          )}
        </>
      ) : (
        <Empty description={t('video.gen.noVideoYet')} />
      )}

      <Divider style={{ margin: '12px 0' }} />

      <Title level={5}>{t('video.gen.shots')} ({project.clips.length}/{project.shots.length})</Title>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {project.clips.map((clip) => {
          const shot = project.shots.find((s) => s.id === clip.shotId);
          return (
            <Tag
              key={clip.shotId}
              color="success"
              style={{ margin: 2, fontSize: 11 }}
            >
              {t('video.gen.shot')} {(shot?.index ?? 0) + 1} · {clip.provider} · {clip.durationSeconds}s
            </Tag>
          );
        })}
      </div>

      {project.finalVideoUrl && (
        <ExportVideoModal
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          sourcePath={project.finalVideoUrl}
          suggestedName={`mojing-${project.novelProjectId}`}
        />
      )}
    </div>
  );
};

export default VideoGeneratorModal;

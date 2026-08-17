import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message, Button, Form, Input, Modal } from 'antd';
import { VideoCameraOutlined, FolderAddOutlined, FireOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import type { VideoMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateVideoModal, { CreateVideoFormValues } from './CreateVideoModal';
import VideoGeneratorModal from './VideoGeneratorModal';
import VideoPipelinePanel from './VideoPipelinePanel';
import { VideoPipelineErrorBoundary } from './VideoPipelineErrorBoundary';
import { VideoPipeline } from '@/services/video/pipeline';
import { buildSceneFromPrompt } from '@/services/video/direct-scene-builder';
import { runFromStage, runPipeline } from '@/services/video/core/pipeline-runner';
import { applySeriesProjectLibrary } from '@/services/video/series-character-library';
import { PipelineOptions, type CharacterAnchor, type SceneAnchor } from '@/types/video';
import VideoSeriesWorkspace from './VideoSeriesWorkspace';

const { Text, Title } = Typography;

const FULL_PIPELINE_OPTIONS: PipelineOptions = {
  enableCharacterAnchor: true,
  enableSceneImage: true,
  enableTTS: true,
  enableKeyframe: true,
  enableI2V: true,
  enableAudioMerge: true,
  enableSubtitles: true,
  characterAnchorLimit: 5,
};

const VideoView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);

  const activePipelineId = useVideoStore((s) => s.activePipelineId);

  const [createOpen, setCreateOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [episodeSeriesId, setEpisodeSeriesId] = useState<string | undefined>();
  const [generatorEpisodeId, setGeneratorEpisodeId] = useState<string | undefined>();
  const [generatorDefaultNovelId, setGeneratorDefaultNovelId] = useState<string | undefined>();
  const [generatorSeriesCharacters, setGeneratorSeriesCharacters] = useState<CharacterAnchor[] | undefined>();
  const [generatorSeriesScenes, setGeneratorSeriesScenes] = useState<SceneAnchor[] | undefined>();
  const [generatorSeriesStyleGuide, setGeneratorSeriesStyleGuide] = useState<string | undefined>();
  const [generatorSeriesContinuityContext, setGeneratorSeriesContinuityContext] = useState<string | undefined>();
  const [seriesForm] = Form.useForm<{ title: string; description?: string }>();

  // Listen for global "new project" event from titlebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      if (type === 'video') {
        setSeriesOpen(true);
      }
    };
    window.addEventListener('mojing:create-project', handler);
    return () => window.removeEventListener('mojing:create-project', handler);
  }, []);

  const videoProjects = useMemo(
    () => projects.filter((p) => p.type === 'video' && (p.metadata as VideoMetadata).seriesRole !== 'episode'),
    [projects],
  );
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeVideoMetadata = activeProject?.metadata as VideoMetadata | undefined;
  const activeSeries = activeProject?.type === 'video' && activeVideoMetadata?.seriesRole === 'series'
    ? activeProject
    : undefined;
  const activeEpisodeSeries = activeVideoMetadata?.seriesRole === 'episode' && activeVideoMetadata.seriesId
    ? projects.find((project) => project.id === activeVideoMetadata.seriesId)
    : undefined;
  const seriesEpisodes = useMemo(
    () => activeSeries
      ? projects.filter((project) => project.type === 'video' && (project.metadata as VideoMetadata).seriesId === activeSeries.id)
      : [],
    [activeSeries, projects],
  );

  const handleCreate = async (values: CreateVideoFormValues) => {
    const desc = values.scriptText || values.description;
    const seriesId = episodeSeriesId;
    const series = seriesId
      ? useProjectStore.getState().projects.find((candidate) => candidate.id === seriesId)
      : undefined;
    const seriesCharacters = (series?.metadata as VideoMetadata | undefined)?.seriesCharacters;
    const seriesScenes = (series?.metadata as VideoMetadata | undefined)?.seriesScenes;
    const seriesStyleGuide = (series?.metadata as VideoMetadata | undefined)?.seriesStyleGuide;
    const existingEpisodes = seriesId
      ? useProjectStore.getState().projects
        .filter((candidate) => candidate.type === 'video' && (candidate.metadata as VideoMetadata).seriesId === seriesId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      : [];
    const previousEpisode = existingEpisodes[existingEpisodes.length - 1];
    const previousEpisodeMetadata = previousEpisode?.metadata as VideoMetadata | undefined;
    const episodeContinuity = previousEpisodeMetadata?.episodeEndingSummary?.trim() || undefined;
    const project = useProjectStore.getState().createProject('video', values.title, desc || values.scriptText || '', {
      style: values.style,
      resolution: values.resolution,
      aspectRatio: values.aspectRatio,
      fps: values.fps,
      scriptText: values.scriptText,
      chapters: values.scriptText ? [{ id: 'ch_1', number: 1, content: values.scriptText }] : undefined,
      ...(seriesId ? { seriesRole: 'episode' as const, seriesId, previousEpisodeId: previousEpisode?.id, episodeContinuity } : {}),
    } as any);
    
    const duration = values.shotDurationSeconds || 5;
    // 初始化 videoStore 中的对应项目运行时状态
    const store = useVideoStore.getState();
    const spec = {
      aspectRatio: (values.aspectRatio as any) || '16:9',
      resolution: values.resolution || '1920x1080',
      fps: values.fps || 24,
      shotDurationSeconds: duration as any,
      videoTier: 'value' as const,
      imageTier: 'value' as const,
      ttsTier: 'free' as const,
      hardcodeSubtitles: false,
      bgmStyle: (values.style as any) || 'cinematic',
    };

    store.initProject(project.id, [], spec, values.title);

    setActiveProject(project.id);
    store.setActivePipelineId(project.id);
    setCreateOpen(false);
    setEpisodeSeriesId(undefined);

    if (values.scriptText) {
      // ✍️ 粘贴剧本生成：统一使用 VideoPipeline 进行切片、分镜规划、角色提取与系列资产绑定！
      message.loading({ content: '正在为剧本切片并规划分镜与角色...', key: 'create-pipeline' });
      try {
        const pipeline = new VideoPipeline(
          {
            novelProjectId: project.id,
            novelTitle: values.title,
            genre: 'script',
            style: values.style,
            chapters: [
              {
                id: `${project.id}_script`,
                order: 0,
                content: values.scriptText,
              },
            ],
            spec,
            options: FULL_PIPELINE_OPTIONS,
            seriesCharacters,
            seriesScenes,
            seriesStyleGuide,
            seriesContinuityContext: episodeContinuity,
          },
          {
            onError: (msg) => {
              message.error({ content: msg, key: 'create-pipeline' });
            },
          },
        );
        message.success({ content: '剧本全流程生成已启动！', key: 'create-pipeline' });
        pipeline.run().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('Failed to run script pipeline:', err);
          message.error({ content: `剧本生成异常: ${msg}`, key: 'create-pipeline' });
        });
      } catch (err) {
        console.error('Failed to start novel script pipeline:', err);
        message.error({ content: '剧本解析启动失败', key: 'create-pipeline' });
      }
    } else if (values.novelId) {
        // 关联了已有小说：打开章节选择配置框
        if (seriesId) {
          setGeneratorEpisodeId(project.id);
          setGeneratorDefaultNovelId(values.novelId);
          setGeneratorSeriesCharacters(seriesCharacters);
          setGeneratorSeriesScenes(seriesScenes);
          setGeneratorSeriesStyleGuide(seriesStyleGuide);
          setGeneratorSeriesContinuityContext(episodeContinuity);
        }
        setGenOpen(true);
    }
  };

  const handleSelectProject = (id: string) => {
    setActiveProject(id);
    const selected = projects.find((project) => project.id === id);
    if (selected?.type === 'video' && (selected.metadata as VideoMetadata).seriesRole === 'series') {
      useVideoStore.getState().setActivePipelineId(undefined);
      return;
    }
    const store = useVideoStore.getState();
    const proj = projects.find((p) => p.id === id);
    const meta = proj?.metadata as Partial<VideoMetadata> | undefined;

    if (!store.projects[id] || !store.projects[id].sceneSpec) {
      if (meta?.initialSceneSpec) {
        store.initProject(
          id,
          meta.initialSceneSpec.shots.map((s) => s.id),
          {
            aspectRatio: (meta?.aspectRatio as any) || '16:9',
            resolution: meta?.resolution || '1920x1080',
            fps: meta?.fps || 24,
            shotDurationSeconds: 5,
            videoTier: 'value',
            imageTier: 'value',
            ttsTier: 'free',
            hardcodeSubtitles: false,
            bgmStyle: meta?.style || 'cinematic',
          },
          proj?.title,
        );
        store.setSceneSpec(id, meta.initialSceneSpec);
      } else {
        store.initProject(
          id,
          [],
          {
            aspectRatio: (meta?.aspectRatio as any) || '16:9',
            resolution: meta?.resolution || '1920x1080',
            fps: meta?.fps || 24,
            shotDurationSeconds: 5,
            videoTier: 'value',
            imageTier: 'value',
            ttsTier: 'free',
            hardcodeSubtitles: false,
            bgmStyle: meta?.style || 'cinematic',
          },
          proj?.title,
        );
      }
    }
    store.setActivePipelineId(id);
  };

  const handleDeleteProject = (id: string) => {
    deleteProject(id);
    useVideoStore.getState().resetProject(id);
    if (useVideoStore.getState().activePipelineId === id) {
      useVideoStore.getState().setActivePipelineId(undefined);
    }
  };

  const handleCreateSeries = async () => {
    const values = await seriesForm.validateFields();
    const series = useProjectStore.getState().createProject('video', values.title.trim(), values.description?.trim() || '', {
      seriesRole: 'series',
      seriesCharacters: [],
    } as Partial<VideoMetadata>);
    setActiveProject(series.id);
    useVideoStore.getState().setActivePipelineId(undefined);
    seriesForm.resetFields();
    setSeriesOpen(false);
    message.success(t('video.series.created'));
  };

  const handleCreateEpisode = (seriesId: string) => {
    setEpisodeSeriesId(seriesId);
    setCreateOpen(true);
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProjectList
          projects={videoProjects}
          type="video"
          activeId={activeProjectId}
          onSelect={handleSelectProject}
          onDelete={handleDeleteProject}
          onToggleFavorite={toggleFavorite}
          onCreate={() => {
            setSeriesOpen(true);
          }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Top toolbar — two entries */}
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)',
          display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        }}>
          <Button type="primary"
            icon={<FolderAddOutlined />}
            onClick={() => setSeriesOpen(true)}
          >
            {t('video.series.newSeries')}
          </Button>
          <Button
            icon={<FireOutlined style={{ color: '#fa8c16' }} />}
            onClick={() => {
              const res = useProjectStore.getState().seedShawBrothersMartialCatProject();
              handleSelectProject(res.series.id);
              message.success('已载入《80年代港风武侠·猫大师与小师妹》示范项目与第1集');
            }}
          >
            载入猫大师港风示范
          </Button>
          {activeEpisodeSeries && (
            <Button onClick={() => handleSelectProject(activeEpisodeSeries.id)}>
              {t('video.series.backToSeries', { title: activeEpisodeSeries.title })}
            </Button>
          )}
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {t('video.series.consistencyHint')}
          </Text>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activeSeries ? (
            <VideoSeriesWorkspace
              series={activeSeries}
              episodes={seriesEpisodes}
              onUpdateCharacters={(characters: CharacterAnchor[]) => {
                useProjectStore.getState().updateProjectMetadata(activeSeries.id, { seriesCharacters: characters });
              }}
              onUpdateScenes={(scenes: SceneAnchor[]) => {
                useProjectStore.getState().updateProjectMetadata(activeSeries.id, { seriesScenes: scenes });
              }}
              onUpdateStyleGuide={(seriesStyleGuide) => {
                useProjectStore.getState().updateProjectMetadata(activeSeries.id, { seriesStyleGuide });
              }}
              onUpdateEpisodeContinuity={(episodeId, values) => {
                useProjectStore.getState().updateProjectMetadata(episodeId, values as unknown as Record<string, unknown>);
              }}
              onSyncEpisodeAssets={async (episodeId) => {
                const pipelineProject = useVideoStore.getState().getProject(episodeId);
                if (!pipelineProject?.sceneSpec) return false;
                const seriesMetadata = activeSeries.metadata as VideoMetadata;
                const boundSceneSpec = applySeriesProjectLibrary(pipelineProject.sceneSpec, {
                  characters: seriesMetadata.seriesCharacters,
                  scenes: seriesMetadata.seriesScenes,
                  styleGuide: seriesMetadata.seriesStyleGuide,
                });
                useVideoStore.getState().setSceneSpec(episodeId, boundSceneSpec);
                return runFromStage(episodeId, 'keyframe_image');
              }}
              onCreateEpisode={() => handleCreateEpisode(activeSeries.id)}
              onOpenEpisode={handleSelectProject}
            />
          ) : activePipelineId ? (
            <VideoPipelineErrorBoundary
              onReset={() => {
                useVideoStore.getState().resetProject(activePipelineId);
                useVideoStore.getState().setActivePipelineId(undefined);
              }}
            >
              <VideoPipelinePanel pipelineId={activePipelineId} />
            </VideoPipelineErrorBoundary>
          ) : (
            <div style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 20,
              padding: 32,
              textAlign: 'center',
              overflowY: 'auto',
            }}>
              <VideoCameraOutlined style={{ fontSize: 56, color: 'var(--accent-primary, #3b82f6)' }} />
              <div>
                <Title level={4} style={{ margin: '0 0 6px 0', color: 'var(--text-primary, inherit)' }}>
                  {t('video.series.consistencyTitle')}
                </Title>
                <Text type="secondary" style={{ maxWidth: 520, fontSize: 13, display: 'inline-block' }}>
                  {t('video.series.descriptionFallback')}
                </Text>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <Button
                  type="primary"
                  size="large"
                  icon={<FolderAddOutlined />}
                  onClick={() => setSeriesOpen(true)}
                >
                  {t('video.series.newSeries')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <CreateVideoModal
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => {
          setCreateOpen(false);
          setEpisodeSeriesId(undefined);
        }}
      />
      <VideoGeneratorModal
        open={genOpen}
        defaultNovelId={generatorDefaultNovelId}
        episodeProjectId={generatorEpisodeId}
        seriesCharacters={generatorSeriesCharacters}
        seriesScenes={generatorSeriesScenes}
        seriesStyleGuide={generatorSeriesStyleGuide}
        seriesContinuityContext={generatorSeriesContinuityContext}
        onClose={() => {
          setGenOpen(false);
          setGeneratorEpisodeId(undefined);
          setGeneratorDefaultNovelId(undefined);
          setGeneratorSeriesCharacters(undefined);
          setGeneratorSeriesScenes(undefined);
          setGeneratorSeriesStyleGuide(undefined);
        }}
      />
      <Modal
        title={t('video.series.newSeries')}
        open={seriesOpen}
        onOk={() => void handleCreateSeries()}
        onCancel={() => {
          seriesForm.resetFields();
          setSeriesOpen(false);
        }}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form form={seriesForm} layout="vertical">
          <Form.Item name="title" label={t('video.series.name')} rules={[{ required: true, message: t('video.series.nameRequired') }]}>
            <Input autoFocus placeholder={t('video.series.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('video.series.description')}>
            <Input.TextArea rows={3} placeholder={t('video.series.descriptionPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default VideoView;

import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message, Button, Tooltip } from 'antd';
import { VideoCameraOutlined, ThunderboltOutlined, FormOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import type { VideoMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateVideoModal from './CreateVideoModal';
import VideoGeneratorModal from './VideoGeneratorModal';
import DirectVideoModal from './DirectVideoModal';
import VideoPipelinePanel from './VideoPipelinePanel';
import { VideoPipelineErrorBoundary } from './VideoPipelineErrorBoundary';

const { Text, Title } = Typography;

const VideoView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);

  const activePipelineId = useVideoStore((s) => s.activePipelineId);

  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'novel' | 'direct'>('novel');
  const [genOpen, setGenOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);

  // Listen for global "new project" event from titlebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      if (type === 'video') {
        setCreateMode('novel');
        setCreateOpen(true);
      }
    };
    window.addEventListener('mojing:create-project', handler);
    return () => window.removeEventListener('mojing:create-project', handler);
  }, []);

  const videoProjects = useMemo(() => projects.filter((p) => p.type === 'video'), [projects]);

  const handleCreate = (values: any) => {
    const desc = values.mode === 'direct' ? values.prompt : (values.scriptText || values.description);
    const project = useProjectStore.getState().createProject('video', values.title, desc || '', {
      style: values.style,
      resolution: values.resolution,
      aspectRatio: values.aspectRatio,
      fps: values.fps,
    } as Partial<VideoMetadata>);
    
    // 初始化 videoStore 中的对应项目运行时状态
    useVideoStore.getState().initProject(
      project.id,
      [],
      {
        aspectRatio: (values.aspectRatio as any) || '16:9',
        resolution: values.resolution || '1920x1080',
        fps: values.fps || 24,
        shotDurationSeconds: 5,
        videoTier: 'value',
        imageTier: 'value',
        ttsTier: 'free',
        hardcodeSubtitles: false,
        bgmStyle: values.style || 'cinematic',
      },
      values.title,
    );

    setActiveProject(project.id);
    useVideoStore.getState().setActivePipelineId(project.id);
    setCreateOpen(false);

    if (values.mode === 'direct') {
      setDirectOpen(true);
    } else {
      setGenOpen(true);
    }

    message.success(t('common.success'));
  };

  const handleSelectProject = (id: string) => {
    setActiveProject(id);
    const store = useVideoStore.getState();
    if (!store.projects[id]) {
      const proj = projects.find((p) => p.id === id);
      const meta = proj?.metadata as Partial<VideoMetadata> | undefined;
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
    store.setActivePipelineId(id);
  };

  const handleDeleteProject = (id: string) => {
    deleteProject(id);
    useVideoStore.getState().resetProject(id);
    if (useVideoStore.getState().activePipelineId === id) {
      useVideoStore.getState().setActivePipelineId(undefined);
    }
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
            setCreateMode('novel');
            setCreateOpen(true);
          }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Top toolbar — two entries */}
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)',
          display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        }}>
          <Tooltip title={t('video.direct.tooltip')}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                setCreateMode('direct');
                setCreateOpen(true);
              }}
            >
              {t('video.direct.button')}
            </Button>
          </Tooltip>
          <Tooltip title={t('video.gen.description')}>
            <Button
              icon={<FormOutlined />}
              onClick={() => {
                setCreateMode('novel');
                setCreateOpen(true);
              }}
            >
              {t('video.gen.title')}
            </Button>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {t('video.direct.tagline')}
          </Text>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activePipelineId ? (
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
                  {t('video.empty.title')}
                </Title>
                <Text type="secondary" style={{ maxWidth: 520, fontSize: 13, display: 'inline-block' }}>
                  {t('video.empty.hint')}
                </Text>
              </div>

              {/* 灵感快捷启动卡片 */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 16,
                maxWidth: 780,
                width: '100%',
                marginTop: 8,
              }}>
                <div
                  onClick={() => setDirectOpen(true)}
                  style={{
                    padding: 16,
                    border: '1px solid var(--border-secondary)',
                    borderRadius: 8,
                    background: 'var(--bg-container)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-secondary)')}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>⚡</div>
                  <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>一键灵感生视频</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>输入单条 Prompt 立即文本/图生成短视频片段</Text>
                </div>

                <div
                  onClick={() => setDirectOpen(true)}
                  style={{
                    padding: 16,
                    border: '1px solid var(--border-secondary)',
                    borderRadius: 8,
                    background: 'var(--bg-container)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-secondary)')}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>🎭</div>
                  <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>角色一致性短剧</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>提取形象立绘与场景背景图，跨镜头脸部统一</Text>
                </div>

                <div
                  onClick={() => setGenOpen(true)}
                  style={{
                    padding: 16,
                    border: '1px solid var(--border-secondary)',
                    borderRadius: 8,
                    background: 'var(--bg-container)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-secondary)')}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>📜</div>
                  <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>小说/脚本改编</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>选择已有小说章节，14步智能编排完整短片</Text>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <Button
                  type="primary"
                  size="large"
                  icon={<ThunderboltOutlined />}
                  onClick={() => setDirectOpen(true)}
                >
                  {t('video.direct.cta')}
                </Button>
                <Button
                  size="large"
                  icon={<FormOutlined />}
                  onClick={() => setGenOpen(true)}
                >
                  {t('video.gen.cta')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <CreateVideoModal open={createOpen} initialMode={createMode} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
      <VideoGeneratorModal open={genOpen} onClose={() => setGenOpen(false)} />
      <DirectVideoModal open={directOpen} onClose={() => setDirectOpen(false)} />
    </div>
  );
};

export default VideoView;

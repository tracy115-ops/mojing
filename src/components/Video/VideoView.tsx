import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message, Button, Tooltip, Tabs } from 'antd';
import { VideoCameraOutlined, ThunderboltOutlined, FormOutlined, LineChartOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import type { VideoMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateVideoModal from './CreateVideoModal';
import VideoWorkspace from './VideoWorkspace';
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
  const [genOpen, setGenOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);
  const [tabKey, setTabKey] = useState<'scenes' | 'pipeline'>('scenes');

  // Auto-switch to pipeline tab when a pipeline starts running
  useEffect(() => {
    if (activePipelineId) setTabKey('pipeline');
  }, [activePipelineId]);

  // Listen for global "new project" event from titlebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      if (type === 'video') setCreateOpen(true);
    };
    window.addEventListener('mojing:create-project', handler);
    return () => window.removeEventListener('mojing:create-project', handler);
  }, []);

  const videoProjects = useMemo(() => projects.filter((p) => p.type === 'video'), [projects]);
  const activeProject = projects.find((p) => p.id === activeProjectId && p.type === 'video');

  const handleCreate = (values: { title: string; description: string; style: string; resolution: string; aspectRatio: string; fps: number }) => {
    const project = useProjectStore.getState().createProject('video', values.title, values.description, {
      style: values.style,
      resolution: values.resolution,
      aspectRatio: values.aspectRatio,
      fps: values.fps,
    } as Partial<VideoMetadata>);
    setActiveProject(project.id);
    setCreateOpen(false);
    message.success(t('common.success'));
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProjectList
          projects={videoProjects}
          type="video"
          activeId={activeProjectId}
          onSelect={setActiveProject}
          onDelete={deleteProject}
          onToggleFavorite={toggleFavorite}
          onCreate={() => setCreateOpen(true)}
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
              onClick={() => setDirectOpen(true)}
            >
              {t('video.direct.button')}
            </Button>
          </Tooltip>
          <Tooltip title={t('video.gen.description')}>
            <Button
              icon={<FormOutlined />}
              onClick={() => setGenOpen(true)}
            >
              {t('video.gen.title')}
            </Button>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {t('video.direct.tagline')}
          </Text>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activeProject || activePipelineId ? (
            <Tabs
              activeKey={tabKey}
              onChange={(k) => setTabKey(k as 'scenes' | 'pipeline')}
              size="small"
              className="video-view-tabs"
              style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              tabBarStyle={{ padding: '0 12px', margin: 0, flexShrink: 0 }}
              items={[
                {
                  key: 'scenes',
                  label: (
                    <span>
                      <VideoCameraOutlined /> {t('video.pipeline.tab.scenes')}
                    </span>
                  ),
                  children: activeProject ? (
                    <VideoWorkspace projectId={activeProject.id} />
                  ) : (
                    <div style={{ padding: 24, textAlign: 'center' }}>
                      <Text type="secondary">{t('video.pipeline.empty')}</Text>
                    </div>
                  ),
                  forceRender: true,
                },
                {
                  key: 'pipeline',
                  label: (
                    <span>
                      <LineChartOutlined /> {t('video.pipeline.tab.pipeline')}
                      {activePipelineId && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-primary)' }}>●</span>
                      )}
                    </span>
                  ),
                  children: (
                    <VideoPipelineErrorBoundary
                      onReset={() => {
                        if (activePipelineId) {
                          useVideoStore.getState().resetProject(activePipelineId);
                        }
                        useVideoStore.getState().setActivePipelineId(undefined);
                      }}
                    >
                      <VideoPipelinePanel pipelineId={activePipelineId ?? null} />
                    </VideoPipelineErrorBoundary>
                  ),
                },
              ]}
            />
          ) : (
            <div style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
              padding: 24,
              textAlign: 'center',
            }}>
              <VideoCameraOutlined style={{ fontSize: 64, color: 'var(--text-tertiary, rgba(0,0,0,0.25))' }} />
              <Title level={4} style={{ margin: 0, color: 'var(--text-primary, inherit)' }}>
                {t('video.empty.title')}
              </Title>
              <Text type="secondary" style={{ maxWidth: 480 }}>
                {t('video.empty.hint')}
              </Text>
              <div style={{ display: 'flex', gap: 12 }}>
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
      <CreateVideoModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
      <VideoGeneratorModal open={genOpen} onClose={() => setGenOpen(false)} />
      <DirectVideoModal open={directOpen} onClose={() => setDirectOpen(false)} />
    </div>
  );
};

export default VideoView;

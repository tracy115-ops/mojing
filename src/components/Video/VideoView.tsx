import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message, Button, Tooltip } from 'antd';
import { VideoCameraOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateVideoModal from './CreateVideoModal';
import VideoWorkspace from './VideoWorkspace';
import VideoGeneratorModal from './VideoGeneratorModal';

const { Text } = Typography;

const VideoView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);

  const [createOpen, setCreateOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);

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
        {/* Top toolbar — entry for novel-based generation */}
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)',
          display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        }}>
          <Tooltip title={t('video.gen.description')}>
            <Button
              icon={<VideoCameraOutlined />}
              onClick={() => setGenOpen(true)}
            >
              {t('video.gen.title')}
            </Button>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('video.gen.description')}
          </Text>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {activeProject ? (
            <VideoWorkspace projectId={activeProject.id} />
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text type="secondary">{t('video.empty')}</Text>
            </div>
          )}
        </div>
      </div>
      <CreateVideoModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
      <VideoGeneratorModal open={genOpen} onClose={() => setGenOpen(false)} />
    </div>
  );
};

export default VideoView;

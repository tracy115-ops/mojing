import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateVideoModal from './CreateVideoModal';
import VideoWorkspace from './VideoWorkspace';

const { Text } = Typography;

const VideoView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);

  const [createOpen, setCreateOpen] = useState(false);

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
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeProject ? (
          <VideoWorkspace projectId={activeProject.id} />
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text type="secondary">{t('video.empty')}</Text>
          </div>
        )}
      </div>
      <CreateVideoModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
    </div>
  );
};

export default VideoView;

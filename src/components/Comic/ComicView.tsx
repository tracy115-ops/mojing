import React, { useState, useMemo } from 'react';
import { Typography, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { ComicMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateComicModal from './CreateComicModal';
import ComicWorkspace from './ComicWorkspace';

const { Text } = Typography;

const ComicView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);

  const [createOpen, setCreateOpen] = useState(false);

  const comicProjects = useMemo(() => projects.filter((p) => p.type === 'comic'), [projects]);
  const activeProject = projects.find((p) => p.id === activeProjectId && p.type === 'comic');

  const handleCreate = (values: { title: string; description: string; style: string; panelLayout: string }) => {
    const project = useProjectStore.getState().createProject('comic', values.title, values.description, {
      style: values.style,
      panelLayout: values.panelLayout,
    } as Partial<ComicMetadata>);
    setActiveProject(project.id);
    setCreateOpen(false);
    message.success(t('common.success'));
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProjectList
          projects={comicProjects}
          type="comic"
          activeId={activeProjectId}
          onSelect={setActiveProject}
          onDelete={deleteProject}
          onToggleFavorite={toggleFavorite}
          onCreate={() => setCreateOpen(true)}
        />
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeProject ? (
          <ComicWorkspace projectId={activeProject.id} />
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text type="secondary">{t('comic.empty')}</Text>
          </div>
        )}
      </div>
      <CreateComicModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
    </div>
  );
};

export default ComicView;

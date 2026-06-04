import React, { useState, useMemo } from 'react';
import { Button, List, Typography, Tag, Popconfirm, message } from 'antd';
import { PlusOutlined, CheckCircleOutlined, EditOutlined, FileTextOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { NovelChapter, NovelMetadata, ChapterStatus } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateNovelModal from './CreateNovelModal';
import ChapterEditor from './ChapterEditor';

const { Text } = Typography;

const STATUS_ICONS: Record<ChapterStatus, React.ReactNode> = {
  planned: <FileTextOutlined style={{ color: 'var(--text-tertiary)' }} />,
  drafting: <EditOutlined style={{ color: '#3b82f6' }} />,
  revising: <EditOutlined style={{ color: '#f59e0b' }} />,
  complete: <CheckCircleOutlined style={{ color: '#22c55e' }} />,
};

const NovelView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);
  const addChapter = useProjectStore((s) => s.addChapter);
  const deleteChapter = useProjectStore((s) => s.deleteChapter);
  const updateChapter = useProjectStore((s) => s.updateChapter);

  const [createOpen, setCreateOpen] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);

  const novelProjects = useMemo(
    () => projects.filter((p) => p.type === 'novel'),
    [projects],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId && p.type === 'novel');
  const novelMeta = activeProject?.metadata as NovelMetadata | undefined;
  const chapters = novelMeta?.chapters ?? [];
  const activeChapter = chapters.find((c) => c.id === activeChapterId);

  const handleCreate = (values: { title: string; description: string; genre: string; targetWordCount: number; style: string; language: string }) => {
    const project = useProjectStore.getState().createProject('novel', values.title, values.description, {
      genre: values.genre,
      targetWordCount: values.targetWordCount,
      style: values.style,
      language: values.language,
    } as Partial<NovelMetadata>);
    setActiveProject(project.id);
    setCreateOpen(false);
    message.success(t('common.success'));
  };

  const handleSelectProject = (id: string) => {
    setActiveProject(id);
    const proj = useProjectStore.getState().projects.find((p) => p.id === id);
    if (proj?.type === 'novel') {
      const meta = proj.metadata as NovelMetadata;
      setActiveChapterId(meta.chapters[0]?.id ?? null);
    }
  };

  const handleUpdateChapter = (updates: Partial<NovelChapter>) => {
    if (!activeProjectId || !activeChapterId) return;
    updateChapter(activeProjectId, activeChapterId, updates);
  };

  const handleAddChapter = () => {
    if (!activeProjectId) return;
    addChapter(activeProjectId);
    const proj = useProjectStore.getState().projects.find((p) => p.id === activeProjectId);
    if (proj?.type === 'novel') {
      const meta = proj.metadata as NovelMetadata;
      setActiveChapterId(meta.chapters[meta.chapters.length - 1]?.id ?? null);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Left: Project list */}
      <div style={{ width: 220, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <ProjectList
          projects={novelProjects}
          type="novel"
          activeId={activeProjectId}
          onSelect={handleSelectProject}
          onDelete={deleteProject}
          onToggleFavorite={toggleFavorite}
          onCreate={() => setCreateOpen(true)}
        />
      </div>

      {/* Right: Workspace */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!activeProject ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
            <Text type="secondary">{t('novel.empty')}</Text>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* Chapter list */}
            <div style={{ width: 180, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', fontWeight: 600, fontSize: 13 }}>
                {t('novel.chapters')} ({chapters.length})
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <List
                  size="small"
                  dataSource={chapters}
                  renderItem={(chapter) => (
                    <List.Item
                      onClick={() => setActiveChapterId(chapter.id)}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        background: activeChapterId === chapter.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                        borderLeft: activeChapterId === chapter.id ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                        {STATUS_ICONS[chapter.status]}
                        <Text ellipsis style={{ flex: 1, fontSize: 12 }}>{chapter.title || `第${chapter.order + 1}章`}</Text>
                        <Text type="secondary" style={{ fontSize: 10 }}>{chapter.wordCount}</Text>
                      </div>
                    </List.Item>
                  )}
                  locale={{ emptyText: t('common.noData') }}
                />
              </div>
              <div style={{ padding: 8, borderTop: '1px solid var(--border-secondary)' }}>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddChapter} block>
                  {t('novel.addChapter')}
                </Button>
              </div>
            </div>

            {/* Chapter editor */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {activeChapter ? (
                <ChapterEditor
                  chapter={activeChapter}
                  onUpdate={handleUpdateChapter}
                  allChapters={chapters}
                  novelTitle={activeProject.title}
                />
              ) : (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary">{t('novel.addChapter')}</Text>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <CreateNovelModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
    </div>
  );
};

export default NovelView;

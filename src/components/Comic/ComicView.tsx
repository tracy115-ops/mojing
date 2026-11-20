import React, { useState, useMemo } from 'react';
import { Typography, List, Tag } from 'antd';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import ProjectCreateBar from '@/components/Common/ProjectCreateBar';
import CreateComicModal from './CreateComicModal';
import ComicPipelinePanel from './ComicPipelinePanel';

const { Text } = Typography;

const ComicView: React.FC = () => {
  const { t } = useTranslation();
  const projectsMap = useComicStore((s) => s.projects);
  const activeProjectId = useComicStore((s) => s.activeProjectId);
  const setActiveProjectId = useComicStore((s) => s.setActiveProjectId);

  const [createOpen, setCreateOpen] = useState(false);

  const projects = useMemo(
    () =>
      Object.values(projectsMap).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [projectsMap],
  );
  const activeProject = activeProjectId ? projectsMap[activeProjectId] : undefined;

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* 项目列表 */}
      <div
        style={{
          flex: '0 0 220px',
          borderRight: '1px solid var(--border-secondary)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <ProjectCreateBar label={t('comic.newProject')} testId="comic-new-project" onCreate={() => setCreateOpen(true)} />
        <div style={{ flex: 1, overflow: 'auto' }}>
          {projects.length > 0 && (
            <List
              size="small"
              dataSource={projects}
              renderItem={(p) => (
                <List.Item
                  onClick={() => setActiveProjectId(p.id)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    background:
                      activeProjectId === p.id
                        ? 'var(--bg-active, rgba(59,130,246,0.08))'
                        : 'transparent',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      width: '100%',
                    }}
                  >
                    <Text ellipsis strong style={{ fontSize: 12 }}>
                      {p.title}
                    </Text>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>
                        {t(`comic.sourceMode.${p.sourceMode === 'novel' ? 'novel' : 'theme'}`)}
                      </Tag>
                      <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>
                        {p.spec.panels.length}/{p.panelCount}
                      </Tag>
                    </div>
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>
      </div>

      {/* 主区域 */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeProject ? (
          <ComicPipelinePanel projectId={activeProject.id} />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              padding: 32,
              textAlign: 'center',
            }}
          >
            <Text type="secondary">{t('comic.empty')}</Text>
          </div>
        )}
      </div>

      <CreateComicModal
        open={createOpen}
        onOk={(id) => {
          setActiveProjectId(id);
          setCreateOpen(false);
        }}
        onCancel={() => setCreateOpen(false)}
      />
    </div>
  );
};

export default ComicView;

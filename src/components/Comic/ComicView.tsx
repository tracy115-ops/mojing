import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message, Button, List, Tag, Empty } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import CreateComicModal from './CreateComicModal';
import ComicPipelinePanel from './ComicPipelinePanel';

const { Text } = Typography;

const ComicView: React.FC = () => {
  const { t } = useTranslation();
  const projectsMap = useComicStore((s) => s.projects);
  const activeProjectId = useComicStore((s) => s.activeProjectId);
  const setActiveProjectId = useComicStore((s) => s.setActiveProjectId);
  const deleteProject = useComicStore((s) => s.deleteProject);

  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      if (type === 'comic') setCreateOpen(true);
    };
    window.addEventListener('mojing:create-project', handler);
    return () => window.removeEventListener('mojing:create-project', handler);
  }, []);

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
          width: 220,
          borderRight: '1px solid var(--border-secondary)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--border-secondary)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Text strong style={{ fontSize: 13 }}>
            {t('comic.title')}
          </Text>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            {t('comic.newProject')}
          </Button>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {projects.length === 0 ? (
            <div style={{ padding: 24 }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t('comic.empty')}
              />
            </div>
          ) : (
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
              alignItems: 'center',
              justifyContent: 'center',
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
          message.success(t('common.success'));
        }}
        onCancel={() => setCreateOpen(false)}
      />
    </div>
  );
};

export default ComicView;

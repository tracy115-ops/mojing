import React from 'react';
import { Card, Button, Tag, Empty, Popconfirm, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined, StarOutlined, StarFilled, BookOutlined, PictureOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import type { CreativeProject, CreativeProjectType, ProjectStatus } from '@/types';

const { Text, Paragraph } = Typography;

const STATUS_COLORS: Record<ProjectStatus, string> = {
  planning: 'default',
  in_progress: 'processing',
  paused: 'warning',
  completed: 'success',
  archived: 'default',
};

const TYPE_ICONS: Record<CreativeProjectType, React.ReactNode> = {
  novel: <BookOutlined />,
  comic: <PictureOutlined />,
  video: <VideoCameraOutlined />,
};

interface ProjectListProps {
  projects: CreativeProject[];
  type: CreativeProjectType;
  activeId?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onCreate: () => void;
}

const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  type,
  activeId,
  onSelect,
  onDelete,
  onToggleFavorite,
  onCreate,
}) => {
  const { t } = useTranslation();

  const createLabel = type === 'novel' ? t('novel.newProject') : type === 'comic' ? t('comic.newProject') : t('video.newProject');
  const emptyText = type === 'novel' ? t('novel.empty') : type === 'comic' ? t('comic.empty') : t('video.empty');

  if (projects.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE}>
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            {createLabel}
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate} block size="small">
          {createLabel}
        </Button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px' }}>
        {projects.map((project) => (
          <Card
            key={project.id}
            size="small"
            hoverable
            onClick={() => onSelect(project.id)}
            style={{
              marginBottom: 8,
              cursor: 'pointer',
              border: activeId === project.id ? '2px solid var(--accent-primary, #3b82f6)' : '1px solid var(--border-secondary)',
              background: activeId === project.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'var(--bg-container)',
            }}
            styles={{ body: { padding: '8px 12px' } }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  {TYPE_ICONS[project.type]}
                  <Text strong ellipsis style={{ fontSize: 13 }}>{project.title}</Text>
                </div>
                {project.description && (
                  <Paragraph ellipsis={{ rows: 1 }} style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {project.description}
                  </Paragraph>
                )}
                <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                  <Tag color={STATUS_COLORS[project.status]} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                    {t(`project.status.${project.status}`)}
                  </Tag>
                  {project.type === 'novel' && (
                    <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                      {(project.metadata as { currentWordCount?: number }).currentWordCount?.toLocaleString() ?? 0} 字
                    </Tag>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  icon={project.isFavorite ? <StarFilled style={{ color: '#f59e0b' }} /> : <StarOutlined />}
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(project.id); }}
                  style={{ padding: '0 4px' }}
                />
                <Popconfirm
                  title={t('project.deleteConfirm')}
                  onConfirm={(e) => { e?.stopPropagation(); onDelete(project.id); }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                    style={{ padding: '0 4px' }}
                  />
                </Popconfirm>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default ProjectList;

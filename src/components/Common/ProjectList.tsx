import React, { useState, useMemo, useCallback } from 'react';
import { Card, Button, Tag, Empty, Typography, Input, Dropdown } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  StarOutlined,
  StarFilled,
  BookOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SearchOutlined,
  EditOutlined,
  InfoCircleOutlined,
  CopyOutlined,
  ExportOutlined,
} from '@ant-design/icons';
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

type FilterTab = 'all' | 'in_progress' | 'completed';

const IN_PROGRESS_STATUSES: ProjectStatus[] = ['planning', 'in_progress', 'paused'];

interface ProjectListProps {
  projects: CreativeProject[];
  type: CreativeProjectType;
  activeId?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onCreate: () => void;
  onEditInfo?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onExport?: (id: string) => void;
}

const TAB_META: { key: FilterTab; color: string }[] = [
  { key: 'all', color: 'var(--text-secondary)' },
  { key: 'in_progress', color: '#3b82f6' },
  { key: 'completed', color: '#22c55e' },
];

const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  type,
  activeId,
  onSelect,
  onDelete,
  onToggleFavorite,
  onCreate,
  onEditInfo,
  onDuplicate,
  onExport,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [searchText, setSearchText] = useState('');

  const createLabel = type === 'novel' ? t('novel.newProject') : type === 'comic' ? t('comic.newProject') : t('video.newProject');
  const emptyText = type === 'novel' ? t('novel.empty') : type === 'comic' ? t('comic.empty') : t('video.empty');

  const filtered = useMemo(() => {
    let list = projects;

    // Filter by tab
    if (activeTab === 'in_progress') {
      list = list.filter((p) => IN_PROGRESS_STATUSES.includes(p.status));
    } else if (activeTab === 'completed') {
      list = list.filter((p) => p.status === 'completed' || p.status === 'archived');
    }

    // Filter by search
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      list = list.filter((p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)),
      );
    }

    // Sort: favorites first, then by updatedAt
    return [...list].sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    });
  }, [projects, activeTab, searchText]);

  // Count per category
  const counts = useMemo(() => ({
    all: projects.length,
    in_progress: projects.filter((p) => IN_PROGRESS_STATUSES.includes(p.status)).length,
    completed: projects.filter((p) => p.status === 'completed' || p.status === 'archived').length,
  }), [projects]);

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
      {/* Search */}
      <div style={{ padding: '6px 12px 0' }}>
        <Input
          size="small"
          prefix={<SearchOutlined style={{ color: 'var(--text-tertiary)' }} />}
          placeholder={t('project.searchPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
        />
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 2, padding: '6px 12px 0',
      }}>
        {TAB_META.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '3px 8px', fontSize: 11, fontWeight: isActive ? 600 : 400,
                color: isActive ? tab.color : 'var(--text-tertiary)',
                background: 'transparent',
                border: 'none', borderBottom: isActive ? `2px solid ${tab.color}` : '2px solid transparent',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {t(`project.tab.${tab.key}`)}
              <span style={{
                fontSize: 9, background: isActive ? tab.color + '18' : 'var(--bg-tertiary, rgba(0,0,0,0.04))',
                padding: '0 4px', borderRadius: 6, color: isActive ? tab.color : 'var(--text-tertiary)',
              }}>
                {counts[tab.key]}
              </span>
            </button>
          );
        })}

        <div style={{ flex: 1 }} />
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={onCreate} style={{ fontSize: 12, padding: '0 4px' }} />
      </div>

      {/* Project list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 12px' }}>
        {filtered.length === 0 ? (
          <Empty
            description={searchText ? t('project.searchEmpty') : t(`project.tabEmpty.${activeTab}`)}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          filtered.map((project) => {
            const ctxMenuItems = [
              { key: 'open', icon: <BookOutlined />, label: t('project.context.open'), onClick: () => onSelect(project.id) },
              { key: 'editInfo', icon: <EditOutlined />, label: t('project.context.editInfo'), onClick: () => onEditInfo?.(project.id) },
              { key: 'favorite', icon: project.isFavorite ? <StarFilled style={{ color: '#f59e0b' }} /> : <StarOutlined />, label: project.isFavorite ? t('project.context.unfavorite') : t('project.context.favorite'), onClick: () => onToggleFavorite(project.id) },
              { type: 'divider' as const },
              { key: 'duplicate', icon: <CopyOutlined />, label: t('project.context.duplicate'), onClick: () => onDuplicate?.(project.id) },
              ...(onExport ? [{ key: 'export', icon: <ExportOutlined />, label: t('project.context.export'), onClick: () => onExport(project.id) }] : []),
              { type: 'divider' as const },
              { key: 'delete', icon: <DeleteOutlined />, danger: true, label: t('project.context.delete'), onClick: () => onDelete(project.id) },
            ];

            return (
              <Dropdown
                key={project.id}
                menu={{ items: ctxMenuItems }}
                trigger={['contextMenu']}
              >
                <Card
                  size="small"
                  hoverable
                  onClick={() => onSelect(project.id)}
                  style={{
                    marginBottom: 6,
                    cursor: 'pointer',
                    border: activeId === project.id ? '2px solid var(--accent-primary, #3b82f6)' : '1px solid var(--border-secondary)',
                    background: activeId === project.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'var(--bg-container)',
                  }}
                  styles={{ body: { padding: '6px 10px' } }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        {TYPE_ICONS[project.type]}
                        <Text strong ellipsis style={{ fontSize: 13 }}>{project.title}</Text>
                        {project.isFavorite && <StarFilled style={{ color: '#f59e0b', fontSize: 10 }} />}
                      </div>
                      {project.description && (
                        <Paragraph ellipsis={{ rows: 1 }} style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
                          {project.description}
                        </Paragraph>
                      )}
                      <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                        <Tag color={STATUS_COLORS[project.status]} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                          {t(`project.status.${project.status}`)}
                        </Tag>
                        {project.type === 'novel' && (
                          <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                            {t('novel.wordCount', { count: (project.metadata as { currentWordCount?: number }).currentWordCount?.toLocaleString() ?? '0' })}
                          </Tag>
                        )}
                        {project.type === 'video' && (project.metadata as { seriesRole?: string }).seriesRole === 'series' && (
                          <Tag color="processing" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                            {t('video.series.badge')}
                          </Tag>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              </Dropdown>
            );
          })
        )}
      </div>
    </div>
  );
};

export default ProjectList;

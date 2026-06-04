import React, { useState } from 'react';
import { Button, Input, Card, List, Typography, Space, Popconfirm, Tag, Empty, InputNumber } from 'antd';
import { PlusOutlined, DeleteOutlined, VideoCameraOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoMetadata, VideoScene } from '@/types';

const { Text, Paragraph } = Typography;

interface VideoWorkspaceProps {
  projectId: string;
}

const VideoWorkspace: React.FC<VideoWorkspaceProps> = ({ projectId }) => {
  const { t } = useTranslation();

  const STATUS_LABELS: Record<VideoScene['status'], { color: string; label: string }> = {
    scripted: { color: 'default', label: t('video.sceneStatus.scripted') },
    storyboarded: { color: 'processing', label: t('video.sceneStatus.storyboarded') },
    generated: { color: 'warning', label: t('video.sceneStatus.generated') },
    complete: { color: 'success', label: t('video.sceneStatus.complete') },
  };
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const addScene = useProjectStore((s) => s.addScene);
  const deleteScene = useProjectStore((s) => s.deleteScene);
  const updateScene = useProjectStore((s) => s.updateScene);

  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);

  if (!project || project.type !== 'video') return null;
  const meta = project.metadata as VideoMetadata;
  const scenes = meta.scenes;
  const selectedScene = scenes.find((s) => s.id === selectedSceneId);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Scene list */}
      <div style={{ width: 200, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 13 }}>{t('video.scenes')} ({scenes.length})</Text>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {scenes.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.noData')} />
            </div>
          ) : (
            <List
              size="small"
              dataSource={scenes}
              renderItem={(scene) => (
                <List.Item
                  onClick={() => setSelectedSceneId(scene.id)}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    background: selectedSceneId === scene.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                    borderLeft: selectedSceneId === scene.id ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                    <VideoCameraOutlined />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text ellipsis style={{ fontSize: 12, display: 'block' }}>{scene.title}</Text>
                      <Text type="secondary" style={{ fontSize: 10 }}>{scene.duration}s</Text>
                    </div>
                    <Popconfirm title={t('project.deleteConfirm')} onConfirm={() => { deleteScene(projectId, scene.id); if (selectedSceneId === scene.id) setSelectedSceneId(null); }}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} style={{ padding: '0 4px' }} />
                    </Popconfirm>
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>
        <div style={{ padding: 8, borderTop: '1px solid var(--border-secondary)' }}>
          <Button size="small" icon={<PlusOutlined />} onClick={() => addScene(projectId)} block>
            {t('video.addScene')}
          </Button>
        </div>
      </div>

      {/* Scene editor */}
      <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {/* Project info */}
          <Card size="small" title={project.title}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Tag>{t('video.style')}: {t(`video.style.${meta.style}`)}</Tag>
              <Tag>{t('video.resolution')}: {meta.resolution}</Tag>
              <Tag>{t('video.duration')}: {meta.duration}s</Tag>
              <Tag>FPS: {meta.fps}</Tag>
            </div>
            {project.description && (
              <Paragraph style={{ marginTop: 8, color: 'var(--text-secondary)' }}>{project.description}</Paragraph>
            )}
          </Card>

          {/* Selected scene */}
          {selectedScene ? (
            <Card size="small" title={<span><PlayCircleOutlined /> {selectedScene.title}</span>}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('video.sceneTitle')}</Text>
                  <Input
                    value={selectedScene.title}
                    onChange={(e) => updateScene(projectId, selectedScene.id, { title: e.target.value })}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('video.sceneDescription')}</Text>
                  <Input.TextArea
                    value={selectedScene.description}
                    onChange={(e) => updateScene(projectId, selectedScene.id, { description: e.target.value })}
                    rows={4}
                    placeholder={t('video.sceneDescPlaceholder')}
                  />
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t('video.duration')} (秒)</Text>
                    <InputNumber
                      value={selectedScene.duration}
                      onChange={(val) => updateScene(projectId, selectedScene.id, { duration: val ?? 5 })}
                      min={1}
                      max={60}
                    />
                  </div>
                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t('video.transitionEffect')}</Text>
                    <Input
                      value={selectedScene.transition ?? ''}
                      onChange={(e) => updateScene(projectId, selectedScene.id, { transition: e.target.value })}
                      placeholder={t('video.transitionPlaceholder')}
                      style={{ width: 200 }}
                    />
                  </div>
                </div>
                <div>
                  <Tag color={STATUS_LABELS[selectedScene.status].color}>
                    {STATUS_LABELS[selectedScene.status].label}
                  </Tag>
                </div>
              </Space>
            </Card>
          ) : (
            <Empty description={t('video.addScene')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Space>
      </div>
    </div>
  );
};

export default VideoWorkspace;

import React, { useState } from 'react';
import { Button, Input, Card, List, Typography, Space, Popconfirm, Modal, Form, Empty, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined, UserOutlined, PictureOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { ComicMetadata, ComicCharacter } from '@/types';

const { Text, Paragraph } = Typography;

interface ComicWorkspaceProps {
  projectId: string;
}

const ComicWorkspace: React.FC<ComicWorkspaceProps> = ({ projectId }) => {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const addComicCharacter = useProjectStore((s) => s.addComicCharacter);
  const deleteComicCharacter = useProjectStore((s) => s.deleteComicCharacter);
  const updateComicCharacter = useProjectStore((s) => s.updateComicCharacter);

  const [charModalOpen, setCharModalOpen] = useState(false);
  const [charForm] = Form.useForm();
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);

  if (!project || project.type !== 'comic') return null;
  const meta = project.metadata as ComicMetadata;
  const characters = meta.characters;
  const selectedChar = characters.find((c) => c.id === selectedCharId);

  const handleAddCharacter = () => {
    charForm.validateFields().then((values) => {
      addComicCharacter(projectId, {
        name: values.name,
        description: values.description ?? '',
        appearance: values.appearance ?? '',
        referenceImages: [],
      });
      charForm.resetFields();
      setCharModalOpen(false);
    });
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Character panel */}
      <div style={{ width: 240, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 13 }}>{t('comic.characters')} ({characters.length})</Text>
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setCharModalOpen(true)} />
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {characters.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.noData')}>
                <Button size="small" icon={<PlusOutlined />} onClick={() => setCharModalOpen(true)}>
                  {t('comic.addCharacter')}
                </Button>
              </Empty>
            </div>
          ) : (
            <List
              size="small"
              dataSource={characters}
              renderItem={(char) => (
                <List.Item
                  onClick={() => setSelectedCharId(char.id)}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    background: selectedCharId === char.id ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                    <UserOutlined />
                    <Text ellipsis style={{ flex: 1, fontSize: 12 }}>{char.name}</Text>
                    <Popconfirm title={t('project.deleteConfirm')} onConfirm={() => { deleteComicCharacter(projectId, char.id); if (selectedCharId === char.id) setSelectedCharId(null); }}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} style={{ padding: '0 4px' }} />
                    </Popconfirm>
                  </div>
                </List.Item>
              )}
            />
          )}
        </div>
      </div>

      {/* Main editing area */}
      <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {/* Project info */}
          <Card size="small" title={project.title}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Tag>{t('comic.style')}: {t(`comic.style.${meta.style}`)}</Tag>
              <Tag>{t('comic.panels')}: {meta.pageCount}</Tag>
              <Tag>{t('comic.characters')}: {characters.length}</Tag>
            </div>
            {project.description && (
              <Paragraph style={{ marginTop: 8, color: 'var(--text-secondary)' }}>{project.description}</Paragraph>
            )}
          </Card>

          {/* Selected character detail */}
          {selectedChar && (
            <Card size="small" title={<span><UserOutlined /> {selectedChar.name}</span>}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>描述</Text>
                  <Input.TextArea
                    value={selectedChar.description}
                    onChange={(e) => updateComicCharacter(projectId, selectedChar.id, { description: e.target.value })}
                    rows={2}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>外貌描述</Text>
                  <Input.TextArea
                    value={selectedChar.appearance}
                    onChange={(e) => updateComicCharacter(projectId, selectedChar.id, { appearance: e.target.value })}
                    rows={3}
                    placeholder="详细描述角色外貌，用于AI生成参考..."
                  />
                </div>
              </Space>
            </Card>
          )}

          {/* Page/Panel area placeholder */}
          <Card size="small" title={<span><PictureOutlined /> {t('comic.panels')}</span>}>
            <Empty description="漫画分格编辑功能开发中" image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Text type="secondary">添加角色后，可基于小说内容自动生成漫画分格脚本</Text>
            </Empty>
          </Card>
        </Space>
      </div>

      {/* Add character modal */}
      <Modal
        title={t('comic.addCharacter')}
        open={charModalOpen}
        onOk={handleAddCharacter}
        onCancel={() => { setCharModalOpen(false); charForm.resetFields(); }}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form form={charForm} layout="vertical" size="small">
          <Form.Item name="name" label="角色名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="角色描述">
            <Input.TextArea rows={2} placeholder="性格、背景等..." />
          </Form.Item>
          <Form.Item name="appearance" label="外貌描述">
            <Input.TextArea rows={3} placeholder="用于AI生成参考的外貌描述..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ComicWorkspace;

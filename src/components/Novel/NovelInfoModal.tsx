import React, { useEffect } from 'react';
import { Modal, Form, Input, Select, InputNumber, Divider, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';

const { Text } = Typography;

interface NovelInfoModalProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

const NovelInfoModal: React.FC<NovelInfoModalProps> = ({ open, onClose, projectId }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const updateProject = useProjectStore((s) => s.updateProject);
  const updateProjectMetadata = useProjectStore((s) => s.updateProjectMetadata);

  const meta = project?.metadata;
  const chapters = (meta as any)?.chapters ?? [];
  const completedCount = chapters.filter((c: any) => c.status === 'complete').length;
  const currentWordCount = chapters.reduce((s: number, c: any) => s + (c.wordCount ?? 0), 0);

  useEffect(() => {
    if (open && project && meta) {
      form.setFieldsValue({
        title: project.title,
        description: project.description,
        genre: (meta as any).genre ?? 'fantasy',
        targetWordCount: (meta as any).targetWordCount ?? 100000,
        style: (meta as any).style ?? 'literary',
        language: (meta as any).language ?? 'zh-CN',
      });
    }
  }, [open, project, meta, form]);

  const handleSave = () => {
    form.validateFields().then((values) => {
      updateProject(projectId, {
        title: values.title,
        description: values.description,
      });
      updateProjectMetadata(projectId, {
        genre: values.genre,
        targetWordCount: values.targetWordCount,
        style: values.style,
        language: values.language,
      });
      onClose();
    });
  };

  return (
    <Modal
      title={t('project.info')}
      open={open}
      onOk={handleSave}
      onCancel={onClose}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      width={480}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="title" label={t('novel.title')} rules={[{ required: true, message: t('common.required') }]}>
          <Input />
        </Form.Item>
        <Form.Item name="description" label={t('common.description')}>
          <Input.TextArea rows={3} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="genre" label={t('novel.genre')} style={{ flex: 1 }}>
            <Select options={[
              { value: 'fantasy', label: t('novel.genre.fantasy') },
              { value: 'scifi', label: t('novel.genre.scifi') },
              { value: 'romance', label: t('novel.genre.romance') },
              { value: 'mystery', label: t('novel.genre.mystery') },
              { value: 'literary', label: t('novel.genre.literary') },
              { value: 'wuxia', label: t('novel.genre.wuxia') },
            ]} />
          </Form.Item>
          <Form.Item name="targetWordCount" label={t('novel.targetWordCount')} style={{ flex: 1 }}>
            <InputNumber min={1000} max={5000000} step={10000} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="style" label={t('novel.style')} style={{ flex: 1 }}>
            <Select options={[
              { value: 'literary', label: t('novel.style.literary') },
              { value: 'light', label: t('novel.style.light') },
              { value: 'suspense', label: t('novel.style.suspense') },
              { value: 'epic', label: t('novel.style.epic') },
              { value: 'humorous', label: t('novel.style.humorous') },
            ]} />
          </Form.Item>
          <Form.Item name="language" label={t('settings.general.language')} style={{ flex: 1 }}>
            <Select options={[
              { value: 'zh-CN', label: t('settings.general.language.zh-CN') },
              { value: 'en-US', label: t('settings.general.language.en-US') },
            ]} />
          </Form.Item>
        </div>
      </Form>

      <Divider style={{ margin: '8px 0 12px' }} />

      <div style={{ display: 'flex', gap: 24, fontSize: 12 }}>
        <Text type="secondary">
          {t('project.createdAt')}: {project?.createdAt ? new Date(project.createdAt).toLocaleDateString() : '-'}
        </Text>
        <Text type="secondary">
          {t('novel.wordCount')}: {currentWordCount.toLocaleString()}
        </Text>
        <Text type="secondary">
          {t('novel.chapters')}: {chapters.length} ({t('novel.chapterStatus.complete')}: {completedCount})
        </Text>
      </div>
    </Modal>
  );
};

export default NovelInfoModal;

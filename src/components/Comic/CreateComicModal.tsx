import React from 'react';
import { Modal, Form, Input, Select, InputNumber } from 'antd';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import type { AspectRatio } from '@/types/video';

interface CreateComicModalProps {
  open: boolean;
  onOk: (projectId: string) => void;
  onCancel: () => void;
}

const CreateComicModal: React.FC<CreateComicModalProps> = ({ open, onOk, onCancel }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const createProject = useComicStore((s) => s.createProject);

  const handleOk = async () => {
    const values = await form.validateFields();
    const project = createProject({
      title: values.title,
      sourceMode: values.sourceMode === 'novel' ? 'novel' : 'pure',
      sourceText: values.theme ?? '',
      style: values.style,
      aspectRatio: values.aspectRatio as AspectRatio,
      panelLayout: values.panelLayout,
      panelCount: values.panelCount ?? 6,
      options: {
        enableCharacterAnchor: true,
        characterAnchorLimit: 5,
      },
    });
    const id = project.id;
    form.resetFields();
    onOk(id);
  };

  return (
    <Modal
      title={t('comic.newProject')}
      open={open}
      onOk={handleOk}
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      width={520}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Form
        form={form}
        layout="vertical"
        size="small"
        initialValues={{
          style: 'manga',
          panelLayout: 'grid-2',
          aspectRatio: '16:9',
          panelCount: 6,
          sourceMode: 'theme',
        }}
      >
        <Form.Item name="title" label={t('project.create')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>

        <Form.Item name="sourceMode" label={t('comic.sourceMode')}>
          <Select
            options={[
              { value: 'theme', label: t('comic.sourceMode.theme') },
              { value: 'novel', label: t('comic.sourceMode.novel') },
            ]}
          />
        </Form.Item>

        <Form.Item
          name="theme"
          label={t('comic.theme')}
          rules={[{ required: true }]}
          tooltip={t('comic.themePlaceholder')}
        >
          <Input.TextArea rows={4} placeholder={t('comic.themePlaceholder')} />
        </Form.Item>

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="style" label={t('comic.style')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'manga', label: t('comic.style.manga') },
                { value: 'western', label: t('comic.style.western') },
                { value: 'watercolor', label: t('comic.style.watercolor') },
                { value: 'pixel', label: t('comic.style.pixel') },
              ]}
            />
          </Form.Item>
          <Form.Item name="aspectRatio" label={t('comic.aspectRatio')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16' },
                { value: '1:1', label: '1:1' },
              ]}
            />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="panelLayout" label={t('comic.panelLayout')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'single', label: t('comic.panelLayout.grid') },
                { value: 'grid-2', label: t('comic.panelLayout.grid') },
                { value: 'grid-4', label: t('comic.panelLayout.grid') },
                { value: 'manga-row', label: t('comic.panelLayout.manga-row') },
              ]}
            />
          </Form.Item>
          <Form.Item name="panelCount" label={t('comic.panelCount')} style={{ flex: 1 }}>
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

export default CreateComicModal;

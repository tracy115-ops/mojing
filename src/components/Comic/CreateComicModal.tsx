import React from 'react';
import { Modal, Form, Input, Select } from 'antd';
import { useTranslation } from '@/i18n';

interface CreateComicModalProps {
  open: boolean;
  onOk: (values: { title: string; description: string; style: string; panelLayout: string }) => void;
  onCancel: () => void;
}

const CreateComicModal: React.FC<CreateComicModalProps> = ({ open, onOk, onCancel }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();

  return (
    <Modal
      title={t('comic.newProject')}
      open={open}
      onOk={() => form.validateFields().then((values) => { onOk(values); form.resetFields(); })}
      onCancel={() => { form.resetFields(); onCancel(); }}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      width={480}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Form form={form} layout="vertical" size="small" initialValues={{ style: 'manga', panelLayout: 'grid' }}>
        <Form.Item name="title" label={t('project.create')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="description" label="简介">
          <Input.TextArea rows={3} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="style" label={t('comic.style')} style={{ flex: 1 }}>
            <Select options={[
              { value: 'manga', label: t('comic.style.manga') },
              { value: 'western', label: t('comic.style.western') },
              { value: 'watercolor', label: t('comic.style.watercolor') },
              { value: 'pixel', label: t('comic.style.pixel') },
            ]} />
          </Form.Item>
          <Form.Item name="panelLayout" label="分格布局" style={{ flex: 1 }}>
            <Select options={[
              { value: 'grid', label: '网格' },
              { value: 'free', label: '自由' },
              { value: 'manga-row', label: '条漫' },
            ]} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

export default CreateComicModal;

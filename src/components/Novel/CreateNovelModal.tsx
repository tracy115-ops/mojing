import React from 'react';
import { Modal, Form, Input, Select, InputNumber } from 'antd';
import { useTranslation } from '@/i18n';

interface CreateNovelModalProps {
  open: boolean;
  onOk: (values: {
    title: string;
    description: string;
    genre: string;
    targetWordCount: number;
    style: string;
    language: string;
  }) => void;
  onCancel: () => void;
}

const CreateNovelModal: React.FC<CreateNovelModalProps> = ({ open, onOk, onCancel }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();

  return (
    <Modal
      title={t('novel.newProject')}
      open={open}
      onOk={() => form.validateFields().then((values) => { onOk(values); form.resetFields(); })}
      onCancel={() => { form.resetFields(); onCancel(); }}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      width={480}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Form form={form} layout="vertical" size="small" initialValues={{ genre: 'fantasy', targetWordCount: 100000, style: 'literary', language: 'zh-CN' }}>
        <Form.Item name="title" label={t('project.create') + ' ' + t('novel.title')} rules={[{ required: true, message: t('common.noData') }]}>
          <Input />
        </Form.Item>
        <Form.Item name="description" label="简介">
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
              { value: 'literary', label: '文学风' },
              { value: 'light', label: '轻松风' },
              { value: 'suspense', label: '悬疑风' },
              { value: 'epic', label: '史诗风' },
              { value: 'humorous', label: '幽默风' },
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
    </Modal>
  );
};

export default CreateNovelModal;

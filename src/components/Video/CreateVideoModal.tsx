import React from 'react';
import { Modal, Form, Input, Select, InputNumber } from 'antd';
import { useTranslation } from '@/i18n';

interface CreateVideoModalProps {
  open: boolean;
  onOk: (values: { title: string; description: string; style: string; resolution: string; aspectRatio: string; fps: number }) => void;
  onCancel: () => void;
}

const CreateVideoModal: React.FC<CreateVideoModalProps> = ({ open, onOk, onCancel }) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();

  return (
    <Modal
      title={t('video.newProject')}
      open={open}
      onOk={() => form.validateFields().then((values) => { onOk(values); form.resetFields(); })}
      onCancel={() => { form.resetFields(); onCancel(); }}
      okText={t('common.create')}
      cancelText={t('common.cancel')}
      width={480}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Form form={form} layout="vertical" size="small" initialValues={{ style: 'cinematic', resolution: '1920x1080', aspectRatio: '16:9', fps: 24 }}>
        <Form.Item name="title" label={t('project.create')} rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="description" label="简介">
          <Input.TextArea rows={3} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="style" label={t('video.style')} style={{ flex: 1 }}>
            <Select options={[
              { value: 'cinematic', label: t('video.style.cinematic') },
              { value: 'anime', label: t('video.style.anime') },
              { value: 'documentary', label: t('video.style.documentary') },
              { value: 'short', label: t('video.style.short') },
            ]} />
          </Form.Item>
          <Form.Item name="resolution" label={t('video.resolution')} style={{ flex: 1 }}>
            <Select options={[
              { value: '1920x1080', label: '1080p' },
              { value: '3840x2160', label: '4K' },
              { value: '1280x720', label: '720p' },
            ]} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="aspectRatio" label="宽高比" style={{ flex: 1 }}>
            <Select options={[
              { value: '16:9', label: '16:9' },
              { value: '9:16', label: '9:16 (竖屏)' },
              { value: '1:1', label: '1:1' },
              { value: '21:9', label: '21:9 (电影)' },
            ]} />
          </Form.Item>
          <Form.Item name="fps" label="FPS" style={{ flex: 1 }}>
            <InputNumber min={12} max={60} style={{ width: '100%' }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

export default CreateVideoModal;

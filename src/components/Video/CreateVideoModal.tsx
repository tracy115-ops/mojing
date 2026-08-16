import React from 'react';
import { Modal, Form, Input, Select, InputNumber, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';

const { Text } = Typography;

export interface CreateVideoFormValues {
  title: string;
  description?: string;
  prompt?: string;
  novelId?: string;
  scriptText?: string;
  style: string;
  resolution: string;
  aspectRatio: string;
  fps: number;
  shotDurationSeconds: 3 | 5 | 10 | 15 | 18;
  targetDurationSeconds?: 5 | 15 | 30 | 60;
}

interface CreateVideoModalProps {
  open: boolean;
  onOk: (values: CreateVideoFormValues) => void;
  onCancel: () => void;
}

const CreateVideoModal: React.FC<CreateVideoModalProps> = ({
  open,
  onOk,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const projects = useProjectStore((s) => s.projects);
  const novelProjects = projects.filter((p) => p.type === 'novel');

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>新建视频项目</span>
        </div>
      }
      open={open}
      onOk={() =>
        form.validateFields().then((values) => {
          if (!values.novelId && !values.scriptText?.trim()) {
            form.setFields([{ name: 'scriptText', errors: [t('video.series.episodeSourceRequired')] }]);
            return;
          }
          onOk(values);
          form.resetFields();
        })
      }
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      okText={t('video.series.newEpisode')}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
        剧集会继承本系列的角色、场景和视觉设定。请选择已有小说，或粘贴本集剧本后继续。
      </Text>

      <Form
        form={form}
        layout="vertical"
        size="small"
        initialValues={{
          style: 'cinematic',
          resolution: '1920x1080',
          aspectRatio: '16:9',
          fps: 24,
          shotDurationSeconds: 5,
          targetDurationSeconds: 15,
        }}
      >
        <Form.Item
          name="title"
          label="项目名称"
          rules={[{ required: true, message: '请输入项目名称' }]}
        >
          <Input placeholder="例如：诛仙第一集 · 少年张小凡" />
        </Form.Item>

        {novelProjects.length > 0 && (
          <Form.Item name="novelId" label="关联已有小说项目（可选）">
            <Select
              allowClear
              placeholder="选择已导入的小说后，在下一步选择章节"
              options={novelProjects.map((p) => ({ value: p.id, label: p.title }))}
            />
          </Form.Item>
        )}
        <Form.Item name="scriptText" label="本集剧本（可选）">
          <Input.TextArea
            rows={4}
            placeholder="粘贴本集故事、小说片段或短剧剧本；AI 将基于系列资产拆分角色与分镜。"
          />
        </Form.Item>

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="targetDurationSeconds" label="期望成片总时长" style={{ flex: 1 }}>
            <Select
              options={[
                { value: 5, label: '5 秒 (单镜头预览)' },
                { value: 15, label: '15 秒 (短视频 3 镜头)' },
                { value: 30, label: '30 秒 (剧情短片 6 镜头)' },
                { value: 60, label: '60 秒 (完整大片 12 镜头)' },
              ]}
            />
          </Form.Item>
          <Form.Item name="shotDurationSeconds" label="单镜头时长" style={{ flex: 1 }}>
            <Select
              options={[
                { value: 3, label: '3 秒 (快节奏)' },
                { value: 5, label: '5 秒 (标准镜头)' },
                { value: 10, label: '10 秒 (长镜头)' },
                { value: 15, label: '15 秒 (特长慢镜头)' },
              ]}
            />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="style" label={t('video.style')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: 'cinematic', label: t('video.style.cinematic') },
                { value: 'anime', label: t('video.style.anime') },
                { value: 'documentary', label: t('video.style.documentary') },
                { value: 'short', label: t('video.style.short') },
              ]}
            />
          </Form.Item>
          <Form.Item name="resolution" label={t('video.resolution')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: '1920x1080', label: t('video.resolution.1080p') },
                { value: '3840x2160', label: t('video.resolution.4k') },
                { value: '1280x720', label: t('video.resolution.720p') },
              ]}
            />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <Form.Item name="aspectRatio" label={t('video.aspectRatio')} style={{ flex: 1 }}>
            <Select
              options={[
                { value: '16:9', label: t('video.aspectRatio.16:9') },
                { value: '9:16', label: t('video.aspectRatio.9:16') },
                { value: '1:1', label: t('video.aspectRatio.1:1') },
                { value: '21:9', label: t('video.aspectRatio.21:9') },
              ]}
            />
          </Form.Item>
          <Form.Item name="fps" label="FPS 帧率" style={{ flex: 1 }}>
            <InputNumber min={12} max={60} style={{ width: '100%' }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

export default CreateVideoModal;

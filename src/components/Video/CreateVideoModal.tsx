import React, { useState } from 'react';
import { Modal, Form, Input, Select, InputNumber, Segmented, Typography } from 'antd';
import { ThunderboltOutlined, FormOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';

const { Text } = Typography;

export interface CreateVideoFormValues {
  mode: 'novel' | 'direct';
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
  initialMode?: 'novel' | 'direct';
  onOk: (values: CreateVideoFormValues) => void;
  onCancel: () => void;
}

const CreateVideoModal: React.FC<CreateVideoModalProps> = ({
  open,
  initialMode = 'novel',
  onOk,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [mode, setMode] = useState<'novel' | 'direct'>(initialMode);
  const projects = useProjectStore((s) => s.projects);
  const novelProjects = projects.filter((p) => p.type === 'novel');

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>🎬 新建视频项目</span>
        </div>
      }
      open={open}
      onOk={() =>
        form.validateFields().then((values) => {
          onOk({ ...values, mode });
          form.resetFields();
        })
      }
      onCancel={() => {
        form.resetFields();
        onCancel();
      }}
      okText={mode === 'direct' ? '⚡ 创建并直接生成视频' : '🚀 创建并开启全流程 AI 生成'}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnClose
      getContainer={() => document.getElementById('root')!}
    >
      <div style={{ marginBottom: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          选择视频生成模式：
        </Text>
        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as 'novel' | 'direct')}
          options={[
            {
              label: (
                <div style={{ padding: '4px 0' }}>
                  <FormOutlined style={{ marginRight: 6, color: '#1890ff' }} />
                  <span>✍️ 小说/剧本全流程生成</span>
                </div>
              ),
              value: 'novel',
            },
            {
              label: (
                <div style={{ padding: '4px 0' }}>
                  <ThunderboltOutlined style={{ marginRight: 6, color: '#fa8c16' }} />
                  <span>⚡ 提示词/短文本直接生成</span>
                </div>
              ),
              value: 'direct',
            },
          ]}
        />
      </div>

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
          <Input placeholder={mode === 'direct' ? '例如: 赛博朋克都市夜景' : '例如: 诛仙第一集 · 少年张小凡'} />
        </Form.Item>

        {mode === 'novel' ? (
          <>
            {novelProjects.length > 0 && (
              <Form.Item name="novelId" label="关联已有小说项目（可选）">
                <Select
                  allowClear
                  placeholder="选择已导入的小说，AI 将提取章节全自动拆分生成"
                  options={novelProjects.map((p) => ({ value: p.id, label: p.title }))}
                />
              </Form.Item>
            )}
            <Form.Item name="scriptText" label="粘贴故事/剧本文本（可选）">
              <Input.TextArea
                rows={3}
                placeholder="直接粘贴故事、小说片段或短剧剧本，AI 将自动分析角色与分镜..."
              />
            </Form.Item>
          </>
        ) : (
          <Form.Item
            name="prompt"
            label="视频场景提示词 / 描述"
            rules={[{ required: true, message: '请输入视频提示词' }]}
          >
            <Input.TextArea
              rows={3}
              placeholder="例如: 镜头从高空俯瞰赛博朋克城市，霓虹灯闪烁，一位雨中穿黑风衣的青年缓步前行，镜头跟推..."
            />
          </Form.Item>
        )}

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

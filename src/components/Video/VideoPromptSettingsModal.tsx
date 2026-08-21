// ============================================================================
// VideoPromptSettingsModal — 视频工坊专属预置提示词配置弹窗
// ============================================================================
// 使用组件本地 state 进行流畅编辑，避免每次击键触发异步 Rust IPC 写盘导致 UI 卡死。

import React, { useState, useEffect } from 'react';
import { Modal, Tabs, Form, Input, Alert, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PromptTemplatesSettings } from '@/types';

interface VideoPromptSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const VideoPromptSettingsModal: React.FC<VideoPromptSettingsModalProps> = ({ open, onClose }) => {
  const settings = useSettingsStore((s) => s.settings);
  const updateCreativeSettings = useSettingsStore((s) => s.updateCreativeSettings);

  const [localTemplates, setLocalTemplates] = useState<PromptTemplatesSettings>({});
  const [saving, setSaving] = useState(false);

  // 弹窗打开时，拉取最新的 store 设置同步到本地状态
  useEffect(() => {
    if (open) {
      setLocalTemplates(settings.creative.promptTemplates || {});
    }
  }, [open, settings.creative.promptTemplates]);

  const handleChange = (field: keyof PromptTemplatesSettings, value: string) => {
    setLocalTemplates((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateCreativeSettings({
        promptTemplates: localTemplates,
      });
      message.success('视频工坊提示词预设模板已保存生效！');
      onClose();
    } catch (err) {
      console.error('保存提示词预设失败:', err);
      message.error('保存设置失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SettingOutlined style={{ color: 'var(--color-primary, #3b82f6)' }} />
          <span>视频工坊 — 提示词预设模板控制中心</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      confirmLoading={saving}
      width={720}
      okText="保存并应用"
      cancelText="取消"
      destroyOnClose
    >
      <Alert
        message="视频工坊预置控制说明"
        description="此处预置的控制模板会在视频工坊执行角色立绘、三视图、场景图、分镜关键帧生成前自动加载使用。您可以随时在此预先编辑您的专属画面修饰词与系统控制指令。修改后请点击“保存并应用”。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />
      <Tabs
        type="card"
        size="small"
        items={[
          {
            key: 'zh',
            label: '中文提示词模板',
            children: (
              <Form layout="vertical" size="small" style={{ paddingTop: 12 }}>
                <Form.Item label="角色立绘模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.portraitZh ?? ''}
                    onChange={(e) => handleChange('portraitZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="三视图生成模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.turnaroundZh ?? ''}
                    onChange={(e) => handleChange('turnaroundZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="场景背景图模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.sceneZh ?? ''}
                    onChange={(e) => handleChange('sceneZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="分镜关键帧模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.keyframeZh ?? ''}
                    onChange={(e) => handleChange('keyframeZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="剧本改写 LLM 系统指令 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.rewriteZh ?? ''}
                    onChange={(e) => handleChange('rewriteZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="实体提取 LLM 系统指令 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.extractZh ?? ''}
                    onChange={(e) => handleChange('extractZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="章节切片分镜 LLM 系统指令 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.storyboardZh ?? ''}
                    onChange={(e) => handleChange('storyboardZh', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="画质与光影增强词 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.qualityZh ?? ''}
                    onChange={(e) => handleChange('qualityZh', e.target.value)}
                  />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'en',
            label: 'English Prompt Presets',
            children: (
              <Form layout="vertical" size="small" style={{ paddingTop: 12 }}>
                <Form.Item label="Character Portrait Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.portraitEn ?? ''}
                    onChange={(e) => handleChange('portraitEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Turnaround Sheet Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.turnaroundEn ?? ''}
                    onChange={(e) => handleChange('turnaroundEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Scene Scenery Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.sceneEn ?? ''}
                    onChange={(e) => handleChange('sceneEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Keyframe Storyboard Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.keyframeEn ?? ''}
                    onChange={(e) => handleChange('keyframeEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Script Rewrite LLM System Prompt (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.rewriteEn ?? ''}
                    onChange={(e) => handleChange('rewriteEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Entity Extraction LLM System Prompt (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.extractEn ?? ''}
                    onChange={(e) => handleChange('extractEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Chapter Storyboard LLM System Prompt (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.storyboardEn ?? ''}
                    onChange={(e) => handleChange('storyboardEn', e.target.value)}
                  />
                </Form.Item>
                <Form.Item label="Quality & Lighting Enhancers (English)">
                  <Input.TextArea
                    rows={2}
                    value={localTemplates.qualityEn ?? ''}
                    onChange={(e) => handleChange('qualityEn', e.target.value)}
                  />
                </Form.Item>
              </Form>
            ),
          },
        ]}
      />
    </Modal>
  );
};

export default VideoPromptSettingsModal;

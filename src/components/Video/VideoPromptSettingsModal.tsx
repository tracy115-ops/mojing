// ============================================================================
// VideoPromptSettingsModal — 视频工坊专属预置提示词配置弹窗
// ============================================================================
// 让用户在视频工坊主界面直接点击【提示词预设】按钮，在执行任何生成步骤前，
// 提前查看与自定义编辑 🇨🇳 中文与 🇺🇸 英文的提示词模板与系统指令。

import React from 'react';
import { Modal, Tabs, Form, Input, Alert, Button, message } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useSettingsStore } from '@/stores/settingsStore';

interface VideoPromptSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const VideoPromptSettingsModal: React.FC<VideoPromptSettingsModalProps> = ({ open, onClose }) => {
  const settings = useSettingsStore((s) => s.settings);
  const updateCreativeSettings = useSettingsStore((s) => s.updateCreativeSettings);

  const handleSave = () => {
    message.success('视频工坊提示词预设模板已保存生效！');
    onClose();
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SettingOutlined style={{ color: 'var(--color-primary, #3b82f6)' }} />
          <span>🎬 视频工坊 — 提示词预设模板控制中心</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      width={720}
      okText="保存并应用"
      cancelText="关闭"
    >
      <Alert
        message="视频工坊预置控制说明"
        description="此处预置的控制模板会在视频工坊执行角色立绘、三视图、场景图、分镜关键帧生成前自动加载使用。您可以随时在此预先编辑您的专属画面修饰词与系统控制指令。占位符：{name} 角色名，{appearance} 外貌描述，{style} 画风，{description} 场景描写。"
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
            label: '🇨🇳 中文提示词模板',
            children: (
              <Form layout="vertical" size="small" style={{ paddingTop: 12 }}>
                <Form.Item label="角色立绘模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.portraitZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, portraitZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="三视图模型板模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.turnaroundZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, turnaroundZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="场景背景图模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.sceneZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, sceneZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="分镜关键帧模板 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.keyframeZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, keyframeZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="剧本改写 LLM 系统指令 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.rewriteZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, rewriteZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="实体提取 LLM 系统指令 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.extractZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, extractZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="画质与光影增强词 (中文)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.qualityZh}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, qualityZh: e.target.value },
                      })
                    }
                  />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'en',
            label: '🇺🇸 English Prompt Presets',
            children: (
              <Form layout="vertical" size="small" style={{ paddingTop: 12 }}>
                <Form.Item label="Character Portrait Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.portraitEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, portraitEn: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="Turnaround Sheet Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.turnaroundEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, turnaroundEn: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="Scene Scenery Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.sceneEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, sceneEn: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="Keyframe Storyboard Template (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.keyframeEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, keyframeEn: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="Script Rewrite LLM System Prompt (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.rewriteEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, rewriteEn: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="Entity Extraction LLM System Prompt (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.extractEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, extractEn: e.target.value },
                      })
                    }
                  />
                </Form.Item>
                <Form.Item label="Quality & Lighting Enhancers (English)">
                  <Input.TextArea
                    rows={2}
                    value={settings.creative.promptTemplates?.qualityEn}
                    onChange={(e) =>
                      updateCreativeSettings({
                        promptTemplates: { ...settings.creative.promptTemplates, qualityEn: e.target.value },
                      })
                    }
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

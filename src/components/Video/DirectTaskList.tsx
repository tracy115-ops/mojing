// DirectTaskList — Direct 视频任务列表(sidebar 用)
//
// 为什么独立组件而不是复用 ProjectList:
//   ProjectList 要的是 CreativeProject(title/description/status/favorite),
//   Direct 任务在 videoStore 里是 VideoProjectState,字段不一样。
//   强行适配会污染 Novel/Comic 的逻辑,所以单独写一个精简版。
//
// 点击任务 = 切 activePipelineId,跟 VideoPipelinePanel 顶部 Select 等价,
// 但 sidebar 入口更直观(用户找任务的常规位置)。

import React, { useState } from 'react';
import { Typography, Empty, Tooltip, Popconfirm, Modal, Input, Dropdown, message } from 'antd';
import {
  ThunderboltOutlined, DeleteOutlined, EditOutlined, CopyOutlined,
  DownloadOutlined, ExportOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { useShallow } from 'zustand/react/shallow';
import ExportVideoModal from './ExportVideoModal';

const { Text } = Typography;

const DirectTaskList: React.FC = () => {
  const { t } = useTranslation();
  const activePipelineId = useVideoStore((s) => s.activePipelineId);
  const setActivePipelineId = useVideoStore((s) => s.setActivePipelineId);
  const resetProject = useVideoStore((s) => s.resetProject);
  const setProjectTitle = useVideoStore((s) => s.setProjectTitle);

  // 重命名弹窗状态
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 导出视频弹窗状态
  const [exportingId, setExportingId] = useState<string | null>(null);

  // 只订阅 id 数组(useShallow 让原始值数组在内容不变时引用稳定)。
  const directTaskIds = useVideoStore(
    useShallow((s) =>
      Object.values(s.projects)
        .filter((p) => p.novelProjectId.startsWith('direct_'))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => p.novelProjectId),
    ),
  );
  // 注意:不能用嵌套对象 Record<id, {stage,title,createdAt}> —— useShallow 是浅比较,
  // 每次返回的 value 都是新对象引用,会触发无限重渲染。拆成 3 个扁平的原始值 record。
  const directTaskTitles = useVideoStore(
    useShallow((s) => {
      const out: Record<string, string | undefined> = {};
      for (const id of directTaskIds) out[id] = s.projects[id]?.title;
      return out;
    }),
  );
  const directTaskStages = useVideoStore(
    useShallow((s) => {
      const out: Record<string, string | undefined> = {};
      for (const id of directTaskIds) out[id] = s.projects[id]?.currentStage;
      return out;
    }),
  );
  const directTaskTimes = useVideoStore(
    useShallow((s) => {
      const out: Record<string, string | undefined> = {};
      for (const id of directTaskIds) out[id] = s.projects[id]?.createdAt;
      return out;
    }),
  );
  // 最终视频 URL(用于右键「导出视频」) + 原始 prompt(用于右键「复制 prompt」)
  const directTaskFinalUrls = useVideoStore(
    useShallow((s) => {
      const out: Record<string, string | undefined> = {};
      for (const id of directTaskIds) out[id] = s.projects[id]?.finalVideoUrl;
      return out;
    }),
  );
  const directTaskPrompts = useVideoStore(
    useShallow((s) => {
      const out: Record<string, string | undefined> = {};
      for (const id of directTaskIds) {
        const p = s.projects[id];
        out[id] = p?.sceneSpec?.shots?.[0]?.sourceText;
      }
      return out;
    }),
  );

  const renameModal = (
    <Modal
      open={renamingId !== null}
      title={t('video.direct.renameTitle')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      onOk={() => {
        if (renamingId) {
          setProjectTitle(renamingId, renameValue.trim());
        }
        setRenamingId(null);
      }}
      onCancel={() => setRenamingId(null)}
      destroyOnClose
    >
      <Input
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        placeholder={t('video.direct.taskNamePlaceholder')}
        maxLength={60}
        autoFocus
        onPressEnter={() => {
          if (renamingId) {
            setProjectTitle(renamingId, renameValue.trim());
          }
          setRenamingId(null);
        }}
      />
    </Modal>
  );

  if (directTaskIds.length === 0) {
    return (
      <>
        <div style={{ padding: '12px 12px 6px', borderTop: '1px solid var(--border-secondary)' }}>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>
            <ThunderboltOutlined style={{ marginRight: 4 }} />
            {t('video.direct.sidebarTitle')}
          </Text>
          <div style={{ marginTop: 6 }}>
            <Empty
              description={t('video.direct.sidebarEmpty')}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ margin: '4px 0' }}
            />
          </div>
        </div>
        {renameModal}
      </>
    );
  }

  return (
    <div style={{
      padding: '8px 12px',
      borderTop: '1px solid var(--border-secondary)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      flexShrink: 1,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginBottom: 6,
        flexShrink: 0,
      }}>
        <ThunderboltOutlined style={{ fontSize: 11, color: 'var(--accent-primary)' }} />
        <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>
          {t('video.direct.sidebarTitle')}
        </Text>
        <Text type="secondary" style={{ fontSize: 10, marginLeft: 'auto' }}>
          {directTaskIds.length}
        </Text>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {directTaskIds.map((id) => {
          const stage = directTaskStages[id];
          const title = directTaskTitles[id];
          const createdAt = directTaskTimes[id];
          const finalUrl = directTaskFinalUrls[id];
          const prompt = directTaskPrompts[id];
          const isActive = activePipelineId === id;
          const contextMenu = {
            items: [
              {
                key: 'rename',
                label: t('video.direct.rename'),
                icon: <EditOutlined />,
                onClick: () => {
                  setRenameValue(title ?? '');
                  setRenamingId(id);
                },
              },
              {
                key: 'copyPrompt',
                label: t('video.direct.copyPrompt'),
                icon: <CopyOutlined />,
                disabled: !prompt,
                onClick: () => {
                  if (prompt) {
                    navigator.clipboard.writeText(prompt);
                    message.success(t('video.direct.copied'));
                  }
                },
              },
              {
                key: 'copyId',
                label: t('video.direct.copyId'),
                icon: <CopyOutlined />,
                onClick: () => {
                  navigator.clipboard.writeText(id);
                  message.success(t('video.direct.copied'));
                },
              },
              { type: 'divider' as const },
              {
                key: 'export',
                label: t('video.direct.exportVideo'),
                icon: <DownloadOutlined />,
                disabled: !finalUrl,
                onClick: () => setExportingId(id),
              },
              { type: 'divider' as const },
              {
                key: 'delete',
                label: t('video.direct.deleteTask'),
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                  resetProject(id);
                  if (activePipelineId === id) setActivePipelineId(undefined);
                },
              },
            ],
          };
          return (
            <Dropdown key={id} menu={contextMenu} trigger={['contextMenu']}>
            <div
              onClick={() => {
                setActivePipelineId(id);
                useProjectStore.getState().setActiveProject(null);
              }}
              style={{
                padding: '6px 8px',
                marginBottom: 4,
                cursor: 'pointer',
                borderRadius: 4,
                border: isActive
                  ? '1px solid var(--accent-primary, #3b82f6)'
                  : '1px solid var(--border-secondary)',
                background: isActive
                  ? 'var(--bg-active, rgba(59,130,246,0.08))'
                  : 'var(--bg-container)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
              }}>
                <Text
                  strong={isActive}
                  ellipsis
                  style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                >
                  {title || t('video.direct.taskItemFallback', {
                    time: createdAt ? new Date(createdAt).toLocaleString() : id,
                  })}
                </Text>
                <Tooltip title={t('video.direct.rename')}>
                  <EditOutlined
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameValue(title ?? '');
                      setRenamingId(id);
                    }}
                    style={{
                      fontSize: 11,
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                      cursor: 'pointer',
                    }}
                  />
                </Tooltip>
                <Popconfirm
                  title={t('video.direct.deleteTask')}
                  okText={t('common.delete')}
                  okButtonProps={{ danger: true, size: 'small' }}
                  cancelText={t('common.cancel')}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    resetProject(id);
                    if (activePipelineId === id) {
                      setActivePipelineId(undefined);
                    }
                  }}
                >
                  <Tooltip title={t('video.direct.deleteTask')}>
                    <DeleteOutlined
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        flexShrink: 0,
                      }}
                    />
                  </Tooltip>
                </Popconfirm>
              </div>
              {(stage || createdAt) && (
                <Text
                  type="secondary"
                  style={{ fontSize: 10, display: 'block', marginTop: 2 }}
                  ellipsis
                >
                  {t('video.direct.taskMeta', {
                    stage: stage ?? '',
                    time: createdAt ? new Date(createdAt).toLocaleString() : '',
                  })}
                </Text>
              )}
            </div>
            </Dropdown>
          );
        })}
      </div>
      {renameModal}
      {exportingId && (
        <ExportVideoModal
          open={exportingId !== null}
          onClose={() => setExportingId(null)}
          sourcePath={directTaskFinalUrls[exportingId] ?? ''}
          suggestedName={`mojing-${exportingId}`}
        />
      )}
    </div>
  );
};

export default DirectTaskList;

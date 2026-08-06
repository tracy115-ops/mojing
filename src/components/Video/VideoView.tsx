import React, { useState, useMemo, useEffect } from 'react';
import { Typography, message, Button, Tooltip } from 'antd';
import { VideoCameraOutlined, ThunderboltOutlined, FormOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import type { VideoMetadata } from '@/types';
import ProjectList from '@/components/Common/ProjectList';
import CreateVideoModal from './CreateVideoModal';
import VideoGeneratorModal from './VideoGeneratorModal';
import DirectVideoModal from './DirectVideoModal';
import DirectTaskList from './DirectTaskList';
import VideoPipelinePanel from './VideoPipelinePanel';
import { VideoPipelineErrorBoundary } from './VideoPipelineErrorBoundary';

const { Text, Title } = Typography;

const VideoView: React.FC = () => {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const toggleFavorite = useProjectStore((s) => s.toggleFavorite);

  const activePipelineId = useVideoStore((s) => s.activePipelineId);

  const [createOpen, setCreateOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);

  // Listen for global "new project" event from titlebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail;
      if (type === 'video') setCreateOpen(true);
    };
    window.addEventListener('mojing:create-project', handler);
    return () => window.removeEventListener('mojing:create-project', handler);
  }, []);

  const videoProjects = useMemo(() => projects.filter((p) => p.type === 'video'), [projects]);

  const handleCreate = (values: { title: string; description: string; style: string; resolution: string; aspectRatio: string; fps: number }) => {
    const project = useProjectStore.getState().createProject('video', values.title, values.description, {
      style: values.style,
      resolution: values.resolution,
      aspectRatio: values.aspectRatio,
      fps: values.fps,
    } as Partial<VideoMetadata>);
    setActiveProject(project.id);
    setCreateOpen(false);
    message.success(t('common.success'));
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 220, borderRight: '1px solid var(--border-secondary)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <ProjectList
            projects={videoProjects}
            type="video"
            activeId={activeProjectId}
            onSelect={setActiveProject}
            onDelete={deleteProject}
            onToggleFavorite={toggleFavorite}
            onCreate={() => setCreateOpen(true)}
          />
        </div>
        {/* Direct 任务列表:跟 Novel 项目并列,但来自 videoStore(不在 projectStore)。
            点任一项 = 切 activePipelineId → VideoPipelinePanel 切到对应执行过程。 */}
        <DirectTaskList />
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Top toolbar — two entries */}
        <div style={{
          padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)',
          display: 'flex', gap: 8, alignItems: 'center', background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        }}>
          <Tooltip title={t('video.direct.tooltip')}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => setDirectOpen(true)}
            >
              {t('video.direct.button')}
            </Button>
          </Tooltip>
          <Tooltip title={t('video.gen.description')}>
            <Button
              icon={<FormOutlined />}
              onClick={() => setGenOpen(true)}
            >
              {t('video.gen.title')}
            </Button>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {t('video.direct.tagline')}
          </Text>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {activePipelineId ? (
            <VideoPipelineErrorBoundary
              onReset={() => {
                useVideoStore.getState().resetProject(activePipelineId);
                useVideoStore.getState().setActivePipelineId(undefined);
              }}
            >
              <VideoPipelinePanel pipelineId={activePipelineId} />
            </VideoPipelineErrorBoundary>
          ) : (
            <div style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 20,
              padding: 32,
              textAlign: 'center',
              overflowY: 'auto',
            }}>
              <VideoCameraOutlined style={{ fontSize: 56, color: 'var(--accent-primary, #3b82f6)' }} />
              <div>
                <Title level={4} style={{ margin: '0 0 6px 0', color: 'var(--text-primary, inherit)' }}>
                  {t('video.empty.title')}
                </Title>
                <Text type="secondary" style={{ maxWidth: 520, fontSize: 13, display: 'inline-block' }}>
                  {t('video.empty.hint')}
                </Text>
              </div>

              {/* 灵感快捷启动卡片 */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 16,
                maxWidth: 780,
                width: '100%',
                marginTop: 8,
              }}>
                <div
                  onClick={() => setDirectOpen(true)}
                  style={{
                    padding: 16,
                    border: '1px solid var(--border-secondary)',
                    borderRadius: 8,
                    background: 'var(--bg-container)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-secondary)')}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>⚡</div>
                  <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>一键灵感生视频</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>输入单条 Prompt 立即文本/图生成短视频片段</Text>
                </div>

                <div
                  onClick={() => setDirectOpen(true)}
                  style={{
                    padding: 16,
                    border: '1px solid var(--border-secondary)',
                    borderRadius: 8,
                    background: 'var(--bg-container)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-secondary)')}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>🎭</div>
                  <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>角色一致性短剧</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>提取形象立绘与场景背景图，跨镜头脸部统一</Text>
                </div>

                <div
                  onClick={() => setGenOpen(true)}
                  style={{
                    padding: 16,
                    border: '1px solid var(--border-secondary)',
                    borderRadius: 8,
                    background: 'var(--bg-container)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-secondary)')}
                >
                  <div style={{ fontSize: 24, marginBottom: 8 }}>📜</div>
                  <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>小说/脚本改编</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>选择已有小说章节，14步智能编排完整短片</Text>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                <Button
                  type="primary"
                  size="large"
                  icon={<ThunderboltOutlined />}
                  onClick={() => setDirectOpen(true)}
                >
                  {t('video.direct.cta')}
                </Button>
                <Button
                  size="large"
                  icon={<FormOutlined />}
                  onClick={() => setGenOpen(true)}
                >
                  {t('video.gen.cta')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <CreateVideoModal open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} />
      <VideoGeneratorModal open={genOpen} onClose={() => setGenOpen(false)} />
      <DirectVideoModal open={directOpen} onClose={() => setDirectOpen(false)} />
    </div>
  );
};

export default VideoView;

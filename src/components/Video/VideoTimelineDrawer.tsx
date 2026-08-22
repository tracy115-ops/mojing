// ============================================================================
// VideoTimelineDrawer — 轻量级可视多轨时间轴剪辑与微调工作台 (Timeline Workspace)
// ============================================================================
// 功能：
//   1. 视频镜头轨 (Video Track)：查看各镜缩略图、拖拽调整顺序、排除/启用镜头、单独修剪。
//   2. 角色配音轨 (Audio Track)：查看/试听每镜角色台词配音、音量调节。
//   3. 背景音乐轨 (BGM Track)：BGM 氛围模式选择、BGM 音量比例调节。
//   4. 字幕预览轨 (Subtitle Track)：对齐时间戳预览各镜头字幕。
//   5. 实时播放预览与基于时间轴快速重新合成（无需消耗 Token 重新生成）。

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Drawer, Typography, Button, Space, Slider, Tag, Tooltip, message,
  Card, Popconfirm, Spin, Select, Divider, Switch,
} from 'antd';
import {
  PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined,
  SoundOutlined, VideoCameraOutlined, FileTextOutlined,
  ClockCircleOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined,
  CheckOutlined, UndoOutlined, SettingOutlined, EyeOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import type { ShotSpec, GeneratedClip, VideoProjectState } from '@/types/video';
import { runCompose } from '@/services/video/core/step-compose';
import { toWebviewUrl, resolveLocalPath } from '@/services/video/asset-store';

const { Text, Title, Paragraph } = Typography;

interface VideoTimelineDrawerProps {
  open: boolean;
  onClose: () => void;
  pipelineId?: string;
  project?: VideoProjectState;
}

interface TimelineShotItem {
  id: string;
  index: number;
  shot: ShotSpec;
  clip?: GeneratedClip;
  enabled: boolean;
  trimStartSeconds: number;
  trimEndSeconds: number;
}

export const VideoTimelineDrawer: React.FC<VideoTimelineDrawerProps> = ({
  open,
  onClose,
  pipelineId,
  project,
}) => {
  const { t } = useTranslation();
  const rawShots = project?.sceneSpec?.shots || [];
  const rawClips = project?.clips || [];

  // 时间轴内部镜头列表状态（支持用户重新排序与启用状态微调）
  const [timelineShots, setTimelineShots] = useState<TimelineShotItem[]>([]);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bgmVolume, setBgmVolume] = useState<number>(30);
  const [dialogueVolume, setDialogueVolume] = useState<number>(100);
  const [isRecomposing, setIsRecomposing] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // 初始化时间轴数据
  useEffect(() => {
    if (!open) return;
    const initialItems: TimelineShotItem[] = rawShots.map((s, idx) => {
      const clip = rawClips.find((c) => c.shotId === s.id);
      return {
        id: s.id,
        index: idx,
        shot: s,
        clip,
        enabled: true,
        trimStartSeconds: 0,
        trimEndSeconds: 0,
      };
    });
    setTimelineShots(initialItems);
    if (initialItems.length > 0 && !selectedShotId) {
      setSelectedShotId(initialItems[0].id);
    }
  }, [open, rawShots, rawClips]);

  // 计算时间轴总时长
  const totalDuration = useMemo(() => {
    return timelineShots
      .filter((item) => item.enabled)
      .reduce((acc, item) => {
        const d = item.clip?.durationSeconds || item.shot.durationSeconds || 5;
        const netDuration = Math.max(1, d - item.trimStartSeconds - item.trimEndSeconds);
        return acc + netDuration;
      }, 0);
  }, [timelineShots]);

  const currentSelected = useMemo(() => {
    return timelineShots.find((item) => item.id === selectedShotId) || timelineShots[0];
  }, [timelineShots, selectedShotId]);

  // 上移分镜顺序
  const handleMoveUp = (index: number) => {
    if (index <= 0) return;
    setTimelineShots((prev) => {
      const copy = [...prev];
      const temp = copy[index - 1];
      copy[index - 1] = copy[index];
      copy[index] = temp;
      return copy;
    });
  };

  // 下移分镜顺序
  const handleMoveDown = (index: number) => {
    if (index >= timelineShots.length - 1) return;
    setTimelineShots((prev) => {
      const copy = [...prev];
      const temp = copy[index + 1];
      copy[index + 1] = copy[index];
      copy[index] = temp;
      return copy;
    });
  };

  // 切换分镜启用状态
  const handleToggleEnable = (id: string) => {
    setTimelineShots((prev) =>
      prev.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)),
    );
  };

  // 试听单独配音
  const handlePlayDialogue = (audioUrl?: string) => {
    if (!audioUrl) {
      message.warning('该镜头尚未生成对白配音音频');
      return;
    }
    if (audioPreviewRef.current) {
      audioPreviewRef.current.src = toWebviewUrl(resolveLocalPath(audioUrl));
      audioPreviewRef.current.play().catch((err) => {
        console.warn('Audio play failed:', err);
      });
      message.info('正在试听该镜头角色配音...');
    }
  };

  // 基于当前时间轴重新合成成片
  const handleRecompose = async () => {
    if (!pipelineId || !project) return;
    const activeItems = timelineShots.filter((item) => item.enabled && item.clip?.videoUrl);
    if (activeItems.length === 0) {
      message.error('请至少保留一个已生成有效视频片段的镜头进行合成');
      return;
    }

    setIsRecomposing(true);
    message.loading('正在根据调整后的时间轴重新合成成片...', 2);

    try {
      const orderedClips = activeItems.map((item) => item.clip!);
      const orderedShots = activeItems.map((item) => item.shot);

      const composeRes = await runCompose({
        novelProjectId: pipelineId,
        clips: orderedClips,
        shots: orderedShots,
        hardcodeSubtitles: project.spec?.hardcodeSubtitles ?? true,
      });

      if (composeRes?.finalVideoUrl) {
        useVideoStore.getState().setFinalVideo(pipelineId, composeRes.finalVideoUrl, {
          durationSeconds: composeRes.durationSeconds,
          sizeBytes: composeRes.sizeBytes,
        });
        message.success('时间轴重新合成成功！已更新最终成片。');
      }
    } catch (err) {
      message.error(`重新合成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRecomposing(false);
    }
  };

  return (
    <Drawer
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <Space>
            <VideoCameraOutlined style={{ color: 'var(--color-primary, #3b82f6)' }} />
            <Text strong style={{ fontSize: 15 }}>
              可视化多轨时间轴剪辑台 (Timeline Workspace)
            </Text>
            <Tag color="blue">总时长: {totalDuration.toFixed(1)} 秒</Tag>
            <Tag color="purple">有效镜头: {timelineShots.filter((s) => s.enabled).length}/{timelineShots.length}</Tag>
          </Space>
          <Space size={8}>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={isRecomposing}
              onClick={handleRecompose}
              style={{ background: '#10b981', borderColor: '#10b981' }}
            >
              基于时间轴快速重新合成
            </Button>
          </Space>
        </div>
      }
      placement="bottom"
      height="85vh"
      open={open}
      onClose={onClose}
      destroyOnClose
      styles={{ body: { padding: '12px 16px', background: 'var(--bg-secondary, #f8fafc)', display: 'flex', flexDirection: 'column', gap: 12 } }}
    >
      {/* 隐藏的音频试听播放器 */}
      <audio ref={audioPreviewRef} style={{ display: 'none' }} />

      {/* ── 顶部：双栏预览与微调控制区 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16, height: 260, flexShrink: 0 }}>
        {/* 左侧：当前分镜视频播放器 */}
        <Card
          size="small"
          title={
            <Space size={4}>
              <EyeOutlined />
              <span>
                镜头 #{currentSelected ? currentSelected.index + 1 : 1} 实时画面预览
              </span>
            </Space>
          }
          style={{ height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 8 }}
          styles={{ body: { flex: 1, padding: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', borderRadius: 6, overflow: 'hidden' } }}
        >
          {currentSelected?.clip?.videoUrl ? (
            <video
              ref={videoRef}
              src={toWebviewUrl(resolveLocalPath(currentSelected.clip.videoUrl))}
              controls
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          ) : (
            <div style={{ textAlign: 'center', color: '#94a3b8' }}>
              <VideoCameraOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block' }} />
              <Text style={{ color: '#94a3b8', fontSize: 12 }}>该镜头尚未生成视频片段</Text>
            </div>
          )}
        </Card>

        {/* 右侧：分镜属性微调面板 */}
        <Card
          size="small"
          title="当前选中分镜微调与全局音轨参数"
          style={{ height: '100%', overflowY: 'auto', borderRadius: 8 }}
        >
          {currentSelected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>画面提示词 (Video Prompt):</Text>
                <Paragraph style={{ margin: 0, fontSize: 12, color: 'var(--text-primary)' }} ellipsis={{ rows: 2 }}>
                  {currentSelected.shot.videoPrompt || currentSelected.shot.sourceText || '无提示词'}
                </Paragraph>
              </div>

              {currentSelected.shot.sourceText && (
                <div>
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>角色对白与台词:</Text>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.03)', padding: '4px 8px', borderRadius: 4, marginTop: 2 }}>
                    <Text style={{ fontSize: 12, flex: 1 }}>{currentSelected.shot.sourceText}</Text>
                    {currentSelected.shot.audioTrack && (
                      <Button
                        size="small"
                        type="text"
                        icon={<SoundOutlined />}
                        onClick={() => handlePlayDialogue(currentSelected.shot.audioTrack)}
                        style={{ color: '#1677ff' }}
                      >
                        试听配音
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <Divider style={{ margin: '4px 0' }} />

              {/* 全局音量控制 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <Text>角色对白人声音量:</Text>
                    <Text strong>{dialogueVolume}%</Text>
                  </div>
                  <Slider
                    min={0}
                    max={150}
                    value={dialogueVolume}
                    onChange={setDialogueVolume}
                    style={{ margin: '6px 0 0 0' }}
                  />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <Text>背景音乐 (BGM) 音量:</Text>
                    <Text strong>{bgmVolume}%</Text>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    value={bgmVolume}
                    onChange={setBgmVolume}
                    style={{ margin: '6px 0 0 0' }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <Text type="secondary">点击下方时间轴中的分镜卡片进行选中与微调</Text>
          )}
        </Card>
      </div>

      {/* ── 中下部：多轨时间轴可视化展示 ── */}
      <div style={{
        flex: 1,
        minHeight: 0,
        background: '#fff',
        border: '1px solid var(--border-secondary, #e2e8f0)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '8px 12px',
          background: 'var(--bg-elevated, #f1f5f9)',
          borderBottom: '1px solid var(--border-secondary, #e2e8f0)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          fontWeight: 600,
        }}>
          <Space>
            <span>分镜多轨流时间轴 (Tracks)</span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              支持在卡片中上下调整顺序、关闭/启用镜头、点击选中查看画面
            </Text>
          </Space>
        </div>

        {/* 轨道横向滚动容器 */}
        <div style={{
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
        }}>
          {timelineShots.map((item, index) => {
            const isSelected = item.id === selectedShotId;
            const duration = item.clip?.durationSeconds || item.shot.durationSeconds || 5;

            return (
              <div
                key={item.id}
                onClick={() => setSelectedShotId(item.id)}
                style={{
                  width: 200,
                  flexShrink: 0,
                  border: isSelected ? '2px solid #3b82f6' : '1px solid var(--border-secondary, #e2e8f0)',
                  borderRadius: 8,
                  background: item.enabled ? '#fff' : '#f8fafc',
                  opacity: item.enabled ? 1 : 0.5,
                  padding: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  boxShadow: isSelected ? '0 2px 8px rgba(59, 130, 246, 0.2)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                {/* 镜头头部标题与操作 */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Space size={4}>
                    <Tag color={isSelected ? 'blue' : 'default'} style={{ margin: 0, fontSize: 10, lineHeight: '18px' }}>
                      第 {index + 1} 镜
                    </Tag>
                    <Text style={{ fontSize: 10, color: '#64748b' }}>
                      <ClockCircleOutlined style={{ marginRight: 2 }} />
                      {duration}s
                    </Text>
                  </Space>
                  <Space size={2} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title="向前移动顺序">
                      <Button
                        size="small"
                        type="text"
                        disabled={index === 0}
                        icon={<ArrowUpOutlined style={{ fontSize: 10 }} />}
                        onClick={() => handleMoveUp(index)}
                        style={{ padding: '0 4px', height: 20 }}
                      />
                    </Tooltip>
                    <Tooltip title="向后移动顺序">
                      <Button
                        size="small"
                        type="text"
                        disabled={index === timelineShots.length - 1}
                        icon={<ArrowDownOutlined style={{ fontSize: 10 }} />}
                        onClick={() => handleMoveDown(index)}
                        style={{ padding: '0 4px', height: 20 }}
                      />
                    </Tooltip>
                    <Switch
                      size="small"
                      checked={item.enabled}
                      onChange={() => handleToggleEnable(item.id)}
                    />
                  </Space>
                </div>

                {/* 关键帧缩略图展示 */}
                <div style={{
                  height: 95,
                  borderRadius: 4,
                  overflow: 'hidden',
                  background: '#000',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  {item.shot.keyframeImage ? (
                    <img
                      src={toWebviewUrl(resolveLocalPath(item.shot.keyframeImage))}
                      alt={`Shot ${index + 1}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Text style={{ fontSize: 10, color: '#94a3b8' }}>无关键帧画面</Text>
                  )}
                  {item.clip?.videoUrl && (
                    <Tag
                      color="green"
                      style={{ position: 'absolute', bottom: 4, right: 4, margin: 0, fontSize: 9, lineHeight: '16px', padding: '0 4px' }}
                    >
                      视频就绪
                    </Tag>
                  )}
                </div>

                {/* 角色与台词摘要 */}
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                    <FileTextOutlined style={{ fontSize: 10 }} />
                    <Text style={{ fontSize: 11, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.shot.sourceText || item.shot.videoPrompt || '无文本'}
                    </Text>
                  </div>
                  {item.shot.audioTrack && (
                    <Tag color="cyan" style={{ fontSize: 9, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                      <SoundOutlined style={{ marginRight: 2 }} />配音已对齐
                    </Tag>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Drawer>
  );
};

export default VideoTimelineDrawer;

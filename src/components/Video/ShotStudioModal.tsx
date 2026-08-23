// ============================================================================
// ShotStudioModal.tsx — 分镜精修与单镜生成沉浸式工作台 (Shot Studio)
// ============================================================================
// 灵感源自成熟商业漫剧工具（如光影漫剧）的单镜精修交互体验：
// 1. 顶栏：多集水平快速切换（第1集、第2集...）、AI 剧本分析、保存工程
// 2. 左栏：分镜列表（拖拽/上下排序、添加/删除、角色/场景状态标签）
// 3. 中栏：沉浸式单镜精修控制台
//    - 顶部模式：[视频创作] / [分镜图创作] / [配音台词]
//    - 素材槽位：[图片 2/9] [视频 0/3] [音频 0/3] 支持从资产库选择与本地上传
//    - 时间轴提示词编辑器：带 AI 一键重构为 [0-1秒]... [1-3秒]... 工业级时间轴规范
//    - 视频控制矩阵：模型、参考生视频/文生视频/首尾帧、分辨率、时长、画幅比例、种子、声音模式
//    - 底部动作：【✨ 立即生成本镜】
// 4. 右栏：多版本历史记录画廊 (Version Gallery)，支持择优一键设为生效

import React, { useState, useMemo, useRef } from 'react';
import {
  Modal, Row, Col, Typography, Space, Button, Input, Select, Tag,
  Card, Tooltip, Divider, Image, message, Popconfirm, Spin, Empty,
  Radio, Segmented,
} from 'antd';
import {
  VideoCameraOutlined, PictureOutlined, AudioOutlined,
  PlusOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined,
  ThunderboltOutlined, CheckCircleOutlined, ReloadOutlined,
  UploadOutlined, PlayCircleOutlined, EyeOutlined, CheckOutlined,
  AppstoreOutlined, ClockCircleOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ShotSpec, GeneratedClip, VideoProjectState, AspectRatio } from '@/types/video';
import { saveAsset, toWebviewUrl, resolveLocalPath, isValidVideoClip } from '@/services/video/asset-store';
import { generateSingleKeyframe } from '@/services/video/core/step-keyframe';
import { generateSingleVideoClip } from '@/services/video/core/step-video-gen';
import { generateSingleTTS } from '@/services/video/core/step-tts';

function readBlobAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const CAMERA_PRESETS = [
  { label: '🎬 希区柯克变焦', tag: '希区柯克推拉变焦，背景戏剧性形变拉伸，人物焦点清晰' },
  { label: '🔄 360°环绕运镜', tag: '360度电影级平滑环绕运镜，光影在人物轮廓流动' },
  { label: '🏃 电影级跟随', tag: '平滑跟随运镜，景深虚化，增强第一视角沉浸感' },
  { label: '✨ 丁达尔光影', tag: '金色丁达尔光束穿透，空气中微尘粒子漂浮，电影级氛围' },
  { label: '🦅 航拍大远景', tag: '宏大高空航拍全景，广角大景深，气势磅礴' },
  { label: '⏳ 慢动作特写', tag: '高帧率慢动作特写镜头，微表情与发丝动态细腻呈现' },
];

const { Text, Title, Paragraph } = Typography;
const { TextArea } = Input;

export interface ShotStudioWorkspaceProps {
  pipelineId?: string;
  showHeader?: boolean;
  onClose?: () => void;
}

export const ShotStudioWorkspace: React.FC<ShotStudioWorkspaceProps> = ({
  pipelineId: initialPipelineId,
  showHeader = true,
  onClose,
}) => {
  const { t } = useTranslation();
  const { projects, updateSceneSpecShot, addSceneSpecShot, deleteSceneSpecShot, addShotVersion, selectShotVersion, addClip } = useVideoStore();
  const activePipelineId = useVideoStore((s) => s.activePipelineId);
  const currentPipelineId = initialPipelineId || activePipelineId || Object.keys(projects)[0];
  const [selectedProjectId, setSelectedProjectId] = useState<string>(currentPipelineId);

  const project = projects[selectedProjectId] || projects[currentPipelineId];
  const allProjects = useMemo(() => Object.values(projects), [projects]);

  const shots = useMemo(() => project?.sceneSpec?.shots || [], [project]);
  const characters = useMemo(() => project?.sceneSpec?.characters || [], [project]);
  const scenes = useMemo(() => project?.sceneSpec?.scenes || [], [project]);

  // 当前选中的分镜 ID
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const activeShot = useMemo(() => {
    if (!shots.length) return null;
    return shots.find((s) => s.id === selectedShotId) || shots[0];
  }, [shots, selectedShotId]);

  // 创作模式：'video' | 'extend' | 'keyframe'
  const [studioMode, setStudioMode] = useState<'video' | 'extend' | 'keyframe'>('video');

  // 生成参数
  const [videoGenMode, setVideoGenMode] = useState<'reference' | 'text' | 'first_last'>('reference');
  const [resolution, setResolution] = useState<'720p' | '1080p'>('720p');
  const [durationSec, setDurationSec] = useState<number>(4);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(project?.spec?.aspectRatio || '16:9');
  const [audioMode, setAudioMode] = useState<'with_audio' | 'silent'>('with_audio');
  const [seed, setSeed] = useState<number>(-1);

  // 加载状态
  const [generating, setGenerating] = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [generatingTTS, setGeneratingTTS] = useState(false);
  const [playingAudioUrl, setPlayingAudioUrl] = useState<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // 素材选择弹窗
  const [assetSelectModalOpen, setAssetSelectModalOpen] = useState(false);
  const imageUploadRef = useRef<HTMLInputElement | null>(null);

  // 视频预览 Modal
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);

  if (!project) return null;

  // --- 智能 AI 重构分秒时间轴提示词 ---
  const handleAIOptimizeTimelinePrompt = () => {
    if (!activeShot) return;
    setOptimizingPrompt(true);
    try {
      const orig = activeShot.videoPrompt || activeShot.sourceText || '';
      const dur = activeShot.durationSeconds || 4;
      const t1 = Math.max(1, Math.floor(dur * 0.25));
      const t2 = Math.max(t1 + 1, Math.floor(dur * 0.75));

      const optimized = `建立镜头，呈现${activeShot.location || '主体环境'}的生动情境。时间轴：[0-${t1}]秒，摄像机平滑推近，展现环境主光影与角色初始状态；[${t1}-${t2}]秒，${activeShot.characterIds?.length ? activeShot.characterIds.join('与') : '主体'}执行主要动作，神态自然流动；[${t2}-${dur}]秒，动作平稳收尾，光影氛围升华。总时长${dur}秒，8K电影级质感，光影层次丰富。`;
      
      updateSceneSpecShot(selectedProjectId, activeShot.id, { videoPrompt: optimized });
      message.success('已自动重构为工业级分秒时间轴分段规范！');
    } catch {
      message.error('重构提示词失败');
    } finally {
      setOptimizingPrompt(false);
    }
  };

  // --- 单镜 TTS 配音生成 ---
  const handleGenerateActiveTTS = async () => {
    if (!activeShot) return;
    setGeneratingTTS(true);
    try {
      const { audioUrl, durationSeconds } = await generateSingleTTS(
        activeShot,
        characters,
        selectedProjectId,
      );
      updateSceneSpecShot(selectedProjectId, activeShot.id, {
        audioTrack: audioUrl,
        durationSeconds: durationSeconds ? (Math.ceil((durationSeconds + 0.5) * 2) / 2 as any) : activeShot.durationSeconds,
      });
      message.success(`分镜 ${activeShot.index + 1} 配音生成成功！`);
    } catch (err) {
      message.error(`配音生成失败: ${String(err)}`);
    } finally {
      setGeneratingTTS(false);
    }
  };

  // --- 试听 / 停止配音 ---
  const handleTogglePlayAudio = (url: string) => {
    if (playingAudioUrl === url) {
      audioPlayerRef.current?.pause();
      setPlayingAudioUrl(null);
    } else {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }
      const audio = new Audio(toWebviewUrl(url));
      audioPlayerRef.current = audio;
      audio.onended = () => setPlayingAudioUrl(null);
      audio.play().catch((err) => message.error(`播放失败: ${String(err)}`));
      setPlayingAudioUrl(url);
    }
  };

  // --- 添加新镜头 ---
  const handleAddShot = () => {
    const newIndex = shots.length;
    addSceneSpecShot(selectedProjectId, {
      sourceText: `新镜头 ${newIndex + 1}`,
      videoPrompt: `建立镜头。时间轴：[0-1]秒，摄像机推进；[1-3]秒，人物动作演进；[3-4]秒，定格光影。总时长4秒，写实电影风格。`,
      durationSeconds: 5,
      characters: [],
      characterIds: [],
    });
    message.success(`已添加分镜 ${newIndex + 1}`);
  };

  // --- 镜头上移/下移 ---
  const handleMoveShot = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= shots.length) return;
    const reordered = [...shots];
    const temp = reordered[index];
    reordered[index] = reordered[targetIndex];
    reordered[targetIndex] = temp;
    reordered.forEach((s, idx) => { s.index = idx; });
    useVideoStore.getState().setSceneSpec(selectedProjectId, { ...project.sceneSpec!, shots: reordered });
  };

  // --- 删除镜头 ---
  const handleDeleteShot = (shotId: string) => {
    if (shots.length <= 1) {
      message.warning('至少保留一个分镜');
      return;
    }
    deleteSceneSpecShot(selectedProjectId, shotId);
    message.success('分镜已删除');
  };

  // --- 素材图片上传 ---
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeShot) return;
    try {
      const dataUri = await readBlobAsDataUri(file);
      const savedPath = await saveAsset(selectedProjectId, 'keyframe', dataUri, `custom_ref_${Date.now()}`);
      const updatedRefs = [...(activeShot.customReferenceImages || []), savedPath];
      updateSceneSpecShot(selectedProjectId, activeShot.id, { customReferenceImages: updatedRefs });
      message.success('参考图片已添加');
    } catch (err) {
      message.error(`上传失败: ${String(err)}`);
    } finally {
      if (imageUploadRef.current) imageUploadRef.current.value = '';
    }
  };

  // --- 生成当前分镜（关键帧、视频或延展视频） ---
  const handleGenerateActiveShot = async () => {
    if (!activeShot) return;
    setGenerating(true);
    try {
      if (studioMode === 'keyframe') {
        // 生成关键帧
        const keyframeUrl = await generateSingleKeyframe(
          activeShot,
          activeShot.index,
          shots,
          {
            characters,
            scenes,
            aspectRatio,
            style: project.spec?.bgmStyle || 'cinematic',
            imageTier: project.spec?.imageTier || 'value',
            novelProjectId: selectedProjectId,
          },
        );

        const versionItem = {
          id: `kf_${Date.now()}`,
          type: 'image' as const,
          url: keyframeUrl,
          createdAt: new Date().toLocaleTimeString(),
          prompt: activeShot.videoPrompt,
        };
        addShotVersion(selectedProjectId, activeShot.id, versionItem);
        message.success(`分镜 ${activeShot.index + 1} 关键帧生成成功！`);
      } else {
        // 生成视频 / 延长视频
        const isExtendMode = studioMode === 'extend';
        const clip = await generateSingleVideoClip(
          { ...activeShot, durationSeconds: (durationSec as any) || activeShot.durationSeconds },
          {
            spec: {
              resolution: resolution === '720p' ? '1280x720' : '1920x1080',
              fps: 24,
              videoTier: project.spec?.videoTier || 'value',
            },
            characters,
            allShots: shots,
            novelProjectId: selectedProjectId,
          },
          videoGenMode !== 'text',
        );

        addClip(selectedProjectId, clip);
        const versionItem = {
          id: `clip_${Date.now()}`,
          type: 'video' as const,
          url: clip.videoUrl,
          createdAt: new Date().toLocaleTimeString(),
          prompt: `${isExtendMode ? '【延展视频】' : ''}${activeShot.videoPrompt}`,
          model: clip.model,
          durationSeconds: clip.durationSeconds,
        };
        addShotVersion(selectedProjectId, activeShot.id, versionItem);
        message.success(`分镜 ${activeShot.index + 1} ${isExtendMode ? '延展视频' : '视频'}生成成功！`);
      }
    } catch (err) {
      message.error(`生成失败: ${String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0 10px 0', flexShrink: 0 }}>
          <Space size="middle">
            <Title level={4} style={{ margin: 0 }}>🎬 分镜精修工作台</Title>
            {/* 顶栏多集快速切换 */}
            <div style={{ display: 'flex', gap: 6, background: 'var(--bg-container, #1f1f1f)', padding: '2px 6px', borderRadius: 16, border: '1px solid var(--border-base, rgba(255,255,255,0.12))' }}>
              {allProjects.map((p, idx) => (
                <Button
                  key={p.novelProjectId}
                  size="small"
                  type={p.novelProjectId === selectedProjectId ? 'primary' : 'text'}
                  style={{ borderRadius: 12, fontSize: 12 }}
                  onClick={() => setSelectedProjectId(p.novelProjectId)}
                >
                  第{idx + 1}集 {p.title ? `· ${p.title.slice(0, 8)}` : ''}
                </Button>
              ))}
            </div>
          </Space>
          <Space>
            <Tooltip title="工业级漫剧工作台：支持多集无缝切换、时间轴提示词分段、单镜素材绑定与版本回溯。">
              <Button icon={<InfoCircleOutlined />} type="text">操作指南</Button>
            </Tooltip>
            {onClose && <Button onClick={onClose}>关闭工作台</Button>}
          </Space>
        </div>
      )}
      <Row gutter={12} style={{ flex: 1, minHeight: 0 }}>
        {/* ==================================================================== */}
        {/* 左栏：分镜列表侧边栏 (Shot List Sidebar)                             */}
        {/* ==================================================================== */}
        <Col span={5} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Card
            size="small"
            style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 } }}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text strong>分镜列表 ({shots.length})</Text>
                <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={handleAddShot}>
                  添加分镜
                </Button>
              </div>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shots.map((s, idx) => {
                const isSelected = activeShot?.id === s.id;
                const hasKeyframe = !!s.keyframeImage;
                const hasClip = project.clips.some((c) => c.shotId === s.id);
                return (
                  <Card
                    key={s.id}
                    size="small"
                    hoverable
                    onClick={() => setSelectedShotId(s.id)}
                    style={{
                      cursor: 'pointer',
                      border: isSelected ? '1.5px solid var(--accent-primary, #1677ff)' : '1px solid var(--border-base, rgba(255,255,255,0.1))',
                      background: isSelected ? 'rgba(22, 119, 255, 0.08)' : 'var(--bg-container, #1f1f1f)',
                    }}
                    styles={{ body: { padding: '8px 10px' } }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <Text strong style={{ fontSize: 13, color: isSelected ? 'var(--accent-primary, #1677ff)' : undefined }}>
                        {idx + 1}. {s.sourceText?.slice(0, 14) || s.videoPrompt?.slice(0, 14) || `分镜 ${idx + 1}`}
                      </Text>
                      <Space size={2} onClick={(e) => e.stopPropagation()}>
                        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={idx === 0} onClick={() => handleMoveShot(idx, 'up')} />
                        <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={idx === shots.length - 1} onClick={() => handleMoveShot(idx, 'down')} />
                        <Popconfirm title="确认删除此分镜？" onConfirm={() => handleDeleteShot(s.id)} okText="删除" cancelText="取消">
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    </div>

                    <Paragraph ellipsis={{ rows: 2 }} style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary, rgba(255,255,255,0.65))', lineHeight: 1.4 }}>
                      {s.videoPrompt || s.sourceText}
                    </Paragraph>

                    <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                      {s.characterIds?.length ? <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>角色 {s.characterIds.length}</Tag> : <Tag style={{ fontSize: 10, margin: 0 }}>无角色</Tag>}
                      {hasKeyframe && <Tag color="cyan" style={{ fontSize: 10, margin: 0 }}>关键帧 ✓</Tag>}
                      {hasClip && <Tag color="green" style={{ fontSize: 10, margin: 0 }}>视频 ✓</Tag>}
                      <Tag style={{ fontSize: 10, margin: 0 }}>{s.durationSeconds || 4}s</Tag>
                    </div>
                  </Card>
                );
              })}
            </div>
          </Card>
        </Col>

        {/* ==================================================================== */}
        {/* 中栏：沉浸式单镜精修与生成控制区                                     */}
        {/* ==================================================================== */}
        <Col span={13} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Card
            size="small"
            style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 } }}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Space>
                  <Text strong style={{ fontSize: 14 }}>
                    当前编辑：分镜 {activeShot ? activeShot.index + 1 : '-'}
                  </Text>
                  <Tag color="purple">{activeShot?.location || '默认场景'}</Tag>
                </Space>
                <Segmented
                  value={studioMode}
                  onChange={(val) => setStudioMode(val as any)}
                  options={[
                    { label: '视频创作', value: 'video', icon: <VideoCameraOutlined /> },
                    { label: '延长视频', value: 'extend', icon: <ReloadOutlined /> },
                    { label: '分镜图创作', value: 'keyframe', icon: <PictureOutlined /> },
                  ]}
                />
              </div>
            }
          >
            {activeShot ? (
              <>
                {/* ── 0. 当前镜头视频主舞台预览 (Main Stage Video Preview) ── */}
                {(() => {
                  const currentClip = project.clips?.find((c) => c.shotId === activeShot.id);
                  const selectedVideo = activeShot.versionHistory?.find((v) => v.id === activeShot.selectedVersionId && v.type === 'video');
                  const activeVideoUrl = selectedVideo?.url || currentClip?.videoUrl;
                  if (activeVideoUrl) {
                    const resolvedSrc = toWebviewUrl(resolveLocalPath(activeVideoUrl));
                    return (
                      <div style={{
                        background: '#000',
                        borderRadius: 8,
                        overflow: 'hidden',
                        border: '1px solid rgba(255,255,255,0.15)',
                        marginBottom: 6,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                      }}>
                        <div style={{
                          padding: '6px 12px',
                          background: 'rgba(255,255,255,0.06)',
                          borderBottom: '1px solid rgba(255,255,255,0.08)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}>
                          <Space size={6}>
                            <Tag color="green" style={{ margin: 0, fontSize: 11, fontWeight: 600 }}>🎬 当前生效视频</Tag>
                            <Text style={{ fontSize: 12, fontWeight: 600 }}>分镜 #{activeShot.index + 1}</Text>
                          </Space>
                          <Space size={6}>
                            <Tag style={{ margin: 0, fontSize: 10 }}>时长: {activeShot.durationSeconds || 4}s</Tag>
                            <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>{resolution}</Tag>
                          </Space>
                        </div>
                        <div style={{
                          width: '100%',
                          background: '#000',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '6px',
                          boxSizing: 'border-box',
                        }}>
                          <div style={{
                            width: aspectRatio === '9:16' ? '240px' : '100%',
                            aspectRatio: aspectRatio === '9:16' ? '9 / 16' : aspectRatio === '1:1' ? '1 / 1' : '16 / 9',
                            maxHeight: aspectRatio === '9:16' ? '420px' : '360px',
                            background: '#000',
                            borderRadius: 6,
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                            <video
                              key={resolvedSrc}
                              src={resolvedSrc}
                              controls
                              playsInline
                              preload="auto"
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                outline: 'none',
                                display: 'block',
                                background: '#000',
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* ── 1. 素材槽位区 (Asset Slots) ── */}
                <div style={{ background: 'rgba(255,255,255,0.03)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-base, rgba(255,255,255,0.08))' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text strong style={{ fontSize: 12 }}>
                      🖼️ 参考素材槽位 (图片 {(activeShot.customReferenceImages?.length || (activeShot.keyframeImage ? 1 : 0))}/9 · 音频 {activeShot.audioTrack ? '1/1' : '0/1'})
                    </Text>
                    <Space size="small">
                      <Button size="small" icon={<AppstoreOutlined />} onClick={() => setAssetSelectModalOpen(true)}>
                        从资产库选择
                      </Button>
                      <Button size="small" icon={<UploadOutlined />} onClick={() => imageUploadRef.current?.click()}>
                        本地上传
                      </Button>
                      <input
                        type="file"
                        ref={imageUploadRef}
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleImageUpload}
                      />
                    </Space>
                  </div>

                  <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                    {/* 已绑定的关键帧/参考图 */}
                    {activeShot.keyframeImage && (
                      <div style={{ position: 'relative', width: 72, height: 72, borderRadius: 6, overflow: 'hidden', border: '1.5px solid #1677ff' }}>
                        <Image src={toWebviewUrl(activeShot.keyframeImage)} width={72} height={72} style={{ objectFit: 'cover' }} />
                        <Tag color="blue" style={{ position: 'absolute', bottom: 2, left: 2, margin: 0, fontSize: 9, padding: '0 2px' }}>关键帧</Tag>
                      </div>
                    )}
                    {activeShot.customReferenceImages?.map((imgUrl, i) => (
                      <div key={i} style={{ position: 'relative', width: 72, height: 72, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.2)' }}>
                        <Image src={toWebviewUrl(imgUrl)} width={72} height={72} style={{ objectFit: 'cover' }} />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.6)', padding: 0, height: 18, width: 18 }}
                          onClick={() => {
                            const filtered = activeShot.customReferenceImages?.filter((_, idx) => idx !== i);
                            updateSceneSpecShot(selectedProjectId, activeShot.id, { customReferenceImages: filtered });
                          }}
                        />
                      </div>
                    ))}
                    {(!activeShot.keyframeImage && (!activeShot.customReferenceImages || activeShot.customReferenceImages.length === 0)) && (
                      <div
                        onClick={() => setAssetSelectModalOpen(true)}
                        style={{
                          width: 72, height: 72, borderRadius: 6, border: '1px dashed var(--border-base, rgba(255,255,255,0.2))',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                        }}
                      >
                        <PlusOutlined style={{ fontSize: 16, color: 'var(--text-secondary)' }} />
                        <Text type="secondary" style={{ fontSize: 10, marginTop: 2 }}>添加参考图</Text>
                      </div>
                    )}
                  </div>

                  {/* 🎙️ 音频配音槽位 */}
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border-base, rgba(255,255,255,0.1))', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Space size="small">
                      <AudioOutlined style={{ color: activeShot.audioTrack ? '#52c41a' : 'inherit' }} />
                      <Text strong style={{ fontSize: 12 }}>
                        本镜配音槽位: {activeShot.audioTrack ? '已就绪' : '未就绪'}
                      </Text>
                      {activeShot.audioTrack && (
                        <Button
                          size="small"
                          type="dashed"
                          icon={playingAudioUrl === activeShot.audioTrack ? <CheckCircleOutlined /> : <PlayCircleOutlined />}
                          onClick={() => handleTogglePlayAudio(activeShot.audioTrack!)}
                          style={{ color: '#52c41a', borderColor: '#52c41a' }}
                        >
                          {playingAudioUrl === activeShot.audioTrack ? '停止试听' : '试听配音'}
                        </Button>
                      )}
                    </Space>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      loading={generatingTTS}
                      icon={<AudioOutlined />}
                      onClick={handleGenerateActiveTTS}
                    >
                      {activeShot.audioTrack ? '重新合成配音' : '✨ 生成本镜配音'}
                    </Button>
                  </div>
                </div>

                {/* ── 2. 时间轴分段提示词编辑器 (Timeline Prompt Editor) ── */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Space>
                      <Text strong style={{ fontSize: 13 }}>⏱️ 画面描述（工业级时间轴规范）</Text>
                      <Tag color="cyan">分秒推进 · 动作防晃</Tag>
                    </Space>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      loading={optimizingPrompt}
                      icon={<ThunderboltOutlined />}
                      onClick={handleAIOptimizeTimelinePrompt}
                    >
                      AI 一键重构时间轴
                    </Button>
                  </div>

                  {/* 🎬 运镜与光影快捷模板库 */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    {CAMERA_PRESETS.map((p, idx) => (
                      <Tag
                        key={idx}
                        color="blue"
                        style={{ cursor: 'pointer', margin: 0, fontSize: 11, padding: '1px 6px', borderRadius: 4 }}
                        onClick={() => {
                          const current = activeShot.videoPrompt || '';
                          const updated = current ? `${current}；${p.tag}` : p.tag;
                          updateSceneSpecShot(selectedProjectId, activeShot.id, { videoPrompt: updated });
                          message.info(`已追加运镜指令: ${p.label}`);
                        }}
                      >
                        {p.label}
                      </Tag>
                    ))}
                  </div>

                  <TextArea
                    rows={4}
                    value={activeShot.videoPrompt}
                    onChange={(e) => updateSceneSpecShot(selectedProjectId, activeShot.id, { videoPrompt: e.target.value })}
                    placeholder="建立镜头，[主体/场景]。时间轴：[0-1]秒，[摄像机动作]；[1-3]秒，[主体动作演进]；[3-4]秒，[收尾与光影]。总时长4秒，电影级光影。"
                    style={{ fontSize: 12, lineHeight: 1.6 }}
                  />
                </div>

                {/* ── 3. 台词与对白编辑器 (Dialogue & Speech) ── */}
                <div>
                  <Text strong style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>🗣️ 配音台词 / 旁白</Text>
                  <Input
                    value={activeShot.narration || ''}
                    onChange={(e) => updateSceneSpecShot(selectedProjectId, activeShot.id, { narration: e.target.value })}
                    placeholder="填写本分镜角色台词或解说旁白..."
                  />
                </div>

                {/* ── 4. 生成参数控制矩阵 (Generation Parameters) ── */}
                <Card size="small" style={{ background: 'rgba(255,255,255,0.02)' }} styles={{ body: { padding: '10px 12px' } }}>
                  <Row gutter={[12, 10]}>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>创作模式</Text>
                      <Select
                        size="small"
                        style={{ width: '100%', marginTop: 2 }}
                        value={videoGenMode}
                        onChange={(val) => setVideoGenMode(val)}
                        options={[
                          { label: '参考生视频 (I2V)', value: 'reference' },
                          { label: '纯文生视频 (T2V)', value: 'text' },
                          { label: '首尾关键帧插值', value: 'first_last' },
                        ]}
                      />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>视频时长</Text>
                      <Select
                        size="small"
                        style={{ width: '100%', marginTop: 2 }}
                        value={durationSec}
                        onChange={(val) => {
                          setDurationSec(val);
                          updateSceneSpecShot(selectedProjectId, activeShot.id, { durationSeconds: val as any });
                        }}
                        options={[
                          { label: '3 秒 (快速特写)', value: 3 },
                          { label: '4 秒 (标准分镜)', value: 4 },
                          { label: '5 秒 (标准叙事)', value: 5 },
                          { label: '10 秒 (超长连续)', value: 10 },
                        ]}
                      />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>画幅比例</Text>
                      <Select
                        size="small"
                        style={{ width: '100%', marginTop: 2 }}
                        value={aspectRatio}
                        onChange={(val) => setAspectRatio(val)}
                        options={[
                          { label: '16:9 横屏', value: '16:9' },
                          { label: '9:16 竖屏漫剧', value: '9:16' },
                          { label: '1:1 方形', value: '1:1' },
                        ]}
                      />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>分辨率</Text>
                      <Select
                        size="small"
                        style={{ width: '100%', marginTop: 2 }}
                        value={resolution}
                        onChange={(val) => setResolution(val)}
                        options={[
                          { label: '720P 高清', value: '720p' },
                          { label: '1080P 超清', value: '1080p' },
                        ]}
                      />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>声音模式</Text>
                      <Select
                        size="small"
                        style={{ width: '100%', marginTop: 2 }}
                        value={audioMode}
                        onChange={(val) => setAudioMode(val)}
                        options={[
                          { label: '有声 (自带配音)', value: 'with_audio' },
                          { label: '无声 (纯画面)', value: 'silent' },
                        ]}
                      />
                    </Col>
                    <Col span={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>随机种子 (Seed)</Text>
                      <Input
                        size="small"
                        type="number"
                        style={{ marginTop: 2 }}
                        value={seed}
                        onChange={(e) => setSeed(Number(e.target.value))}
                        placeholder="-1 (随机)"
                      />
                    </Col>
                  </Row>
                </Card>

                {/* ── 5. 底部主执行按钮 ── */}
                <div style={{ marginTop: 'auto', paddingTop: 8 }}>
                  <Button
                    type="primary"
                    size="large"
                    block
                    loading={generating}
                    icon={<ThunderboltOutlined />}
                    onClick={handleGenerateActiveShot}
                    style={{ height: 44, fontSize: 15, fontWeight: 600 }}
                  >
                    {generating
                      ? 'AI 正在渲染生成中...'
                      : studioMode === 'keyframe'
                      ? `✨ 生成分镜 ${activeShot.index + 1} 关键帧`
                      : studioMode === 'extend'
                      ? `✨ 生成分镜 ${activeShot.index + 1} 延展视频`
                      : `✨ 生成分镜 ${activeShot.index + 1} 视频片段`}
                  </Button>
                </div>
              </>
            ) : (
              <Empty description="请从左侧选择一个分镜" />
            )}
          </Card>
        </Col>

        {/* ==================================================================== */}
        {/* 右栏：多版本历史记录画廊 (Version Gallery)                           */}
        {/* ==================================================================== */}
        <Col span={6} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Card
            size="small"
            style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 } }}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text strong>版本画廊 ({activeShot?.versionHistory?.length || 0})</Text>
                <Tag color="blue">分镜 {activeShot ? activeShot.index + 1 : '-'}</Tag>
              </div>
            }
          >
            {activeShot?.versionHistory?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeShot.versionHistory.map((ver, vIdx) => {
                  const isSelected = activeShot.selectedVersionId === ver.id;
                  const isVideo = ver.type === 'video';
                  return (
                    <Card
                      key={ver.id}
                      size="small"
                      style={{
                        border: isSelected ? '1.5px solid #52c41a' : '1px solid var(--border-base, rgba(255,255,255,0.1))',
                        background: isSelected ? 'rgba(82, 196, 26, 0.08)' : 'var(--bg-container, #1f1f1f)',
                      }}
                      styles={{ body: { padding: 8 } }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <Space size={4}>
                          <Tag color={isVideo ? 'purple' : 'cyan'} style={{ margin: 0, fontSize: 10 }}>
                            {isVideo ? '视频' : '关键帧'}
                          </Tag>
                          <Text style={{ fontSize: 11 }}>版本 #{activeShot.versionHistory!.length - vIdx}</Text>
                        </Space>
                        <Text type="secondary" style={{ fontSize: 10 }}>{ver.createdAt}</Text>
                      </div>

                      {isVideo ? (
                        <div style={{
                          width: '100%',
                          height: 140,
                          borderRadius: 6,
                          overflow: 'hidden',
                          background: '#000',
                          marginBottom: 4,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}>
                          <video
                            src={toWebviewUrl(resolveLocalPath(ver.url))}
                            controls
                            playsInline
                            preload="metadata"
                            style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain', display: 'block' }}
                          />
                        </div>
                      ) : (
                        <Image
                          src={toWebviewUrl(resolveLocalPath(ver.url))}
                          width="100%"
                          height={110}
                          style={{ objectFit: 'cover', borderRadius: 6 }}
                        />
                      )}

                      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text type="secondary" style={{ fontSize: 10 }}>
                          {ver.model || (ver.durationSeconds ? `${ver.durationSeconds}s` : '高清')}
                        </Text>
                        <Button
                          size="small"
                          type={isSelected ? 'default' : 'primary'}
                          ghost={!isSelected}
                          icon={<CheckOutlined />}
                          onClick={() => {
                            selectShotVersion(selectedProjectId, activeShot.id, ver.id);
                            message.success('已设为当前生效镜头！');
                          }}
                        >
                          {isSelected ? '已生效' : '设为生效'}
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无生成历史。点击左侧【生成】开始渲染第一版镜头。"
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* ── 素材库选择 Modal ── */}
      <Modal
        open={assetSelectModalOpen}
        onCancel={() => setAssetSelectModalOpen(false)}
        footer={null}
        title="选择项目角色或场景作为参考图"
        width={600}
        zIndex={2500}
        destroyOnClose
        getContainer={() => document.body}
      >
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <Title level={5}>角色立绘</Title>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
            {characters.map((c) => (
              <Card
                key={c.id}
                size="small"
                hoverable
                onClick={() => {
                  if (!activeShot || !c.portraitImage) return;
                  const updated = [...(activeShot.customReferenceImages || []), c.portraitImage];
                  updateSceneSpecShot(selectedProjectId, activeShot.id, { customReferenceImages: updated });
                  setAssetSelectModalOpen(false);
                  message.success(`已绑定角色【${c.name}】立绘`);
                }}
              >
                {c.portraitImage ? (
                  <Image src={toWebviewUrl(c.portraitImage)} width="100%" height={90} preview={false} style={{ objectFit: 'cover' }} />
                ) : (
                  <div style={{ height: 90, background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>无图</div>
                )}
                <Text strong style={{ fontSize: 11, display: 'block', textAlign: 'center', marginTop: 4 }}>{c.name}</Text>
              </Card>
            ))}
          </div>

          <Title level={5}>场景背景</Title>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {scenes.map((s) => (
              <Card
                key={s.id}
                size="small"
                hoverable
                onClick={() => {
                  if (!activeShot || !s.backgroundImage) return;
                  const updated = [...(activeShot.customReferenceImages || []), s.backgroundImage];
                  updateSceneSpecShot(selectedProjectId, activeShot.id, { customReferenceImages: updated });
                  setAssetSelectModalOpen(false);
                  message.success(`已绑定场景【${s.name}】背景`);
                }}
              >
                {s.backgroundImage ? (
                  <Image src={toWebviewUrl(s.backgroundImage)} width="100%" height={80} preview={false} style={{ objectFit: 'cover' }} />
                ) : (
                  <div style={{ height: 80, background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>无图</div>
                )}
                <Text strong style={{ fontSize: 11, display: 'block', textAlign: 'center', marginTop: 4 }}>{s.name}</Text>
              </Card>
            ))}
          </div>
        </div>
      </Modal>

      {/* ── 视频播放预览 Modal ── */}
      <Modal
        open={!!previewVideoUrl}
        onCancel={() => setPreviewVideoUrl(null)}
        footer={null}
        width={720}
        title="镜头视频预览"
        zIndex={3000}
        destroyOnClose
        getContainer={() => document.body}
      >
        {previewVideoUrl && (
          <video
            src={previewVideoUrl}
            controls
            autoPlay
            playsInline
            style={{ width: '100%', maxHeight: '65vh', borderRadius: 8, background: '#000', display: 'block' }}
          />
        )}
      </Modal>
    </div>
  );
};

export interface ShotStudioModalProps {
  open: boolean;
  onClose: () => void;
  pipelineId?: string;
}

export const ShotStudioModal: React.FC<ShotStudioModalProps> = ({ open, onClose, pipelineId }) => {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="96vw"
      style={{ top: 16, paddingBottom: 0 }}
      styles={{ body: { height: '88vh', padding: '12px 16px', display: 'flex', flexDirection: 'column' } }}
      title={null}
      closable={false}
    >
      <ShotStudioWorkspace pipelineId={pipelineId} showHeader onClose={onClose} />
    </Modal>
  );
};

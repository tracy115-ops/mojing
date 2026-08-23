// ============================================================================
// VideoPipelinePanel.tsx — 工业级 AI 漫剧人机协同创作工作台 (Studio Architecture)
// ============================================================================
// 人机协同核心哲学 (Human-in-the-Loop & Smart Automation):
//   1. 自动化 (Automation): 剧本切词、提示词增强、批量生图生视频、音频混流、字幕对齐与合成
//   2. 人工介入门禁 (Human Checkpoints / Gates):
//      - Gate 1: 📝 剧本分镜门禁 — 检查/微调景别、运镜、台词与镜头时长
//      - Gate 2: 🎨 角色场景门禁 — 确认正面立绘/三视图、试听挑选音色、锁定 Seed
//      - Gate 3: 🎬 分镜精修门禁 — 单镜提示词分秒重构、运镜预设、TTS试听、多版本画廊
//      - Gate 4: 🎞️ 多轨成片门禁 — 实时播放器、多轨剪辑、BGM音量平衡、4K导出
// ============================================================================

import React, { useState, useMemo, useRef } from 'react';
import {
  Typography, Tag, Card, Empty, Button, Space,
  Popconfirm, Tooltip, Input, message, Modal, Image,
  Drawer, Progress, Segmented, Row, Col, Select, InputNumber,
  Divider, Upload, Spin, Alert,
} from 'antd';
import {
  PlayCircleOutlined, StopOutlined, DownloadOutlined, ReloadOutlined,
  DeleteOutlined, SettingOutlined, PlusOutlined, ProfileOutlined,
  SoundOutlined, LockOutlined, UnlockOutlined, UploadOutlined,
  CheckCircleOutlined, ArrowRightOutlined, EditOutlined, CopyOutlined,
  EyeOutlined, VideoCameraOutlined, RocketOutlined, LoadingOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import type { VideoStage, StoryboardShot, CharacterAnchor, SceneAnchor, AspectRatio, ShotSpec } from '@/types/video';
import type { VideoMetadata } from '@/types';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES } from '@/types/video';
import { renderStageContent } from './StageArtifactsModal';
import ExportVideoModal from './ExportVideoModal';
import VideoPromptSettingsModal from './VideoPromptSettingsModal';
import { ShotStudioWorkspace } from './ShotStudioModal';
import { VideoTimelineWorkspace } from './VideoTimelineDrawer';
import { runFromFirstFailedStage, runFromStage, abortPipeline } from '@/services/video/core/pipeline-runner';
import { RUNTIME_STAGE_ORDER } from '@/services/video/core/stage-handlers';
import { toWebviewUrl, saveAsset } from '@/services/video/asset-store';
import { generateSingleCharacterPortrait, generateSingleCharacterTurnaround } from '@/services/video/core/step-character-anchor';
import { generateSingleSceneImage } from '@/services/video/core/step-scene-image';
import { generateSingleTTS } from '@/services/video/core/step-tts';

const { Text, Title, Paragraph } = Typography;

export type StudioPhase = 'script' | 'assets' | 'studio' | 'timeline';

export const STAGE_NAMES_ZH: Record<string, string> = {
  script_slicing: '📝 剧本智能切片与分镜规划',
  storyboard_prompt: '✨ 分镜提示词工业级增强',
  extraction: '🔍 角色与场景资产提取',
  character_anchor: '🎨 角色正面立绘与三视图生成',
  scene_image: '🏞️ 场景环境背景图生成',
  voice_assignment: '🎙️ 智能角色音色分配',
  tts: '🗣️ 台词配音与旁白合成',
  keyframe_image: '🖼️ 分镜关键帧生成与参考图对齐',
  video_generation: '🎬 AI 视频片段分镜渲染',
  audio_merge: '🎚️ 视频与配音音视融合',
  composing: '🎞️ 多轨剪辑与最终成片导出',
};

// 常用高质量推荐音色库
export const VOICE_PRESETS = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 甜美少女 (温暖亲切/解说推荐)', gender: 'female' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼萝莉 (萌系/童声)', gender: 'female' },
  { value: 'zh-CN-YunxiNeural', label: '云希 · 阳光青年 (男主/活力清脆)', gender: 'male' },
  { value: 'zh-CN-YunyangNeural', label: '云扬 · 沉稳大气 (旁白/老僧/大叔)', gender: 'male' },
  { value: 'zh-CN-YunjianNeural', label: '云健 · 磁性总裁 (冷峻/力量感)', gender: 'male' },
  { value: 'zh-CN-XiaohanNeural', label: '晓涵 · 情感细腻 (忧郁/唯美叙事)', gender: 'female' },
  { value: 'zh-CN-XiaomengNeural', label: '晓梦 · 温柔御姐 (成熟知性)', gender: 'female' },
];

export const VideoPipelinePanel: React.FC<{ pipelineId?: string }> = ({ pipelineId: propPipelineId }) => {
  const { t } = useTranslation();
  const activePipelineId = useVideoStore((s) => s.activePipelineId);
  const pipelineId = propPipelineId || activePipelineId;

  const project = useVideoStore((s) => (pipelineId ? s.projects[pipelineId] : undefined));
  const stages = project?.stages;
  const currentStage = project?.currentStage;
  const errorMsg = project?.error;
  const sceneSpec = project?.sceneSpec;
  const shots = project?.sceneSpec?.shots || [];
  const characters = project?.sceneSpec?.characters || [];
  const scenes = project?.sceneSpec?.scenes || [];
  const clips = project?.clips || [];
  const finalVideoUrl = project?.finalVideoUrl;

  const updateSceneSpecShot = useVideoStore((s) => s.updateSceneSpecShot);
  const addSceneSpecShot = useVideoStore((s) => s.addSceneSpecShot);
  const deleteSceneSpecShot = useVideoStore((s) => s.deleteSceneSpecShot);
  const updateSceneSpecCharacter = useVideoStore((s) => s.updateSceneSpecCharacter);
  const updateSceneSpecScene = useVideoStore((s) => s.updateSceneSpecScene);

  // 4 大核心创作阶段切换
  const [activePhase, setActivePhase] = useState<StudioPhase>('script');

  // 弹窗与抽屉状态
  const [exportOpen, setExportOpen] = useState(false);
  const [promptSettingsOpen, setPromptSettingsOpen] = useState(false);
  const [logsDrawerOpen, setLogsDrawerOpen] = useState(false);

  // 分镜编辑状态
  const [addShotModalOpen, setAddShotModalOpen] = useState(false);
  const [newShotPrompt, setNewShotPrompt] = useState('');

  // 单角色/单场景生成加载状态
  const [busyCharId, setBusyCharId] = useState<string | null>(null);
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // 系列项目信息
  const novelTitle = useProjectStore((s) => {
    if (!pipelineId || !project) return undefined;
    if (pipelineId.startsWith('direct_')) return undefined;
    const np = s.projects.find((p) => p.id === pipelineId);
    return np?.title;
  });

  const headerLabel = useMemo(() => {
    if (!project) return '';
    if (pipelineId?.startsWith('direct_')) {
      return project.title || t('video.pipeline.directLabel');
    }
    if (novelTitle) return t('video.pipeline.fromNovelLabel', { title: novelTitle });
    return t('video.pipeline.title');
  }, [project, pipelineId, novelTitle, t]);

  // 整体状态与实时工序计算
  const overall: 'idle' | 'running' | 'complete' | 'error' = (() => {
    if (currentStage === 'complete') return 'complete';
    if (currentStage === 'error' || errorMsg) return 'error';
    if (currentStage === 'idle' || !currentStage) return 'idle';
    const stageState = stages?.[currentStage];
    if (!stageState) return 'idle';
    if (stageState.status === 'running') return 'running';
    if (stageState.status === 'error') return 'error';
    return 'idle';
  })();
  const statusColor = { idle: 'default', running: 'processing', complete: 'success', error: 'error' }[overall];
  const statusLabel = t(`video.pipeline.status.${overall}`);

  const isRunning = overall === 'running';
  const runningStage = isRunning && currentStage && stages?.[currentStage]?.status === 'running' ? currentStage : undefined;
  const runningStageName = runningStage ? (STAGE_NAMES_ZH[runningStage] || runningStage) : '';
  const currentStageState = runningStage ? stages?.[runningStage] : undefined;
  const currentStageSummary = currentStageState?.inputSummary?.headline || currentStageState?.error || '';
  const currentStageProgressNum = typeof currentStageState?.progress === 'number' 
    ? Math.round(currentStageState.progress * 100) 
    : 0;

  // 各大阶段实时运行态判定
  const isPhase1Running = isRunning && (currentStage === 'script_slicing' || currentStage === 'storyboard_prompt' || currentStage === 'extraction');
  const isPhase2Running = isRunning && (currentStage === 'character_anchor' || currentStage === 'scene_image' || currentStage === 'voice_assignment');
  const isPhase3Running = isRunning && (currentStage === 'keyframe_image' || currentStage === 'tts');
  const isPhase4Running = isRunning && (currentStage === 'video_generation' || currentStage === 'audio_merge' || currentStage === 'composing');

  // 步骤完成统计
  const visibleStages = VIDEO_PIPELINE_STAGES.filter((s) => !DEFAULT_SKIPPED_STAGES.has(s));
  const completedStages = visibleStages.filter((s) => stages?.[s]?.status === 'completed');
  const progressPercent = Math.round((completedStages.length / visibleStages.length) * 100);

  // 4 个阶段完成度计算
  const phase1Done = shots.length > 0;
  const phase2Done = characters.length > 0 && characters.every((c) => !!c.portraitImage);
  const phase3Done = shots.length > 0 && shots.every((s) => !!s.keyframeImage);
  const phase4Done = !!finalVideoUrl;

  if (!pipelineId || !project) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description={t('video.pipeline.empty')} />
      </div>
    );
  }

  // --- 处理追加新镜头 ---
  const handleAddShotConfirm = () => {
    if (!newShotPrompt.trim()) {
      message.warning('请输入镜头描述');
      return;
    }
    addSceneSpecShot(pipelineId, {
      videoPrompt: newShotPrompt.trim(),
      sourceText: newShotPrompt.trim(),
      durationSeconds: 5,
      cameraMovement: 'static',
      characters: [],
      characterIds: [],
    });
    setNewShotPrompt('');
    setAddShotModalOpen(false);
    message.success('已追加新分镜！');
  };

  // --- 处理复制镜头 ---
  const handleDuplicateShot = (shot: ShotSpec) => {
    addSceneSpecShot(pipelineId, {
      videoPrompt: `${shot.videoPrompt} (副本)`,
      sourceText: shot.sourceText || shot.videoPrompt || '',
      durationSeconds: (shot.durationSeconds || 5) as any,
      cameraMovement: shot.cameraMovement || 'static',
      location: shot.location,
      characters: [],
      characterIds: [...(shot.characterIds || [])],
      narration: shot.narration,
    });
    message.success(`已复制分镜 #${shot.index + 1}`);
  };

  // --- 试听音色 ---
  const handlePreviewVoice = (voiceId: string) => {
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance('你好，我是 AI 漫剧配音，当前音色已成功匹配。');
        utterance.lang = 'zh-CN';
        utterance.rate = 1.0;
        window.speechSynthesis.speak(utterance);
        setPlayingVoice(voiceId);
        utterance.onend = () => setPlayingVoice(null);
        utterance.onerror = () => setPlayingVoice(null);
      } else {
        message.info(`已选中音色: ${voiceId}`);
      }
    } catch {
      message.info(`已选中音色: ${voiceId}`);
    }
  };

  // --- 单角色：重新生成正面立绘 ---
  const handleRegenCharPortrait = async (char: CharacterAnchor) => {
    setBusyCharId(char.id);
    try {
      message.loading(`正在重新生成【${char.name}】正面立绘...`, 2.5);
      const newPath = await generateSingleCharacterPortrait(char, characters, {
        style: project.spec?.style,
        imageTier: project.spec?.imageTier,
        novelProjectId: pipelineId,
      });
      updateSceneSpecCharacter(pipelineId, char.id, { portraitImage: newPath });
      message.success(`【${char.name}】正面立绘生成成功！`);
    } catch (err) {
      message.error(`立绘生成失败: ${String(err)}`);
    } finally {
      setBusyCharId(null);
    }
  };

  // --- 单角色：重新生成三视图 ---
  const handleRegenCharTurnaround = async (char: CharacterAnchor) => {
    setBusyCharId(char.id);
    try {
      message.loading(`正在基于正面立绘生成【${char.name}】正/侧/背三视图...`, 3.0);
      const newPath = await generateSingleCharacterTurnaround(char, {
        style: project.spec?.style,
        imageTier: project.spec?.imageTier,
        novelProjectId: pipelineId,
      });
      updateSceneSpecCharacter(pipelineId, char.id, { turnaroundImage: newPath });
      message.success(`【${char.name}】三视图生成成功！`);
    } catch (err) {
      message.error(`三视图生成失败: ${String(err)}`);
    } finally {
      setBusyCharId(null);
    }
  };

  // --- 单角色：上传自定义立绘 ---
  const handleUploadCharPortrait = async (char: CharacterAnchor, file: File) => {
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        const savedPath = await saveAsset(pipelineId, 'portrait', base64, `custom_${char.id}_${Date.now()}`);
        updateSceneSpecCharacter(pipelineId, char.id, { portraitImage: savedPath });
        message.success(`【${char.name}】自定义参考图已生效！`);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      message.error(`上传失败: ${String(err)}`);
    }
    return false;
  };

  // --- 单场景：重新生成背景图 ---
  const handleRegenSceneBg = async (scene: SceneAnchor) => {
    setBusySceneId(scene.id);
    try {
      message.loading(`正在重新生成【${scene.name}】场景背景图...`, 2.5);
      const newPath = await generateSingleSceneImage(scene, {
        aspectRatio: project.spec?.aspectRatio as AspectRatio,
        style: project.spec?.style,
        imageTier: project.spec?.imageTier,
        novelProjectId: pipelineId,
      });
      updateSceneSpecScene(pipelineId, scene.id, { backgroundImage: newPath });
      message.success(`【${scene.name}】场景背景图生成成功！`);
    } catch (err) {
      message.error(`场景生成失败: ${String(err)}`);
    } finally {
      setBusySceneId(null);
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-layout, #0f172a)', overflow: 'hidden' }}>
      <audio ref={audioPreviewRef} style={{ display: 'none' }} />

      {/* ==================================================================== */}
      {/* 1. 顶栏：工作室全局导航与向导式阶段选择器 (Studio Stepper Header)     */}
      {/* ==================================================================== */}
      <div style={{
        padding: '8px 16px',
        background: 'var(--bg-container, #1e293b)',
        borderBottom: '1px solid var(--border-base, rgba(255,255,255,0.1))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        flexShrink: 0,
      }}>
        {/* 左侧：工程标题与全局进度 */}
        <Space size="middle" align="center">
          <Title level={5} style={{ margin: 0, color: 'var(--text-primary, #fff)', fontWeight: 600 }}>
            {headerLabel}
          </Title>
          <Tag color={statusColor}>{statusLabel}</Tag>
          <Tooltip title={`总工序进度: 已完成 ${completedStages.length}/${visibleStages.length} 步骤`}>
            <div style={{ width: 90, display: 'flex', alignItems: 'center' }}>
              <Progress percent={progressPercent} size="small" showInfo={false} strokeColor="#3b82f6" />
            </div>
          </Tooltip>
        </Space>

        {/* 中间：4 大阶段导航胶囊 (带有清晰状态 Badge 与实时运行旋转态) */}
        <Segmented
          value={activePhase}
          onChange={(val) => setActivePhase(val as StudioPhase)}
          options={[
            {
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>📝 1. 剧本分镜</span>
                  {isPhase1Running ? (
                    <LoadingOutlined spin style={{ color: '#38bdf8', fontSize: 12 }} />
                  ) : phase1Done ? (
                    <CheckCircleOutlined style={{ color: '#10b981', fontSize: 12 }} />
                  ) : null}
                </span>
              ),
              value: 'script',
            },
            {
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>🎨 2. 角色场景</span>
                  {isPhase2Running ? (
                    <LoadingOutlined spin style={{ color: '#38bdf8', fontSize: 12 }} />
                  ) : phase2Done ? (
                    <CheckCircleOutlined style={{ color: '#10b981', fontSize: 12 }} />
                  ) : characters.length > 0 ? (
                    <Tag color="warning" style={{ fontSize: 9, lineHeight: '14px', padding: '0 3px', margin: 0 }}>待确认</Tag>
                  ) : null}
                </span>
              ),
              value: 'assets',
            },
            {
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>🎬 3. 分镜精修</span>
                  {isPhase3Running ? (
                    <LoadingOutlined spin style={{ color: '#38bdf8', fontSize: 12 }} />
                  ) : phase3Done ? (
                    <CheckCircleOutlined style={{ color: '#10b981', fontSize: 12 }} />
                  ) : null}
                </span>
              ),
              value: 'studio',
            },
            {
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>🎞️ 4. 多轨成片</span>
                  {isPhase4Running ? (
                    <LoadingOutlined spin style={{ color: '#38bdf8', fontSize: 12 }} />
                  ) : phase4Done ? (
                    <CheckCircleOutlined style={{ color: '#10b981', fontSize: 12 }} />
                  ) : null}
                </span>
              ),
              value: 'timeline',
            },
          ]}
          style={{
            background: 'rgba(0,0,0,0.3)',
            padding: 3,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.1)',
            fontWeight: 500,
          }}
        />

        {/* 右侧：智能导引主按钮 + 全自动成片 + 工具箱 */}
        <Space size="small">
          {/* 智能主按钮：根据当前阶段给予最直接的下一步导引 */}
          {activePhase === 'script' && (
            shots.length === 0 ? (
              <Button
                type="primary"
                size="small"
                loading={isPhase1Running}
                icon={<PlayCircleOutlined />}
                onClick={async () => {
                  message.loading('AI 正在智能切片剧本并提取分镜大纲...', 2.0);
                  await runFromStage(pipelineId, 'script_slicing');
                }}
                style={{ background: 'linear-gradient(135deg, #1677ff 0%, #722ed1 100%)', border: 'none' }}
              >
                {isPhase1Running ? 'AI 正在切片分镜...' : '✨ AI 智能切片分镜'}
              </Button>
            ) : (
              <Button
                type="primary"
                size="small"
                icon={<ArrowRightOutlined />}
                onClick={() => setActivePhase('assets')}
                style={{ background: '#10b981', borderColor: '#10b981' }}
              >
                👉 确认分镜，下一步：角色与场景
              </Button>
            )
          )}

          {activePhase === 'assets' && (
            !phase2Done ? (
              <Button
                type="primary"
                size="small"
                loading={isPhase2Running}
                icon={<ReloadOutlined />}
                onClick={async () => {
                  message.loading('正在批量生成全套角色立绘与场景图...', 2.0);
                  await runFromStage(pipelineId, 'character_anchor');
                }}
                style={{ background: 'linear-gradient(135deg, #1677ff 0%, #722ed1 100%)', border: 'none' }}
              >
                {isPhase2Running ? '正在批量生成立绘与场景...' : '🎨 批量生成立绘与三视图'}
              </Button>
            ) : (
              <Button
                type="primary"
                size="small"
                icon={<ArrowRightOutlined />}
                onClick={() => setActivePhase('studio')}
                style={{ background: '#10b981', borderColor: '#10b981' }}
              >
                🔒 锁定形象，下一步：分镜精修
              </Button>
            )
          )}

          {activePhase === 'studio' && (
            !phase3Done ? (
              <Button
                type="primary"
                size="small"
                loading={isPhase3Running}
                icon={<PlayCircleOutlined />}
                onClick={async () => {
                  message.loading('正在批量生成关键帧与配音...', 2.0);
                  await runFromStage(pipelineId, 'keyframe_image');
                }}
                style={{ background: 'linear-gradient(135deg, #1677ff 0%, #722ed1 100%)', border: 'none' }}
              >
                {isPhase3Running ? '正在批量生成关键帧/配音...' : '🖼️ 批量生成关键帧与配音'}
              </Button>
            ) : (
              <Space size={8}>
                <Button
                  type="primary"
                  size="small"
                  icon={<RocketOutlined />}
                  loading={isPhase4Running}
                  onClick={async () => {
                    setActivePhase('timeline');
                    message.loading('正在批量渲染分镜视频并合成成片...', 2.0);
                    await runFromStage(pipelineId, 'video_generation');
                  }}
                  style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', border: 'none' }}
                >
                  {isPhase4Running ? '正在渲染视频与合成成片...' : '🎬 批量渲染分镜视频并合成成片'}
                </Button>
                <Button
                  size="small"
                  icon={<ArrowRightOutlined />}
                  onClick={() => setActivePhase('timeline')}
                >
                  🎞️ 多轨剪辑台
                </Button>
              </Space>
            )
          )}

          {activePhase === 'timeline' && (
            finalVideoUrl ? (
              <Space size={8}>
                <Button
                  type="primary"
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={() => setExportOpen(true)}
                  style={{ background: '#10b981', borderColor: '#10b981' }}
                >
                  📦 导出成片 MP4
                </Button>
              </Space>
            ) : (
              <Button
                type="primary"
                size="small"
                icon={<RocketOutlined />}
                loading={isPhase4Running}
                onClick={async () => {
                  message.loading('正在批量渲染分镜视频并合成最终成片...', 2.0);
                  await runFromStage(pipelineId, 'video_generation');
                }}
                style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', border: 'none' }}
              >
                {isPhase4Running ? '正在渲染分镜与合成成片...' : '🎬 一键渲染视频并合成成片'}
              </Button>
            )
          )}

          {/* 全自动一键生成 (Auto-Pilot) */}
          <Tooltip title="一键全流程无人值守自动生成：自动切片 -> 生成立绘 -> 生成分镜视频 -> 混音成片">
            <Button
              size="small"
              icon={<RocketOutlined />}
              loading={isRunning}
              onClick={async () => {
                message.loading('正在启动全流程全自动生成...', 1.5);
                const firstStage = RUNTIME_STAGE_ORDER[0] || 'script_slicing';
                await runFromStage(pipelineId, firstStage);
              }}
            >
              一键全自动
            </Button>
          </Tooltip>

          {isRunning && (
            <Popconfirm
              title="确定要立即强行终止当前生成流程吗？"
              onConfirm={() => {
                abortPipeline(pipelineId);
                message.warning('已强行终止生成任务');
              }}
            >
              <Button type="primary" danger size="small" icon={<StopOutlined />}>
                终止
              </Button>
            </Popconfirm>
          )}

          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={() => setPromptSettingsOpen(true)}
          >
            预设
          </Button>
        </Space>
      </div>

      {/* ── 全局实时生成进度动态横幅 (Live Execution Status Banner) ── */}
      {isRunning && (
        <div style={{
          padding: '8px 16px',
          background: 'linear-gradient(90deg, rgba(14, 116, 144, 0.25) 0%, rgba(88, 28, 135, 0.25) 100%)',
          borderBottom: '1px solid rgba(56, 189, 248, 0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          flexShrink: 0,
        }}>
          <Space size="middle" align="center">
            <Spin indicator={<LoadingOutlined style={{ fontSize: 18, color: '#38bdf8' }} spin />} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Text strong style={{ fontSize: 13, color: '#38bdf8' }}>
                  ⚙️ 正在执行工序：【{runningStageName}】
                </Text>
                {currentStageProgressNum > 0 && (
                  <Tag color="cyan" style={{ fontSize: 11, margin: 0, fontWeight: 600 }}>{currentStageProgressNum}%</Tag>
                )}
              </div>
              {currentStageSummary && (
                <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', display: 'block', marginTop: 2 }}>
                  {currentStageSummary}
                </Text>
              )}
            </div>
          </Space>

          <Space size="middle" align="center">
            <div style={{ width: 160 }}>
              <Progress
                percent={currentStageProgressNum || 40}
                status="active"
                size="small"
                strokeColor={{ '0%': '#1677ff', '100%': '#38bdf8' }}
              />
            </div>
            <Popconfirm
              title="确定要强行终止当前生成吗？"
              onConfirm={() => {
                abortPipeline(pipelineId);
                message.warning('已强行终止生成任务');
              }}
            >
              <Button size="small" danger type="primary" icon={<StopOutlined />}>
                终止生成
              </Button>
            </Popconfirm>
          </Space>
        </div>
      )}

      {/* ==================================================================== */}
      {/* 2. 主画板区：根据当前选中的阶段展示对应工作台                       */}
      {/* ==================================================================== */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: activePhase === 'studio' || activePhase === 'timeline' ? 0 : 16 }}>
        {/* ── Phase 1: 📝 剧本与分镜大纲 (人机协同检查门禁 1) ── */}
        {activePhase === 'script' && (
          <div style={{ height: '100%', minHeight: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {isPhase1Running && (
              <Alert
                type="info"
                showIcon
                icon={<LoadingOutlined spin style={{ color: '#38bdf8', fontSize: 16 }} />}
                message="AI 正在深度切片原著章节、规划分镜时长并提取登场角色与场景..."
                description={currentStageSummary || '正在执行剧本语义切词与分镜提示词工业级增强，分镜生成后将自动呈现于下方列表。'}
                style={{ background: 'rgba(14, 116, 144, 0.15)', borderColor: 'rgba(56, 189, 248, 0.3)' }}
              />
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: 16 }}>
              {/* 左侧：小说与剧本文本预览与切片 */}
              <Card
                size="small"
                title="📄 原始小说与剧本文本"
              extra={
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<ReloadOutlined />}
                  onClick={async () => {
                    message.loading('正在重新切片分镜...', 1.5);
                    await runFromStage(pipelineId, 'script_slicing');
                  }}
                >
                  AI 重新切片
                </Button>
              }
              style={{ height: '100%', minHeight: 480, display: 'flex', flexDirection: 'column' }}
              styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 12 } }}
            >
              <div style={{ marginBottom: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                分镜切片将依据下方剧本提取动作、台词与场景切换：
              </div>
              <Input.TextArea
                value={sceneSpec?.shots?.map((s) => s.sourceText || s.videoPrompt).join('\n\n') || ''}
                readOnly
                placeholder="本集小说段落或剧本文本..."
                style={{ flex: 1, minHeight: 120, resize: 'none', lineHeight: 1.8, fontSize: 13, background: 'rgba(0,0,0,0.2)' }}
              />
            </Card>

            {/* 右侧：结构化分镜卡片流 (支持景别、运镜、台词行内快速修改) */}
            <Card
              size="small"
              title={`🎬 镜头大纲清单 (${shots.length} 镜) · 人工审核与微调`}
              extra={
                <Space>
                  <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddShotModalOpen(true)}>
                    追加分镜
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<ArrowRightOutlined />}
                    onClick={() => setActivePhase('assets')}
                    style={{ background: '#10b981', borderColor: '#10b981' }}
                  >
                    确认分镜，下一步
                  </Button>
                </Space>
              }
              style={{ height: '100%', minHeight: 480, display: 'flex', flexDirection: 'column' }}
              styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 } }}
            >
              {shots.length === 0 ? (
                <Empty description="暂无切片镜头，请点击左上方【AI 重新切片】或右上角【追加分镜】" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {shots.map((s, idx) => (
                    <Card
                      key={s.id}
                      size="small"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
                      styles={{ body: { padding: '10px 14px' } }}
                    >
                      {/* 顶排：序号、景别、运镜、时长、场景 */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <Space size={6} wrap>
                          <Tag color="blue" style={{ fontWeight: 600 }}>镜头 #{idx + 1}</Tag>

                          {/* 运镜与景别选择 */}
                          <Select
                            size="small"
                            value={s.cameraMovement || 'static'}
                            onChange={(val) => updateSceneSpecShot(pipelineId, s.id, { cameraMovement: val })}
                            style={{ width: 130 }}
                            options={[
                              { label: '🎬 定镜 (Static)', value: 'static' },
                              { label: '🔍 特写推镜 (Push in)', value: 'zoom_in' },
                              { label: '🔭 全景拉镜 (Pull out)', value: 'zoom_out' },
                              { label: '🏃 跟随运镜 (Follow)', value: 'pan_right' },
                              { label: '🔄 360°环绕 (Orbit)', value: 'orbit' },
                            ]}
                          />

                          {/* 时长 */}
                          <Space size={2}>
                            <InputNumber
                              size="small"
                              min={2}
                              max={12}
                              value={s.durationSeconds || 5}
                              onChange={(val) => updateSceneSpecShot(pipelineId, s.id, { durationSeconds: (val || 5) as any })}
                              style={{ width: 55 }}
                            />
                            <Text style={{ fontSize: 11 }}>秒</Text>
                          </Space>

                          <Tag color="purple">{s.location || '默认场景'}</Tag>
                        </Space>

                        {/* 操作栏 */}
                        <Space size="small">
                          <Tooltip title="复制该镜头">
                            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => handleDuplicateShot(s)} />
                          </Tooltip>
                          <Tooltip title="删除该镜头">
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => deleteSceneSpecShot(pipelineId, s.id)} />
                          </Tooltip>
                        </Space>
                      </div>

                      {/* 画面描述 (Prompt) */}
                      <Input.TextArea
                        rows={2}
                        value={s.videoPrompt || s.sourceText}
                        onChange={(e) => updateSceneSpecShot(pipelineId, s.id, { videoPrompt: e.target.value })}
                        placeholder="镜头画面描述与人物动作..."
                        style={{ fontSize: 12, marginBottom: 6, resize: 'none' }}
                      />

                      {/* 台词与说话人 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Tag color="green" style={{ margin: 0, fontSize: 11 }}>🗣️ 台词对白</Tag>
                        <Input
                          size="small"
                          value={s.narration || ''}
                          onChange={(e) => updateSceneSpecShot(pipelineId, s.id, { narration: e.target.value })}
                          placeholder="输入台词或旁白（为空则为纯画面）..."
                          style={{ flex: 1, fontSize: 12 }}
                        />
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </Card>
          </div>
          </div>
        )}

        {/* ── Phase 2: 🎨 角色与场景资产设定 (人机协同核心质量门禁 2) ── */}
        {activePhase === 'assets' && (
          <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
            {/* 角色一致性资产库 */}
            <Card
              size="small"
              title={`👥 角色一致性资产库 (${characters.length} 位角色) · 形象与音色确认门禁`}
              extra={
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<ReloadOutlined />}
                    onClick={async () => {
                      message.loading('正在批量生成角色三视图...', 1.5);
                      await runFromStage(pipelineId, 'character_anchor');
                    }}
                  >
                    批量重新生成立绘
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<ArrowRightOutlined />}
                    onClick={() => setActivePhase('studio')}
                    style={{ background: '#10b981', borderColor: '#10b981' }}
                  >
                    锁定形象，进入分镜精修
                  </Button>
                </Space>
              }
            >
              {characters.length === 0 ? (
                <Empty description="暂无角色资产，请先在阶段一完成【剧本切片】" />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 14 }}>
                  {characters.map((char) => (
                    <Card
                      key={char.id}
                      size="small"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)' }}
                      styles={{ body: { padding: 12 } }}
                    >
                      <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                        {/* 左侧：正面立绘 */}
                        <div style={{ width: 95, height: 130, borderRadius: 6, overflow: 'hidden', background: '#181818', flexShrink: 0, position: 'relative' }}>
                          {char.portraitImage ? (
                            <Image src={toWebviewUrl(char.portraitImage)} width={95} height={130} style={{ objectFit: 'cover' }} />
                          ) : (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#38bdf8', gap: 6, padding: 4, textAlign: 'center' }}>
                              {isPhase2Running ? (
                                <>
                                  <Spin size="small" indicator={<LoadingOutlined spin style={{ color: '#38bdf8' }} />} />
                                  <span style={{ fontSize: 10 }}>生成立绘中...</span>
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-secondary)' }}>待生成立绘</span>
                              )}
                            </div>
                          )}
                          <Tag style={{ position: 'absolute', bottom: 2, left: 2, margin: 0, fontSize: 9, padding: '0 3px', lineHeight: '14px' }}>
                            正面立绘
                          </Tag>
                        </div>

                        {/* 中间：三视图展示 */}
                        <div style={{ width: 140, height: 130, borderRadius: 6, overflow: 'hidden', background: '#181818', flexShrink: 0, position: 'relative' }}>
                          {char.turnaroundImage ? (
                            <Image src={toWebviewUrl(char.turnaroundImage)} width={140} height={130} style={{ objectFit: 'cover' }} />
                          ) : (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#38bdf8', gap: 6, padding: 4, textAlign: 'center' }}>
                              {isPhase2Running ? (
                                <>
                                  <Spin size="small" indicator={<LoadingOutlined spin style={{ color: '#38bdf8' }} />} />
                                  <span style={{ fontSize: 10 }}>生成三视图中...</span>
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-secondary)' }}>待生成三视图</span>
                              )}
                            </div>
                          )}
                          <Tag color="cyan" style={{ position: 'absolute', bottom: 2, left: 2, margin: 0, fontSize: 9, padding: '0 3px', lineHeight: '14px' }}>
                            正/侧/背三视图
                          </Tag>
                        </div>

                        {/* 右侧：信息与 Seed 锁 */}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <Text strong style={{ fontSize: 14 }}>{char.name}</Text>
                              <Tag color="orange" style={{ margin: 0, fontSize: 10 }}>
                                <LockOutlined style={{ marginRight: 2 }} />
                                Seed: {char.seed || '锁定'}
                              </Tag>
                            </div>
                            <Paragraph type="secondary" style={{ fontSize: 11, margin: '4px 0 0 0' }} ellipsis={{ rows: 2 }}>
                              {char.appearance || '已锁定角色外貌特征'}
                            </Paragraph>
                          </div>

                          {/* 音色配置与试听播放器 */}
                          <div style={{ marginTop: 6 }}>
                            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>🎙️ 专属配音音色：</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <Select
                                size="small"
                                value={char.voiceRef || 'zh-CN-XiaoxiaoNeural'}
                                onChange={(val) => updateSceneSpecCharacter(pipelineId, char.id, { voiceRef: val })}
                                style={{ flex: 1, fontSize: 11 }}
                                options={VOICE_PRESETS.map((v) => ({ label: v.label, value: v.value }))}
                              />
                              <Button
                                size="small"
                                icon={<SoundOutlined />}
                                onClick={() => handlePreviewVoice(char.voiceRef || 'zh-CN-XiaoxiaoNeural')}
                                type={playingVoice === (char.voiceRef || 'zh-CN-XiaoxiaoNeural') ? 'primary' : 'default'}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 底部单角色操作矩阵 */}
                      <div style={{ display: 'flex', gap: 6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={busyCharId === char.id}
                          onClick={() => handleRegenCharPortrait(char)}
                          style={{ flex: 1, fontSize: 11 }}
                        >
                          重画正面
                        </Button>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={busyCharId === char.id}
                          onClick={() => handleRegenCharTurnaround(char)}
                          style={{ flex: 1, fontSize: 11 }}
                        >
                          重画三视图
                        </Button>
                        <Upload
                          showUploadList={false}
                          beforeUpload={(file) => handleUploadCharPortrait(char, file)}
                          accept="image/*"
                        >
                          <Button size="small" icon={<UploadOutlined />} style={{ fontSize: 11 }}>
                            上传参考图
                          </Button>
                        </Upload>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </Card>

            {/* 场景环境资产库 */}
            <Card
              size="small"
              title={`🏞️ 场景资产库 (${scenes.length} 个场景) · 环境与光影背景`}
              extra={
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<ReloadOutlined />}
                  onClick={async () => {
                    message.loading('正在批量生成场景背景图...', 1.5);
                    await runFromStage(pipelineId, 'scene_image');
                  }}
                >
                  批量生成场景图
                </Button>
              }
            >
              {scenes.length === 0 ? (
                <Empty description="暂无场景资产" />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                  {scenes.map((scene) => (
                    <Card
                      key={scene.id}
                      size="small"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)' }}
                      styles={{ body: { padding: 10 } }}
                    >
                      <div style={{ height: 110, borderRadius: 6, overflow: 'hidden', background: '#181818', marginBottom: 8, position: 'relative' }}>
                        {scene.backgroundImage ? (
                          <Image src={toWebviewUrl(scene.backgroundImage)} width="100%" height={110} style={{ objectFit: 'cover' }} />
                        ) : (
                          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#38bdf8', gap: 6, padding: 4, textAlign: 'center' }}>
                            {isPhase2Running ? (
                              <>
                                <Spin size="small" indicator={<LoadingOutlined spin style={{ color: '#38bdf8' }} />} />
                                <span style={{ fontSize: 10 }}>生成背景中...</span>
                              </>
                            ) : (
                              <span style={{ color: 'var(--text-secondary)' }}>待生成场景背景</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <Text strong style={{ fontSize: 13 }}>{scene.name}</Text>
                        <Button
                          size="small"
                          type="text"
                          icon={<ReloadOutlined />}
                          loading={busySceneId === scene.id}
                          onClick={() => handleRegenSceneBg(scene)}
                        >
                          重画背景
                        </Button>
                      </div>
                      <Text type="secondary" style={{ fontSize: 11 }} ellipsis>{scene.description || '默认环境'}</Text>
                    </Card>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ── Phase 3: 🎬 分镜精修工作台 (人机协同质量门禁 3) ── */}
        {activePhase === 'studio' && (
          <div style={{ height: '100%', padding: '0 8px 8px 8px' }}>
            <ShotStudioWorkspace pipelineId={pipelineId} showHeader={false} />
          </div>
        )}

        {/* ── Phase 4: 🎞️ 多轨剪辑与最终成片 (人机协同质量门禁 4) ── */}
        {activePhase === 'timeline' && (
          <div style={{ height: '100%' }}>
            <VideoTimelineWorkspace pipelineId={pipelineId} project={project} showHeader={false} />
          </div>
        )}
      </div>

      {/* ==================================================================== */}
      {/* 3. 抽屉：底层流水线执行日志与账本 (Collapsible Pipeline Log Drawer)   */}
      {/* ==================================================================== */}
      <Drawer
        title="📋 底层流水线步骤产物与账本 (Pipeline Log & Invocations)"
        placement="right"
        width={720}
        open={logsDrawerOpen}
        onClose={() => setLogsDrawerOpen(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {visibleStages.map((st) => (
            <Card
              key={st}
              size="small"
              title={
                <Space>
                  <Text strong>{t(`video.gen.stage.${st}`)}</Text>
                  <Tag>{st}</Tag>
                  <Tag color={stages?.[st]?.status === 'completed' ? 'success' : stages?.[st]?.status === 'running' ? 'processing' : 'default'}>
                    {stages?.[st]?.status || 'idle'}
                  </Tag>
                </Space>
              }
            >
              {renderStageContent(st, project, sceneSpec, t)}
            </Card>
          ))}
        </div>
      </Drawer>

      {/* 追加镜头 Modal */}
      <Modal
        title="追加新分镜"
        open={addShotModalOpen}
        onOk={handleAddShotConfirm}
        onCancel={() => setAddShotModalOpen(false)}
        okText="追加镜头"
        cancelText="取消"
      >
        <div style={{ marginTop: 8 }}>
          <Text style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
            输入新分镜的画面描述 (Video Prompt):
          </Text>
          <Input.TextArea
            rows={4}
            value={newShotPrompt}
            onChange={(e) => setNewShotPrompt(e.target.value)}
            placeholder="例如: 镜头从主角侧面推近，环境光影交织，气势磅礴..."
          />
        </div>
      </Modal>

      {/* 导出视频 Modal */}
      {finalVideoUrl && (
        <ExportVideoModal
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          sourcePath={finalVideoUrl}
          suggestedName={`mojing-${pipelineId}`}
        />
      )}

      {/* 预设配置 Modal */}
      <VideoPromptSettingsModal
        open={promptSettingsOpen}
        onClose={() => setPromptSettingsOpen(false)}
      />
    </div>
  );
};

export default VideoPipelinePanel;

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

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Typography, Tag, Card, Empty, Button, Space,
  Tooltip, Input, message, Modal, Image,
  Drawer, Select,
  Upload, Spin,
} from 'antd';
import {
  ReloadOutlined,
  DeleteOutlined, SettingOutlined, PlusOutlined,
  SoundOutlined, LockOutlined, UploadOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { useProviderStore } from '@/stores/providerStore';
import type { CharacterAnchor, SceneAnchor, AspectRatio, ShotSpec, VideoStage } from '@/types/video';
import { VIDEO_PIPELINE_STAGES, DEFAULT_SKIPPED_STAGES, DEFAULT_PIPELINE_OPTIONS } from '@/types/video';
import { getVideoPipelineStatus } from '@/services/video/core/production-readiness';
import { renderStageContent } from './StageArtifactsModal';
import ExportVideoModal from './ExportVideoModal';
import VideoPromptSettingsModal from './VideoPromptSettingsModal';
import ShotProductionBoard from './ShotProductionBoard';
import StoryboardSheet from './StoryboardSheet';
import { VideoTimelineWorkspace } from './VideoTimelineDrawer';
import VideoFlowTracePanel from './VideoFlowTracePanel';
import VideoProductionConsole, { phaseForStage, type ConsolePhase } from './VideoProductionConsole';
import { approvePlanning, runFromStage, abortPipeline } from '@/services/video/core/pipeline-runner';
import { VideoPipeline } from '@/services/video/pipeline';
import { toWebviewUrl, saveAsset, resolveLocalPath } from '@/services/video/asset-store';
import { generateSingleCharacterPortrait, generateSingleCharacterTurnaround } from '@/services/video/core/step-character-anchor';
import { ENVIRONMENT_REFERENCE_VERSION, generateSingleSceneImage } from '@/services/video/core/step-scene-image';
import { collectVideoPipelinePreflight } from '@/services/video/core/pipeline-preflight';
import { providerRouter } from '@/services/providers';
import { stepVoice } from '@/services/video/core/step-voice';
import './VideoPipelinePanel.css';

const { Text } = Typography;

export type StudioPhase = ConsolePhase;

interface WorkflowRun {
  planning?: VideoPipeline;
}

// A project can keep generating while its panel is unmounted.
const workflowRuns = new Map<string, WorkflowRun>();

function shotStoryText(shot: ShotSpec): string {
  const source = shot.sourceText?.trim();
  if (source) return source;
  const dialogue = shot.dialogue?.map((line) => `${line.speaker}：${line.text}`).join(' ') ?? '';
  return dialogue || shot.narration?.trim() || '';
}

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
  const providerState = useProviderStore(useShallow((s) => ({ endpoints: s.endpoints, config: s.config })));
  const activeImageEndpoint = useProviderStore((s) => s.getActiveEndpoint('image'));
  const stages = project?.stages;
  const currentStage = Object.values(stages ?? {}).find((stage) => stage.status === 'running')?.stage ?? project?.currentStage;
  const sceneSpec = project?.sceneSpec;
  const shots = project?.sceneSpec?.shots || [];
  const characters = project?.sceneSpec?.characters || [];
  const scenes = project?.sceneSpec?.scenes || [];
  const finalVideoUrl = project?.finalVideoUrl;
  const sourceProject = useProjectStore((s) => (
    pipelineId ? s.projects.find((candidate) => candidate.id === pipelineId) : undefined
  ));
  const parentSeries = useProjectStore((s) => {
    const seriesId = (sourceProject?.metadata as { seriesId?: string } | undefined)?.seriesId;
    return seriesId ? s.projects.find((candidate) => candidate.id === seriesId) : undefined;
  });
  const sourceText = (sourceProject?.metadata as { scriptText?: string } | undefined)?.scriptText
    ?? sourceProject?.description
    ?? sceneSpec?.shots.map(shotStoryText).filter(Boolean).join('\n\n')
    ?? '';

  const updateSceneSpecShot = useVideoStore((s) => s.updateSceneSpecShot);
  const addSceneSpecShot = useVideoStore((s) => s.addSceneSpecShot);
  const deleteSceneSpecShot = useVideoStore((s) => s.deleteSceneSpecShot);
  const updateSceneSpecCharacter = useVideoStore((s) => s.updateSceneSpecCharacter);
  const updateSceneSpecScene = useVideoStore((s) => s.updateSceneSpecScene);
  const updateProject = useProjectStore((s) => s.updateProject);
  const updateProjectMetadata = useProjectStore((s) => s.updateProjectMetadata);

  // 4 大核心创作阶段切换
  // The shot board is the primary production surface. Flow trace remains an
  // audit/debug view, while the legacy studio is still reachable through the
  // same phase navigation for existing projects.
  // The overview is the project home. A new project must first show its
  // inputs, readiness, and next action instead of an empty shot editor.
  const [activePhase, setActivePhase] = useState<StudioPhase>('flow');
  const [shotFocus, setShotFocus] = useState<{ shotId: string; review?: 'image' | 'video' }>();
  const [runningProjectIds, setRunningProjectIds] = useState<string[]>([]);
  const starting = !!pipelineId && runningProjectIds.includes(pipelineId);
  const [traceOpen, setTraceOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(sourceText);

  useEffect(() => {
    setActivePhase('flow');
    setShotFocus(undefined);
    setTraceOpen(false);
  }, [pipelineId]);

  useEffect(() => {
    setSourceDraft(sourceText);
  }, [pipelineId, sourceText]);

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
  const voicePreview = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    voicePreview.current?.pause();
    voicePreview.current = null;
  }, [pipelineId]);

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
    if (parentSeries?.title && sourceProject?.title) {
      return t('video.pipeline.seriesEpisodeLabel', { series: parentSeries.title, episode: sourceProject.title });
    }
    if (novelTitle && sourceProject?.type === 'novel') return t('video.pipeline.fromNovelLabel', { title: novelTitle });
    return sourceProject?.title || project.title || t('video.pipeline.title');
  }, [parentSeries?.title, project, pipelineId, novelTitle, sourceProject?.title, sourceProject?.type, t]);

  // 整体状态与实时工序计算
  const overall = project ? getVideoPipelineStatus(project).status : 'idle';
  const statusLabel = t(`video.pipeline.status.${overall}`);

  const isRunning = overall === 'running';
  const productionBusy = starting || isRunning;
  const editingAsset = !!busyCharId || !!busySceneId;
  const isPhase2Running = isRunning && (currentStage === 'character_anchor' || currentStage === 'scene_image' || currentStage === 'voice_assignment');

  // 步骤完成统计
  const visibleStages = VIDEO_PIPELINE_STAGES.filter((s) => !DEFAULT_SKIPPED_STAGES.has(s));
  const completedStages = visibleStages.filter((s) => stages?.[s]?.status === 'completed');
  const progressPercent = Math.round(
    visibleStages.reduce((total, stage) => {
      const state = stages?.[stage];
      if (state?.status === 'completed' || state?.status === 'skipped') return total + 1;
      if (state?.status === 'running' || state?.status === 'awaiting_review') {
        return total + Math.max(0, Math.min(1, state.progress || 0));
      }
      return total;
    }, 0) / Math.max(visibleStages.length, 1) * 100,
  );

  const checkPreflight = useMemo(() => (stage: VideoStage, endStage?: VideoStage) => {
    const spec = project?.sceneSpec;
    const options = project?.options ?? DEFAULT_PIPELINE_OPTIONS;
    return collectVideoPipelinePreflight({
      channel: spec?.meta.channel ?? (pipelineId?.startsWith('direct_') ? 'direct' : 'novel'),
      sourceMode: spec?.meta.sourceMode,
      options,
      startStage: stage === 'video_generation' && options.enableTTS && stages?.tts?.status !== 'completed'
        ? 'voice_assignment'
        : stage,
      endStage,
      planningRequired: phaseForStage(stage) === 'script' && spec?.meta.channel !== 'direct',
      sceneSpec: spec,
      hasCharacterReferences: options.enableCharacterAnchor && (spec?.characters?.length ?? 0) > 0,
      hasSpeech: spec
        ? spec.shots.some((shot) => !!(
          shot.dialogue?.some((line) => !!line.text?.trim())
          || shot.narration?.trim()
          || shot.sourceText?.trim()
          || shot.videoPrompt?.trim()
        ))
        : pipelineId?.startsWith('direct_') !== true,
      imageEndpointId: project?.executionBinding?.image?.endpointId,
      imageModel: project?.executionBinding?.image?.model,
      videoEndpointId: project?.executionBinding?.video.endpointId,
      videoModel: project?.executionBinding?.video.model,
    });
  }, [pipelineId, project, providerState, stages?.tts?.status]);

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
      imagePrompt: newShotPrompt.trim(),
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
      characters: [...(shot.characterIds || shot.visibleCharacterIds || [])],
      location: shot.location,
      mood: shot.mood,
      characterIds: [...(shot.characterIds || [])],
      visibleCharacterIds: shot.visibleCharacterIds ? [...shot.visibleCharacterIds] : undefined,
      offscreenCharacterIds: shot.offscreenCharacterIds ? [...shot.offscreenCharacterIds] : undefined,
      characterBinding: shot.characterBinding,
      costumeVariantRefs: shot.costumeVariantRefs ? { ...shot.costumeVariantRefs } : undefined,
      sceneId: shot.sceneId,
      narration: shot.narration,
      dialogue: shot.dialogue ? shot.dialogue.map((line) => ({ ...line })) : undefined,
      imagePrompt: shot.imagePrompt,
      imageNegativePrompt: shot.imageNegativePrompt,
      imageParameters: shot.imageParameters ? { ...shot.imageParameters } : undefined,
      videoNegativePrompt: shot.videoNegativePrompt,
      videoParameters: shot.videoParameters ? { ...shot.videoParameters } : undefined,
      startState: shot.startState,
      endState: shot.endState,
      transition: shot.transition,
      previsReferenceImage: shot.previsReferenceImage,
      previsWorldId: shot.previsWorldId,
      seed: shot.seed,
      customReferenceImages: shot.customReferenceImages ? [...shot.customReferenceImages] : undefined,
      customReferenceVideos: shot.customReferenceVideos ? [...shot.customReferenceVideos] : undefined,
    });
    message.success(`已复制分镜 #${shot.index + 1}`);
  };

  // --- 试听音色 ---
  const handlePreviewVoice = async (character: CharacterAnchor) => {
    voicePreview.current?.pause();
    const audio = new Audio();
    voicePreview.current = audio;
    setPlayingVoice(character.id);
    try {
      const assigned = (await stepVoice(characters)).characters.find((item) => item.id === character.id);
      const response = await providerRouter.generateTTS({ text: t('video.workflow.voiceSample'), voice: assigned?.voiceRef });
      if (voicePreview.current !== audio) return;
      audio.src = response.audioData;
      audio.onended = () => { if (voicePreview.current === audio) setPlayingVoice(null); };
      await audio.play();
    } catch (error) {
      if (voicePreview.current !== audio) return;
      setPlayingVoice(null);
      message.error(t('video.workflow.voicePreviewFailed', { error: error instanceof Error ? error.message : String(error) }));
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
        imageEndpointId: activeImageEndpoint?.id,
        novelProjectId: pipelineId,
      });
      updateSceneSpecCharacter(pipelineId, char.id, {
        portraitImage: newPath,
        turnaroundImage: undefined,
        turnaroundSourcePortrait: undefined,
      });
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
        imageEndpointId: activeImageEndpoint?.id,
        novelProjectId: pipelineId,
      });
      updateSceneSpecCharacter(pipelineId, char.id, {
        turnaroundImage: newPath,
        turnaroundSourcePortrait: char.portraitImage,
      });
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
        updateSceneSpecCharacter(pipelineId, char.id, {
          portraitImage: savedPath,
          turnaroundImage: undefined,
          turnaroundSourcePortrait: undefined,
        });
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
        imageEndpointId: activeImageEndpoint?.id,
        characters,
        novelProjectId: pipelineId,
      });
      updateSceneSpecScene(pipelineId, scene.id, {
        backgroundImage: newPath,
        backgroundReferenceRole: 'environment_only',
        backgroundReferenceVersion: ENVIRONMENT_REFERENCE_VERSION,
      });
      message.success(`【${scene.name}】场景背景图生成成功！`);
    } catch (err) {
      message.error(`场景生成失败: ${String(err)}`);
    } finally {
      setBusySceneId(null);
    }
  };

  const finishWorkflowRun = (run: WorkflowRun) => {
    if (workflowRuns.get(pipelineId) !== run) return;
    workflowRuns.delete(pipelineId);
    setRunningProjectIds((ids) => ids.filter((id) => id !== pipelineId));
  };

  const handleWorkflowRun = async (stage: VideoStage, endStage?: VideoStage, automatic = false) => {
    if (productionBusy || editingAsset || workflowRuns.has(pipelineId)) return;
    if (!automatic && !checkPreflight(stage, endStage).ok) {
      message.error(t('video.preflight.blocked'));
      return;
    }
    const run: WorkflowRun = {};
    workflowRuns.set(pipelineId, run);
    setRunningProjectIds((ids) => [...ids, pipelineId]);
    setActivePhase(automatic ? 'flow' : phaseForStage(stage));
    const noticeKey = `video-workflow-run-${pipelineId}`;
    try {
      let ok: boolean;
      if (automatic) {
        if (!useVideoStore.getState().getProject(pipelineId)?.sceneSpec?.shots.length) {
          const pipeline = VideoPipeline.forResume(pipelineId);
          if (!pipeline) throw new Error(t('video.overview.inputRequired'));
          run.planning = pipeline;
          if (!await pipeline.run()) return;
        }
        if (workflowRuns.get(pipelineId) !== run) return;
        if (!approvePlanning(pipelineId)) throw new Error(t('video.workflow.planApprovalFailed'));
        ok = await runFromStage(pipelineId, 'character_anchor', { force: false, automatic: true });
      } else if (phaseForStage(stage) === 'script') {
        const pipeline = VideoPipeline.forResume(pipelineId);
        if (!pipeline) throw new Error(t('video.overview.inputRequired'));
        run.planning = pipeline;
        ok = !!(await (stage === 'script_slicing' && sceneSpec ? pipeline.replan() : pipeline.run()));
      } else {
        ok = await runFromStage(pipelineId, stage, { force: false, endStage });
      }
      if (workflowRuns.get(pipelineId) === run && !ok && useVideoStore.getState().getProject(pipelineId)?.error) {
        message.warning({ content: t('video.pipeline.batchGenerationIncomplete'), key: noticeKey });
      }
    } catch (error) {
      if (workflowRuns.get(pipelineId) !== run) return;
      message.error({
        content: t('video.pipeline.batchGenerationFailed', { error: error instanceof Error ? error.message : String(error) }),
        key: noticeKey,
      });
    } finally {
      finishWorkflowRun(run);
    }
  };

  const handleApprovePlan = () => {
    if (!approvePlanning(pipelineId)) {
      message.error(t('video.workflow.planApprovalFailed'));
      return;
    }
    setActivePhase('assets');
  };

  const handleAssembleApprovedShots = () => {
    const needsAudioMerge = project.options?.enableAudioMerge
      && shots.some((shot) => !!shot.audioTrack)
      && project.stages.audio_merge?.status !== 'completed';
    void handleWorkflowRun(needsAudioMerge ? 'audio_merge' : 'composing', 'composing');
  };

  const handleWorkflowStop = () => {
    const run = workflowRuns.get(pipelineId);
    Modal.confirm({
      title: t('video.workflow.stopConfirmTitle'),
      content: t('video.workflow.stopConfirmDescription'),
      okText: t('video.workflow.stop'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => {
        if (workflowRuns.get(pipelineId) !== run) return;
        const latest = useVideoStore.getState().getProject(pipelineId);
        if (!Object.values(latest?.stages ?? {}).some((stage) => stage.status === 'running')) return;
        if (run) {
          run.planning?.abort();
          finishWorkflowRun(run);
        }
        abortPipeline(pipelineId);
        message.warning(t('video.workflow.stopped'));
      },
    });
  };

  return (
    <div className="video-pipeline-panel">
      <VideoProductionConsole
        project={project}
        headerLabel={headerLabel}
        sourceText={sourceText}
        activePhase={activePhase}
        overall={overall}
        statusLabel={statusLabel}
        stages={stages}
        currentStage={currentStage}
        progressPercent={progressPercent}
        checkPreflight={checkPreflight}
        onPhaseChange={(phase) => setActivePhase(phase)}
        onRunFromStage={(stage, endStage) => void handleWorkflowRun(stage, endStage)}
        onRunAutomatic={() => void handleWorkflowRun('character_anchor', 'composing', true)}
        onApprovePlan={handleApprovePlan}
        onAssemble={handleAssembleApprovedShots}
        onStop={handleWorkflowStop}
        onOpenSettings={() => window.dispatchEvent(new CustomEvent('mojing:open-settings', { detail: { tab: 'providers' } }))}
        onOpenPromptSettings={() => setPromptSettingsOpen(true)}
        onOpenLogs={() => setLogsDrawerOpen(true)}
        onOpenTrace={() => setTraceOpen(true)}
        onVisualReviewChange={(automatic) => {
          if (productionBusy) return;
          const latest = useVideoStore.getState().getProject(pipelineId);
          if (latest) useVideoStore.getState().setPipelineOptions(pipelineId, { ...DEFAULT_PIPELINE_OPTIONS, ...latest.options, enableVisualQualityGate: automatic, blockOnVisualReviewUnavailable: automatic });
        }}
        onOpenShot={(shotId, review) => {
          setShotFocus({ shotId, review });
          setActivePhase('studio');
        }}
        starting={starting}
        editingAsset={editingAsset}
        t={t}
      >

      {/* ==================================================================== */}
      {/* ==================================================================== */}
      {/* 2. 主画板区：根据当前选中的阶段展示对应工作台                       */}
      {/* ==================================================================== */}
      <main className={`video-workflow-content is-${activePhase}`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: activePhase === 'studio' || activePhase === 'timeline' ? 0 : 16 }}>

        {/* ── Phase 1: 📝 剧本与分镜大纲 (人机协同检查门禁 1) ── */}
        {activePhase === 'script' && (
          <div style={{ height: '100%', minHeight: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="video-script-workspace">
              {/* 左侧：小说与剧本文本预览与切片 */}
              <Card
                size="small"
                title={t('video.workbench.sourceScript')}
              extra={sceneSpec?.meta.channel === 'novel' && shots.length > 0 && (
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  disabled={productionBusy}
                  onClick={() => Modal.confirm({
                    title: t('video.workflow.replan'),
                    content: t('video.workflow.replanConfirm'),
                    okText: t('video.workflow.replan'),
                    onOk: () => void handleWorkflowRun('script_slicing', 'extraction'),
                  })}
                >
                  {t('video.workflow.replan')}
                </Button>
              )}
              style={{ height: '100%', minHeight: 280, display: 'flex', flexDirection: 'column' }}
              styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 12 } }}
            >
              <div className="video-script-source-meta">{t('video.workbench.sourceScriptMeta')}</div>
              <Input.TextArea
                value={sourceDraft}
                readOnly={sceneSpec?.meta.channel === 'direct'}
                disabled={productionBusy}
                placeholder={t('video.workbench.sourceScriptEmpty')}
                className="video-script-source-input"
                onChange={(event) => {
                  const value = event.target.value;
                  setSourceDraft(value);
                  if (!pipelineId) return;
                  const chapterId = project.selectedChapterIds[0] || `${pipelineId}_script`;
                  updateProject(pipelineId, { description: value });
                  updateProjectMetadata(pipelineId, {
                    scriptText: value,
                    chapters: [{ id: chapterId, number: 1, order: 0, content: value }],
                  });
                }}
              />
            </Card>

            {/* 右侧：结构化分镜卡片流 (支持景别、运镜、台词行内快速修改) */}
            <StoryboardSheet
              project={project}
              disabled={productionBusy}
              onUpdateShot={(shotId, patch) => updateSceneSpecShot(pipelineId, shotId, patch)}
              onOpenShot={(shotId) => { setShotFocus({ shotId }); setActivePhase('studio'); }}
              onAddShot={() => setAddShotModalOpen(true)}
              onDuplicateShot={handleDuplicateShot}
              onDeleteShot={(shotId) => deleteSceneSpecShot(pipelineId, shotId)}
            />
          </div>
          </div>
        )}

        {/* ── Phase 2: 🎨 角色与场景资产设定 (人机协同核心质量门禁 2) ── */}
        {activePhase === 'assets' && (
          <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
            {/* 角色一致性资产库 */}
            <Card
              size="small"
              title={t('video.workflow.characters', { count: characters.length })}
            >
              {characters.length === 0 ? (
                <Empty description="暂无角色资产，请先在阶段一完成【剧本切片】" />
              ) : (
                <div className="video-character-grid">
                  {characters.map((char) => (
                    <Card
                      key={char.id}
                      size="small"
                      style={{
                        background: 'var(--bg-container)',
                        border: '1px solid var(--border-secondary)',
                        boxShadow: 'var(--shadow-sm)',
                        overflow: 'hidden',
                      }}
                      styles={{ body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 12 } }}
                    >
                      {/* 1. 角色卡片头部：名称、主角设定与 Seed 锁 */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Space size={8}>
                          <Text strong style={{ fontSize: 15, color: 'var(--text-primary)' }}>{char.name}</Text>
                          <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>主角设定</Tag>
                        </Space>
                        <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>
                          <LockOutlined style={{ marginRight: 3 }} />
                          Seed: {char.seed || '锁定'}
                        </Tag>
                      </div>

                      {/* 2. 角色立绘双视窗与外貌描述 */}
                      <div className="video-character-visuals">
                        {/* 正面立绘 */}
                        <div style={{ width: 95, height: 130, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0, position: 'relative', border: '1px solid var(--border-base)' }}>
                          {char.portraitImage ? (
                            <Image src={toWebviewUrl(resolveLocalPath(char.portraitImage))} width={95} height={130} style={{ objectFit: 'cover' }} />
                          ) : (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--accent-info)', gap: 6, padding: 4, textAlign: 'center' }}>
                              {isPhase2Running ? (
                                <>
                                  <Spin size="small" indicator={<LoadingOutlined spin style={{ color: 'var(--accent-info)' }} />} />
                                  <span style={{ fontSize: 10 }}>生成立绘中...</span>
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-secondary)' }}>待生成立绘</span>
                              )}
                            </div>
                          )}
                          <Tag style={{ position: 'absolute', bottom: 2, left: 2, margin: 0, fontSize: 9, padding: '0 4px', lineHeight: '16px' }}>
                            正面立绘
                          </Tag>
                        </div>

                        {/* 三视图展示 */}
                        <div style={{ width: 140, height: 130, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0, position: 'relative', border: '1px solid var(--border-base)' }}>
                          {char.turnaroundImage ? (
                            <Image src={toWebviewUrl(resolveLocalPath(char.turnaroundImage))} width={140} height={130} style={{ objectFit: 'cover' }} />
                          ) : (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--accent-info)', gap: 6, padding: 4, textAlign: 'center' }}>
                              {isPhase2Running ? (
                                <>
                                  <Spin size="small" indicator={<LoadingOutlined spin style={{ color: 'var(--accent-info)' }} />} />
                                  <span style={{ fontSize: 10 }}>生成三视图中...</span>
                                </>
                              ) : (
                                <span style={{ color: 'var(--text-secondary)' }}>待生成三视图</span>
                              )}
                            </div>
                          )}
                          <Tag color="cyan" style={{ position: 'absolute', bottom: 2, left: 2, margin: 0, fontSize: 9, padding: '0 4px', lineHeight: '16px' }}>
                            正/侧/背三视图
                          </Tag>
                        </div>

                        {/* 右侧外貌特征描述 */}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>外貌设定特征：</div>
                          <div
                            style={{
                              flex: 1,
                              fontSize: 11,
                              color: 'var(--text-secondary)',
                              background: 'var(--bg-tertiary)',
                              padding: '6px 8px',
                              borderRadius: 4,
                              border: '1px solid var(--border-secondary)',
                              overflowY: 'auto',
                              lineHeight: 1.4,
                              maxHeight: 105,
                            }}
                          >
                            {char.appearance || '已锁定角色外貌特征'}
                          </div>
                        </div>
                      </div>

                      {/* 3. 专属配音音色配置栏 (全宽独立行，绝不溢出) */}
                      <div style={{
                        background: 'var(--bg-tertiary)',
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: '1px solid var(--border-secondary)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        boxSizing: 'border-box',
                      }}>
                        <Text style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          🎙️ 专属配音音色:
                        </Text>
                        <Select
                          size="small"
                          disabled={productionBusy || editingAsset}
                          value={char.voiceRef}
                          placeholder={t('video.workflow.automaticVoice')}
                          onChange={(val) => updateSceneSpecCharacter(pipelineId, char.id, { voiceRef: val })}
                          style={{ flex: 1, minWidth: 0 }}
                          dropdownMatchSelectWidth={false}
                          options={VOICE_PRESETS.map((v) => ({ label: v.label, value: v.value }))}
                        />
                        <Button
                          size="small"
                          icon={<SoundOutlined />}
                          onClick={() => void handlePreviewVoice(char)}
                          loading={playingVoice === char.id}
                          style={{ flexShrink: 0 }}
                        >
                          试听
                        </Button>
                      </div>

                      {/* 4. 底部单角色操作矩阵 */}
                      <div className="video-character-actions">
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={busyCharId === char.id}
                          disabled={productionBusy || editingAsset}
                          onClick={() => handleRegenCharPortrait(char)}
                          style={{ flex: 1, fontSize: 11 }}
                        >
                          {t(char.portraitImage ? 'video.workflow.redrawPortrait' : 'video.workflow.generatePortrait')}
                        </Button>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={busyCharId === char.id}
                          disabled={productionBusy || editingAsset || !char.portraitImage}
                          onClick={() => handleRegenCharTurnaround(char)}
                          style={{ flex: 1, fontSize: 11 }}
                        >
                          {t(char.turnaroundImage ? 'video.workflow.redrawTurnaround' : 'video.workflow.generateTurnaround')}
                        </Button>
                        <Upload
                          showUploadList={false}
                          disabled={productionBusy || editingAsset}
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
              title={t('video.workflow.scenes', { count: scenes.length })}
            >
              {scenes.length === 0 ? (
                <Empty description="暂无场景资产" />
              ) : (
                <div className="video-scene-grid">
                  {scenes.map((scene) => (
                    <Card
                      key={scene.id}
                      size="small"
                      style={{ background: 'var(--bg-container)', border: '1px solid var(--border-secondary)' }}
                      styles={{ body: { padding: 10 } }}
                    >
                      <div style={{ height: 110, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', marginBottom: 8, position: 'relative' }}>
                        {scene.backgroundImage ? (
                          <Image src={toWebviewUrl(scene.backgroundImage)} width="100%" height={110} style={{ objectFit: 'cover' }} />
                        ) : (
                          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--accent-info)', gap: 6, padding: 4, textAlign: 'center' }}>
                            {isPhase2Running ? (
                              <>
                                <Spin size="small" indicator={<LoadingOutlined spin style={{ color: 'var(--accent-info)' }} />} />
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
                          disabled={productionBusy || editingAsset}
                          onClick={() => handleRegenSceneBg(scene)}
                        >
                          {t(scene.backgroundImage ? 'video.workflow.redrawScene' : 'video.workflow.generateScene')}
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
          <ShotProductionBoard
            pipelineId={pipelineId}
            focus={shotFocus}
            productionBusy={productionBusy}
            onOpenScript={() => setActivePhase('script')}
            onOpenAssets={() => setActivePhase('assets')}
            onOpenTimeline={() => setActivePhase('timeline')}
            onOpenFlow={() => setTraceOpen(true)}
            onAssemble={() => void handleAssembleApprovedShots()}
          />
        )}

        {/* ── Phase 4: 🎞️ 多轨剪辑与最终成片 (人机协同质量门禁 4) ── */}
        {activePhase === 'timeline' && (
          <div style={{ height: '100%' }}>
            <VideoTimelineWorkspace
              pipelineId={pipelineId}
              project={project}
              onOpenScript={() => setActivePhase('script')}
              onOpenShotStudio={() => setActivePhase('studio')}
            />
          </div>
        )}
      </main>
      </VideoProductionConsole>

      {/* ==================================================================== */}
      {/* 3. 抽屉：底层流水线执行日志与账本 (Collapsible Pipeline Log Drawer)   */}
      {/* ==================================================================== */}
      <VideoFlowTracePanel
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        project={project}
        onOpenStage={(stage, shotId) => {
          setShotFocus(shotId ? { shotId } : undefined);
          setTraceOpen(false);
          setActivePhase(phaseForStage(stage));
        }}
      />
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

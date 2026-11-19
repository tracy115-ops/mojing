import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Empty,
  Image,
  Input,
  InputNumber,
  Progress,
  Select,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FileSearchOutlined,
  LockOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  SoundOutlined,
  UploadOutlined,
  VideoCameraOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import { saveAsset, resolveLocalPath, toWebviewUrl, isAssetAvailable } from '@/services/video/asset-store';
import { getShotStillPrompt } from '@/services/video/core/shot-plan-contract';
import { generateSingleKeyframe } from '@/services/video/core/step-keyframe';
import { generateSingleVideoClip } from '@/services/video/core/step-video-gen';
import { evaluateVideoClipQuality } from '@/services/video/core/video-quality-gate';
import { evaluateVideoClipVisually } from '@/services/video/core/visual-quality-review';
import { updateShotGenerationPlan } from '@/services/video/core/shot-generation-plan';
import { resolveAssemblyQualityRequirements, resolveVideoQualityPolicy } from '@/services/video/core/quality-policy';
import { resolveTemporalAuthority } from '@/services/video/core/shot-continuity';
import { planVideoPrompt } from '@/services/video/core/prompt-enricher';
import { findMatchingCharacters } from '@/services/video/core/character-dna';
import { getCandidateSeed, getSubjectContinuityShot, shotsShareScene, shotsShareSubjects } from '@/services/video/core/shot-continuity';
import {
  getVideoParameter,
  getVideoResolutionTiers,
  normalizeNumberForParameter,
  resolutionForAspect,
} from '@/services/video/core/video-capability-utils';
import {
  getShotProductionReadiness,
  getShotVersionStatus,
  isApprovedVideoClip,
  isShotKeyframeCurrent,
  isShotKeyframeApproved,
  isShotAssemblyReady,
} from '@/services/video/core/shot-production-contract';
import type {
  CharacterAnchor,
  SceneAnchor,
  ShotSpec,
  ShotVersion,
  StageInvocation,
  VideoProjectState,
} from '@/types/video';
import type { VideoControlMode } from '@/types/providers';
import './ShotProductionBoard.css';

const { Text, Title } = Typography;
const { TextArea } = Input;

export interface ShotProductionBoardProps {
  pipelineId: string;
  focus?: { shotId: string; review?: 'image' | 'video' };
  productionBusy?: boolean;
  onOpenScript?: () => void;
  onOpenAssets?: () => void;
  onOpenTimeline?: () => void;
  onOpenFlow?: () => void;
  onAssemble?: () => void;
}

type PreviewTab = 'keyframe' | 'video';
type VideoMode = 'keyframe' | 'reference' | 'text';
type InspectorTab = 'contract' | 'references' | 'request' | 'review';

function imageSrc(value?: string): string {
  return value ? toWebviewUrl(resolveLocalPath(value)) : '';
}

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function stateColor(state: ReturnType<typeof getShotProductionReadiness>['state']): string {
  if (state === 'approved') return 'success';
  if (state === 'awaiting_review' || state === 'needs_keyframe_review' || state === 'needs_binding') return 'warning';
  if (state === 'rejected') return 'error';
  return 'default';
}

function stateIcon(state: ReturnType<typeof getShotProductionReadiness>['state']): React.ReactNode {
  if (state === 'approved') return <CheckCircleOutlined />;
  if (state === 'awaiting_review' || state === 'needs_keyframe_review' || state === 'needs_binding') return <ClockCircleOutlined />;
  if (state === 'rejected') return <WarningOutlined />;
  return <EditOutlined />;
}

type ShotStepState = 'done' | 'active' | 'blocked' | 'pending';

function shotStepIcon(state: ShotStepState): React.ReactNode {
  if (state === 'done') return <CheckCircleOutlined />;
  if (state === 'blocked') return <WarningOutlined />;
  if (state === 'active') return <ClockCircleOutlined />;
  return <ArrowRightOutlined />;
}

function getEffectiveShots(project?: VideoProjectState): ShotSpec[] {
  return project?.sceneSpec?.shots ?? (project?.shots as unknown as ShotSpec[]) ?? [];
}

function getVersionLabel(version: ShotVersion, index: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  return `${version.type === 'image' ? t('video.production.keyframe') : t('video.production.video')} ${t('video.production.versionNumber', { number: index + 1 })}`;
}

function formatInvocationParameters(invocation?: StageInvocation): string {
  const snapshot = invocation?.requestSnapshot;
  if (!snapshot) return '';
  const values = snapshot.wireParameterValues ?? snapshot.parameterValues;
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length === 0) return snapshot.acceptedParameterKeys.join(', ');
  return entries.slice(0, 8).map(([key, value]) => {
    const formatted = typeof value === 'string' ? value : JSON.stringify(value);
    return `${key}=${formatted}`;
  }).join(' · ');
}

function formatSnapshotValues(values?: Record<string, unknown>): string {
  if (!values) return '';
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

function shortFingerprint(value?: string): string {
  if (!value) return '-';
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function snapshotsMatch(left: StageInvocation['requestSnapshot'], right: StageInvocation['requestSnapshot']): boolean {
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

function findInvocationForSnapshot(
  invocations: StageInvocation[] | undefined,
  sourceLabel: string,
  snapshot?: StageInvocation['requestSnapshot'],
): StageInvocation | undefined {
  const candidates = invocations?.filter((invocation) => (
    invocation.sourceLabel === sourceLabel
      || invocation.sourceLabel?.startsWith(`${sourceLabel}:`)
  )) ?? [];
  if (snapshot) {
    const matching = candidates.slice().reverse().find((invocation) => snapshotsMatch(invocation.requestSnapshot, snapshot));
    if (matching) return matching;
  }
  return candidates.slice().reverse().find((invocation) => invocation.executionStatus === 'succeeded')
    ?? candidates.slice().reverse()[0];
}

const ShotProductionBoard: React.FC<ShotProductionBoardProps> = ({
  pipelineId,
  focus,
  productionBusy = false,
  onOpenScript,
  onOpenAssets,
  onOpenTimeline,
  onOpenFlow,
  onAssemble,
}) => {
  const { t } = useTranslation();
  const project = useVideoStore((state) => state.projects[pipelineId]);
  const updateSceneSpecShot = useVideoStore((state) => state.updateSceneSpecShot);
  const addSceneSpecShot = useVideoStore((state) => state.addSceneSpecShot);
  const deleteSceneSpecShot = useVideoStore((state) => state.deleteSceneSpecShot);
  const addShotVersion = useVideoStore((state) => state.addShotVersion);
  const selectShotVersion = useVideoStore((state) => state.selectShotVersion);
  const reviewShotVersion = useVideoStore((state) => state.reviewShotVersion);
  const lockShotVersion = useVideoStore((state) => state.lockShotVersion);
  const ensureShotVersionHistory = useVideoStore((state) => state.ensureShotVersionHistory);
  const setClips = useVideoStore((state) => state.setClips);
  const activeImageEndpoint = useProviderStore((state) => state.getActiveEndpoint('image'));
  const activeVideoEndpoint = useProviderStore((state) => state.getActiveEndpoint('video'));

  const shots = useMemo(() => getEffectiveShots(project), [project]);
  const characters = useMemo(() => project?.sceneSpec?.characters ?? [], [project?.sceneSpec?.characters]);
  const scenes = useMemo(() => project?.sceneSpec?.scenes ?? [], [project?.sceneSpec?.scenes]);
  const [selectedShotId, setSelectedShotId] = useState<string | undefined>(focus?.shotId);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('keyframe');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('contract');
  const [videoMode, setVideoMode] = useState<VideoMode>('keyframe');
  const [resolutionTierId, setResolutionTierId] = useState('720p');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [seed, setSeed] = useState<number | undefined>();
  const [sourceDraft, setSourceDraft] = useState('');
  const [imagePromptDraft, setImagePromptDraft] = useState('');
  const [videoPromptDraft, setVideoPromptDraft] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [generating, setGenerating] = useState<'keyframe' | 'video' | undefined>();
  const [optimizing, setOptimizing] = useState(false);
  const [uploading, setUploading] = useState<'manual' | 'supporting' | undefined>();
  const manualReferenceInput = useRef<HTMLInputElement | null>(null);
  const supportingReferenceInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ensureShotVersionHistory(pipelineId);
  }, [ensureShotVersionHistory, pipelineId]);

  useEffect(() => {
    setSelectedShotId((current) => {
      if (current && shots.some((shot) => shot.id === current)) return current;
      return shots[0]?.id;
    });
  }, [shots]);

  useEffect(() => {
    if (!focus) return;
    setSelectedShotId(focus.shotId);
    if (focus.review) {
      setPreviewTab(focus.review === 'image' ? 'keyframe' : 'video');
      setInspectorTab('review');
    }
  }, [focus]);

  const activeShot = useMemo(
    () => shots.find((shot) => shot.id === selectedShotId) ?? shots[0],
    [selectedShotId, shots],
  );
  const activeClip = useMemo(
    () => (activeShot ? project?.clips.find((clip) => clip.shotId === activeShot.id) : undefined),
    [activeShot?.id, project?.clips],
  );
  const activeCharacters = useMemo(
    () => (activeShot ? findMatchingCharacters(activeShot, characters) : []),
    [activeShot, characters],
  );
  const activeScene = useMemo(
    () => (activeShot?.sceneId ? scenes.find((scene) => scene.id === activeShot.sceneId) : undefined),
    [activeShot?.sceneId, scenes],
  );
  const readiness = useMemo(
    () => (activeShot ? getShotProductionReadiness(activeShot, activeClip, true) : undefined),
    [activeClip, activeShot],
  );
  const imageCapabilities = useMemo(() => {
    try {
      return providerRouter.getImageCapabilities(
        'storyboard',
        typeof activeShot?.imageParameters?.model === 'string' ? activeShot.imageParameters.model : project?.executionBinding?.image?.model,
        project?.executionBinding?.image?.endpointId ?? activeImageEndpoint?.id,
      );
    } catch {
      return undefined;
    }
  }, [activeImageEndpoint?.id, activeShot?.imageParameters?.model, project?.executionBinding?.image?.endpointId, project?.executionBinding?.image?.model]);
  const videoCapabilities = useMemo(() => {
    try {
      return providerRouter.getVideoCapabilities(
        'clip',
        typeof activeShot?.videoParameters?.model === 'string' ? activeShot.videoParameters.model : project?.executionBinding?.video?.model,
        project?.executionBinding?.video?.endpointId ?? activeVideoEndpoint?.id,
      );
    } catch {
      return undefined;
    }
  }, [activeVideoEndpoint?.id, activeShot?.videoParameters?.model, project?.executionBinding?.video?.endpointId, project?.executionBinding?.video?.model]);
  const videoModelOptions = videoCapabilities?.availableModels?.length
    ? videoCapabilities.availableModels
    : videoCapabilities ? [videoCapabilities.model] : [];
  const imageSizeOptions = imageCapabilities?.parameters.find((parameter) => parameter.key === 'size')?.enumValues ?? [];
  const imageEndpointId = project?.executionBinding?.image?.endpointId ?? activeImageEndpoint?.id;
  const videoEndpointId = project?.executionBinding?.video?.endpointId ?? activeVideoEndpoint?.id;
  const imageGenerationReady = Boolean(imageEndpointId && imageCapabilities?.adapterAvailable !== false);
  const videoGenerationReady = Boolean(videoEndpointId && videoCapabilities?.adapterAvailable !== false);
  const resolutionTiers = useMemo(
    () => getVideoResolutionTiers(videoCapabilities),
    [videoCapabilities?.model, videoCapabilities?.endpointId, videoCapabilities?.resolutionTiers],
  );
  const selectedResolutionTier = resolutionTiers.find((tier) => tier.id === resolutionTierId) ?? resolutionTiers[0];
  const durationParameter = getVideoParameter(videoCapabilities, 'durationSeconds');
  const durationOptions = durationParameter?.allowedValues ?? [];

  useEffect(() => {
    if (!videoCapabilities) return;
    const supportsMode = (mode: VideoMode) => mode === 'text'
      || (mode === 'keyframe' && videoCapabilities.references.supportsFirstFrame)
      || (mode === 'reference' && videoCapabilities.references.supportsSubjectReferences);
    setVideoMode((current) => supportsMode(current)
      ? current
      : videoCapabilities.references.supportsFirstFrame
        ? 'keyframe'
        : videoCapabilities.references.supportsSubjectReferences
          ? 'reference'
          : 'text');
  }, [videoCapabilities?.model, videoCapabilities?.endpointId, videoCapabilities?.references.supportsFirstFrame, videoCapabilities?.references.supportsSubjectReferences]);

  useEffect(() => {
    setResolutionTierId((current) => resolutionTiers.some((tier) => tier.id === current)
      ? current
      : resolutionTiers[0]?.id ?? '');
  }, [resolutionTiers]);

  useEffect(() => {
    if (!activeShot) return;
    setSourceDraft(activeShot.sourceText || activeShot.videoPrompt || '');
    setImagePromptDraft(getShotStillPrompt(activeShot));
    setVideoPromptDraft(activeShot.videoPrompt ?? activeShot.sourceText ?? '');
    setDurationSeconds(normalizeNumberForParameter(activeShot.durationSeconds, durationParameter, durationOptions[0] ?? 5));
    setSeed(activeShot.seed);
    setReviewNote('');
    setInspectorTab('contract');
    setPreviewTab(activeClip?.videoUrl ? 'video' : 'keyframe');
  }, [activeShot?.id, durationParameter?.key, durationParameter?.min, durationParameter?.max, durationOptions.join(',')]);

  const assemblyRequirements = useMemo(
    () => resolveAssemblyQualityRequirements(project?.options),
    [project?.options],
  );
  const approvedCount = useMemo(
    () => shots.filter((shot) => isShotAssemblyReady(
      shot,
      project?.clips.find((clip) => clip.shotId === shot.id),
      assemblyRequirements,
    )).length,
    [assemblyRequirements, project?.clips, shots],
  );
  const clipCount = useMemo(
    () => shots.filter((shot) => !!project?.clips.some((clip) => clip.shotId === shot.id && !!clip.videoUrl)).length,
    [project?.clips, shots],
  );
  const keyframeCount = useMemo(
    () => shots.filter(isShotKeyframeCurrent).length,
    [shots],
  );
  const selectedVersion = activeShot
    ? activeShot.versionHistory?.find((version) => version.id === activeShot.selectedVersionId)
    : undefined;
  const activeKeyframeVersion = activeShot?.versionHistory?.find((version) => (
    version.type === 'image' && version.url === activeShot.keyframeImage
  ));
  const selectedVideoVersion = selectedVersion?.type === 'video'
    ? selectedVersion
    : activeShot?.versionHistory?.find((version) => version.id === activeClip?.shotVersionId && version.type === 'video')
      ?? activeShot?.versionHistory?.find((version) => version.type === 'video' && version.url === activeClip?.videoUrl)
      ?? activeShot?.versionHistory?.find((version) => version.type === 'video');
  const keyframePlan = activeKeyframeVersion?.generationPlan?.keyframe
    ?? activeShot?.generationPlan?.keyframe;
  const videoPlan = selectedVideoVersion?.generationPlan?.video
    ?? activeShot?.generationPlan?.video;
  const actualKeyframeSnapshot = activeKeyframeVersion?.requestSnapshot ?? keyframePlan?.requestSnapshot;
  const actualKeyframeResponse = activeKeyframeVersion?.responseSnapshot ?? keyframePlan?.responseSnapshot;
  const actualVideoSnapshot = selectedVideoVersion?.requestSnapshot
    ?? videoPlan?.requestSnapshot
    ?? activeClip?.requestSnapshot;
  const actualVideoResponse = selectedVideoVersion?.responseSnapshot
    ?? videoPlan?.responseSnapshot
    ?? activeClip?.responseSnapshot;
  const continuityReferenceShot = useMemo(
    () => activeShot ? getSubjectContinuityShot(shots, activeShot) : undefined,
    [activeShot, shots],
  );
  const hasSingleCompleteReference = !!continuityReferenceShot?.keyframeImage && !activeShot?.manualReferenceImage;
  const imageReferenceBlockReason: 'unsupported' | 'multi_subject' | 'capacity' | undefined = (() => {
    if (!activeShot || activeCharacters.length === 0 || !imageCapabilities) return undefined;
    if (imageCapabilities.references.supported !== true || imageCapabilities.references.maxImages <= 0) return 'unsupported';
    if (activeShot.manualReferenceImage || hasSingleCompleteReference) return undefined;
    if (activeCharacters.length > imageCapabilities.references.maxImages) return 'capacity';
    if (activeCharacters.length > 1 && imageCapabilities.references.supportsReferenceRoles !== true) return 'multi_subject';
    return undefined;
  })();
  const visibleSubjectRisk = !!imageReferenceBlockReason;
  const referenceBlockMessage = imageReferenceBlockReason === 'unsupported'
    ? t('video.production.imageReferenceBlocked')
    : t('video.production.multiSubjectBlocked');
  const referenceBlockDescription = imageReferenceBlockReason === 'unsupported'
    ? t('video.production.imageReferenceBlockedDescription')
    : t('video.production.multiSubjectBlockedDescription');
  const bindingRisk = !!activeShot?.unresolvedCharacterRefs?.some((reference) => reference.trim());
  const actualKeyframeRefs = activeKeyframeVersion?.imageReferenceAssets
    ?? keyframePlan?.references
    ?? activeShot?.referenceAssets
    ?? [];
  const actualVideoRefs = selectedVideoVersion?.videoReferenceAssets
    ?? videoPlan?.references
    ?? activeClip?.videoReferenceAssets
    ?? [];
  const actualKeyframeContext = activeKeyframeVersion?.imageGenerationContext
    ?? keyframePlan?.executionContext
    ?? activeShot?.keyframeGenerationContext;
  const actualVideoContext = selectedVideoVersion?.generationContext
    ?? videoPlan?.executionContext
    ?? activeClip?.generationContext;
  const previousShot = useMemo(
    () => activeShot ? shots[activeShot.index - 1] : undefined,
    [activeShot?.index, shots],
  );
  const previousClip = previousShot
    ? project?.clips.find((clip) => clip.shotId === previousShot.id)
    : undefined;
  const previousTailImage = previousShot
    && isApprovedVideoClip(previousShot, previousClip)
    ? previousClip?.lastFrameImage
    : undefined;
  const continuityExpected = !!activeShot
    && !!previousShot
    && shotsShareScene(previousShot, activeShot)
    && shotsShareSubjects(previousShot, activeShot);
  const videoTailHandoffSent = actualVideoRefs.some((asset) => (
    asset.kind === 'previous' && asset.sentToProvider !== false
  ));
  const continuitySummary = !continuityExpected
    ? t('video.production.handoff.newSegment')
    : actualVideoContext?.continuity?.source === 'previous_tail' || videoTailHandoffSent
      ? t('video.production.handoff.tailApplied')
      : actualVideoContext?.temporalAuthority === 'approved_keyframe'
        ? t('video.production.handoff.approvedKeyframeApplied')
      : previousTailImage
        ? t('video.production.handoff.tailReady')
        : t('video.production.handoff.waitingTail');
  const continuityTone = !continuityExpected
    ? 'neutral'
    : actualVideoContext?.continuity?.source === 'previous_tail' || videoTailHandoffSent
      ? 'good'
      : actualVideoContext?.temporalAuthority === 'approved_keyframe'
        ? 'good'
      : previousTailImage
        ? 'ready'
        : 'warning';
  const sentKeyframeReferenceCount = actualKeyframeRefs.filter((asset) => asset.sentToProvider !== false).length;
  const handoffOutput = activeClip?.videoUrl
    ? t('video.production.handoff.videoReady')
    : activeShot?.keyframeImage
      ? t('video.production.handoff.keyframeReady')
      : t('video.production.handoff.pending');
  const actualKeyframeInvocation = useMemo(
    () => activeShot
      ? findInvocationForSnapshot(
          project?.stages.keyframe_image?.invocations,
          `${activeShot.id}:keyframe`,
          actualKeyframeSnapshot,
        )
      : undefined,
    [activeShot?.id, actualKeyframeSnapshot, project?.stages.keyframe_image?.invocations],
  );
  const actualVideoInvocation = useMemo(
    () => activeShot
      ? findInvocationForSnapshot(
          project?.stages.video_generation?.invocations,
          `${activeShot.id}:video`,
          actualVideoSnapshot,
        )
      : undefined,
    [activeShot?.id, actualVideoSnapshot, project?.stages.video_generation?.invocations],
  );
  const actualKeyframeParameters = formatSnapshotValues(actualKeyframeSnapshot?.wireParameterValues ?? actualKeyframeSnapshot?.parameterValues)
    || formatInvocationParameters(actualKeyframeInvocation);
  const actualVideoParameters = formatSnapshotValues(actualVideoSnapshot?.wireParameterValues ?? actualVideoSnapshot?.parameterValues)
    || formatInvocationParameters(actualVideoInvocation);
  const videoCandidateCount = activeShot?.versionHistory?.filter((version) => version.type === 'video').length ?? 0;
  const videoPreviewUrl = selectedVersion?.type === 'video' ? selectedVersion.url : activeClip?.videoUrl;
  const keyframePreviewUrl = activeShot?.keyframeImage;
  const canAssemble = shots.length > 0 && approvedCount === shots.length;
  const keyframeApproved = !!activeShot && isShotKeyframeApproved(activeShot);
  const generationBlocker = bindingRisk
    ? t('video.production.unresolvedBinding')
    : visibleSubjectRisk
      ? referenceBlockMessage
      : !imageGenerationReady
        ? t('video.production.imageProviderNotReady')
        : !videoGenerationReady
          ? t('video.production.videoProviderNotReady')
          : !imagePromptDraft.trim()
            ? t('video.production.imagePromptRequired')
          : !sourceDraft.trim() && !videoPromptDraft.trim()
            ? t('video.production.storyInputRequired')
            : undefined;

  const persistDrafts = () => {
    if (!activeShot) return;
    updateSceneSpecShot(pipelineId, activeShot.id, {
      sourceText: sourceDraft,
      imagePrompt: imagePromptDraft.trim() || undefined,
      videoPrompt: videoPromptDraft.trim(),
      durationSeconds: (durationSeconds || 5) as ShotSpec['durationSeconds'],
      seed,
    });
  };

  const getLatestShot = (): ShotSpec | undefined => {
    const latestProject = useVideoStore.getState().getProject(pipelineId);
    return getEffectiveShots(latestProject).find((shot) => shot.id === activeShot?.id);
  };

  /** Persist drafts first, then read the exact object that will cross the provider boundary. */
  const getGenerationSnapshot = () => {
    persistDrafts();
    const latestProject = useVideoStore.getState().getProject(pipelineId);
    const latestShots = getEffectiveShots(latestProject);
    const latestShot = latestShots.find((shot) => shot.id === activeShot?.id);
    if (!latestProject || !latestShot) return undefined;
    return { project: latestProject, shots: latestShots, shot: latestShot };
  };

  const handleOptimizePrompt = async () => {
    const snapshot = getGenerationSnapshot();
    if (!snapshot) return;
    const { project: latestProject, shot } = snapshot;
    setOptimizing(true);
    try {
      const plan = await planVideoPrompt({
        shot: {
          ...shot,
          sourceText: sourceDraft,
          videoPrompt: videoPromptDraft,
          visibleCharacterIds: shot.visibleCharacterIds,
          offscreenCharacterIds: shot.offscreenCharacterIds,
        },
        style: latestProject.sceneSpec?.meta.style || latestProject.spec.style,
        requestedAspectRatio: latestProject.spec.aspectRatio,
        durationSeconds,
        endpointId: latestProject.executionBinding?.video?.endpointId ?? activeVideoEndpoint?.id,
        model: videoCapabilities?.model ?? latestProject.executionBinding?.video?.model,
      });
      if (!plan.prompt?.trim()) throw new Error('The planner returned an empty prompt');
      setVideoPromptDraft(plan.prompt);
      updateSceneSpecShot(pipelineId, shot.id, {
        videoPrompt: plan.prompt,
        videoNegativePrompt: plan.negativePrompt,
        videoParameters: { ...plan.parameters, ...(videoCapabilities?.model ? { model: videoCapabilities.model } : {}) },
      });
      message.success(t('video.production.promptOptimized'));
    } catch (error) {
      message.error(`${t('video.production.promptOptimizeFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOptimizing(false);
    }
  };

  const handleGenerateKeyframe = async () => {
    if (!imagePromptDraft.trim()) {
      message.warning(t('video.production.imagePromptRequired'));
      setInspectorTab('contract');
      return;
    }
    const snapshot = getGenerationSnapshot();
    if (!snapshot) return;
    const { project: latestProject, shots: latestShots, shot } = snapshot;
    const imageCandidateIndex = (shot.versionHistory?.filter((version) => version.type === 'image').length ?? 0) + 1;
    const candidateSeed = getCandidateSeed(shot, seed, imageCandidateIndex);
    const generationShot = { ...shot, seed: candidateSeed };
    setGenerating('keyframe');
    try {
      const result = await generateSingleKeyframe(generationShot, shot.index, latestShots.map((item) => item.id === shot.id ? generationShot : item), {
        characters: latestProject.sceneSpec?.characters ?? [],
        scenes: latestProject.sceneSpec?.scenes ?? [],
        aspectRatio: latestProject.spec.aspectRatio,
        style: latestProject.sceneSpec?.meta.style || latestProject.spec.style,
        imageTier: latestProject.spec.imageTier || 'value',
        imageEndpointId: latestProject.executionBinding?.image?.endpointId ?? activeImageEndpoint?.id,
        imageModel: latestProject.executionBinding?.image?.model,
        novelProjectId: pipelineId,
        openingReferenceImage: latestProject.sceneSpec?.meta.openingReferenceImage,
        seed: candidateSeed,
        requireCharacterReferences: (latestProject.sceneSpec?.characters?.length ?? 0) > 0,
      });
      updateSceneSpecShot(pipelineId, shot.id, {
        keyframeImage: result.imagePath,
        referenceAssets: result.referenceAssets,
        keyframeInputFingerprint: result.inputFingerprint,
        keyframeGenerationContext: result.executionContext,
        generationPlan: result.generationPlan,
      });
      addShotVersion(pipelineId, shot.id, {
        id: `keyframe_${Date.now()}_${candidateSeed}`,
        type: 'image',
        url: result.imagePath,
        createdAt: new Date().toISOString(),
        prompt: imagePromptDraft || videoPromptDraft,
        seed: candidateSeed,
        inputFingerprint: result.inputFingerprint,
        imageReferenceAssets: result.referenceAssets,
        imageGenerationContext: result.executionContext,
        requestSnapshot: result.generationPlan?.keyframe?.requestSnapshot,
        responseSnapshot: result.generationPlan?.keyframe?.responseSnapshot,
        generationPlan: result.generationPlan,
        reviewStatus: 'unreviewed',
      });
      setPreviewTab('keyframe');
      message.success(t('video.production.keyframeGenerated'));
    } catch (error) {
      message.error(`${t('video.production.keyframeFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setGenerating(undefined);
    }
  };

  const handleGenerateVideo = async () => {
    const snapshot = getGenerationSnapshot();
    if (!snapshot) return;
    const { project: latestProject, shots: latestShots, shot: latestShot } = snapshot;
    if (latestProject.options?.enableI2V !== false && latestProject.options?.enableKeyframe !== false
      && !isShotKeyframeApproved(latestShot)) {
      message.warning(t('video.production.keyframeApprovalRequired'));
      setPreviewTab('keyframe');
      return;
    }
    const videoCandidateIndex = (latestShot.versionHistory?.filter((version) => version.type === 'video').length ?? 0) + 1;
    const candidateSeed = getCandidateSeed(latestShot, seed, videoCandidateIndex);
    const generationShot = {
      ...latestShot,
      durationSeconds: (durationSeconds || latestShot.durationSeconds || 5) as ShotSpec['durationSeconds'],
      seed: candidateSeed,
    };
    setGenerating('video');
    try {
      const previousShot = latestShots.find((candidate) => candidate.index === generationShot.index - 1);
      const previousClip = previousShot ? latestProject.clips.find((clip) => clip.shotId === previousShot.id) : undefined;
      const controlMode: VideoControlMode = videoMode === 'keyframe'
        ? 'keyframe'
        : videoMode === 'reference'
          ? 'reference'
          : 'text';
      const useReferences = videoMode !== 'text';
      const qualityPolicy = resolveVideoQualityPolicy(latestProject.options);
      const expectedTemporalAuthority = controlMode === 'keyframe'
        ? resolveTemporalAuthority(qualityPolicy.continuityMode, previousShot, generationShot, previousClip)
        : undefined;
      const clip = await generateSingleVideoClip(
        generationShot,
        {
          spec: {
            resolution: resolutionForAspect(
              latestProject.spec.aspectRatio,
              selectedResolutionTier ?? { id: '720p', shortEdge: 720 },
            ),
            fps: latestProject.spec.fps || 24,
            aspectRatio: latestProject.spec.aspectRatio,
            videoTier: latestProject.spec.videoTier || 'value',
          },
          characters: latestProject.sceneSpec?.characters ?? [],
          allShots: latestShots,
          novelProjectId: pipelineId,
          endpointId: latestProject.executionBinding?.video?.endpointId ?? activeVideoEndpoint?.id,
          model: videoCapabilities?.model ?? latestProject.executionBinding?.video?.model,
          imageEndpointId: latestProject.executionBinding?.image?.endpointId ?? activeImageEndpoint?.id,
          requireKeyframeForI2V: videoMode === 'keyframe',
          requireContinuityHandoff: videoMode === 'keyframe',
          temporalAuthority: expectedTemporalAuthority ?? 'approved_keyframe',
          allowReferenceFallback: false,
          controlMode,
          seed: candidateSeed,
        },
        useReferences,
        previousTailImage,
      );
      const qualityReview = evaluateVideoClipQuality(generationShot, clip, {
        assetAvailable: await isAssetAvailable(clip.videoUrl),
        requireI2V: useReferences,
        requiredControlMode: useReferences ? controlMode : undefined,
        requiredTemporalAuthority: expectedTemporalAuthority,
        requirePreviousTail: expectedTemporalAuthority === 'previous_tail',
        requireTailFrame: false,
      });
      const visualReview = latestProject.options?.enableVisualQualityGate === false
        ? undefined
        : await evaluateVideoClipVisually(generationShot, clip, {
            projectId: pipelineId,
            characters: latestProject.sceneSpec?.characters,
            scenes: latestProject.sceneSpec?.scenes,
          });
      const versionId = `video_${Date.now()}_${candidateSeed}`;
      const reviewedClip = { ...clip, shotVersionId: versionId, qualityReview, ...(visualReview ? { visualReview } : {}) };
      const videoGenerationPlan = updateShotGenerationPlan(generationShot, {
        video: {
          inputFingerprint: clip.inputFingerprint,
          executionContext: clip.generationContext,
          requestSnapshot: clip.requestSnapshot,
          responseSnapshot: clip.responseSnapshot,
          controlMode: clip.videoControlMode,
          referenceMode: clip.videoReferenceMode,
          references: clip.videoReferenceAssets ?? [],
          outputUrl: clip.videoUrl,
        },
      });
      updateSceneSpecShot(pipelineId, generationShot.id, {
        generationPlan: videoGenerationPlan,
      });
      setClips(pipelineId, [
        ...latestProject.clips.filter((candidate) => candidate.shotId !== generationShot.id),
        reviewedClip,
      ]);
      addShotVersion(pipelineId, generationShot.id, {
        id: versionId,
        type: 'video',
        url: clip.videoUrl,
        createdAt: new Date().toISOString(),
        prompt: videoPromptDraft,
        seed: candidateSeed,
        provider: clip.provider,
        model: clip.model,
        durationSeconds: clip.durationSeconds,
        generationContext: clip.generationContext,
        requestSnapshot: clip.requestSnapshot,
        responseSnapshot: clip.responseSnapshot,
        videoReferenceAssets: clip.videoReferenceAssets,
        videoReferenceMode: clip.videoReferenceMode,
        videoControlMode: clip.videoControlMode,
        lastFrameImage: clip.lastFrameImage,
        thumbnailUrl: clip.thumbnailUrl,
        hasAudio: clip.hasAudio,
        generationPlan: videoGenerationPlan,
        inputFingerprint: clip.inputFingerprint,
        qualityReview,
        visualReview,
        reviewStatus: 'unreviewed',
      });
      setPreviewTab('video');
      message.success(t('video.production.videoGenerated'));
    } catch (error) {
      message.error(`${t('video.production.videoFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setGenerating(undefined);
    }
  };

  const handleReferenceUpload = async (event: React.ChangeEvent<HTMLInputElement>, kind: 'manual' | 'supporting') => {
    const file = event.target.files?.[0];
    const shot = getLatestShot();
    if (!file || !shot) return;
    setUploading(kind);
    try {
      const dataUri = await readFileAsDataUri(file);
      const savedPath = await saveAsset(pipelineId, 'keyframe', dataUri, `${kind}_reference_${shot.index + 1}`);
      if (kind === 'manual') {
        updateSceneSpecShot(pipelineId, shot.id, { manualReferenceImage: savedPath });
      } else {
        updateSceneSpecShot(pipelineId, shot.id, {
          customReferenceImages: [...new Set([...(shot.customReferenceImages ?? []), savedPath])],
        });
      }
      message.success(t('video.production.referenceAdded'));
    } catch (error) {
      message.error(`${t('video.production.referenceUploadFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUploading(undefined);
      event.target.value = '';
    }
  };

  const handleRemoveSupportingReference = (url: string) => {
    if (!activeShot) return;
    updateSceneSpecShot(pipelineId, activeShot.id, {
      customReferenceImages: (activeShot.customReferenceImages ?? []).filter((item) => item !== url),
    });
  };

  const handleAddShot = () => {
    addSceneSpecShot(pipelineId, {
      sourceText: '',
      videoPrompt: '',
      durationSeconds: 5,
      characters: [],
      characterIds: [],
    });
    const latest = useVideoStore.getState().getProject(pipelineId);
    const nextShots = getEffectiveShots(latest);
    setSelectedShotId(nextShots[nextShots.length - 1]?.id);
  };

  const handleDeleteShot = () => {
    if (!activeShot) return;
    if (shots.length <= 1) {
      message.warning(t('video.production.keepOneShot'));
      return;
    }
    deleteSceneSpecShot(pipelineId, activeShot.id);
  };

  const handleSelectVersion = (version: ShotVersion) => {
    if (!activeShot) return;
    selectShotVersion(pipelineId, activeShot.id, version.id);
    setPreviewTab(version.type === 'video' ? 'video' : 'keyframe');
  };

  const handleReviewVersion = (version: ShotVersion, status: 'approved' | 'rejected') => {
    if (!activeShot) return;
    selectShotVersion(pipelineId, activeShot.id, version.id);
    reviewShotVersion(pipelineId, activeShot.id, version.id, status, reviewNote);
    if (status === 'approved') message.success(t('video.production.versionApproved'));
    else message.info(t('video.production.versionRejected'));
  };

  const handleLockVersion = (version: ShotVersion) => {
    if (!activeShot || version.type !== 'video' || getShotVersionStatus(version) !== 'approved') return;
    selectShotVersion(pipelineId, activeShot.id, version.id);
    const locked = lockShotVersion(pipelineId, activeShot.id, version.id);
    if (!locked) {
      message.warning(t('video.production.lockVersionBlocked'));
      return;
    }
    message.success(t('video.production.versionLocked'));
  };

  if (!project) {
    return <Empty description={t('video.pipeline.empty')} />;
  }

  return (
    <div className="shot-production-board">
      <div className="shot-production-toolbar">
        <div className="shot-production-toolbar-copy">
          <Text strong>{t('video.production.workbenchTitle')}</Text>
          <Text type="secondary">{t('video.production.workbenchHint')}</Text>
        </div>
        <div className="shot-production-progress-metrics">
          <span><strong>{keyframeCount}</strong>/{shots.length} {t('video.production.keyframes')}</span>
          <span><strong>{clipCount}</strong>/{shots.length} {t('video.production.clips')}</span>
          <span className={approvedCount === shots.length && shots.length > 0 ? 'is-good' : ''}><strong>{approvedCount}</strong>/{shots.length} {t('video.production.locked')}</span>
        </div>
        <Progress
          className="shot-production-progress"
          percent={shots.length ? Math.round((approvedCount / shots.length) * 100) : 0}
          showInfo={false}
          size="small"
        />
        <div className="shot-production-toolbar-actions">
          <Button size="small" icon={<FileSearchOutlined />} onClick={onOpenFlow}>{t('video.production.trace')}</Button>
          <Button size="small" data-testid="shot-production-open-timeline" icon={<SoundOutlined />} onClick={onOpenTimeline}>{t('video.production.timeline')}</Button>
          <Button size="small" type="primary" icon={<CheckOutlined />} disabled={!canAssemble || productionBusy || !!generating} onClick={onAssemble}>
            {t('video.production.assemble')}
          </Button>
        </div>
      </div>

      {activeShot && readiness && (
        <ShotProductionStepStrip shot={activeShot} readiness={readiness} t={t} />
      )}

      {shots.length === 0 ? (
        <div className="shot-production-empty">
          <PictureOutlined />
          <Title level={5}>{t('video.production.noShotsTitle')}</Title>
          <Text type="secondary">{t('video.production.noShotsDescription')}</Text>
          <Space>
            <Button type="primary" data-testid="shot-production-add-shot" icon={<PlusOutlined />} onClick={handleAddShot}>{t('video.production.addShot')}</Button>
            <Button icon={<FileSearchOutlined />} onClick={onOpenScript}>{t('video.production.openScript')}</Button>
          </Space>
        </div>
      ) : (
        <div className="shot-production-grid">
          <aside className="shot-production-queue" aria-label={t('video.production.shotQueue')}>
            <div className="shot-production-section-heading">
              <div>
                <Text strong>{t('video.production.shotQueue')}</Text>
                <Text type="secondary">{t('video.production.queueHint')}</Text>
              </div>
              <Tooltip title={t('video.production.addShot')}>
                <Button type="text" icon={<PlusOutlined />} aria-label={t('video.production.addShot')} onClick={handleAddShot} />
              </Tooltip>
            </div>
            <div className="shot-production-shot-list">
              {shots.map((shot) => {
                const clip = project.clips.find((candidate) => candidate.shotId === shot.id);
                const shotReadiness = getShotProductionReadiness(shot, clip, true);
                const thumbnail = shot.keyframeImage || clip?.thumbnailUrl;
                return (
                  <button
                    type="button"
                    key={shot.id}
                    className={`shot-production-shot-item ${shot.id === activeShot?.id ? 'is-active' : ''}`}
                    onClick={() => setSelectedShotId(shot.id)}
                  >
                    <span className="shot-production-shot-thumb">
                      {thumbnail ? <img src={imageSrc(thumbnail)} alt="" /> : <PictureOutlined />}
                    </span>
                    <span className="shot-production-shot-copy">
                      <strong>{t('video.production.shotNumber', { number: shot.index + 1 })}</strong>
                      <small>{(shot.sourceText || shot.videoPrompt || t('video.production.emptyShot')).slice(0, 44)}</small>
                      <span className="shot-production-shot-meta">
                        <Tag color={stateColor(shotReadiness.state)} icon={stateIcon(shotReadiness.state)}>{t(`video.production.state.${shotReadiness.state}`)}</Tag>
                        <span>{shot.durationSeconds}s</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <Button className="shot-production-add-shot" data-testid="shot-production-add-shot" icon={<PlusOutlined />} onClick={handleAddShot}>
              {t('video.production.addShot')}
            </Button>
          </aside>

          {activeShot && (
            <section className="shot-production-editor">
              <div className="shot-production-editor-header">
                <div className="shot-production-editor-title">
                  <div className="shot-production-shot-heading">
                    <Text className="shot-production-shot-index">{t('video.production.shotNumber', { number: activeShot.index + 1 })}</Text>
                    <Tag color={readiness ? stateColor(readiness.state) : 'default'} icon={readiness ? stateIcon(readiness.state) : undefined}>
                      {readiness ? t(`video.production.state.${readiness.state}`) : t('video.production.state.needs_prompt')}
                    </Tag>
                  </div>
                  <Text type="secondary">{activeShot.location || t('video.production.locationUnset')} · {activeShot.durationSeconds}s</Text>
                </div>
                <Space>
                  <Button size="small" icon={<DeleteOutlined />} danger onClick={handleDeleteShot}>{t('common.delete')}</Button>
                  <Segmented
                    size="small"
                    value={previewTab}
                    onChange={(value) => setPreviewTab(value as PreviewTab)}
                    options={[
                      { value: 'keyframe', label: <span><PictureOutlined /> {t('video.production.keyframe')}</span> },
                      { value: 'video', label: <span><VideoCameraOutlined /> {t('video.production.video')}</span> },
                    ]}
                  />
                </Space>
              </div>

              <div className="shot-production-preview-wrap">
                <div className="shot-production-preview">
                  {previewTab === 'video' && videoPreviewUrl ? (
                    <video src={imageSrc(videoPreviewUrl)} controls playsInline preload="metadata" />
                  ) : keyframePreviewUrl ? (
                    <Image src={imageSrc(keyframePreviewUrl)} preview={{ mask: <span>{t('video.production.previewImage')}</span> }} />
                  ) : (
                    <div className="shot-production-preview-empty">
                      {generating ? <Spin size="large" /> : <PictureOutlined />}
                      <Text type="secondary">{previewTab === 'video' ? t('video.production.noVideo') : t('video.production.noKeyframe')}</Text>
                    </div>
                  )}
                  {activeClip?.qualityReview && (
                    <Tag className="shot-production-preview-quality" color={activeClip.qualityReview.status === 'passed' ? 'success' : activeClip.qualityReview.status === 'failed' ? 'error' : 'warning'}>
                      {t('video.production.technicalScore', { score: activeClip.qualityReview.score })}
                    </Tag>
                  )}
                </div>
                <div className="shot-production-preview-caption">
                  <div>
                    <Text strong>{previewTab === 'video' ? t('video.production.videoOutput') : t('video.production.keyframeOutput')}</Text>
                    <Text type="secondary">{previewTab === 'video' ? (activeClip?.model || t('video.production.waitingProvider')) : t('video.production.keyframeCaption')}</Text>
                  </div>
                  {activeClip?.videoControlMode && <Tag>{activeClip.videoControlMode.toUpperCase()}</Tag>}
                </div>
              </div>

              <section className="shot-production-handoff" aria-label={t('video.production.handoff.title')}>
                <div className="shot-production-handoff-header">
                  <div>
                    <Text strong>{t('video.production.handoff.title')}</Text>
                    <Text type="secondary">{t('video.production.handoff.hint')}</Text>
                  </div>
                  <Tag color={continuityTone === 'good' ? 'success' : continuityTone === 'warning' ? 'warning' : continuityTone === 'ready' ? 'processing' : 'default'}>
                    {continuitySummary}
                  </Tag>
                </div>
                <div className="shot-production-handoff-grid">
                  <div className="shot-production-handoff-item">
                    <span>{t('video.production.handoff.input')}</span>
                    <strong>{activeCharacters.length > 0 ? activeCharacters.map((character) => character.name).join('、') : t('video.production.noVisibleSubjects')}</strong>
                    <small>{activeScene?.name || t('video.production.sceneUnset')}</small>
                  </div>
                  <div className="shot-production-handoff-item">
                    <span>{t('video.production.handoff.reference')}</span>
                    <strong>{actualKeyframeRefs.length > 0 ? t('video.production.referenceCount', { count: sentKeyframeReferenceCount }) : t('video.production.handoff.pending')}</strong>
                    <small>{actualVideoContext?.continuity?.source === 'previous_tail' || videoTailHandoffSent
                      ? t('video.production.handoff.tailApplied')
                      : actualVideoContext?.temporalAuthority === 'approved_keyframe'
                        ? t('video.production.handoff.approvedKeyframeApplied')
                        : t('video.production.keyframeCaption')}</small>
                  </div>
                  <div className="shot-production-handoff-item">
                    <span>{t('video.production.handoff.output')}</span>
                    <strong>{handoffOutput}</strong>
                    <small>{actualVideoContext?.model || t('video.production.handoff.pending')}</small>
                  </div>
                  <div className="shot-production-handoff-item">
                    <span>{t('video.production.handoff.next')}</span>
                    <strong>{activeClip?.videoUrl ? t('video.production.handoff.awaitReview') : t('video.production.handoff.generate')}</strong>
                    <small>{continuityExpected ? continuitySummary : t('video.production.handoff.newSegment')}</small>
                  </div>
                </div>
              </section>

              <div className="shot-production-prompt-area">
                <div className="shot-production-section-heading">
                  <div>
                    <Text strong>{t('video.production.storyInput')}</Text>
                    <Text type="secondary">{t('video.production.storyInputHint')}</Text>
                  </div>
                  <Space>
                    <Button size="small" icon={<ReloadOutlined />} loading={optimizing} onClick={() => void handleOptimizePrompt()}>
                      {t('video.production.optimizePrompt')}
                    </Button>
                    <Button size="small" icon={<SettingOutlined />} onClick={onOpenAssets}>{t('video.production.assets')}</Button>
                  </Space>
                </div>
                <TextArea
                  className="shot-production-source-input"
                  value={sourceDraft}
                  onChange={(event) => setSourceDraft(event.target.value)}
                  onBlur={persistDrafts}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder={t('video.production.storyPlaceholder')}
                />
                <div className="shot-production-prompt-grid">
                  <label>
                    <span>{t('video.production.imagePrompt')}</span>
                    <TextArea
                      value={imagePromptDraft}
                      onChange={(event) => setImagePromptDraft(event.target.value)}
                      onBlur={persistDrafts}
                      autoSize={{ minRows: 3, maxRows: 6 }}
                      placeholder={t('video.production.imagePromptPlaceholder')}
                    />
                  </label>
                  <label>
                    <span>{t('video.production.videoPrompt')}</span>
                    <TextArea
                      value={videoPromptDraft}
                      onChange={(event) => setVideoPromptDraft(event.target.value)}
                      onBlur={persistDrafts}
                      autoSize={{ minRows: 3, maxRows: 6 }}
                      placeholder={t('video.production.videoPromptPlaceholder')}
                    />
                  </label>
                </div>
              </div>

              {generationBlocker && (
                <Alert
                  className="shot-production-generation-blocker"
                  type="warning"
                  showIcon
                  message={t('video.production.generationBlocked')}
                  description={generationBlocker}
                />
              )}
              <div className="shot-production-generate-bar">
                <div className="shot-production-control-group">
                  <label>
                    <span>{t('video.production.videoModel')}</span>
                    <Select
                      size="small"
                      data-testid="shot-production-video-model"
                      aria-label={t('video.production.videoModel')}
                      value={videoCapabilities?.model}
                      disabled={!!generating || videoModelOptions.length === 0}
                      popupMatchSelectWidth={false}
                      options={videoModelOptions.map((value) => ({ value, label: value }))}
                      onChange={(model) => updateSceneSpecShot(pipelineId, activeShot.id, { videoParameters: { model } })}
                    />
                  </label>
                  {imageSizeOptions.includes('2K') && (
                    <label>
                      <span>{t('video.production.imageSize')}</span>
                      <Select
                        size="small"
                        aria-label={t('video.production.imageSize')}
                        value={typeof activeShot.imageParameters?.size === 'string' ? activeShot.imageParameters.size : '2K'}
                        disabled={!!generating}
                        options={imageSizeOptions.map((value) => ({ value, label: value }))}
                        onChange={(size) => updateSceneSpecShot(pipelineId, activeShot.id, { imageParameters: { ...activeShot.imageParameters, size } })}
                      />
                    </label>
                  )}
                  <label>
                    <span>{t('video.production.videoMode')}</span>
                    <Select
                      size="small"
                      value={videoMode}
                      onChange={(value) => setVideoMode(value as VideoMode)}
                      options={[
                        {
                          value: 'keyframe',
                          label: t('video.production.mode.keyframe'),
                          disabled: videoCapabilities?.references.supportsFirstFrame !== true,
                        },
                        {
                          value: 'reference',
                          label: t('video.production.mode.reference'),
                          disabled: videoCapabilities?.references.supportsSubjectReferences !== true,
                        },
                        { value: 'text', label: t('video.production.mode.text') },
                      ]}
                    />
                  </label>
                  <label>
                    <span>{t('video.production.resolution')}</span>
                    <Select
                      size="small"
                      value={selectedResolutionTier?.id}
                      onChange={(value) => setResolutionTierId(value)}
                      options={resolutionTiers.map((tier) => ({ value: tier.id, label: tier.label ?? tier.id }))}
                    />
                  </label>
                  <label>
                    <span>{t('video.production.duration')}</span>
                    {durationOptions.length > 0 ? (
                      <Select
                        size="small"
                        value={durationSeconds}
                        onChange={(value) => setDurationSeconds(Number(value))}
                        options={durationOptions.map((value) => ({ value, label: `${value}s` }))}
                      />
                    ) : (
                      <InputNumber
                        size="small"
                        min={durationParameter?.min}
                        max={durationParameter?.max}
                        step={durationParameter?.type === 'integer' ? 1 : 0.5}
                        value={durationSeconds}
                        onChange={(value) => setDurationSeconds(normalizeNumberForParameter(value ?? undefined, durationParameter, 5))}
                      />
                    )}
                  </label>
                  <label>
                    <span>{t('video.production.seed')}</span>
                    <InputNumber size="small" min={0} value={seed} placeholder={t('video.production.randomSeed')} onChange={(value) => setSeed(value ?? undefined)} />
                  </label>
                </div>
                <div className="shot-production-candidate-summary" data-testid="shot-production-candidate-summary">
                  <Tag color={videoCandidateCount > 0 ? 'blue' : 'default'}>
                    {t('video.production.candidateCount', { count: videoCandidateCount })}
                  </Tag>
                  <Text type="secondary">{t('video.production.candidateSeed', { seed: getCandidateSeed(activeShot, seed, videoCandidateCount + 1) })}</Text>
                </div>
                <div className="shot-production-generate-actions">
                  <Button icon={<PictureOutlined />} loading={generating === 'keyframe'} disabled={productionBusy || !!generating || !imageGenerationReady || visibleSubjectRisk || bindingRisk || !imagePromptDraft.trim()} onClick={() => void handleGenerateKeyframe()}>
                    {t('video.production.generateKeyframe')}
                  </Button>
                  <Button type="primary" icon={<PlayCircleOutlined />} loading={generating === 'video'} disabled={productionBusy || !!generating || !videoGenerationReady || bindingRisk || (videoMode === 'keyframe' && (!activeShot.keyframeImage || !keyframeApproved))} onClick={() => void handleGenerateVideo()}>
                    {videoCandidateCount > 0 ? t('video.production.generateAnotherVideo') : t('video.production.generateVideo')}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {activeShot && (
            <aside className="shot-production-inspector">
              <div className="shot-production-inspector-header">
                <div>
                  <Text strong>{t('video.production.shotDetails')}</Text>
                  <Text type="secondary">{t('video.production.shotDetailsHint')}</Text>
                </div>
                <Tag color={readiness && readiness.state === 'approved' ? 'success' : 'processing'}>
                  {readiness ? t(`video.production.state.${readiness.state}`) : t('video.production.pending')}
                </Tag>
              </div>
              <div className="shot-production-inspector-tabs" role="tablist" aria-label={t('video.production.shotDetails')}>
                {([
                  ['contract', t('video.production.inputContract'), <EditOutlined />],
                  ['references', t('video.production.supportingReferences'), <PictureOutlined />],
                  ['request', t('video.production.actualRequest'), <SettingOutlined />],
                  ['review', t('video.production.versionReview'), <CheckCircleOutlined />],
                ] as Array<[InspectorTab, string, React.ReactNode]>).map(([tab, label, icon]) => (
                  <button
                    type="button"
                    key={tab}
                    role="tab"
                    aria-selected={inspectorTab === tab}
                    data-tab={tab}
                    className={`shot-production-inspector-tab ${inspectorTab === tab ? 'is-active' : ''}`}
                    onClick={() => setInspectorTab(tab)}
                  >
                    {icon}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div className="shot-production-inspector-sections">
              <section className={`shot-production-inspector-section ${inspectorTab === 'contract' ? '' : 'is-panel-hidden'}`} data-testid="shot-production-input-contract">
                <div className="shot-production-section-heading">
                  <div>
                    <Text strong>{t('video.production.inputContract')}</Text>
                    <Text type="secondary">{t('video.production.inputContractHint')}</Text>
                  </div>
                </div>
                {bindingRisk && (
                  <Alert
                    type="error"
                    showIcon
                    message={t('video.production.unresolvedBinding')}
                    description={t('video.production.unresolvedBindingDescription', {
                      references: (activeShot.unresolvedCharacterRefs ?? []).join('、'),
                    })}
                  />
                )}
                <div className="shot-production-entity-list">
                  <div className="shot-production-entity-row">
                    <span className="shot-production-entity-label">{t('video.production.visibleSubjects')}</span>
                    <div className="shot-production-entity-values">
                      {activeCharacters.length > 0 ? activeCharacters.map((character: CharacterAnchor) => (
                        <Tag key={character.id} icon={character.portraitImage ? <PictureOutlined /> : undefined}>{character.name}</Tag>
                      )) : <Text type="secondary">{t('video.production.noVisibleSubjects')}</Text>}
                    </div>
                  </div>
                  <div className="shot-production-entity-row">
                    <span className="shot-production-entity-label">{t('video.production.sceneReference')}</span>
                    <div className="shot-production-entity-values">
                      {activeScene ? <Tag icon={activeScene.backgroundImage ? <PictureOutlined /> : undefined}>{activeScene.name}</Tag> : <Text type="secondary">{t('video.production.sceneUnset')}</Text>}
                    </div>
                  </div>
                </div>
                <div className="shot-production-binding-editor">
                  <label>
                    <span>{t('video.production.visibleSubjects')}</span>
                    <Select
                      size="small"
                      mode="multiple"
                      value={activeShot.visibleCharacterIds ?? activeShot.characterIds ?? []}
                      placeholder={t('video.production.noVisibleSubjects')}
                      options={characters.map((character) => ({ value: character.id, label: character.name }))}
                      onChange={(values) => updateSceneSpecShot(pipelineId, activeShot.id, {
                        characterIds: values,
                        visibleCharacterIds: values,
                        characterBinding: 'explicit',
                        unresolvedCharacterRefs: undefined,
                      })}
                    />
                  </label>
                  <label>
                    <span>{t('video.production.sceneReference')}</span>
                    <Select
                      size="small"
                      allowClear
                      value={activeShot.sceneId}
                      placeholder={t('video.production.sceneUnset')}
                      options={scenes.map((scene) => ({ value: scene.id, label: scene.name }))}
                      onChange={(value) => updateSceneSpecShot(pipelineId, activeShot.id, { sceneId: value || undefined })}
                    />
                  </label>
                </div>
                {visibleSubjectRisk && (
                  <Alert
                    type="warning"
                    showIcon
                    message={referenceBlockMessage}
                    description={referenceBlockDescription}
                  />
                )}
              </section>

              <section className={`shot-production-inspector-section ${inspectorTab === 'references' ? '' : 'is-panel-hidden'}`} data-testid="shot-production-reference-assets">
                <div className="shot-production-section-heading">
                  <div>
                    <Text strong>{t('video.production.referenceAssetsTitle')}</Text>
                    <Text type="secondary">{t('video.production.referenceAssetsHint')}</Text>
                  </div>
                </div>
                <div className="shot-production-reference-block">
                  <div className="shot-production-reference-heading">
                    <Text strong>{t('video.production.manualShotReference')}</Text>
                    <Tag>{activeShot.manualReferenceImage ? t('video.production.referenceReady') : t('video.production.referenceOptional')}</Tag>
                  </div>
                  <div className="shot-production-manual-reference">
                    {activeShot.manualReferenceImage ? (
                      <>
                        <Image src={imageSrc(activeShot.manualReferenceImage)} preview />
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => updateSceneSpecShot(pipelineId, activeShot.id, { manualReferenceImage: undefined })}
                        >
                          {t('common.remove')}
                        </Button>
                      </>
                    ) : (
                      <Button icon={<UploadOutlined />} loading={uploading === 'manual'} onClick={() => manualReferenceInput.current?.click()}>
                        {t('video.production.uploadShotReference')}
                      </Button>
                    )}
                    <input ref={manualReferenceInput} type="file" accept="image/*" hidden onChange={(event) => void handleReferenceUpload(event, 'manual')} />
                  </div>
                  <Text type="secondary" className="shot-production-reference-help">{t('video.production.manualShotReferenceHint')}</Text>
                </div>
                <div className="shot-production-reference-block">
                  <div className="shot-production-reference-heading">
                    <Text strong>{t('video.production.supportingReferences')}</Text>
                    <Button size="small" icon={<UploadOutlined />} loading={uploading === 'supporting'} onClick={() => supportingReferenceInput.current?.click()}>
                      {t('video.production.addReference')}
                    </Button>
                    <input ref={supportingReferenceInput} type="file" accept="image/*" hidden onChange={(event) => void handleReferenceUpload(event, 'supporting')} />
                  </div>
                  {(activeShot.customReferenceImages ?? []).length > 0 ? (
                    <div className="shot-production-supporting-list">
                      {(activeShot.customReferenceImages ?? []).map((url, index) => (
                        <div className="shot-production-supporting-item" key={`${url}-${index}`}>
                          <Image src={imageSrc(url)} preview={false} />
                          <span>{t('video.production.referenceNumber', { number: index + 1 })}</span>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('common.remove')} onClick={() => handleRemoveSupportingReference(url)} />
                        </div>
                      ))}
                    </div>
                  ) : <Text type="secondary">{t('video.production.noSupportingReferences')}</Text>}
                </div>
              </section>

              <section className={`shot-production-inspector-section ${inspectorTab === 'request' ? '' : 'is-panel-hidden'}`} data-testid="shot-production-actual-request">
                <div className="shot-production-section-heading">
                  <div>
                    <Text strong>{t('video.production.actualRequest')}</Text>
                    <Text type="secondary">{t('video.production.actualRequestHint')}</Text>
                  </div>
                </div>
                <div className="shot-production-request-list">
                  <div><span>{t('video.production.imageProvider')}</span><strong>{actualKeyframeContext?.provider && actualKeyframeContext.model ? `${actualKeyframeContext.provider} / ${actualKeyframeContext.model}` : t('video.production.notGenerated')}</strong></div>
                  <div><span>{t('video.production.videoProvider')}</span><strong>{actualVideoContext?.provider && actualVideoContext.model ? `${actualVideoContext.provider} / ${actualVideoContext.model}` : t('video.production.notGenerated')}</strong></div>
                  <div><span>{t('video.production.keyframeReferences')}</span><strong>{actualKeyframeRefs.length > 0 ? t('video.production.referenceCount', { count: actualKeyframeRefs.filter((asset) => asset.sentToProvider !== false).length }) : t('video.production.notGenerated')}</strong></div>
                  <div><span>{t('video.production.videoReferences')}</span><strong>{actualVideoRefs.length > 0 ? t('video.production.referenceCount', { count: actualVideoRefs.filter((asset) => asset.sentToProvider !== false).length }) : t('video.production.notGenerated')}</strong></div>
                  <div><span>{t('video.production.controlMode')}</span><strong>{selectedVideoVersion?.videoControlMode?.toUpperCase() || activeClip?.videoControlMode?.toUpperCase() || t('video.production.pending')}</strong></div>
                  <div><span>{t('video.production.temporalAuthority')}</span><strong>{actualVideoContext?.temporalAuthority === 'previous_tail'
                    ? t('video.production.handoff.tailApplied')
                    : actualVideoContext?.temporalAuthority === 'approved_keyframe'
                      ? t('video.production.handoff.approvedKeyframeApplied')
                      : t('video.production.pending')}</strong></div>
                  <div><span>{t('video.production.keyframeParameters')}</span><strong>{actualKeyframeParameters || t('video.production.notGenerated')}</strong></div>
                  <div><span>{t('video.production.videoParameters')}</span><strong>{actualVideoParameters || t('video.production.notGenerated')}</strong></div>
                </div>
                {([
                  {
                    label: t('video.production.keyframe'),
                    snapshot: actualKeyframeSnapshot,
                    responseSnapshot: actualKeyframeResponse,
                    invocation: actualKeyframeInvocation,
                  },
                  {
                    label: t('video.production.video'),
                    snapshot: actualVideoSnapshot,
                    responseSnapshot: actualVideoResponse,
                    invocation: actualVideoInvocation,
                  },
                ]).map(({ label, snapshot, responseSnapshot, invocation }) => {
                  if (!snapshot) return null;
                  const response = responseSnapshot ?? invocation?.responseSnapshot;
                  return (
                    <div className="shot-production-request-audit" key={label}>
                      <div className="shot-production-request-audit-title">
                        <Text strong>{label}</Text>
                        <Tag color={invocation?.executionStatus === 'succeeded' ? 'success' : 'warning'}>
                          {invocation?.executionStatus || t('video.production.pending')}
                        </Tag>
                      </div>
                      <div className="shot-production-request-audit-row">
                        <span>{t('video.production.plannedParameters')}</span>
                        <code>{formatSnapshotValues(snapshot.parameterValues) || '-'}</code>
                      </div>
                      <div className="shot-production-request-audit-row">
                        <span>{t('video.production.wireParameters')}</span>
                        <code>{formatSnapshotValues(snapshot.wireParameterValues ?? snapshot.parameterValues) || '-'}</code>
                      </div>
                      <div className="shot-production-request-audit-row">
                        <span>{t('video.production.filteredParameters')}</span>
                        <code>{snapshot.rejectedParameterKeys.length > 0 ? snapshot.rejectedParameterKeys.join(', ') : '-'}</code>
                      </div>
                      <div className="shot-production-request-audit-row">
                        <span>{t('video.production.providerOutput')}</span>
                        <code>{response
                          ? `${response.width ?? '?'}x${response.height ?? '?'} · ${response.durationSeconds ?? '?'}s · ${response.outputFingerprint ?? '-'}`
                          : t('video.production.notGenerated')}</code>
                      </div>
                      <div className="shot-production-request-slots">
                        {snapshot.referenceSlots.length === 0 ? (
                          <Text type="secondary">{t('video.production.noReferenceSlots')}</Text>
                        ) : snapshot.referenceSlots.map((slot) => (
                          <Tag key={slot.id}>
                            #{slot.providerIndex + 1} {slot.role} · {shortFingerprint(slot.payloadFingerprint)}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {actualKeyframeRefs.length > 0 && (
                  <div className="shot-production-actual-refs">
                    {actualKeyframeRefs.map((asset) => (
                      <div className={`shot-production-actual-ref ${asset.sentToProvider === false ? 'is-omitted' : 'is-sent'}`} key={asset.id}>
                        <img src={imageSrc(asset.imageUrl)} alt="" />
                        <span>{asset.label}</span>
                        <Tag>{asset.sentToProvider === false ? t('video.production.omitted') : `#${(asset.providerIndex ?? 0) + 1}`}</Tag>
                      </div>
                    ))}
                  </div>
                )}
                {actualVideoRefs.length > 0 && (
                  <div className="shot-production-actual-refs">
                    {actualVideoRefs.map((asset) => (
                      <div className={`shot-production-actual-ref ${asset.sentToProvider === false ? 'is-omitted' : 'is-sent'}`} key={`video-${asset.id}`}>
                        <img src={imageSrc(asset.imageUrl)} alt="" />
                        <span>{asset.label}</span>
                        <Tag>{asset.sentToProvider === false ? t('video.production.omitted') : `#${(asset.providerIndex ?? 0) + 1}`}</Tag>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className={`shot-production-inspector-section shot-production-review-section ${inspectorTab === 'review' ? '' : 'is-panel-hidden'}`} data-testid="shot-production-version-review">
                <div className="shot-production-section-heading">
                  <div>
                    <Text strong>{t('video.production.versionReview')}</Text>
                    <Text type="secondary">{t('video.production.versionReviewHint')}</Text>
                  </div>
                  {activeShot.lockedVersionId && <Tag color="success" icon={<LockOutlined />}>{t('video.production.lockedVersion')}</Tag>}
                </div>
                <Input
                  size="small"
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  placeholder={t('video.production.reviewNotePlaceholder')}
                />
                <div className="shot-production-version-list">
                  {(activeShot.versionHistory ?? []).length === 0 ? (
                    <Text type="secondary">{t('video.production.noVersions')}</Text>
                  ) : (activeShot.versionHistory ?? []).map((version, index) => {
                    const status = getShotVersionStatus(version);
                    const selected = activeShot.selectedVersionId === version.id;
                    const locked = activeShot.lockedVersionId === version.id;
                    return (
                      <div className={`shot-production-version ${selected ? 'is-selected' : ''} ${locked ? 'is-locked' : ''}`} key={version.id}>
                        <button type="button" className="shot-production-version-main" onClick={() => handleSelectVersion(version)}>
                          <span className="shot-production-version-thumb">
                            {version.type === 'video' ? <video src={imageSrc(version.url)} muted preload="metadata" /> : <img src={imageSrc(version.url)} alt="" />}
                          </span>
                          <span className="shot-production-version-copy">
                            <strong>{getVersionLabel(version, index, t)}</strong>
                            <small>{version.importedVideo ? t('studio.transfer.inspectedVideo') : version.sourceStudioAssetId ? t('studio.transfer.importedCandidate') : version.model || t('video.production.generatedLocally')}</small>
                            {version.seed !== undefined && <small>{t('video.production.candidateSeed', { seed: version.seed })}</small>}
                            <Tag color={status === 'approved' ? 'success' : status === 'rejected' ? 'error' : 'default'}>{t(`video.production.review.${status}`)}</Tag>
                            {version.qualityReview && <Tag color={version.qualityReview.status === 'passed' ? 'success' : version.qualityReview.status === 'failed' ? 'error' : 'warning'}>{t('video.production.technicalScore', { score: version.qualityReview.score })}</Tag>}
                            {version.visualReview && <Tag color={version.visualReview.status === 'passed' ? 'success' : version.visualReview.status === 'failed' ? 'error' : 'warning'}>{t('video.production.visualScore', { score: version.visualReview.score ?? t('video.production.notAvailable') })}</Tag>}
                          </span>
                        </button>
                        <div className="shot-production-version-actions">
                          {status !== 'approved' && <Tooltip title={t('video.production.approveVersion')}><Button type="text" size="small" icon={<CheckOutlined />} onClick={() => handleReviewVersion(version, 'approved')} /></Tooltip>}
                          {status !== 'rejected' && <Tooltip title={t('video.production.rejectVersion')}><Button type="text" size="small" danger icon={<WarningOutlined />} onClick={() => handleReviewVersion(version, 'rejected')} /></Tooltip>}
                          {version.type === 'video' && status === 'approved' && !locked && <Tooltip title={t('video.production.lockVersion')}><Button type="text" size="small" icon={<LockOutlined />} onClick={() => handleLockVersion(version)} /></Tooltip>}
                          {locked && <LockOutlined className="shot-production-locked-icon" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {activeClip?.qualityReview && (
                  <div className="shot-production-quality-summary">
                    <Text strong>{t('video.production.technicalReview')}</Text>
                    <Tag color={activeClip.qualityReview.status === 'passed' ? 'success' : activeClip.qualityReview.status === 'failed' ? 'error' : 'warning'}>
                      {activeClip.qualityReview.score}
                    </Tag>
                    <Text type="secondary">{activeClip.qualityReview.checks.filter((check) => check.status === 'fail').length > 0 ? t('video.production.technicalFailed') : t('video.production.technicalPassed')}</Text>
                  </div>
                )}
                {activeClip?.visualReview && (
                  <div className="shot-production-quality-summary">
                    <Text strong>{t('video.production.visualReview')}</Text>
                    <Tag color={activeClip.visualReview.status === 'passed' ? 'success' : activeClip.visualReview.status === 'failed' ? 'error' : 'warning'}>
                      {activeClip.visualReview.score ?? t('video.production.notAvailable')}
                    </Tag>
                    <Text type="secondary">
                      {activeClip.visualReview.status === 'unavailable'
                        ? t('video.production.visualUnavailable')
                        : activeClip.visualReview.summary || t('video.production.visualReviewComplete')}
                    </Text>
                  </div>
                )}
              </section>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
};

function ShotProductionStepStrip({
  shot,
  readiness,
  t,
}: {
  shot: ShotSpec;
  readiness: ReturnType<typeof getShotProductionReadiness>;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const inputState: ShotStepState = readiness.state === 'needs_prompt' || readiness.state === 'needs_binding'
    ? 'blocked'
    : 'done';
  const keyframeState: ShotStepState = !isShotKeyframeCurrent(shot)
    ? 'active'
    : isShotKeyframeApproved(shot) ? 'done' : 'active';
  const videoState: ShotStepState = readiness.qualityFailed
    ? 'blocked'
    : readiness.hasVideo ? 'done' : 'pending';
  const lockState: ShotStepState = readiness.isLocked && readiness.selectedVersion?.type === 'video'
    ? 'done'
    : readiness.hasVideo ? 'active' : 'pending';
  const steps: Array<{ number: string; label: string; state: ShotStepState }> = [
    { number: '01', label: t('video.production.inputContract'), state: inputState },
    { number: '02', label: t('video.production.keyframe'), state: keyframeState },
    { number: '03', label: t('video.production.video'), state: videoState },
    { number: '04', label: t('video.production.versionReview'), state: lockState },
  ];

  return (
    <div className="shot-production-step-strip" aria-label={t('video.production.workbenchTitle')}>
      {steps.map((step, index) => (
        <React.Fragment key={step.number}>
          <div className={`shot-production-step is-${step.state}`}>
            <span className="shot-production-step-number">{step.number}</span>
            <span className="shot-production-step-icon">{shotStepIcon(step.state)}</span>
            <strong>{step.label}</strong>
          </div>
          {index < steps.length - 1 && <ArrowRightOutlined className="shot-production-step-arrow" />}
        </React.Fragment>
      ))}
    </div>
  );
}

export default ShotProductionBoard;

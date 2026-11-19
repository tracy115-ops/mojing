import React, { useMemo } from 'react';
import {
  Alert,
  Button,
  Empty,
  Progress,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
  PictureOutlined,
  ProfileOutlined,
  RocketOutlined,
  SettingOutlined,
  SoundOutlined,
  StopOutlined,
  VideoCameraOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { PipelinePreflightResult } from '@/services/video/core/pipeline-preflight-rules';
import {
  getProductionReadiness,
  type ProductionPhase,
  type ProductionReadiness,
  type VideoPipelineStatus,
} from '@/services/video/core/production-readiness';
import type { VideoProjectState, VideoStage, VideoStageState } from '@/types/video';
import { resolveLocalPath, toWebviewUrl } from '@/services/video/asset-store';
import { resolveVideoQualityPolicy } from '@/services/video/core/quality-policy';
import { isShotKeyframeApproved, isShotKeyframeCurrent } from '@/services/video/core/shot-production-contract';
import { formatPipelinePreflightIssue } from './PipelinePreflightAlert';
import { formatVideoQueueRetry } from './VideoProjectProgress';
import { isVideoQueueFull } from '@/services/providers/router';
import './VideoProductionConsole.css';

const { Text, Title } = Typography;

export type ConsolePhase = 'flow' | 'script' | 'assets' | 'studio' | 'timeline';
type Translate = (key: string, params?: Record<string, string | number>) => string;
type PhaseStatus = 'pending' | 'ready' | 'done' | 'blocked';

interface Props {
  project: VideoProjectState;
  headerLabel: string;
  sourceText?: string;
  activePhase: ConsolePhase;
  overall: VideoPipelineStatus;
  statusLabel: string;
  stages?: Record<VideoStage, VideoStageState>;
  currentStage?: VideoStage;
  progressPercent: number;
  checkPreflight: (stage: VideoStage, endStage?: VideoStage) => PipelinePreflightResult;
  onPhaseChange: (phase: ConsolePhase) => void;
  onRunFromStage: (stage: VideoStage, endStage?: VideoStage) => void;
  onRunAutomatic: () => void;
  onApprovePlan: () => void;
  onAssemble: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenPromptSettings: () => void;
  onOpenLogs: () => void;
  onOpenTrace: () => void;
  onVisualReviewChange: (automatic: boolean) => void;
  onOpenShot: (shotId: string, review?: 'image' | 'video') => void;
  starting: boolean;
  editingAsset: boolean;
  t: Translate;
  children?: React.ReactNode;
}

const phaseDefinitions: Array<{
  id: Exclude<ConsolePhase, 'flow'>;
  readiness: ProductionPhase;
  labelKey: string;
  hintKey: string;
}> = [
  { id: 'script', readiness: 'script', labelKey: 'video.workflow.phase.script', hintKey: 'video.workflow.phase.scriptHint' },
  { id: 'assets', readiness: 'assets', labelKey: 'video.workflow.phase.assets', hintKey: 'video.workflow.phase.assetsHint' },
  { id: 'studio', readiness: 'shots', labelKey: 'video.workflow.phase.studio', hintKey: 'video.workflow.phase.studioHint' },
  { id: 'timeline', readiness: 'timeline', labelKey: 'video.workflow.phase.timeline', hintKey: 'video.workflow.phase.timelineHint' },
];

export function phaseForStage(stage: VideoStage): Exclude<ConsolePhase, 'flow'> {
  if (stage === 'script_slicing' || stage === 'storyboard_prompt' || stage === 'extraction') return 'script';
  if (stage === 'character_anchor' || stage === 'scene_image') return 'assets';
  if (stage === 'audio_merge' || stage === 'composing' || stage === 'complete') return 'timeline';
  return 'studio';
}

function statusColor(status: VideoPipelineStatus | PhaseStatus): string {
  if (status === 'complete' || status === 'done') return 'success';
  if (status === 'running' || status === 'ready') return 'processing';
  if (status === 'review' || status === 'stopped' || status === 'interrupted') return 'warning';
  if (status === 'error' || status === 'blocked') return 'error';
  return 'default';
}

function shotStateColor(state: string): string {
  if (state === 'approved') return 'success';
  if (state === 'rejected') return 'error';
  if (state === 'awaiting_review' || state === 'needs_keyframe_review' || state === 'needs_binding') return 'warning';
  return 'default';
}

function shotStateIcon(state: string): React.ReactNode {
  if (state === 'approved') return <CheckCircleOutlined />;
  if (state === 'rejected' || state === 'needs_binding') return <WarningOutlined />;
  if (state === 'awaiting_review' || state === 'needs_keyframe_review') return <ClockCircleOutlined />;
  return <ArrowRightOutlined />;
}

function phaseStatus(readiness: ProductionReadiness, phase: ProductionPhase): PhaseStatus {
  if (phase === 'script') {
    if (readiness.planningReviewRequired) return 'ready';
    if (readiness.planningApproved) return 'done';
    return readiness.sourceReady ? 'ready' : 'blocked';
  }
  if (!readiness.planningApproved) return 'pending';
  if (phase === 'assets') {
    if (readiness.counts.assetsRequired === readiness.counts.assetsReady) {
      return readiness.counts.shots > 0 ? 'done' : 'pending';
    }
    return readiness.counts.shots > 0 ? 'ready' : 'blocked';
  }
  if (phase === 'shots') {
    if (readiness.counts.shots > 0 && readiness.counts.approved === readiness.counts.shots) return 'done';
    return readiness.counts.shots > 0 ? 'ready' : 'blocked';
  }
  if (readiness.action === 'complete') return 'done';
  return readiness.counts.approved === readiness.counts.shots && readiness.counts.shots > 0 ? 'ready' : 'blocked';
}

function productProgress(readiness: ProductionReadiness): number {
  const states = phaseDefinitions.map((phase) => phaseStatus(readiness, phase.readiness));
  return Math.round((states.filter((status) => status === 'done').length / phaseDefinitions.length) * 100);
}

interface NextAction {
  label: string;
  detail: string;
  onClick?: () => void;
  testId?: string;
  preflight?: PipelinePreflightResult;
}

const VideoProductionConsole: React.FC<Props> = ({
  project,
  headerLabel,
  sourceText,
  activePhase,
  overall,
  statusLabel,
  stages,
  currentStage,
  progressPercent,
  checkPreflight,
  onPhaseChange,
  onRunFromStage,
  onRunAutomatic,
  onApprovePlan,
  onAssemble,
  onStop,
  onOpenSettings,
  onOpenPromptSettings,
  onOpenLogs,
  onOpenTrace,
  onVisualReviewChange,
  onOpenShot,
  starting,
  editingAsset,
  t,
  children,
}) => {
  const readiness = useMemo(
    () => getProductionReadiness(project, { sourceText }),
    [project, sourceText],
  );
  const qualityPolicy = useMemo(() => resolveVideoQualityPolicy(project.options), [project.options]);
  const effectiveProgress = Math.max(progressPercent, productProgress(readiness));
  const { counts } = readiness;
  const productionBusy = overall === 'running' || starting;
  const waitingForKeyframes = project.options?.enableKeyframe !== false;
  const assetDetail = t('video.workflow.assetProgress', {
    charactersReady: counts.charactersReady, charactersTotal: counts.charactersRequired,
    scenesReady: counts.scenesReady, scenesTotal: counts.scenesRequired,
  });
  const runAction = (stage: VideoStage, label: string, detail: string, endStage?: VideoStage): NextAction => ({
    label, detail, preflight: checkPreflight(stage, endStage),
    onClick: () => onRunFromStage(stage, endStage),
  });
  const navigate = (phase: ConsolePhase, label: string, detail: string): NextAction => ({
    label, detail, onClick: () => onPhaseChange(phase),
  });
  const failedStage = readiness.failedStage;
  const nextAction = (): NextAction => {
    if (productionBusy) {
      const stage = currentStage ?? project.currentStage;
      const state = stages?.[stage];
      const phase = phaseForStage(stage);
      return {
        label: state?.status === 'running' ? t(`video.gen.stage.${stage}`) : t('video.workflow.starting'),
        detail: state?.queueRetry
          ? formatVideoQueueRetry(t, state.queueRetry)
          : state?.status === 'running' && state.progress > 0
            ? t('video.overview.progress', { percent: Math.round(state.progress * 100) })
            : t('video.workflow.awaitingResult'),
        onClick: state?.status === 'running' && activePhase !== phase ? () => onPhaseChange(phase) : undefined,
      };
    }
    if (failedStage) {
      if (failedStage === 'error' || failedStage === 'idle') {
        return { label: statusLabel, detail: project.error || t('video.workflow.resumeAutomaticHint') };
      }
      const phase = phaseForStage(failedStage);
      const endStage = phase === 'assets' ? 'scene_image'
        : phase === 'script' ? 'extraction'
        : failedStage === 'keyframe_image' ? 'keyframe_image'
        : phase === 'studio' ? 'video_review' : 'composing';
      if (overall === 'stopped' || overall === 'interrupted') {
        const detailKey = overall === 'interrupted' ? 'video.workflow.interruptedDescription' : 'video.workflow.resumeDescription';
        return runAction(failedStage, t('video.workflow.resume'), t(detailKey, {
          stage: t(`video.gen.stage.${failedStage}`),
        }), endStage);
      }
      const error = stages?.[failedStage]?.error ?? project.error;
      if (failedStage === 'video_generation' && isVideoQueueFull(error)) {
        return runAction(failedStage, t('video.workflow.retryStep'), t('video.workflow.queueFullRecovery'), endStage);
      }
      return runAction(failedStage, t('video.workflow.fixStage'), error || t(`video.gen.stage.${failedStage}`), endStage);
    }
    if (!readiness.sourceReady && !counts.shots) {
      return activePhase === 'script'
        ? { label: t('video.overview.openScript'), detail: t('video.overview.inputRequired') }
        : navigate('script', t('video.overview.openScript'), t('video.overview.inputRequired'));
    }
    if (!readiness.planningReady) {
      const detail = counts.shots > 0 ? t('video.workflow.planNeedsAttention') : t('video.overview.planningDescription');
      if (counts.shots > 0 && activePhase !== 'script') return navigate('script', t('video.overview.reviewPlan'), detail);
      return runAction('script_slicing', t(counts.shots > 0 ? 'video.workflow.replan' : 'video.overview.startPlanning'), detail, 'extraction');
    }
    if (readiness.planningReviewRequired) {
      return activePhase === 'script'
        ? { label: t('video.workflow.approvePlan'), detail: t('video.workflow.planReviewDescription'), onClick: onApprovePlan, testId: 'video-approve-planning' }
        : navigate('script', t('video.overview.reviewPlan'), t('video.overview.planReviewRequired'));
    }
    if (counts.assetsReady < counts.assetsRequired) {
      return runAction(
        counts.charactersReady < counts.charactersRequired ? 'character_anchor' : 'scene_image',
        t('video.workflow.generateAssets'), assetDetail, 'scene_image',
      );
    }
    if (counts.approved === counts.shots) {
      return project.finalVideoUrl
        ? activePhase === 'timeline'
          ? { label: t('video.overview.finalReady'), detail: t('video.workflow.exportHint') }
          : navigate('timeline', t('video.workflow.openFinal'), t('video.workflow.exportHint'))
        : { label: t('video.timeline.compose'), detail: t('video.overview.timelineInput', { count: counts.approved }), onClick: onAssemble };
    }
    if (waitingForKeyframes && counts.keyframes < counts.shots) {
      return runAction('keyframe_image', t('video.workflow.generateKeyframes'), t('video.overview.keyframeCount', { ready: counts.keyframes, total: counts.shots }), 'keyframe_image');
    }
    const unapprovedKeyframe = waitingForKeyframes && project.options?.enableI2V !== false
      ? readiness.shots.find((shot) => isShotKeyframeCurrent(shot) && !isShotKeyframeApproved(shot))
      : undefined;
    if (unapprovedKeyframe && counts.videoCandidates < counts.shots) {
      return { label: t('video.workflow.reviewKeyframes'), detail: t('video.workflow.keyframeReviewHint'), onClick: () => onOpenShot(unapprovedKeyframe.id, 'image') };
    }
    if (counts.videoCandidates < counts.shots) {
      return runAction('video_generation', t(project.options?.enableTTS === false ? 'video.production.generateVideo' : 'video.workflow.generateClips'), t('video.workflow.clipGenerationHint'), 'video_review');
    }
    const unlocked = readiness.shots.find((shot) => readiness.shotStates[shot.id] !== 'approved');
    return {
      label: t('video.workflow.reviewClips'),
      detail: t('video.overview.shotsDescription', { approved: counts.approved, total: counts.shots }),
      onClick: unlocked ? () => onOpenShot(unlocked.id, 'video') : () => onPhaseChange('studio'),
    };
  };

  const next = nextAction();
  const preflight = next.preflight;
  const blocking = preflight?.blocking ?? [];
  const configure = blocking.length > 0;
  const canStartAutomatic = !productionBusy && !project.finalVideoUrl && (readiness.sourceReady || counts.shots > 0);
  const automaticButton = canStartAutomatic && (
    <Button
      type="primary"
      icon={<RocketOutlined />}
      disabled={editingAsset}
      data-testid="video-automatic-production"
      onClick={onRunAutomatic}
    >
      {t(failedStage ? 'video.workflow.resumeAutomatic' : 'video.workflow.automaticProduction')}
    </Button>
  );
  const actionButton = next.onClick && (
    <Button
      type={productionBusy || canStartAutomatic ? 'default' : 'primary'}
      icon={configure ? <SettingOutlined /> : productionBusy ? <ArrowRightOutlined /> : <RocketOutlined />}
      disabled={editingAsset}
      data-testid={next.testId || (activePhase === 'flow' ? 'video-overview-next-action-button' : 'video-phase-next-action-button')}
      onClick={configure ? onOpenSettings : next.onClick}
    >
      {configure ? t('video.workflow.configureModels') : productionBusy ? t('video.workflow.viewProgress') : next.label}
    </Button>
  );
  const technicalDraft = project.finalVideoUrl && stages?.video_review?.inputSummary?.automaticReviewMode === 'technical';
  const actionDetails = technicalDraft
    ? t('video.workflow.automaticTechnicalDraft')
    : canStartAutomatic && configure && blocking.every((issue) => issue.code === 'multi-subject-reference-unsupported')
    ? t('video.workflow.automaticComposition')
    : configure
    ? blocking.map((issue) => formatPipelinePreflightIssue(issue, t)).join(' ')
    : project.error && !productionBusy && !failedStage ? project.error : next.detail;
  const actionTitle = productionBusy || !next.onClick
    ? next.label
    : t('video.workflow.nextLabel');
  const visualReviewIssue = activePhase === 'flow' && qualityPolicy.visualReviewRequired
    ? checkPreflight('video_review', 'video_review').blocking[0]
    : undefined;

  const phases = phaseDefinitions.map((phase) => ({
    ...phase,
    status: phaseStatus(readiness, phase.readiness),
  }));
  const qualityChecks = [
    { label: t('video.workflow.phase.script'), value: readiness.sourceReady && readiness.planningApproved, detail: readiness.planningReviewRequired ? t('video.overview.planReviewRequired') : t('video.overview.shotCount', { count: readiness.counts.shots }) },
    { label: t('video.workflow.phase.assets'), value: readiness.counts.assetsRequired === readiness.counts.assetsReady, detail: t('video.overview.assetCount', { characters: readiness.counts.charactersReady, scenes: readiness.counts.scenesReady }) },
    { label: t('video.workflow.phase.studio'), value: readiness.counts.keyframes === readiness.counts.shots && readiness.counts.shots > 0, detail: t('video.overview.keyframeCount', { ready: readiness.counts.keyframes, total: readiness.counts.shots }) },
    { label: t('video.production.locked'), value: readiness.counts.approved === readiness.counts.shots && readiness.counts.shots > 0, detail: t('video.overview.approvedCount', { ready: readiness.counts.approved, total: readiness.counts.shots }) },
    { label: t('video.overview.qualityCandidates'), value: qualityPolicy.videoCandidatesPerShot > 1, detail: t('video.overview.qualityCandidatesDetail', { keyframes: qualityPolicy.keyframeCandidatesPerShot, videos: qualityPolicy.videoCandidatesPerShot }) },
  ];

  return (
    <div className={`video-production-console is-${activePhase} is-${overall}`}>
      <header className="video-production-console-header">
        <div className="video-production-console-project">
          <Title level={4} title={headerLabel || project.title}>{headerLabel || project.title || t('video.workflow.overview')}</Title>
          <div className="video-production-console-status">
            <Tag color={statusColor(overall)}>{statusLabel}</Tag>
            {counts.shots > 0 && <Text type="secondary">{t('video.production.approvedProgress', { approved: counts.approved, total: counts.shots })}</Text>}
            <Progress percent={effectiveProgress} showInfo={false} size="small" />
          </div>
        </div>
        <Space className="video-production-console-tools" size={4} wrap>
          <Button type={activePhase === 'flow' ? 'default' : 'text'} size="small" icon={<AppstoreOutlined />} aria-label={t('video.workflow.overview')} onClick={() => onPhaseChange('flow')}>{t('video.workflow.projectOverview')}</Button>
          {overall === 'running' && <Button size="small" danger icon={<StopOutlined />} onClick={onStop}>{t('video.workflow.stop')}</Button>}
          <Tooltip title={t('video.workflow.openLogs')}>
            <Button type="text" size="small" icon={<ProfileOutlined />} aria-label={t('video.workflow.openLogs')} onClick={onOpenLogs} />
          </Tooltip>
          <Tooltip title={t('video.workflow.openPromptSettings')}>
            <Button type="text" size="small" icon={<SettingOutlined />} aria-label={t('video.workflow.openPromptSettings')} onClick={onOpenPromptSettings} />
          </Tooltip>
        </Space>
      </header>

      <nav className="video-production-console-steps" aria-label={t('video.workflow.phaseNavigation')}>
        {phases.map((phase, index) => (
          <button type="button" key={phase.id} className={`video-production-console-step is-${phase.status} ${activePhase === phase.id ? 'is-active' : ''}`} data-phase={phase.id} aria-current={activePhase === phase.id ? 'step' : undefined} onClick={() => onPhaseChange(phase.id)}>
            <span className="video-production-console-step-number">{index + 1}</span>
            <span className="video-production-console-step-copy"><strong>{t(phase.labelKey)}</strong><small>{t(phase.hintKey)}</small></span>
            <span className="video-production-console-step-status">{phase.status === 'done' ? <CheckCircleOutlined /> : phase.status === 'blocked' ? <WarningOutlined /> : <ArrowRightOutlined />}</span>
          </button>
        ))}
      </nav>

      {activePhase === 'flow' ? (
        <main className="video-command-center" data-testid="video-production-overview">
          <section className={`video-command-center-hero is-${readiness.action}`} data-testid="video-overview-next-action">
            <div className="video-command-center-hero-copy">
              <Text className="video-command-center-eyebrow">{t('video.overview.eyebrow')}</Text>
              <div className="video-command-center-title-row">
                <div>
                  <Title level={3}>{t('video.overview.projectStatus')}</Title>
                  <Text type="secondary">{sourceText?.trim() ? sourceText.trim().slice(0, 180) : t('video.overview.sourceMissing')}</Text>
                </div>
                <Tag color={statusColor(overall)}>{statusLabel}</Tag>
              </div>
              <div className="video-command-center-facts">
                <span>{project.spec.aspectRatio}</span>
                <span>{project.spec.resolution}</span>
                <span>{readiness.counts.shots} {t('video.production.shotQueue')}</span>
                {counts.shots > 0 && <span>{t('video.production.approvedProgress', { approved: counts.approved, total: counts.shots })}</span>}
              </div>
            </div>
            <div className="video-command-center-hero-action">
              <strong>{actionTitle}</strong>
              <Text type="secondary">{actionDetails}</Text>
              <Space wrap>{automaticButton}{actionButton}</Space>
            </div>
          </section>

          {readiness.continuityRisks.length > 0 && <Alert type="info" showIcon icon={<InfoCircleOutlined />} message={t('video.production.continuityRisk', { count: readiness.continuityRisks.length })} description={t('video.production.continuityRiskDescription')} action={<Button size="small" onClick={() => onPhaseChange('studio')}>{t('video.overview.openShots')}</Button>} />}
          {readiness.blockers.some((blocker) => blocker.code === 'unresolved_character_binding') && <Alert type="warning" showIcon icon={<WarningOutlined />} message={t('video.overview.shotBindingsRequired')} description={t('video.overview.shotBindingsRequiredDescription')} action={<Button size="small" onClick={() => onPhaseChange('studio')}>{t('video.overview.openShots')}</Button>} />}

          <div className="video-command-center-grid">
            <section className="video-command-center-main">
              <div className="video-command-center-section-head">
                <div><Title level={5}>{t('video.production.shotQueue')}</Title><Text type="secondary">{t('video.production.queueHint')}</Text></div>
                <Space size={6}>
                  <Button size="small" icon={<ProfileOutlined />} data-testid="video-overview-trace" onClick={onOpenTrace}>{t('video.overview.technicalDetails')}</Button>
                  <Button size="small" type="primary" ghost icon={<VideoCameraOutlined />} onClick={() => onPhaseChange('studio')}>{t('video.overview.openShots')}</Button>
                </Space>
              </div>
              {readiness.shots.length === 0 ? (
                <div className="video-command-center-empty"><Empty description={t('video.production.noShotsDescription')} /><Button type="primary" onClick={() => onPhaseChange('script')}>{t('video.production.openScript')}</Button></div>
              ) : (
                <div className="video-command-center-shot-table" data-testid="video-overview-shot-snapshot">
                  <div className="video-command-center-shot-table-head">
                    <span>{t('video.production.shotNumberLabel')}</span>
                    <span aria-hidden="true" />
                    <span>{t('video.production.handoff.input')}</span>
                    <span>{t('video.production.handoff.reference')}</span>
                    <span>{t('video.production.handoff.output')}</span>
                    <span>{t('video.production.versionReview')}</span>
                  </div>
                  {readiness.shots.map((shot) => {
                    const state = readiness.shotStates[shot.id] || 'needs_prompt';
                    const refs = shot.referenceAssets ?? shot.generationPlan?.keyframe?.references ?? [];
                    const clip = project.clips.find((candidate) => candidate.shotId === shot.id);
                    const subjects = shot.visibleCharacterIds ?? shot.characterIds ?? [];
                    const subjectNames = subjects.map((id) => project.sceneSpec?.characters?.find((character) => character.id === id || character.name === id)?.name || id).filter(Boolean);
                    const sentRefs = refs.filter((reference) => reference.sentToProvider !== false);
                    const image = clip?.thumbnailUrl || shot.keyframeImage || sentRefs[0]?.imageUrl;
                    const outputLabel = clip?.videoUrl
                      ? t('video.production.handoff.videoReady')
                      : shot.keyframeImage
                        ? t('video.production.handoff.keyframeReady')
                        : t('video.production.handoff.pending');
                    const selectedVideoVersion = shot.versionHistory?.find((version) => version.type === 'video' && version.id === shot.selectedVersionId)
                      ?? shot.versionHistory?.find((version) => version.type === 'video' && version.url === clip?.videoUrl)
                      ?? shot.versionHistory?.find((version) => version.type === 'video');
                    const videoCandidateCount = shot.versionHistory?.filter((version) => version.type === 'video').length ?? 0;
                    return (
                      <button type="button" className={`video-command-center-shot-row is-${state}`} key={shot.id} onClick={() => onOpenShot(shot.id)}>
                        <span className="video-command-center-shot-index">{String(shot.index + 1).padStart(2, '0')}</span>
                        <span className="video-command-center-shot-visual">{image ? <img src={toWebviewUrl(resolveLocalPath(image))} alt="" /> : <PictureOutlined />}</span>
                        <span className="video-command-center-shot-story">
                          <strong>{(shot.sourceText || shot.videoPrompt || t('video.production.emptyShot')).slice(0, 110)}</strong>
                          <span className="video-command-center-shot-subjects">{subjectNames.length ? subjectNames.slice(0, 3).map((name) => <Tag key={name}>{name}</Tag>) : <Text type="secondary">{t('video.production.noVisibleSubjects')}</Text>}</span>
                          <small>{shot.durationSeconds}s · {shot.location || t('video.production.locationUnset')}</small>
                        </span>
                        <span className="video-command-center-shot-request">
                          <strong>{project.executionBinding?.video?.model || t('video.production.notConfigured')}</strong>
                          <small>{sentRefs.length} {t('video.production.referenceSlots')}</small>
                          {clip?.videoControlMode && <Tag color="blue">{clip.videoControlMode.toUpperCase()}</Tag>}
                        </span>
                        <span className="video-command-center-shot-output">
                          <strong>{outputLabel}</strong>
                          <small>{selectedVideoVersion?.model || clip?.model || t('video.production.handoff.pending')}</small>
                          {videoCandidateCount > 0 && <span>{t('video.production.candidateCount', { count: videoCandidateCount })}</span>}
                        </span>
                        <span className="video-command-center-shot-state"><Tag color={shotStateColor(state)} icon={shotStateIcon(state)}>{t(`video.production.state.${state}`)}</Tag><ArrowRightOutlined /></span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <aside className="video-command-center-sidebar">
              <section className="video-command-center-panel">
                <div className="video-command-center-panel-head"><Title level={5}>{t('video.overview.qualityTitle')}</Title><Tag color={project.options?.enableVisualQualityGate === false ? 'default' : 'green'}>{project.options?.enableVisualQualityGate === false ? t('video.overview.qualityVisualOff') : t('video.overview.qualityVisualOn')}</Tag></div>
                <div className="video-command-center-review-mode">
                  <label htmlFor="video-visual-review-mode">{t('video.overview.reviewMode')}</label>
                  <Select id="video-visual-review-mode" aria-label={t('video.overview.reviewMode')} data-testid="video-visual-review-mode" value={qualityPolicy.visualReviewRequired ? 'automatic' : 'manual'} disabled={productionBusy} onChange={(value) => onVisualReviewChange(value === 'automatic')} options={[{ value: 'automatic', label: t('video.overview.reviewAutomatic') }, { value: 'manual', label: t('video.overview.reviewManual') }]} />
                  <Text type="secondary">{t(qualityPolicy.visualReviewRequired ? 'video.overview.reviewAutomaticHint' : 'video.overview.reviewManualHint')}</Text>
                  {visualReviewIssue && <Alert className="video-command-center-preflight-issues" type="warning" message={formatPipelinePreflightIssue(visualReviewIssue, t)} />}
                </div>
                <div className="video-command-center-policy" data-testid="video-quality-policy">
                  <div><span>{t('video.overview.qualityProfile')}</span><strong>{t(`video.overview.qualityProfile.${qualityPolicy.profile}`)}</strong></div>
                  <div><span>{t('video.overview.qualityCandidates')}</span><strong>{t('video.overview.qualityCandidatesDetail', { keyframes: qualityPolicy.keyframeCandidatesPerShot, videos: qualityPolicy.videoCandidatesPerShot })}</strong></div>
                  <div><span>{t('video.overview.qualityGate')}</span><strong>{qualityPolicy.visualReviewRequired ? t('video.overview.qualityGateRequired') : t('video.overview.qualityGateOptional')}</strong></div>
                  <div><span>{t('video.overview.continuityMode')}</span><strong>{t(`video.overview.continuityMode.${qualityPolicy.continuityMode}`)}</strong></div>
                </div>
                <div className="video-command-center-checks">{qualityChecks.map((check) => <QualityCheck key={check.label} label={check.label} detail={check.detail} passed={check.value} />)}</div>
              </section>
              <section className="video-command-center-panel">
                <div className="video-command-center-panel-head"><Title level={5}>{t('video.production.actualRequest')}</Title><Button type="text" size="small" icon={<SettingOutlined />} onClick={onOpenSettings} aria-label={t('video.overview.openSettings')} /></div>
                <div className="video-command-center-binding"><span>{t('video.production.imageProvider')}</span><strong>{project.executionBinding?.image ? `${project.executionBinding.image.provider} / ${project.executionBinding.image.model}` : t('video.production.notConfigured')}</strong><span>{t('video.production.videoProvider')}</span><strong>{project.executionBinding?.video ? `${project.executionBinding.video.provider} / ${project.executionBinding.video.model}` : t('video.production.notConfigured')}</strong></div>
                <Button type="link" size="small" onClick={onOpenTrace}>{t('video.overview.technicalDetails')}</Button>
              </section>
            </aside>
          </div>
        </main>
      ) : (
        <>
          <section className="video-production-actionbar" data-testid="video-phase-action" aria-busy={productionBusy}>
            <div role="status">
              <strong>{actionTitle}</strong>
              <Text type={configure || overall === 'error' ? 'danger' : 'secondary'}>{actionDetails}</Text>
              {activePhase === 'assets' && actionDetails !== assetDetail && <Text type="secondary">{assetDetail}</Text>}
            </div>
            <Space wrap>{automaticButton}{actionButton}</Space>
          </section>
          <main className="video-production-console-workspace">{children}</main>
        </>
      )}
    </div>
  );
};

function QualityCheck({ label, detail, passed }: { label: string; detail: string; passed: boolean }) {
  return <div className={`video-production-console-quality-check ${passed ? 'is-passed' : 'is-pending'}`}><span>{passed ? <CheckCircleOutlined /> : <WarningOutlined />}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

export default VideoProductionConsole;

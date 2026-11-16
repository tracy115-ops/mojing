import React, { useMemo } from 'react';
import {
  Alert,
  Button,
  Empty,
  Progress,
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
  FileTextOutlined,
  InfoCircleOutlined,
  PictureOutlined,
  PlayCircleOutlined,
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
  type ProductionAction,
  type ProductionPhase,
  type ProductionReadiness,
} from '@/services/video/core/production-readiness';
import type { VideoProjectState, VideoStage, VideoStageState } from '@/types/video';
import { resolveLocalPath, toWebviewUrl } from '@/services/video/asset-store';
import { resolveVideoQualityPolicy } from '@/services/video/core/quality-policy';
import './VideoProductionConsole.css';

const { Text, Title } = Typography;

export type ConsolePhase = 'flow' | 'script' | 'assets' | 'studio' | 'timeline';
export type ConsoleOverall = 'idle' | 'running' | 'review' | 'complete' | 'error';
type Translate = (key: string, params?: Record<string, string | number>) => string;
type PhaseStatus = 'pending' | 'ready' | 'done' | 'blocked';

interface Props {
  project: VideoProjectState;
  headerLabel: string;
  sourceText?: string;
  activePhase: ConsolePhase;
  overall: ConsoleOverall;
  statusLabel: string;
  visibleStages: VideoStage[];
  stages?: Record<VideoStage, VideoStageState>;
  progressPercent: number;
  preflight: PipelinePreflightResult;
  onPhaseChange: (phase: ConsolePhase) => void;
  onRunFromStage: (stage: VideoStage) => void;
  onContinueReview: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenPromptSettings: () => void;
  onOpenLogs: () => void;
  onOpenTrace: () => void;
  onOpenShot?: (shotId: string) => void;
  continuingReview: boolean;
  t: Translate;
  children?: React.ReactNode;
}

const phaseDefinitions: Array<{
  id: Exclude<ConsolePhase, 'flow'>;
  readiness: ProductionPhase;
  icon: React.ReactNode;
  labelKey: string;
  hintKey: string;
}> = [
  { id: 'script', readiness: 'script', icon: <FileTextOutlined />, labelKey: 'video.workflow.phase.script', hintKey: 'video.workflow.phase.scriptHint' },
  { id: 'assets', readiness: 'assets', icon: <PictureOutlined />, labelKey: 'video.workflow.phase.assets', hintKey: 'video.workflow.phase.assetsHint' },
  { id: 'studio', readiness: 'shots', icon: <VideoCameraOutlined />, labelKey: 'video.workflow.phase.studio', hintKey: 'video.workflow.phase.studioHint' },
  { id: 'timeline', readiness: 'timeline', icon: <SoundOutlined />, labelKey: 'video.workflow.phase.timeline', hintKey: 'video.workflow.phase.timelineHint' },
];

function isDone(state?: VideoStageState): boolean {
  return state?.status === 'completed' || state?.status === 'skipped';
}

function nextStage(
  visibleStages: VideoStage[],
  stages: Record<VideoStage, VideoStageState> | undefined,
): VideoStage | undefined {
  return visibleStages.find((stage) => stages?.[stage]?.status === 'error')
    ?? visibleStages.find((stage) => stages?.[stage]?.status === 'running' || stages?.[stage]?.status === 'awaiting_review')
    ?? visibleStages.find((stage) => !isDone(stages?.[stage]));
}

function statusColor(status: ConsoleOverall | PhaseStatus): string {
  if (status === 'complete' || status === 'done') return 'success';
  if (status === 'running' || status === 'ready') return 'processing';
  if (status === 'review') return 'warning';
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
  if (readiness.overall === 'complete' || readiness.action === 'complete') return 'done';
  return readiness.counts.approved === readiness.counts.shots && readiness.counts.shots > 0 ? 'ready' : 'blocked';
}

function productProgress(readiness: ProductionReadiness): number {
  const states = phaseDefinitions.map((phase) => phaseStatus(readiness, phase.readiness));
  return Math.round((states.filter((status) => status === 'done').length / phaseDefinitions.length) * 100);
}

function actionIcon(action: ProductionAction): React.ReactNode {
  switch (action) {
    case 'configure': return <SettingOutlined />;
    case 'write_source': return <FileTextOutlined />;
    case 'prepare_assets': return <PictureOutlined />;
    case 'review_shots': return <VideoCameraOutlined />;
    case 'assemble': return <SoundOutlined />;
    case 'monitor': return <PlayCircleOutlined />;
    case 'repair': return <WarningOutlined />;
    case 'complete': return <CheckCircleOutlined />;
    case 'plan': return <RocketOutlined />;
    case 'review_plan': return <FileTextOutlined />;
  }
}

function actionLabel(action: ProductionAction, t: Translate): string {
  switch (action) {
    case 'configure': return t('video.workflow.configureModels');
    case 'write_source': return t('video.overview.openScript');
    case 'plan': return t('video.overview.startPlanning');
    case 'review_plan': return t('video.overview.reviewPlan');
    case 'prepare_assets': return t('video.overview.openAssets');
    case 'review_shots': return t('video.overview.openShots');
    case 'assemble': return t('video.timeline.compose');
    case 'monitor': return t('video.workflow.viewProgress');
    case 'repair': return t('video.workflow.fixStage');
    case 'complete': return t('video.workflow.openFinal');
  }
}

const VideoProductionConsole: React.FC<Props> = ({
  project,
  headerLabel,
  sourceText,
  activePhase,
  overall,
  statusLabel,
  visibleStages,
  stages,
  progressPercent,
  preflight,
  onPhaseChange,
  onRunFromStage,
  onContinueReview,
  onStop,
  onOpenSettings,
  onOpenPromptSettings,
  onOpenLogs,
  onOpenTrace,
  onOpenShot,
  continuingReview,
  t,
  children,
}) => {
  const readiness = useMemo(
    () => getProductionReadiness(project, { sourceText, preflight }),
    [preflight, project, sourceText],
  );
  const qualityPolicy = useMemo(() => resolveVideoQualityPolicy(project.options), [project.options]);
  const pendingStage = nextStage(visibleStages, stages);
  const effectiveProgress = Math.max(progressPercent, productProgress(readiness));

  const primaryAction = () => {
    // The overview owns the safe automation boundary. A user should not have
    // to understand runtime stage ids to move a project forward; only stop at
    // a human decision (keyframe or video review) or a missing input.
    const automaticStage = (() => {
      switch (readiness.action) {
        case 'plan':
          return readiness.sourceReady && readiness.shots.length === 0 ? 'script_slicing' as VideoStage : undefined;
        case 'review_plan':
          return undefined;
        case 'prepare_assets':
          return 'character_anchor' as VideoStage;
        case 'review_shots':
          if (readiness.counts.keyframes < readiness.counts.shots) return 'keyframe_image' as VideoStage;
          if (readiness.counts.approved === readiness.counts.shots && readiness.counts.videoCandidates < readiness.counts.shots) {
            return 'video_generation' as VideoStage;
          }
          return undefined;
        case 'repair':
          return pendingStage;
        default:
          return undefined;
      }
    })();

    if (automaticStage) {
      onRunFromStage(automaticStage);
      return;
    }

    switch (readiness.action) {
      case 'configure': onOpenSettings(); break;
      case 'write_source':
      case 'plan': onPhaseChange('script'); break;
      case 'review_plan': onPhaseChange('script'); break;
      case 'prepare_assets': onPhaseChange('assets'); break;
      case 'review_shots':
      case 'monitor':
      case 'repair': onPhaseChange('studio'); break;
      case 'assemble': onRunFromStage('composing'); break;
      case 'complete': onPhaseChange('timeline'); break;
    }
  };

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
          <Text className="video-production-console-eyebrow">{t('video.production.eyebrow')}</Text>
          <Title level={4}>{headerLabel || project.title || t('video.workflow.overview')}</Title>
          <div className="video-production-console-status">
            <Tag color={statusColor(overall)}>{statusLabel}</Tag>
            <Text type="secondary">{readiness.counts.approved}/{Math.max(readiness.counts.shots, 1)} {t('video.production.locked')}</Text>
            <Progress percent={effectiveProgress} showInfo={false} size="small" />
          </div>
        </div>
        <Space className="video-production-console-tools" size={4} wrap>
          <Tooltip title={t('video.workflow.overview')}>
            <Button type={activePhase === 'flow' ? 'default' : 'text'} size="small" icon={<AppstoreOutlined />} aria-label={t('video.workflow.overview')} onClick={() => onPhaseChange('flow')} />
          </Tooltip>
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
          <button type="button" key={phase.id} className={`video-production-console-step is-${phase.status} ${activePhase === phase.id ? 'is-active' : ''}`} data-phase={phase.id} onClick={() => onPhaseChange(phase.id)}>
            <span className="video-production-console-step-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="video-production-console-step-icon">{phase.icon}</span>
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
                <span>{readiness.counts.approved}/{Math.max(readiness.counts.shots, 1)} {t('video.production.locked')}</span>
              </div>
            </div>
            <div className="video-command-center-hero-action">
              <Text type="secondary">{t('video.overview.nextLabel')}</Text>
              <strong>{actionLabel(readiness.action, t)}</strong>
              <Button type="primary" icon={actionIcon(readiness.action)} data-testid="video-overview-next-action-button" loading={continuingReview || overall === 'running'} onClick={readiness.action === 'review_shots' && overall === 'review' ? onContinueReview : primaryAction}>{actionLabel(readiness.action, t)}</Button>
            </div>
          </section>

          {preflight.blocking.length > 0 && <Alert type="warning" showIcon icon={<WarningOutlined />} message={t('video.overview.configurationRequired', { count: preflight.blocking.length })} description={t('video.overview.configurationHint')} action={<Button size="small" icon={<SettingOutlined />} onClick={onOpenSettings}>{t('video.overview.openSettings')}</Button>} />}
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
                      <button type="button" className={`video-command-center-shot-row is-${state}`} key={shot.id} onClick={() => onOpenShot ? onOpenShot(shot.id) : onPhaseChange('studio')}>
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
        <main className="video-production-console-workspace">{children}</main>
      )}
    </div>
  );
};

function QualityCheck({ label, detail, passed }: { label: string; detail: string; passed: boolean }) {
  return <div className={`video-production-console-quality-check ${passed ? 'is-passed' : 'is-pending'}`}><span>{passed ? <CheckCircleOutlined /> : <WarningOutlined />}</span><div><strong>{label}</strong><small>{detail}</small></div></div>;
}

export default VideoProductionConsole;

import React, { useMemo } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Progress,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
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
import type {
  ShotSpec,
  VideoProjectState,
  VideoStage,
  VideoStageState,
} from '@/types/video';
import { isShotKeyframeCurrent } from '@/services/video/core/shot-production-contract';
import PipelinePreflightAlert from './PipelinePreflightAlert';
import './VideoWorkflowGuide.css';

const { Text, Title } = Typography;

export type WorkflowPhase = 'flow' | 'script' | 'assets' | 'studio' | 'timeline';
export type WorkflowOverall = 'idle' | 'running' | 'review' | 'complete' | 'error';

type WorkPhase = Exclude<WorkflowPhase, 'flow'>;
type PhaseStatus = 'pending' | 'ready' | 'running' | 'error' | 'completed';

const PHASES: Array<{
  id: WorkPhase;
  number: string;
  icon: React.ReactNode;
  labelKey: string;
  hintKey: string;
  stages: VideoStage[];
}> = [
  {
    id: 'script',
    number: '01',
    icon: <FileTextOutlined />,
    labelKey: 'video.workflow.phase.script',
    hintKey: 'video.workflow.phase.scriptHint',
    stages: ['script_slicing', 'storyboard_prompt', 'extraction'],
  },
  {
    id: 'assets',
    number: '02',
    icon: <PictureOutlined />,
    labelKey: 'video.workflow.phase.assets',
    hintKey: 'video.workflow.phase.assetsHint',
    stages: ['character_anchor', 'scene_image', 'voice_assignment'],
  },
  {
    id: 'studio',
    number: '03',
    icon: <VideoCameraOutlined />,
    labelKey: 'video.workflow.phase.studio',
    hintKey: 'video.workflow.phase.studioHint',
    stages: ['tts', 'keyframe_image', 'video_generation', 'video_review'],
  },
  {
    id: 'timeline',
    number: '04',
    icon: <SoundOutlined />,
    labelKey: 'video.workflow.phase.timeline',
    hintKey: 'video.workflow.phase.timelineHint',
    stages: ['audio_merge', 'composing'],
  },
];

interface Props {
  project: VideoProjectState;
  headerLabel: string;
  activePhase: WorkflowPhase;
  overall: WorkflowOverall;
  statusLabel: string;
  visibleStages: VideoStage[];
  stages?: Record<VideoStage, VideoStageState>;
  completedStageCount: number;
  progressPercent: number;
  preflight: PipelinePreflightResult;
  currentStageSummary?: string;
  currentStageProgress: number;
  onPhaseChange: (phase: WorkflowPhase) => void;
  onRunFromStage: (stage: VideoStage) => void;
  onContinueReview: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenPromptSettings: () => void;
  onOpenLogs: () => void;
  continuingReview: boolean;
}

function isDone(state?: VideoStageState): boolean {
  return state?.status === 'completed' || state?.status === 'skipped';
}

function phaseForStage(stage: VideoStage | undefined): WorkPhase {
  const phase = PHASES.find((candidate) => candidate.stages.includes(stage as VideoStage));
  return phase?.id ?? 'script';
}

function statusColor(status: WorkflowOverall | PhaseStatus): string {
  if (status === 'complete' || status === 'completed') return 'success';
  if (status === 'running') return 'processing';
  if (status === 'review' || status === 'ready') return 'warning';
  if (status === 'error') return 'error';
  return 'default';
}

function phaseStatus(
  phase: typeof PHASES[number],
  stages: Record<VideoStage, VideoStageState> | undefined,
  nextStage: VideoStage | undefined,
): PhaseStatus {
  const states = phase.stages.map((stage) => stages?.[stage]);
  if (states.some((state) => state?.status === 'error')) return 'error';
  if (states.some((state) => state?.status === 'running' || state?.status === 'awaiting_review')) return 'running';
  if (states.length > 0 && states.every((state) => isDone(state))) return 'completed';
  return nextStage && phase.stages.includes(nextStage) ? 'ready' : 'pending';
}

function phaseHandoff(phase: WorkPhase, project: VideoProjectState, t: Translate): { input: string; output: string } {
  const spec = project.sceneSpec;
  const shots = spec?.shots ?? (project.shots as unknown as Array<{ id: string }>);
  const shotCount = shots.length;
  const characterCount = spec?.characters?.length ?? 0;
  const sceneCount = spec?.scenes?.length ?? 0;
  const keyframeCount = shots.filter((shot) => isShotKeyframeCurrent(shot as ShotSpec)).length;
  const clipCount = project.clips.filter((clip) => !!clip.videoUrl).length;

  switch (phase) {
    case 'script':
      return {
        input: t('video.workflow.handoff.source'),
        output: t('video.workflow.handoff.shots', { count: shotCount }),
      };
    case 'assets':
      return {
        input: t('video.workflow.handoff.entities', { characters: characterCount, scenes: sceneCount }),
        output: t('video.workflow.handoff.assetReady', { characters: characterCount, scenes: sceneCount }),
      };
    case 'studio':
      return {
        input: t('video.workflow.handoff.keyframes', { ready: keyframeCount, total: shotCount }),
        output: t('video.workflow.handoff.clips', { ready: clipCount, total: shotCount }),
      };
    case 'timeline':
      return {
        input: t('video.workflow.handoff.timelineInput', { count: clipCount }),
        output: project.finalVideoUrl
          ? t('video.workflow.handoff.finalReady')
          : t('video.workflow.handoff.finalPending'),
      };
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

const VideoWorkflowGuide: React.FC<Props & { t: Translate }> = ({
  project,
  headerLabel: _headerLabel,
  activePhase,
  overall,
  statusLabel,
  visibleStages,
  stages,
  completedStageCount,
  progressPercent,
  preflight,
  currentStageSummary,
  currentStageProgress,
  onPhaseChange,
  onRunFromStage,
  onContinueReview,
  onStop,
  onOpenSettings,
  onOpenPromptSettings,
  onOpenLogs,
  continuingReview,
  t,
}) => {
  const nextStage = useMemo(() => (
    visibleStages.find((stage) => stages?.[stage]?.status === 'error')
      ?? visibleStages.find((stage) => stages?.[stage]?.status === 'running' || stages?.[stage]?.status === 'awaiting_review')
      ?? visibleStages.find((stage) => !isDone(stages?.[stage]))
  ), [stages, visibleStages]);
  const nextPhase: WorkPhase = nextStage
    ? phaseForStage(nextStage)
    : overall === 'complete'
      ? 'timeline'
      : activePhase === 'flow'
        ? 'script'
        : activePhase;
  const handoff = phaseHandoff(nextPhase, project, t);
  const nextStageState = nextStage ? stages?.[nextStage] : undefined;
  const completedPhaseCount = PHASES.filter((phase) => phaseStatus(phase, stages, nextStage) === 'completed').length;
  const blocking = preflight.blocking.length > 0;
  const shotReferenceBlocking = preflight.blocking.some((issue) => issue.code === 'multi-subject-reference-unsupported');
  const issueCategories = [...new Set(preflight.blocking.map((issue) => t(`video.preflight.category.${issue.category}`)))].join('、');

  let actionLabel = t('video.workflow.openStage');
  let actionDescription = currentStageSummary || t('video.workflow.openStageDescription', {
    stage: nextStage ? t(`video.gen.stage.${nextStage}`) : t('video.workflow.phase.timeline'),
  });
  let actionIcon: React.ReactNode = <ArrowRightOutlined />;
  let action: () => void = () => onPhaseChange(nextPhase);

  if (blocking) {
    if (shotReferenceBlocking) {
      actionLabel = t('video.workflow.openStage');
      actionDescription = t('video.workflow.openStageDescription', {
        stage: t('video.workflow.phase.studio'),
      });
      actionIcon = <VideoCameraOutlined />;
      action = () => onPhaseChange('studio');
    } else {
      actionLabel = t('video.workflow.configureModels');
      actionDescription = t('video.workflow.configureModelsDescription', {
        count: preflight.blocking.length,
        categories: issueCategories,
      });
      actionIcon = <SettingOutlined />;
      action = onOpenSettings;
    }
  } else if (overall === 'error' && nextStage) {
    actionLabel = t('video.workflow.fixStage');
    actionDescription = nextStageState?.error || t('video.workflow.fixStageDescription', {
      stage: t(`video.gen.stage.${nextStage}`),
    });
    actionIcon = <WarningOutlined />;
    action = () => onPhaseChange(nextPhase);
  } else if (overall === 'review' && nextStage) {
    actionLabel = t('video.pipeline.reviewContinue');
    actionDescription = t('video.workflow.reviewDescription', {
      stage: t(`video.gen.stage.${nextStage}`),
    });
    actionIcon = <PlayCircleOutlined />;
    action = onContinueReview;
  } else if (overall === 'running' && nextStage) {
    actionLabel = t('video.workflow.viewProgress');
    actionDescription = currentStageSummary || t('video.workflow.runningDescription', {
      stage: t(`video.gen.stage.${nextStage}`),
    });
    actionIcon = <ArrowRightOutlined />;
    action = () => onPhaseChange(nextPhase);
  } else if (overall === 'complete') {
    actionLabel = t('video.workflow.openFinal');
    actionDescription = t('video.workflow.completeDescription');
    actionIcon = <CheckCircleOutlined />;
    action = () => onPhaseChange('timeline');
  } else if (nextStage) {
    actionLabel = t('video.workflow.startStage');
    actionDescription = t('video.workflow.startStageDescription', {
      stage: t(`video.gen.stage.${nextStage}`),
    });
    actionIcon = <RocketOutlined />;
    action = () => onRunFromStage(nextStage);
  }

  const primaryLoading = overall === 'running' || continuingReview;
  // The shot board is the primary production surface. The large next-action
  // card is useful while navigating or recovering a run, but it duplicates the
  // board's controls during normal shot editing.
  const showNextAction = !blocking && (activePhase !== 'studio' || overall !== 'idle');

  return (
    <div className={`video-workflow-guide is-${activePhase} is-${overall}`}>
      <header className="video-workflow-header">
        <div className="video-workflow-progress-summary">
          <div className="video-workflow-status-line">
            <Text className="video-workflow-eyebrow">{t('video.workflow.eyebrow')}</Text>
            <Tag color={statusColor(overall)}>{statusLabel}</Tag>
            <Text type="secondary">{completedPhaseCount}/{PHASES.length} {t('video.workflow.phasesDone')}</Text>
          </div>
          <Progress percent={progressPercent} showInfo={false} size="small" />
        </div>
        <div className="video-workflow-tools">
          {activePhase !== 'flow' && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              className="video-workflow-back-button"
              onClick={() => onPhaseChange('flow')}
            >
              {t('video.workbench.backToFlow')}
            </Button>
          )}
          <Tooltip title={t('video.workflow.openLogs')}>
            <Button type="text" icon={<ProfileOutlined />} aria-label={t('video.workflow.openLogs')} onClick={onOpenLogs} />
          </Tooltip>
          <Tooltip title={t('video.workflow.openPromptSettings')}>
            <Button type="text" icon={<SettingOutlined />} aria-label={t('video.workflow.openPromptSettings')} onClick={onOpenPromptSettings} />
          </Tooltip>
        </div>
      </header>

      <nav className="video-workflow-phase-nav" aria-label={t('video.workflow.phaseNavigation')}>
        <button
          type="button"
          className={`video-workflow-phase-tab is-overview ${activePhase === 'flow' ? 'is-active' : ''}`}
          aria-current={activePhase === 'flow' ? 'step' : undefined}
          onClick={() => onPhaseChange('flow')}
        >
          <span className="video-workflow-phase-number"><ArrowRightOutlined /></span>
          <span className="video-workflow-phase-copy">
            <strong>{t('video.workflow.overview')}</strong>
            <small>{t('video.workflow.overviewHint')}</small>
          </span>
        </button>
        {PHASES.map((phase) => {
          const status = phaseStatus(phase, stages, nextStage);
          const completed = phase.stages.filter((stage) => isDone(stages?.[stage])).length;
          return (
            <button
              type="button"
              key={phase.id}
              className={`video-workflow-phase-tab is-${status} ${activePhase === phase.id ? 'is-active' : ''}`}
              aria-current={activePhase === phase.id ? 'step' : undefined}
              data-phase={phase.id}
              onClick={() => onPhaseChange(phase.id)}
            >
              <span className="video-workflow-phase-number">{phase.number}</span>
              <span className="video-workflow-phase-icon">{phase.icon}</span>
              <span className="video-workflow-phase-copy">
                <strong>{t(phase.labelKey)}</strong>
                <small>{t(phase.hintKey)}</small>
              </span>
              <span className="video-workflow-phase-count">
                {status === 'completed' ? <CheckCircleOutlined /> : `${completed}/${phase.stages.length}`}
              </span>
            </button>
          );
        })}
      </nav>

      {showNextAction && (
        <section className={`video-workflow-next is-${overall}`} aria-live="polite">
          <div className="video-workflow-next-copy">
            <div className="video-workflow-next-kicker">
              <span>{t('video.workflow.nextLabel')}</span>
              <Tag color={statusColor(overall)}>{statusLabel}</Tag>
            </div>
            <div className="video-workflow-next-title-row">
              <span className="video-workflow-next-icon">{actionIcon}</span>
              <div>
                <Title level={5}>{actionLabel}</Title>
                <Text type="secondary">
                  {actionDescription}
                  {overall === 'running' && currentStageProgress > 0 ? ` (${currentStageProgress}%)` : ''}
                </Text>
              </div>
            </div>
            <div className="video-workflow-handoff">
              <div>
                <small>{t('video.workflow.input')}</small>
                <strong>{handoff.input}</strong>
              </div>
              <ArrowRightOutlined />
              <div>
                <small>{t('video.workflow.output')}</small>
                <strong>{handoff.output}</strong>
              </div>
            </div>
          </div>
          <div className="video-workflow-next-actions">
            <Button
              type="primary"
              icon={actionIcon}
              loading={primaryLoading}
              disabled={overall === 'running' && !nextStage}
              onClick={action}
            >
              {actionLabel}
            </Button>
            {overall === 'running' && (
              <Button danger icon={<StopOutlined />} onClick={onStop}>
                {t('video.workflow.stop')}
              </Button>
            )}
          </div>
        </section>
      )}

      {(preflight.blocking.length > 0 || preflight.warnings.length > 0) && (
        <section className="video-workflow-preflight">
          {preflight.blocking.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message={t('video.workflow.preflightBlocked')}
              description={t('video.workflow.preflightBlockedDescription', {
                count: preflight.blocking.length,
                categories: issueCategories,
              })}
              action={<Button size="small" icon={<SettingOutlined />} onClick={onOpenSettings}>{t('video.preflight.openSettings')}</Button>}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              message={t('video.workflow.preflightWarning')}
              description={t('video.workflow.preflightWarningDescription', { count: preflight.warnings.length })}
            />
          )}
          <Collapse
            ghost
            size="small"
            items={[{
              key: 'preflight-details',
              label: t('video.workflow.preflightDetails'),
              children: <PipelinePreflightAlert result={preflight} onOpenShots={() => onPhaseChange('studio')} />,
            }]}
          />
        </section>
      )}

    </div>
  );
};

export default VideoWorkflowGuide;

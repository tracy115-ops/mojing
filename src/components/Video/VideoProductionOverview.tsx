import React, { useMemo } from 'react';
import { Alert, Button, Progress, Space, Tag, Typography } from 'antd';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  PictureOutlined,
  ProfileOutlined,
  SettingOutlined,
  SoundOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { PipelinePreflightResult } from '@/services/video/core/pipeline-preflight-rules';
import { isShotAssemblyReady, isShotKeyframeCurrent } from '@/services/video/core/shot-production-contract';
import { resolveAssemblyQualityRequirements } from '@/services/video/core/quality-policy';
import type { VideoProjectState, VideoStage } from '@/types/video';
import type { WorkflowPhase } from './VideoWorkflowGuide';
import './VideoProductionOverview.css';

const { Text, Title } = Typography;

type WorkPhase = Exclude<WorkflowPhase, 'flow'>;
type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  project: VideoProjectState;
  sourceText?: string;
  preflight: PipelinePreflightResult;
  progressPercent: number;
  onOpenPhase: (phase: WorkPhase) => void;
  onRunStage: (stage: VideoStage) => void;
  onOpenSettings: () => void;
  onOpenTrace: () => void;
  t: Translate;
}

interface PhaseSummary {
  id: WorkPhase;
  number: string;
  icon: React.ReactNode;
  label: string;
  description: string;
  input: string;
  output: string;
  status: 'ready' | 'progress' | 'done' | 'blocked';
  action: string;
}

function isStageDone(project: VideoProjectState, stage: VideoStage): boolean {
  const status = project.stages[stage]?.status;
  return status === 'completed' || status === 'skipped';
}

const VideoProductionOverview: React.FC<Props> = ({
  project,
  sourceText,
  preflight,
  progressPercent,
  onOpenPhase,
  onRunStage,
  onOpenSettings,
  onOpenTrace,
  t,
}) => {
  const sceneSpec = project.sceneSpec;
  const shots = sceneSpec?.shots ?? [];
  const characters = sceneSpec?.characters ?? [];
  const scenes = sceneSpec?.scenes ?? [];
  const clips = project.clips.filter((clip) => !!clip.videoUrl);
  const keyframes = shots.filter(isShotKeyframeCurrent).length;
  const assemblyRequirements = resolveAssemblyQualityRequirements(project.options);
  const approved = shots.filter((shot) => {
    const clip = project.clips.find((candidate) => candidate.shotId === shot.id);
    return isShotAssemblyReady(shot, clip, assemblyRequirements);
  }).length;
  const assetsReady = characters.every((character) => !!(character.portraitImage || character.turnaroundImage))
    && scenes.every((scene) => !!scene.backgroundImage);
  const hasInput = !!sourceText?.trim() || shots.length > 0;

  const nextPhase = useMemo<WorkPhase>(() => {
    if (shots.length === 0) return 'script';
    if (!assetsReady) return 'assets';
    if (keyframes < shots.length || clips.length < shots.length || approved < shots.length) return 'studio';
    return 'timeline';
  }, [approved, assetsReady, clips.length, keyframes, shots.length]);

  const nextAction = useMemo(() => {
    const shotReferenceBlocking = preflight.blocking.some((issue) => issue.code === 'multi-subject-reference-unsupported');
    if (shotReferenceBlocking) {
      return {
        label: t('video.overview.openShots'),
        description: t('video.overview.shotsDescription', { approved, total: shots.length }),
        icon: <VideoCameraOutlined />,
        run: () => onOpenPhase('studio'),
      };
    }
    if (preflight.blocking.length > 0) {
      return {
        label: t('video.overview.openSettings'),
        description: t('video.overview.configurationRequired', { count: preflight.blocking.length }),
        icon: <SettingOutlined />,
        run: onOpenSettings,
      };
    }
    if (!hasInput) {
      return {
        label: t('video.overview.openScript'),
        description: t('video.overview.inputRequired'),
        icon: <FileTextOutlined />,
        run: () => onOpenPhase('script'),
      };
    }
    if (shots.length === 0) {
      return {
        label: t('video.overview.startPlanning'),
        description: t('video.overview.planningDescription'),
        icon: <ArrowRightOutlined />,
        run: () => onRunStage('script_slicing'),
      };
    }
    if (nextPhase === 'assets') {
      return {
        label: t('video.overview.openAssets'),
        description: t('video.overview.assetsDescription'),
        icon: <PictureOutlined />,
        run: () => onOpenPhase('assets'),
      };
    }
    if (nextPhase === 'studio') {
      return {
        label: t('video.overview.openShots'),
        description: t('video.overview.shotsDescription', { approved, total: shots.length }),
        icon: <VideoCameraOutlined />,
        run: () => onOpenPhase('studio'),
      };
    }
    return {
      label: t('video.overview.openTimeline'),
      description: t('video.overview.timelineDescription'),
      icon: <SoundOutlined />,
      run: () => onOpenPhase('timeline'),
    };
  }, [approved, hasInput, nextPhase, onOpenPhase, onOpenSettings, onRunStage, preflight.blocking.length, shots.length, t]);

  const phases = useMemo<PhaseSummary[]>(() => [
    {
      id: 'script',
      number: '01',
      icon: <FileTextOutlined />,
      label: t('video.workflow.phase.script'),
      description: t('video.workflow.phase.scriptHint'),
      input: sourceText?.trim() ? t('video.overview.sourceReady') : t('video.overview.sourceMissing'),
      output: t('video.overview.shotCount', { count: shots.length }),
      status: shots.length > 0 ? 'done' : sourceText?.trim() ? 'ready' : 'blocked',
      action: t('video.overview.open'),
    },
    {
      id: 'assets',
      number: '02',
      icon: <PictureOutlined />,
      label: t('video.workflow.phase.assets'),
      description: t('video.workflow.phase.assetsHint'),
      input: t('video.overview.entityCount', { characters: characters.length, scenes: scenes.length }),
      output: t('video.overview.assetCount', {
        characters: characters.filter((character) => !!(character.portraitImage || character.turnaroundImage)).length,
        scenes: scenes.filter((scene) => !!scene.backgroundImage).length,
      }),
      status: shots.length > 0 && assetsReady ? 'done' : shots.length > 0 ? 'ready' : 'blocked',
      action: t('video.overview.open'),
    },
    {
      id: 'studio',
      number: '03',
      icon: <VideoCameraOutlined />,
      label: t('video.workflow.phase.studio'),
      description: t('video.workflow.phase.studioHint'),
      input: t('video.overview.keyframeCount', { ready: keyframes, total: shots.length }),
      output: t('video.overview.approvedCount', { ready: approved, total: shots.length }),
      status: approved === shots.length && shots.length > 0 ? 'done' : shots.length > 0 ? 'progress' : 'blocked',
      action: t('video.overview.open'),
    },
    {
      id: 'timeline',
      number: '04',
      icon: <SoundOutlined />,
      label: t('video.workflow.phase.timeline'),
      description: t('video.workflow.phase.timelineHint'),
      input: t('video.overview.timelineInput', { count: approved }),
      output: project.finalVideoUrl ? t('video.overview.finalReady') : t('video.overview.finalPending'),
      status: project.finalVideoUrl ? 'done' : approved === shots.length && shots.length > 0 ? 'ready' : 'blocked',
      action: t('video.overview.open'),
    },
  ], [approved, assetsReady, characters, keyframes, project.finalVideoUrl, scenes, shots.length, sourceText, t]);

  return (
    <div className="video-production-overview" data-testid="video-production-overview">
      <header className="video-production-overview-header">
        <div>
          <Text className="video-production-overview-eyebrow">{t('video.overview.eyebrow')}</Text>
          <Title level={4}>{t('video.overview.title')}</Title>
          <Text type="secondary">{t('video.overview.subtitle')}</Text>
        </div>
        <Space size={8} wrap>
          <Tag color={project.finalVideoUrl ? 'success' : progressPercent > 0 ? 'processing' : 'default'}>
            {project.finalVideoUrl ? t('video.overview.complete') : t('video.overview.progress', { percent: progressPercent })}
          </Tag>
          <Button size="small" icon={<ProfileOutlined />} data-testid="video-overview-trace" onClick={onOpenTrace}>
            {t('video.overview.technicalDetails')}
          </Button>
        </Space>
      </header>

      <section className="video-production-overview-next" data-testid="video-overview-next-action">
        <div className="video-production-overview-next-copy">
          <Text type="secondary">{t('video.overview.nextLabel')}</Text>
          <div className="video-production-overview-next-title">
            <span className="video-production-overview-next-icon">{nextAction.icon}</span>
            <div>
              <Title level={5}>{nextAction.label}</Title>
              <Text type="secondary">{nextAction.description}</Text>
            </div>
          </div>
        </div>
        <Button type="primary" icon={nextAction.icon} data-testid="video-overview-next-action-button" onClick={nextAction.run}>
          {nextAction.label}
        </Button>
      </section>

      {preflight.blocking.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message={t('video.overview.configurationRequired', { count: preflight.blocking.length })}
          description={t('video.overview.configurationHint')}
          action={<Button size="small" icon={<SettingOutlined />} onClick={onOpenSettings}>{t('video.overview.openSettings')}</Button>}
        />
      )}

      <section className="video-production-overview-section">
        <div className="video-production-overview-section-heading">
          <div>
            <Text strong>{t('video.overview.flowTitle')}</Text>
            <Text type="secondary">{t('video.overview.flowHint')}</Text>
          </div>
          <Progress percent={progressPercent} showInfo={false} size="small" />
        </div>
        <div className="video-production-overview-phases">
          {phases.map((phase) => (
            <button
              type="button"
              className={`video-production-overview-phase is-${phase.status} ${nextPhase === phase.id ? 'is-next' : ''}`}
              key={phase.id}
              onClick={() => onOpenPhase(phase.id)}
            >
              <span className="video-production-overview-phase-number">{phase.number}</span>
              <span className="video-production-overview-phase-icon">{phase.icon}</span>
              <span className="video-production-overview-phase-copy">
                <strong>{phase.label}</strong>
                <small>{phase.description}</small>
                <span>{phase.input} <ArrowRightOutlined /> {phase.output}</span>
              </span>
              <span className="video-production-overview-phase-status">
                {phase.status === 'done' ? <CheckCircleOutlined /> : phase.status === 'blocked' ? <ExclamationCircleOutlined /> : phase.action}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="video-production-overview-quality">
        <div>
          <Text strong>{t('video.overview.qualityTitle')}</Text>
          <Text type="secondary">{t('video.overview.qualityHint')}</Text>
        </div>
        <div className="video-production-overview-quality-items">
          <Tag color="blue">{t('video.overview.qualityI2V')}</Tag>
          <Tag color="purple">{t('video.overview.qualityCandidates')}</Tag>
          <Tag color="orange">{t('video.overview.qualityHumanGate')}</Tag>
          <Tag color={project.options?.enableVisualQualityGate === false ? 'default' : 'green'}>
            {project.options?.enableVisualQualityGate === false ? t('video.overview.qualityVisualOff') : t('video.overview.qualityVisualOn')}
          </Tag>
        </div>
      </section>
    </div>
  );
};

export default VideoProductionOverview;

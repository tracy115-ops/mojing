import { Tag } from 'antd';
import { useTranslation } from '@/i18n';
import { isVideoQueueFull } from '@/services/providers/router';
import {
  getProductionReadiness,
  getVideoPipelineStatus,
  type VideoPipelineStatus,
} from '@/services/video/core/production-readiness';
import type { VideoProjectState, VideoQueueRetry } from '@/types/video';
import './VideoProjectProgress.css';

const colors: Record<VideoPipelineStatus, string> = {
  idle: 'default',
  running: 'processing',
  review: 'warning',
  complete: 'success',
  error: 'error',
  stopped: 'warning',
  interrupted: 'warning',
};

export function formatVideoQueueRetry(t: ReturnType<typeof useTranslation>['t'], retry: VideoQueueRetry): string {
  return t('video.progress.queueRetry', {
    attempt: retry.attempt,
    total: retry.total,
    time: new Date(retry.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
  });
}

interface Props {
  project: VideoProjectState;
  episodeNumber?: number;
  runningEpisodes?: number;
}

export default function VideoProjectProgress({ project, episodeNumber, runningEpisodes }: Props) {
  const { t } = useTranslation();
  const { status, stage } = getVideoPipelineStatus(project);
  if (status === 'idle') return null;
  const stageState = project.stages[stage];
  const { counts } = getProductionReadiness(project);
  const showVideoCount = ['video_generation', 'video_review', 'audio_merge', 'composing', 'complete'].includes(stage);
  const detail = stage === 'keyframe_image' && counts.shots > 0
    ? t('video.overview.keyframeCount', { ready: counts.keyframes, total: counts.shots })
    : showVideoCount && counts.shots > 0
      ? t('video.progress.clips', { ready: counts.videoCandidates, total: counts.shots })
      : status === 'running' && stageState?.progress
        ? t('video.overview.progress', { percent: Math.round(stageState.progress * 100) })
        : undefined;
  const queueRetry = status === 'running' ? stageState?.queueRetry : undefined;
  const queueFailed = status === 'error' && isVideoQueueFull(stageState?.error ?? project.error);
  const stageLabel = stage === 'complete' || stage === 'error' ? undefined : t(`video.gen.stage.${stage}`);
  const progress = [stageLabel, detail].filter(Boolean).join(' · ');

  return (
    <div className="video-project-progress" role="status" data-testid="video-project-progress">
      <div className="video-project-progress-heading">
        <Tag color={queueRetry ? 'warning' : colors[status]}>
          {runningEpisodes && runningEpisodes > 1
            ? t('video.progress.runningEpisodes', { count: runningEpisodes })
            : t(`video.pipeline.status.${status}`)}
        </Tag>
        {episodeNumber !== undefined && <span>{t('video.series.episodeNumber', { number: episodeNumber })}</span>}
      </div>
      {progress && <div>{progress}</div>}
      {queueRetry && <div className="video-project-progress-queue">{formatVideoQueueRetry(t, queueRetry)}</div>}
      {queueFailed && <div className="video-project-progress-queue">{t('video.progress.queueFailed')}</div>}
    </div>
  );
}

import { useMemo } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import { getVideoPipelineStatus, type VideoPipelineStatus } from '@/services/video/core/production-readiness';
import type { VideoMetadata } from '@/types';

function taskPriority(status: VideoPipelineStatus): number {
  if (status === 'running') return 0;
  return status === 'complete' ? 2 : 1;
}

export function useShortDramaTasks() {
  const projects = useProjectStore((state) => state.projects);
  const pipelines = useVideoStore((state) => state.projects);

  return useMemo(() => {
    const titles = new Map(projects.map((project) => [project.id, project.title]));
    return projects.flatMap((project) => {
      const pipeline = pipelines[project.id];
      if (!pipeline || project.type !== 'video' || project.status === 'archived') return [];
      const { status } = getVideoPipelineStatus(pipeline);
      if (status === 'idle') return [];
      const { seriesId } = project.metadata as VideoMetadata;
      return [{
        projectId: project.id,
        title: project.title,
        series: seriesId ? titles.get(seriesId) : undefined,
        pipeline,
        status,
      }];
    }).sort((a, b) => taskPriority(a.status) - taskPriority(b.status)
      || (b.pipeline.updatedAt ?? '').localeCompare(a.pipeline.updatedAt ?? ''));
  }, [projects, pipelines]);
}

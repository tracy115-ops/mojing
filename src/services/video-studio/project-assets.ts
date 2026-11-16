import type { VideoProjectState } from '../../types/video.ts';
import type { StudioAsset } from '../../types/video-studio.ts';

export interface ProjectStudioAsset extends StudioAsset { projectId?: string }
export function collectProjectStudioAssets(projects: Record<string, VideoProjectState>, titles: Record<string, string> = {}): ProjectStudioAsset[] {
  const result: ProjectStudioAsset[] = [];
  for (const project of Object.values(projects)) {
    const projectId = project.novelProjectId;
    const prefix = titles[projectId] || project.title || projectId;
    const add = (id: string, name: string, kind: StudioAsset['kind'], category: StudioAsset['category'], url?: string, text?: string) => {
      if (url || text) result.push({ id: `${projectId}:${id}`, projectId, name: `${prefix} · ${name}`, kind, category, url, text, createdAt: project.createdAt });
    };
    for (const character of project.sceneSpec?.characters ?? []) {
      add(`portrait:${character.id}`, character.name, 'image', 'character', character.portraitImage);
      add(`turnaround:${character.id}`, `${character.name} / turnaround`, 'image', 'character', character.turnaroundImage);
      for (const costume of character.costumeVariants ?? []) add(`costume:${character.id}:${costume.id}`, `${character.name} / ${costume.id}`, 'image', 'character', costume.portraitImage);
    }
    for (const scene of project.sceneSpec?.scenes ?? []) add(`scene:${scene.id}`, scene.name, 'image', 'scene', scene.backgroundImage);
    for (const prop of project.sceneSpec?.props ?? []) add(`prop:${prop.id}`, prop.name, 'text', 'prop', undefined, prop.description);
    for (const shot of project.sceneSpec?.shots ?? []) {
      add(`shot:${shot.id}`, `#${shot.index + 1}`, 'image', 'reference', shot.keyframeImage);
      for (const version of shot.versionHistory ?? []) add(`version:${version.id}`, `#${shot.index + 1} / ${version.id}`, version.type, 'output', version.url);
    }
    for (const clip of project.clips) {
      add(`clip:${clip.shotId}`, clip.shotId, 'video', 'output', clip.videoUrl);
      add(`tail:${clip.shotId}`, `${clip.shotId} / tail`, 'image', 'reference', clip.lastFrameImage);
    }
    for (const audio of project.audios) add(`audio:${audio.shotId}`, audio.shotId, 'audio', 'output', audio.audioUrl);
    add('final', prefix, 'video', 'output', project.finalVideoUrl);
  }
  return result;
}

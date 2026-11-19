import type {
  GeneratedClip,
  ShotSpec,
  VideoProjectState,
  VideoStage,
} from '../../../types/video.ts';
import { hasCurrentTurnaround } from './character-asset-binding.ts';
import { isShotKeyframeCurrent } from './shot-production-contract.ts';

export interface StageArtifactHealthDependencies {
  isAssetAvailable: (url: string | undefined) => Promise<boolean>;
  isValidVideoClip: (clip: { videoUrl?: string } | undefined) => boolean;
  environmentReferenceVersion: number;
  resolveAssetPath?: (url: string) => string;
}

export function hasMergedDialogue(
  shot: Pick<ShotSpec, 'audioTrack'>,
  clip: GeneratedClip,
  resolveAssetPath: (url: string) => string = (url) => url,
): boolean {
  if (clip.importedVideo?.audio === 'preserve') return true;
  const dialogue = shot.audioTrack;
  // Older projects stored the muxed video itself as the shot's audioTrack.
  return !!dialogue && !!clip.hasAudio && (clip.audioTrack === dialogue
    || resolveAssetPath(clip.videoUrl) === resolveAssetPath(dialogue));
}

/** Decide whether a completed stage still has every output required downstream. */
export async function isStageLiveCompleted(
  project: VideoProjectState,
  stage: VideoStage,
  dependencies: StageArtifactHealthDependencies,
): Promise<boolean> {
  const state = project.stages[stage];
  if (!state || state.status !== 'completed') return false;

  switch (stage) {
    case 'script_slicing':
      return project.shots.length > 0;
    case 'storyboard_prompt':
      return project.shots.length > 0 && project.shots.every((shot) => !!shot.videoPrompt?.trim());
    case 'extraction':
      return !!project.sceneSpec && project.sceneSpec.shots.length > 0;
    case 'character_anchor':
      return characterAnchorAssetsAvailable(project, dependencies.isAssetAvailable);
    case 'scene_image':
      return sceneImageAssetsAvailable(project, dependencies);
    case 'keyframe_image':
      return keyframeAssetsAvailable(project, dependencies.isAssetAvailable);
    case 'video_generation':
      return videoGenerationAssetsAvailable(project, dependencies);
    case 'video_review':
      return videoReviewAssetsAvailable(project, dependencies);
    case 'tts':
      return ttsAssetsAvailable(project, dependencies.isAssetAvailable);
    case 'audio_merge':
      return audioMergeAssetsAvailable(project, dependencies);
    case 'composing':
      return dependencies.isAssetAvailable(project.finalVideoUrl);
    default:
      return true;
  }
}

async function keyframeAssetsAvailable(
  project: VideoProjectState,
  isAssetAvailable: StageArtifactHealthDependencies['isAssetAvailable'],
): Promise<boolean> {
  const shots = project.sceneSpec?.shots ?? [];
  return shots.length > 0 && (await Promise.all(shots.map(async (shot) => (
    isShotKeyframeCurrent(shot) && await isAssetAvailable(shot.keyframeImage)
  )))).every(Boolean);
}

async function allAssetsAvailable(
  urls: Array<string | undefined>,
  isAssetAvailable: StageArtifactHealthDependencies['isAssetAvailable'],
): Promise<boolean> {
  return urls.length > 0 && (await Promise.all(urls.map(isAssetAvailable))).every(Boolean);
}

async function characterAnchorAssetsAvailable(
  project: VideoProjectState,
  isAssetAvailable: StageArtifactHealthDependencies['isAssetAvailable'],
): Promise<boolean> {
  const characters = project.sceneSpec?.characters ?? [];
  if (characters.length === 0) return false;
  const anchorMode = project.stages.character_anchor?.input?.anchorMode === 'single' ? 'single' : 'turnaround';
  const urls = characters.flatMap((character) => [
    character.portraitImage,
    ...(anchorMode === 'turnaround' && hasCurrentTurnaround(character) ? [character.turnaroundImage] : []),
    ...(character.costumeVariants ?? [])
      .filter((variant) => variant.id !== 'default')
      .map((variant) => variant.portraitImage),
  ]);
  const requiredCount = characters.length
    + (anchorMode === 'turnaround' ? characters.length : 0)
    + characters.reduce(
      (count, character) => count + (character.costumeVariants?.filter((variant) => variant.id !== 'default').length ?? 0),
      0,
    );
  return urls.length === requiredCount && await allAssetsAvailable(urls, isAssetAvailable);
}

async function sceneImageAssetsAvailable(
  project: VideoProjectState,
  dependencies: StageArtifactHealthDependencies,
): Promise<boolean> {
  const scenes = project.sceneSpec?.scenes ?? [];
  if (scenes.length === 0) return false;
  const verified = scenes.every((scene) =>
    !!scene.backgroundImage
      && scene.backgroundReferenceRole === 'environment_only'
      && scene.backgroundReferenceVersion === dependencies.environmentReferenceVersion,
  );
  return verified && await allAssetsAvailable(
    scenes.map((scene) => scene.backgroundImage),
    dependencies.isAssetAvailable,
  );
}

function shotHasSpeech(shot: ShotSpec): boolean {
  return !!(
    shot.dialogue?.some((dialogue) => !!dialogue.text?.trim())
    || shot.narration?.trim()
    || shot.sourceText?.trim()
    || shot.videoPrompt?.trim()
  );
}

async function ttsAssetsAvailable(
  project: VideoProjectState,
  isAssetAvailable: StageArtifactHealthDependencies['isAssetAvailable'],
): Promise<boolean> {
  const shots = project.sceneSpec?.shots ?? [];
  const expectedShots = shots.filter(shotHasSpeech);
  if (expectedShots.length === 0) return true;
  const audioByShot = new Map(project.audios.map((audio) => [audio.shotId, audio.audioUrl]));
  return (await Promise.all(expectedShots.map((shot) =>
    isAssetAvailable(shot.audioTrack || audioByShot.get(shot.id)),
  ))).every(Boolean);
}

async function videoGenerationAssetsAvailable(
  project: VideoProjectState,
  dependencies: StageArtifactHealthDependencies,
): Promise<boolean> {
  if (project.shots.length === 0 || project.clips.length !== project.shots.length) return false;
  const shotIds = new Set(project.shots.map((shot) => shot.id));
  const clipIds = new Set(project.clips.map((clip) => clip.shotId));
  if (clipIds.size !== shotIds.size || [...clipIds].some((id) => !shotIds.has(id))) return false;
  return (await Promise.all(project.clips.map(async (clip) =>
    dependencies.isValidVideoClip(clip) && await dependencies.isAssetAvailable(clip.videoUrl),
  ))).every(Boolean);
}

async function videoReviewAssetsAvailable(
  project: VideoProjectState,
  dependencies: StageArtifactHealthDependencies,
): Promise<boolean> {
  if (!(await videoGenerationAssetsAvailable(project, dependencies))) return false;
  return project.clips.every((clip) => (
    !!clip.qualityReview
      && clip.qualityReview.status !== 'failed'
      && clip.visualReview?.status !== 'failed'
  ));
}

async function audioMergeAssetsAvailable(
  project: VideoProjectState,
  dependencies: StageArtifactHealthDependencies,
): Promise<boolean> {
  const shotsWithAudio = (project.sceneSpec?.shots ?? []).filter((shot) => !!shot.audioTrack);
  if (shotsWithAudio.length === 0) return true;
  const clipsByShot = new Map(project.clips.map((clip) => [clip.shotId, clip]));
  return (await Promise.all(shotsWithAudio.map(async (shot) => {
    const clip = clipsByShot.get(shot.id);
    return !!clip && hasMergedDialogue(shot, clip, dependencies.resolveAssetPath)
      && dependencies.isValidVideoClip(clip)
      && await dependencies.isAssetAvailable(clip.videoUrl);
  }))).every(Boolean);
}

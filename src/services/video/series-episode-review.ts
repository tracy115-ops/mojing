import type { CharacterAnchor, SceneAnchor, SceneSpec } from '@/types/video';

export interface SeriesEpisodeReview {
  totalShots: number;
  keyframedShots: number;
  missingKeyframeIndexes: number[];
  unresolvedCharacterIds: string[];
  unresolvedSceneIds: string[];
  libraryCharacterMismatches: string[];
  librarySceneMismatches: string[];
  charactersWithoutPortrait: string[];
  scenesWithoutReference: string[];
  ready: boolean;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s·・._-]/g, '');
}

function libraryNames<T extends { name: string; aliases?: string[] }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    result.set(normalize(item.name), item);
    for (const alias of item.aliases ?? []) result.set(normalize(alias), item);
  }
  return result;
}

/** 可解释的本地审核：不调用模型，也不把没有资产的自由镜头判为错误。 */
export function reviewSeriesEpisode(
  sceneSpec: SceneSpec | undefined,
  library: { characters?: CharacterAnchor[]; scenes?: SceneAnchor[] } | undefined,
): SeriesEpisodeReview {
  const shots = sceneSpec?.shots ?? [];
  const characters = sceneSpec?.characters ?? [];
  const scenes = sceneSpec?.scenes ?? [];
  const characterById = new Map(characters.map((item) => [item.id, item]));
  const sceneById = new Map(scenes.map((item) => [item.id, item]));
  const usedCharacterIds = new Set(shots.flatMap((shot) => shot.characterIds));
  const usedSceneIds = new Set(shots.map((shot) => shot.sceneId).filter((id): id is string => !!id));
  const characterLibrary = libraryNames(library?.characters ?? []);
  const sceneLibrary = libraryNames(library?.scenes ?? []);

  const unresolvedCharacterIds = [...usedCharacterIds].filter((id) => !characterById.has(id));
  const unresolvedSceneIds = [...usedSceneIds].filter((id) => !sceneById.has(id));
  const libraryCharacterMismatches = characters
    .filter((character) => {
      const canonical = characterLibrary.get(normalize(character.name));
      return !!canonical && canonical.id !== character.id;
    })
    .map((character) => character.name);
  const librarySceneMismatches = scenes
    .filter((scene) => {
      const canonical = sceneLibrary.get(normalize(scene.name));
      return !!canonical && canonical.id !== scene.id;
    })
    .map((scene) => scene.name);

  return {
    totalShots: shots.length,
    keyframedShots: shots.filter((shot) => !!shot.keyframeImage).length,
    missingKeyframeIndexes: shots.filter((shot) => !shot.keyframeImage).map((shot) => shot.index + 1),
    unresolvedCharacterIds,
    unresolvedSceneIds,
    libraryCharacterMismatches,
    librarySceneMismatches,
    charactersWithoutPortrait: [...usedCharacterIds]
      .map((id) => characterById.get(id))
      .filter((character): character is CharacterAnchor => !!character && !character.portraitImage)
      .map((character) => character.name),
    scenesWithoutReference: [...usedSceneIds]
      .map((id) => sceneById.get(id))
      .filter((scene): scene is SceneAnchor => !!scene && !scene.backgroundImage)
      .map((scene) => scene.name),
    ready: shots.length > 0
      && shots.every((shot) => !!shot.keyframeImage)
      && unresolvedCharacterIds.length === 0
      && unresolvedSceneIds.length === 0
      && libraryCharacterMismatches.length === 0
      && librarySceneMismatches.length === 0,
  };
}

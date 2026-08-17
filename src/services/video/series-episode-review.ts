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
  const characterById = new Map<string, CharacterAnchor>();
  for (const c of characters) {
    characterById.set(c.id, c);
    characterById.set(normalize(c.name), c);
  }
  const sceneById = new Map<string, SceneAnchor>();
  for (const s of scenes) {
    sceneById.set(s.id, s);
    sceneById.set(normalize(s.name), s);
  }
  const usedCharacterIds = new Set(shots.flatMap((shot) => shot.characterIds || []));
  const usedSceneIds = new Set(shots.map((shot) => shot.sceneId).filter((id): id is string => !!id));
  const characterLibrary = libraryNames(library?.characters ?? []);
  const sceneLibrary = libraryNames(library?.scenes ?? []);

  const unresolvedCharacterIds = [...usedCharacterIds].filter((id) => !characterById.has(id) && !characterById.has(normalize(id)));
  const unresolvedSceneIds = [...usedSceneIds].filter((id) => !sceneById.has(id) && !sceneById.has(normalize(id)));
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

  const missingKeyframeIndexes = shots.filter((shot) => !shot.keyframeImage).map((shot) => shot.index + 1);

  return {
    totalShots: shots.length,
    keyframedShots: shots.filter((shot) => !!shot.keyframeImage).length,
    missingKeyframeIndexes,
    unresolvedCharacterIds,
    unresolvedSceneIds,
    libraryCharacterMismatches,
    librarySceneMismatches,
    charactersWithoutPortrait: [...usedCharacterIds]
      .map((id) => characterById.get(id) || characterById.get(normalize(id)))
      .filter((character): character is CharacterAnchor => !!character && !character.portraitImage)
      .map((character) => character.name),
    scenesWithoutReference: [...usedSceneIds]
      .map((id) => sceneById.get(id) || sceneById.get(normalize(id)))
      .filter((scene): scene is SceneAnchor => !!scene && !scene.backgroundImage)
      .map((scene) => scene.name),
    ready: shots.length > 0,
  };
}

import type { CharacterAnchor, SceneAnchor, SceneSpec } from '@/types/video';

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s·・._-]/g, '');
}

function cloneCharacter(character: CharacterAnchor): CharacterAnchor {
  return {
    ...character,
    costumeVariants: character.costumeVariants?.map((variant) => ({ ...variant })),
  };
}

function resolveCostumeVariant(character: CharacterAnchor, shot: SceneSpec['shots'][number]): string | undefined {
  const text = normalizeName(`${shot.sourceText ?? ''} ${shot.videoPrompt}`);
  return character.costumeVariants?.find((variant) => {
    const id = normalizeName(variant.id);
    const description = normalizeName(variant.description);
    return (id.length >= 3 && text.includes(id)) || (description.length >= 4 && text.includes(description));
  })?.id;
}

/**
 * 将剧本提取到的角色绑定到系列角色库。名字或别名相同的角色保留本集首登信息，
 * 其余外观、立绘、三视图、服装和音色都以项目资产为准。
 */
export function applySeriesCharacterLibrary(
  sceneSpec: SceneSpec,
  library: CharacterAnchor[] | undefined,
): SceneSpec {
  if (!library?.length || !sceneSpec.characters?.length) return sceneSpec;

  const byName = new Map<string, CharacterAnchor>();
  for (const character of library) {
    byName.set(normalizeName(character.name), character);
    for (const alias of character.aliases ?? []) byName.set(normalizeName(alias), character);
  }

  const idMap = new Map<string, string>();
  const matchedCharacterNames: string[] = [];
  const unmatchedCharacterNames: string[] = [];

  const characters = sceneSpec.characters.map((detected) => {
    const canonical = byName.get(normalizeName(detected.name));
    if (!canonical) {
      unmatchedCharacterNames.push(detected.name);
      return cloneCharacter(detected);
    }
    matchedCharacterNames.push(`${detected.name} → ${canonical.name}`);
    idMap.set(detected.id, canonical.id);
    return { ...cloneCharacter(canonical), firstAppearShotIndex: detected.firstAppearShotIndex };
  });

  const seen = new Set<string>();
  const uniqueCharacters = characters.filter((character) => {
    if (seen.has(character.id)) return false;
    seen.add(character.id);
    return true;
  });

  return {
    ...sceneSpec,
    characters: uniqueCharacters,
    shots: sceneSpec.shots.map((shot) => {
      const characterIds = [...new Set(shot.characterIds.map((id) => idMap.get(id) ?? id))];
      const costumeVariantRefs = { ...shot.costumeVariantRefs };
      for (const characterId of characterIds) {
        const character = uniqueCharacters.find((item) => item.id === characterId);
        const variantId = character && resolveCostumeVariant(character, shot);
        if (variantId) costumeVariantRefs[characterId] = variantId;
      }
      return { ...shot, characterIds, costumeVariantRefs: Object.keys(costumeVariantRefs).length ? costumeVariantRefs : undefined };
    }),
    meta: {
      ...sceneSpec.meta,
      matchedCharacterNames,
      unmatchedCharacterNames,
    },
  };
}

/** 将提取场景替换为项目场景资产，并为同一组镜头复用场景 ID。 */
export function applySeriesSceneLibrary(
  sceneSpec: SceneSpec,
  library: SceneAnchor[] | undefined,
  styleGuide?: string,
): SceneSpec {
  if (!library?.length && !styleGuide?.trim()) return sceneSpec;

  const byName = new Map<string, SceneAnchor>();
  for (const scene of library ?? []) {
    byName.set(normalizeName(scene.name), scene);
    for (const alias of scene.aliases ?? []) byName.set(normalizeName(alias), scene);
  }

  const idMap = new Map<string, string>();
  const matchedSceneNames: string[] = [];
  const unmatchedSceneNames: string[] = [];

  const scenes = (sceneSpec.scenes ?? []).map((detected) => {
    const canonical = byName.get(normalizeName(detected.name));
    if (!canonical) {
      unmatchedSceneNames.push(detected.name);
      return { ...detected };
    }
    matchedSceneNames.push(`${detected.name} → ${canonical.name}`);
    idMap.set(detected.id, canonical.id);
    return { ...canonical, firstAppearShotIndex: detected.firstAppearShotIndex };
  });
  const seen = new Set<string>();

  return {
    ...sceneSpec,
    scenes: scenes.filter((scene) => {
      if (seen.has(scene.id)) return false;
      seen.add(scene.id);
      return true;
    }),
    shots: sceneSpec.shots.map((shot) => ({ ...shot, sceneId: shot.sceneId ? idMap.get(shot.sceneId) ?? shot.sceneId : undefined })),
    meta: {
      ...sceneSpec.meta,
      style: [sceneSpec.meta.style, styleGuide?.trim()].filter(Boolean).join(', '),
      matchedSceneNames,
      unmatchedSceneNames,
    },
  };
}

export function applySeriesProjectLibrary(
  sceneSpec: SceneSpec,
  library: { characters?: CharacterAnchor[]; scenes?: SceneAnchor[]; styleGuide?: string },
): SceneSpec {
  return applySeriesSceneLibrary(
    applySeriesCharacterLibrary(sceneSpec, library.characters),
    library.scenes,
    library.styleGuide,
  );
}

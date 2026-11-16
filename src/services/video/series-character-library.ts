import type { CharacterAnchor, SceneAnchor, SceneSpec } from '@/types/video';

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s·・._-]/g, '');
}

function cloneCharacter(character: CharacterAnchor): CharacterAnchor {
  return {
    ...character,
    aliases: character.aliases ? [...character.aliases] : undefined,
    costumeVariants: character.costumeVariants?.map((variant) => ({ ...variant })),
  };
}

function cloneScene(scene: SceneAnchor): SceneAnchor {
  return { ...scene, aliases: scene.aliases ? [...scene.aliases] : undefined };
}

function identityReferences(character: CharacterAnchor): string[] {
  return [character.id, character.name, ...(character.aliases ?? [])];
}

function buildLookup<T extends { id: string; name: string; aliases?: string[] }>(items: T[]): Map<string, T> {
  const lookup = new Map<string, T>();
  for (const item of items) {
    lookup.set(normalizeName(item.id), item);
    lookup.set(normalizeName(item.name), item);
    for (const alias of item.aliases ?? []) lookup.set(normalizeName(alias), item);
  }
  return lookup;
}

function hasExplicitVisibleBinding(shot: SceneSpec['shots'][number]): boolean {
  if (shot.characterBinding === 'explicit') return true;
  if (shot.characterBinding === 'inferred') return false;
  if (Array.isArray(shot.visibleCharacterIds)) return true;
  return (shot.characterIds ?? []).length > 0;
}

function shotVisibleRefs(shot: SceneSpec['shots'][number]): string[] {
  return Array.isArray(shot.visibleCharacterIds)
    ? shot.visibleCharacterIds
    : shot.characterIds ?? [];
}

function shotVisualText(shot: SceneSpec['shots'][number]): string {
  return [
    shot.videoPrompt || shot.sourceText || '',
    shot.location || '',
    shot.startState || '',
    shot.endState || '',
    ...(shot.dialogue ?? []).map((dialogue) => dialogue.speaker || ''),
  ].filter(Boolean).join(' ');
}

function mapReference(
  reference: string,
  idMap: Map<string, string>,
  lookup: Map<string, CharacterAnchor>,
): string {
  return idMap.get(reference)
    ?? idMap.get(normalizeName(reference))
    ?? lookup.get(normalizeName(reference))?.id
    ?? reference;
}

function resolveLibraryCharacter(
  reference: string,
  idMap: Map<string, string>,
  lookup: Map<string, CharacterAnchor>,
): CharacterAnchor | undefined {
  const mappedId = mapReference(reference, idMap, lookup);
  return lookup.get(normalizeName(mappedId)) ?? lookup.get(normalizeName(reference));
}

function matchLibraryCharacters(text: string, library: CharacterAnchor[]): CharacterAnchor[] {
  const normalizedText = normalizeName(text);
  if (!normalizedText) return [];
  return library.filter((character) => identityReferences(character)
    .map(normalizeName)
    .filter((reference) => reference.length >= 2)
    .some((reference) => normalizedText.includes(reference)));
}

/**
 * Replace extracted character descriptions with project assets. Existing
 * visible/offscreen bindings are authoritative; only inferred legacy shots may
 * recover exact project names or aliases from their visual text.
 */
export function applySeriesCharacterLibrary(
  sceneSpec: SceneSpec,
  library: CharacterAnchor[] | undefined,
): SceneSpec {
  if (!library?.length || !Array.isArray(sceneSpec.shots)) return sceneSpec;

  const lookup = buildLookup(library);
  const idMap = new Map<string, string>();
  const matchedCharacterNames: string[] = [];
  const unmatchedCharacterNames: string[] = [];

  const extractedCharacters = (sceneSpec.characters ?? []).map((detected) => {
    const canonical = lookup.get(normalizeName(detected.id)) ?? lookup.get(normalizeName(detected.name));
    if (!canonical) {
      unmatchedCharacterNames.push(detected.name);
      return cloneCharacter(detected);
    }

    matchedCharacterNames.push(`${detected.name} → ${canonical.name}`);
    for (const reference of identityReferences(detected)) idMap.set(reference, canonical.id);
    return {
      ...cloneCharacter(canonical),
      // The series asset owns stable appearance/images, while extraction still
      // owns facts that may be missing from an older library record.
      appearance: canonical.appearance || detected.appearance,
      entityType: canonical.entityType && canonical.entityType !== 'unknown'
        ? canonical.entityType
        : detected.entityType,
      gender: canonical.gender && canonical.gender !== 'unknown'
        ? canonical.gender
        : detected.gender,
      ageGroup: canonical.ageGroup && canonical.ageGroup !== 'unknown'
        ? canonical.ageGroup
        : detected.ageGroup,
      aliases: [...new Set([
        ...(canonical.aliases ?? []),
        detected.name,
        ...(detected.aliases ?? []),
      ])].filter((alias) => alias && alias !== canonical.name),
      firstAppearShotIndex: detected.firstAppearShotIndex,
    };
  });

  const uniqueCharacters: CharacterAnchor[] = [];
  const seenCharacters = new Set<string>();
  const addCharacter = (character: CharacterAnchor): void => {
    if (seenCharacters.has(character.id)) return;
    seenCharacters.add(character.id);
    uniqueCharacters.push(cloneCharacter(character));
  };
  extractedCharacters.forEach(addCharacter);

  const shots = sceneSpec.shots.map((shot) => {
    const visibleRefs = shotVisibleRefs(shot);
    const offscreenRefs = shot.offscreenCharacterIds ?? [];

    // The storyboard binding is authoritative for what must be visible in a
    // shot. Do not require extraction to repeat a character that already
    // exists in the series library: an LLM may omit a named subject while the
    // shot still carries the canonical id or alias. Without this step the id
    // is written onto the shot but the asset is absent from sceneSpec, so the
    // keyframe/video stages cannot resolve its reference image.
    [...visibleRefs, ...offscreenRefs].forEach((reference) => {
      const libraryCharacter = resolveLibraryCharacter(reference, idMap, lookup);
      if (libraryCharacter) addCharacter(libraryCharacter);
    });

    const visibleIds = [...new Set(visibleRefs.map((reference) => mapReference(reference, idMap, lookup)))];
    const offscreenIds = [...new Set(offscreenRefs.map((reference) => mapReference(reference, idMap, lookup)))];
    const offscreenSet = new Set(offscreenIds.map(normalizeName));

    let characterIds = visibleIds;
    if (!hasExplicitVisibleBinding(shot)) {
      const inferred = matchLibraryCharacters(shotVisualText(shot), library);
      inferred.forEach(addCharacter);
      characterIds = [...new Set([
        ...characterIds,
        ...inferred.map((character) => character.id),
      ])];
    }
    characterIds = characterIds.filter((id) => !offscreenSet.has(normalizeName(id)));

    return {
      ...shot,
      characterIds,
      visibleCharacterIds: characterIds,
      offscreenCharacterIds: offscreenIds,
      costumeVariantRefs: shot.costumeVariantRefs,
    };
  });

  return {
    ...sceneSpec,
    characters: uniqueCharacters,
    shots,
    meta: {
      ...sceneSpec.meta,
      matchedCharacterNames,
      unmatchedCharacterNames,
    },
  };
}

function resolveSceneId(
  shot: SceneSpec['shots'][number],
  scenes: SceneAnchor[],
  idMap: Map<string, string>,
  lookup: Map<string, SceneAnchor>,
): string | undefined {
  if (shot.sceneId) {
    const mapped = idMap.get(shot.sceneId) ?? idMap.get(normalizeName(shot.sceneId));
    if (mapped && scenes.some((scene) => scene.id === mapped)) return mapped;
    if (scenes.some((scene) => scene.id === shot.sceneId)) return shot.sceneId;
  }

  const location = normalizeName(shot.location ?? '');
  if (location) {
    const matches = scenes
      .filter((scene) => [scene.name, ...(scene.aliases ?? [])]
        .map(normalizeName)
        .some((name) => name && (name === location || name.includes(location) || location.includes(name))))
      .sort((a, b) => {
        const aLength = Math.max(normalizeName(a.name).length, ...(a.aliases ?? []).map((alias) => normalizeName(alias).length));
        const bLength = Math.max(normalizeName(b.name).length, ...(b.aliases ?? []).map((alias) => normalizeName(alias).length));
        return bLength - aLength;
      });
    if (matches[0]) return matches[0].id;
  }

  if (scenes.length === 1) return scenes[0].id;
  if (scenes.length > 1) {
    return scenes
      .slice()
      .sort((a, b) => {
        const aDistance = Math.abs(a.firstAppearShotIndex - shot.index);
        const bDistance = Math.abs(b.firstAppearShotIndex - shot.index);
        return aDistance - bDistance || a.firstAppearShotIndex - b.firstAppearShotIndex;
      })[0]?.id;
  }

  return lookup.get(normalizeName(shot.location ?? ''))?.id;
}

/** Replace extracted scenes with project assets and fill missing scene links. */
export function applySeriesSceneLibrary(
  sceneSpec: SceneSpec,
  library: SceneAnchor[] | undefined,
  styleGuide?: string,
): SceneSpec {
  if ((!library?.length && !styleGuide?.trim()) || !Array.isArray(sceneSpec.shots)) return sceneSpec;

  const sourceScenes = sceneSpec.scenes ?? [];
  const lookup = buildLookup(library ?? []);
  const idMap = new Map<string, string>();
  const matchedSceneNames: string[] = [];
  const unmatchedSceneNames: string[] = [];
  const extractedScenes = sourceScenes.map((detected) => {
    const canonical = lookup.get(normalizeName(detected.id)) ?? lookup.get(normalizeName(detected.name));
    if (!canonical) {
      unmatchedSceneNames.push(detected.name);
      return { ...detected };
    }
    matchedSceneNames.push(`${detected.name} → ${canonical.name}`);
    idMap.set(detected.id, canonical.id);
    idMap.set(normalizeName(detected.id), canonical.id);
    idMap.set(detected.name, canonical.id);
    idMap.set(normalizeName(detected.name), canonical.id);
    return { ...cloneScene(canonical), firstAppearShotIndex: detected.firstAppearShotIndex };
  });

  const sceneList = extractedScenes.length > 0
    ? extractedScenes
    : (library ?? []).map(cloneScene);
  const scenes: SceneAnchor[] = [];
  const seenScenes = new Set<string>();
  for (const scene of sceneList) {
    if (seenScenes.has(scene.id)) continue;
    seenScenes.add(scene.id);
    scenes.push(scene);
  }

  return {
    ...sceneSpec,
    scenes,
    shots: sceneSpec.shots.map((shot) => ({
      ...shot,
      sceneId: resolveSceneId(shot, scenes, idMap, lookup),
    })),
    meta: {
      ...sceneSpec.meta,
      style: styleGuide?.trim() && !sceneSpec.meta.style?.includes(styleGuide.trim())
        ? [sceneSpec.meta.style, styleGuide.trim()].filter(Boolean).join(', ')
        : sceneSpec.meta.style,
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

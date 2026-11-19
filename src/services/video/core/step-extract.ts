// step-extract.ts — 步 3:提取角色 / 场景 / 道具
// 输入:文本(章节原文 / 用户 prompt) + 已知 ShotSpec[](用于回填 characterIds/sceneId)
// 输出:CharacterAnchor[] + SceneAnchor[] + PropSpec[],并把 ShotSpec 里的占位 id 替换成真实 id
//
// Novel 通道:从 RawShot.rawText 提取
// Direct extract:从用户 prompt 提取(单镜头)
// Direct multishot:从用户 prompt 提取(配合 step-storyboard 输出的占位)

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import type {
  CharacterAnchor,
  SceneAnchor,
  PropSpec,
  ShotSpec,
  CostumeVariant,
  CharacterEntityType,
} from '@/types/video';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ExtractInput {
  /** 文本来源:章节原文 / 用户 prompt */
  text: string;
  /** 已切好的镜头(若已 step-storyboard 过),用于回填真实 characterIds/sceneId */
  shots?: ShotSpec[];
  /** 已有的角色(Novel 通道从 NovelBible 注入,合并去重) */
  existingCharacters?: CharacterAnchor[];
  /** 正式生成关闭回退，避免伪角色进入参考图链路。 */
  allowFallback?: boolean;
}

export interface ExtractResult {
  characters: CharacterAnchor[];
  scenes: SceneAnchor[];
  props: PropSpec[];
  /** 回填 characterIds/sceneId 后的 shots(若传入了 shots) */
  resolvedShots?: ShotSpec[];
}

interface LLMExtract {
  characters?: Array<{
    name?: string;
    aliases?: string[];
    appearance?: string;
    entityType?: string;
    gender?: string;
    ageGroup?: string;
    costumeVariants?: Array<{ id?: string; description?: string }>;
    firstAppearShotIndex?: number;
    seed?: number;
  }>;
  scenes?: Array<{
    name?: string;
    description?: string;
    firstAppearShotIndex?: number;
  }>;
  props?: Array<{ name?: string; description?: string }>;
  /** charId 映射:{"char_0": "林墨", ...} 用于回填 ShotSpec */
  characterIdMap?: Record<string, string>;
  sceneIdMap?: Record<string, string>;
}

/**
 * 步 3:LLM 提取角色/场景/道具。
 * 失败不阻塞,返回空数组。
 */
export async function stepExtract(input: ExtractInput, signal?: AbortSignal): Promise<ExtractResult> {
  const templates = useSettingsStore.getState().settings.creative.promptTemplates;
  const customSystem = useSettingsStore.getState().settings.creative.promptTemplatesEnabled
    ? templates?.extractEn || templates?.extractZh
    : undefined;
  const systemPrompt = customSystem?.trim() || [
    'You are a schema-constrained entity extraction model.',
    'Extract only entities, attributes, locations, props, and shot bindings explicitly supported by the supplied source.',
    'Preserve the source language and wording. Do not invent appearance, age, gender, clothing, identity, setting details, or visual style.',
    'Character appearance contains stable physical identity and default clothing. Put movable props in props, and their temporary placement or open/closed states in the shot plan. Return costumeVariants=[] unless the source explicitly calls for different outfits; a single default outfit is not a variant.',
    'Classify entities as human, non_human, object, or unknown. A speaker or mentioned target is not automatically visible in a shot.',
    'Return JSON with characters, scenes, props, characterIdMap, and sceneIdMap. Use unknown or an empty field when the source does not provide a fact.',
  ].join('\n');

  const request: LLMGenerateRequest = {
    taskType: 'extraction',
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.3,
    maxTokens: 8192,
  };

  try {
    const resp = await providerRouter.generate(request, signal);
    let parsed: any = parseLLMJson<any>(resp.content);
    if (!parsed) {
      const repairResp = await providerRouter.generate({
        ...request,
        userPrompt: `${request.userPrompt}\n\n上一次输出格式无效。只返回符合 system schema 的 JSON 对象，不要 Markdown、解释或代码围栏。`,
        temperature: 0.1,
      }, signal);
      parsed = parseLLMJson<any>(repairResp.content);
    }
    if (!parsed) {
      if (input.allowFallback === false) {
        throw new Error('角色场景提取模型未返回有效 JSON');
      }
      return fallbackHeuristicExtract(input);
    }

    if (Array.isArray(parsed)) {
      parsed = { characters: parsed };
    } else if (parsed && typeof parsed === 'object') {
      if (parsed.result && typeof parsed.result === 'object') parsed = parsed.result;
      else if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) parsed = parsed.data;
      else if (parsed.output && typeof parsed.output === 'object' && !Array.isArray(parsed.output)) parsed = parsed.output;
    }

    const rawChars = parsed.characters || parsed.roles || parsed.persons || parsed.actors || parsed.people || [];
    const rawScenes = parsed.scenes || parsed.locations || parsed.backgrounds || parsed.environments || [];
    const rawProps = parsed.props || parsed.items || parsed.objects || [];

    const characters = mergeCharacters(
      normalizeCharacters(Array.isArray(rawChars) ? rawChars : []),
      input.existingCharacters ?? [],
    );
    const scenes = normalizeScenes(Array.isArray(rawScenes) ? rawScenes : []);
    const props = normalizeProps(Array.isArray(rawProps) ? rawProps : []);

    // 用 characterIdMap / sceneIdMap 把 ShotSpec 里的占位 id 换成真实 id
    const nameToId = new Map(characters.map((c) => [c.name, c.id]));
    const sceneNameToId = new Map(scenes.map((s) => [normalizeSceneLabel(s.name), s.id]));
    const charPlaceholderToName = parsed.characterIdMap ?? {};
    const scenePlaceholderToName = parsed.sceneIdMap ?? {};
    const resolvedShots = input.shots?.map((sh) => {
      const declaredCharacterRefs = getVisibleCharacterRefs(sh)
        .map((ref) => String(ref).trim())
        .filter(Boolean);
      const offscreenCharacterRefs = getOffscreenCharacterRefs(sh)
        .map((ref) => String(ref).trim())
        .filter(Boolean);
      const explicitBinding = hasExplicitCharacterBinding(sh);
      const declaredIds = resolveCharacterRefs(
        declaredCharacterRefs,
        characters,
        nameToId,
        charPlaceholderToName,
      );

      const offscreenIds = resolveLooseCharacterRefs(offscreenCharacterRefs, characters);
      let charIds = declaredIds;
      if (!explicitBinding) {
        // Inferred shots may recover names that are present in visual text, but
        // they must never inherit the only project character by default.
        charIds = [...new Set([
          ...charIds,
          ...matchCharactersInText(buildShotSubjectText(sh), characters, new Set(offscreenIds)),
        ])];
      }
      charIds = charIds.filter((id) => !offscreenIds.includes(id));

      const unresolvedCharacterRefs = explicitBinding
        ? declaredCharacterRefs.filter((ref) => !resolveCharacterRefs(
          [ref],
          characters,
          nameToId,
          charPlaceholderToName,
        ).length && !resolveLooseCharacterRefs([ref], characters).length)
        : [];
      const mappedSceneId = resolveShotSceneId(sh, scenes, scenePlaceholderToName, sceneNameToId);

      const binding: 'explicit' | 'inferred' = explicitBinding ? 'explicit' : 'inferred';
      return {
        ...sh,
        characterIds: charIds,
        visibleCharacterIds: charIds,
        offscreenCharacterIds: offscreenIds,
        characterBinding: binding,
        unresolvedCharacterRefs: unresolvedCharacterRefs.length > 0
          ? [...new Set(unresolvedCharacterRefs)]
          : undefined,
        sceneId: mappedSceneId,
      };
    });

    return { characters, scenes, props, resolvedShots };
  } catch (err) {
    signal?.throwIfAborted();
    if (input.allowFallback === false) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`角色与场景提取失败，已停止后续生成：${reason}`);
    }
    console.warn('stepExtract: LLM failed, using heuristic rule fallback', err);
    return fallbackHeuristicExtract(input);
  }
}

function buildUserPrompt(input: ExtractInput): string {
  return JSON.stringify({
    sourceText: input.text,
    outputSchema: {
      characters: [{ name: 'source entity name', aliases: [], appearance: 'source-supported physical appearance, hair, clothing, colors and accessories as one string', entityType: 'human | non_human | object | unknown', gender: 'female | male | unknown', ageGroup: 'child | teen | young | middle | elder | unknown', costumeVariants: [{ id: 'variant id', description: 'source costume as one string' }], firstAppearShotIndex: 0 }],
      scenes: [{ name: 'location label matching shot.location', description: 'source-supported environment, layout, lighting and shared constraints as one string', firstAppearShotIndex: 0 }],
      props: [{ name: 'prop name', description: 'source-supported appearance as one string' }],
      characterIdMap: { optional_placeholder: 'source entity name' },
      sceneIdMap: { optional_placeholder: 'location label' },
    },
    existingCharacters: input.existingCharacters?.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      appearance: character.appearance,
      entityType: character.entityType,
      gender: character.gender,
      ageGroup: character.ageGroup,
      costumeVariants: character.costumeVariants,
    })),
    shots: input.shots?.map((shot) => ({
      id: shot.id,
      index: shot.index,
      sourceText: shot.sourceText,
      videoPrompt: shot.videoPrompt,
      visibleCharacterRefs: getVisibleCharacterRefs(shot),
      offscreenCharacterRefs: getOffscreenCharacterRefs(shot),
      characterBinding: shot.characterBinding,
      location: shot.location,
      sceneId: shot.sceneId,
    })),
  }, null, 2);
}

function normalizeCharacters(arr: NonNullable<LLMExtract['characters']>): CharacterAnchor[] {
  return arr.flatMap((c, i) => {
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) return [];
    const variants: CostumeVariant[] | undefined =
      Array.isArray(c.costumeVariants) && c.costumeVariants.length
        ? c.costumeVariants.map((v) => ({
            id: String(v.id ?? 'default'),
            description: String(v.description ?? ''),
        }))
        : undefined;
    return [{
      id: `char_${Date.now()}_${i}`,
      name,
      aliases: Array.isArray(c.aliases)
        ? c.aliases.map(String).map((value) => value.trim()).filter(Boolean)
        : undefined,
      appearance: String(c.appearance ?? ''),
      entityType: normalizeEntityType(c.entityType),
      gender: normalizeGender(c.gender),
      ageGroup: normalizeAgeGroup(c.ageGroup),
      costumeVariants: variants,
      firstAppearShotIndex: clampIndex(c.firstAppearShotIndex),
      seed: typeof c.seed === 'number' && Number.isFinite(c.seed) ? c.seed : undefined,
    }];
  });
}

function normalizeScenes(arr: NonNullable<LLMExtract['scenes']>): SceneAnchor[] {
  return arr.flatMap((s, i) => {
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name) return [];
    return [{
      id: `scene_${Date.now()}_${i}`,
      name,
      description: String(s.description ?? ''),
      firstAppearShotIndex: clampIndex(s.firstAppearShotIndex),
    }];
  });
}

function normalizeSceneLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function resolveShotSceneId(
  shot: ShotSpec,
  scenes: SceneAnchor[],
  placeholderToName: Record<string, string>,
  sceneNameToId: Map<string, string>,
): string | undefined {
  if (shot.sceneId) {
    const mappedName = placeholderToName[shot.sceneId];
    const mappedId = mappedName ? sceneNameToId.get(normalizeSceneLabel(mappedName)) : undefined;
    if (mappedId) return mappedId;
    if (scenes.some((scene) => scene.id === shot.sceneId)) return shot.sceneId;
  }

  const location = normalizeSceneLabel(shot.location || '');
  if (location) {
    const matches = scenes
      .filter((scene) => {
        const name = normalizeSceneLabel(scene.name);
        return name && (name === location || name.includes(location) || location.includes(name));
      })
      .sort((a, b) => normalizeSceneLabel(b.name).length - normalizeSceneLabel(a.name).length);
    if (matches[0]) return matches[0].id;
  }

  if (scenes.length === 1) return scenes[0].id;

  const candidates = scenes
    .filter((scene) => scene.firstAppearShotIndex <= shot.index)
    .sort((a, b) => b.firstAppearShotIndex - a.firstAppearShotIndex);
  return candidates[0]?.id;
}

function normalizeProps(arr: NonNullable<LLMExtract['props']>): PropSpec[] {
  return arr.flatMap((p, i) => {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) return [];
    return [{
      id: `prop_${Date.now()}_${i}`,
      name,
      description: String(p.description ?? ''),
    }];
  });
}

function mergeCharacters(
  fresh: CharacterAnchor[],
  existing: CharacterAnchor[],
): CharacterAnchor[] {
  if (!existing.length) return fresh;
  const merged: CharacterAnchor[] = existing.map((c) => ({
    ...c,
    aliases: c.aliases ? [...c.aliases] : undefined,
    entityType: c.entityType ?? 'unknown',
  }));
  for (const c of fresh) {
    const prev = merged.find((candidate) => characterReferenceMatches(c.name, candidate));
    if (prev) {
      // Existing library facts are authoritative; only fill missing fields.
      prev.appearance = prev.appearance || c.appearance;
      prev.entityType = prev.entityType !== 'unknown' ? prev.entityType : c.entityType;
      prev.costumeVariants = prev.costumeVariants ?? c.costumeVariants;
      prev.gender = prev.gender !== 'unknown' ? prev.gender : c.gender;
      prev.ageGroup = prev.ageGroup !== 'unknown' ? prev.ageGroup : c.ageGroup;
      prev.aliases = [...new Set([...(prev.aliases ?? []), c.name, ...(c.aliases ?? [])])]
        .filter((alias) => alias && alias !== prev.name);
      prev.seed = prev.seed ?? c.seed;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

function fallbackHeuristicExtract(input: ExtractInput): ExtractResult {
  const characters: CharacterAnchor[] = [...(input.existingCharacters ?? [])];
  // A heuristic fallback preserves only known library entities. It must never
  // turn an untrusted storyboard label into a new character asset.
  const scenes: SceneAnchor[] = [];

  // Resolve only references that are already present in the entity library.
  const resolvedShots = input.shots?.map((sh) => {
    const visibleRefs = getVisibleCharacterRefs(sh).map(String).map((ref) => ref.trim()).filter(Boolean);
    const offscreenRefs = getOffscreenCharacterRefs(sh).map(String).map((ref) => ref.trim()).filter(Boolean);
    const explicitBinding = hasExplicitCharacterBinding(sh);
    const matchedIds = new Set<string>();
    const nameToId = new Map(characters.map((c) => [c.name, c.id]));
    for (const id of [
      ...resolveCharacterRefs(visibleRefs, characters, nameToId, {}),
      ...resolveLooseCharacterRefs(visibleRefs, characters),
    ]) {
      matchedIds.add(id);
    }
    const offscreenIds = resolveLooseCharacterRefs(offscreenRefs, characters);
    if (!explicitBinding) {
      for (const id of matchCharactersInText(buildShotSubjectText(sh), characters, new Set(offscreenIds))) {
        matchedIds.add(id);
      }
    }
    offscreenIds.forEach((id) => matchedIds.delete(id));

    const fallbackId = Array.from(matchedIds);
    const unresolvedCharacterRefs = explicitBinding
      ? visibleRefs.filter((ref) => !resolveCharacterRefs([ref], characters, nameToId, {}).length
        && !resolveLooseCharacterRefs([ref], characters).length)
      : [];
    const binding: 'explicit' | 'inferred' = explicitBinding ? 'explicit' : 'inferred';
    return {
      ...sh,
      characterIds: fallbackId,
      visibleCharacterIds: fallbackId,
      offscreenCharacterIds: offscreenIds,
      characterBinding: binding,
      unresolvedCharacterRefs: unresolvedCharacterRefs.length > 0
        ? [...new Set(unresolvedCharacterRefs)]
        : undefined,
      sceneId: undefined,
    };
  });

  return {
    characters,
    scenes,
    props: [],
    resolvedShots: resolvedShots || input.shots,
  };
}

function normalizeCharacterRef(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s·・._-]/g, '');
}

function characterReferenceMatches(reference: string, character: CharacterAnchor): boolean {
  const normalized = normalizeCharacterRef(reference);
  if (!normalized) return false;
  return [character.id, character.name, ...(character.aliases ?? [])]
    .map(normalizeCharacterRef)
    .some((candidate) => candidate === normalized);
}

function resolveLooseCharacterRefs(refs: string[], characters: CharacterAnchor[]): string[] {
  const resolved = new Set<string>();
  for (const ref of refs) {
    const exact = characters.filter((character) => characterReferenceMatches(ref, character));
    if (exact.length > 0) {
      exact.forEach((character) => resolved.add(character.id));
      continue;
    }
  }
  return Array.from(resolved);
}

function resolveCharacterRefs(
  refs: string[],
  characters: CharacterAnchor[],
  nameToId: Map<string, string>,
  placeholderToName: Record<string, string>,
): string[] {
  const byId = new Map(characters.map((c) => [c.id.toLowerCase(), c.id]));
  const byName = new Map<string, string>();
  for (const character of characters) {
    byName.set(character.name.toLowerCase(), character.id);
    for (const alias of character.aliases || []) byName.set(alias.toLowerCase(), character.id);
  }

  const resolved = new Set<string>();
  for (const ref of refs) {
    const normalized = ref.trim().toLowerCase();
    if (!normalized) continue;
    const mappedName = placeholderToName[ref] || placeholderToName[normalized];
    const mappedId = mappedName ? (nameToId.get(mappedName) || byName.get(mappedName.toLowerCase())) : undefined;
    const directId = byId.get(normalized);
    const directName = byName.get(normalized);
    const placeholderIndex = normalized.match(/^char[_-]?(\d+)$/)?.[1];
    const indexed = placeholderIndex ? characters[Number(placeholderIndex)]?.id : undefined;
    const id = mappedId || directId || directName || indexed;
    if (id) resolved.add(id);
  }
  return Array.from(resolved);
}

function matchCharactersInText(
  text: string,
  characters: CharacterAnchor[],
  excludedIds: Set<string> = new Set(),
): string[] {
  const normalized = text.toLowerCase();
  const exact = characters
    .filter((character) => {
      if (excludedIds.has(character.id)) return false;
      const names = [character.name, ...(character.aliases || [])]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length >= 2);
      return names.some((name) => normalized.includes(name));
    })
    .map((character) => character.id);

  return [...new Set(exact)];
}

function getVisibleCharacterRefs(shot: ShotSpec): string[] {
  const candidate = (shot as ShotSpec & { visibleCharacterIds?: string[] }).visibleCharacterIds;
  return Array.isArray(candidate) ? candidate : (shot.characterIds || []);
}

function getOffscreenCharacterRefs(shot: ShotSpec): string[] {
  const candidate = (shot as ShotSpec & { offscreenCharacterIds?: string[] }).offscreenCharacterIds;
  return Array.isArray(candidate) ? candidate : [];
}

function hasExplicitCharacterBinding(shot: ShotSpec): boolean {
  if (shot.characterBinding === 'explicit') return true;
  if (shot.characterBinding === 'inferred') return false;
  // Legacy shots with a non-empty characterIds list already carried a deliberate
  // binding. An explicit visibleCharacterIds field also makes [] authoritative.
  return getVisibleCharacterRefs(shot).length > 0 || Object.prototype.hasOwnProperty.call(shot, 'visibleCharacterIds');
}

/**
 * Build the visible-subject text used for binding. Dialogue content may name
 * an off-screen target, so only the visual prompt and
 * dialogue speakers are allowed to introduce a reference subject.
 */
function buildShotSubjectText(shot: ShotSpec): string {
  const visualText = shot.videoPrompt?.trim() || shot.sourceText?.trim() || '';
  const speakerText = (shot.dialogue ?? []).map((dialogue) => dialogue.speaker || '').join(' ');
  return [visualText, shot.location || '', shot.startState || '', shot.endState || '', speakerText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}


function normalizeGender(v: unknown): CharacterAnchor['gender'] {
  if (typeof v !== 'string') return 'unknown';
  const s = v.trim().toLowerCase();
  if (!s) return 'unknown';
  // 英文
  if (s === 'male' || s === 'm' || s === 'man' || s === 'boy' || s === 'guy') return 'male';
  if (s === 'female' || s === 'f' || s === 'woman' || s === 'girl' || s === 'lady') return 'female';
  return 'unknown';
}

function normalizeEntityType(v: unknown): CharacterEntityType {
  if (typeof v !== 'string') return 'unknown';
  const normalized = v.trim().toLowerCase();
  if (['human', 'person', 'people'].includes(normalized)) return 'human';
  if (['non_human', 'non-human', 'animal', 'creature', 'entity'].includes(normalized)) return 'non_human';
  if (['object', 'prop', 'item'].includes(normalized)) return 'object';
  return 'unknown';
}

function normalizeAgeGroup(v: unknown): CharacterAnchor['ageGroup'] {
  const valid = ['child', 'teen', 'young', 'middle', 'elder', 'unknown'];
  return typeof v === 'string' && valid.includes(v) ? (v as CharacterAnchor['ageGroup']) : 'unknown';
}

function clampIndex(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

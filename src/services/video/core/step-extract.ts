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
} from '@/types/video';

export interface ExtractInput {
  /** 文本来源:章节原文 / 用户 prompt */
  text: string;
  /** 已切好的镜头(若已 step-storyboard 过),用于回填真实 characterIds/sceneId */
  shots?: ShotSpec[];
  /** 已有的角色(Novel 通道从 NovelBible 注入,合并去重) */
  existingCharacters?: CharacterAnchor[];
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
    appearance?: string;
    gender?: string;
    ageGroup?: string;
    costumeVariants?: Array<{ id?: string; description?: string }>;
    firstAppearShotIndex?: number;
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
export async function stepExtract(input: ExtractInput): Promise<ExtractResult> {
  const request: LLMGenerateRequest = {
    taskType: 'extraction',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.3,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    const parsed = parseLLMJson<LLMExtract>(resp.content);
    if (!parsed) return emptyResult(input);

    const characters = mergeCharacters(
      normalizeCharacters(parsed.characters ?? []),
      input.existingCharacters ?? [],
    );
    const scenes = normalizeScenes(parsed.scenes ?? []);
    const props = normalizeProps(parsed.props ?? []);

    // 用 characterIdMap / sceneIdMap 把 ShotSpec 里的占位 id 换成真实 id
    const nameToId = new Map(characters.map((c) => [c.name, c.id]));
    const sceneNameToId = new Map(scenes.map((s) => [s.name, s.id]));
    const charPlaceholderToName = parsed.characterIdMap ?? {};
    const scenePlaceholderToName = parsed.sceneIdMap ?? {};
    const resolvedShots = input.shots?.map((sh) => ({
      ...sh,
      characterIds: sh.characterIds
        .map((pid) => {
          const name = charPlaceholderToName[pid];
          return name ? nameToId.get(name) : undefined;
        })
        .filter((x): x is string => !!x),
      sceneId: sh.sceneId
        ? (() => {
            const name = scenePlaceholderToName[sh.sceneId!];
            return name ? sceneNameToId.get(name) : sh.sceneId;
          })()
        : sh.sceneId,
    }));

    return { characters, scenes, props, resolvedShots };
  } catch (err) {
    console.warn('stepExtract: LLM failed, returning empty', err);
    return emptyResult(input);
  }
}

const SYSTEM_PROMPT = `你是剧本分析师。从给定文本中提取结构化的角色/场景/道具信息。

【输出 JSON】严格遵循:
{
  "characters": [
    {
      "name": "角色名",
      "appearance": "完整外貌:gender/age/face/hair/clothing/distinguishing features",
      "gender": "male | female | unknown",
      "ageGroup": "child | teen | young | middle | elder | unknown",
      "costumeVariants": [
        {"id": "default", "description": "默认服装"},
        {"id": "rain",    "description": "雨夜变装"}
      ],
      "firstAppearShotIndex": 0
    }
  ],
  "scenes": [
    {"name": "场景名", "description": "环境描述", "firstAppearShotIndex": 0}
  ],
  "props": [
    {"name": "道具名", "description": "描述"}
  ],
  "characterIdMap": {"char_0": "角色名", "char_1": "角色名"},
  "sceneIdMap":     {"scene_0": "场景名"}
}

【规则】
- 同名角色合并,描述取所有提及的并集
- 换装场景必须输出 costumeVariants
- characterIdMap / sceneIdMap 用于回填分镜里的占位 id
- 道具只提取推动剧情的关键道具,不提取背景物件`;

function buildUserPrompt(input: ExtractInput): string {
  const shotsHint = input.shots?.length
    ? `\n\n【已切分的镜头(含占位 id)】\n${input.shots
        .map(
          (s, i) =>
            `- 镜头${i}: id=${s.id} prompt=${s.videoPrompt.slice(0, 100)} characters=${s.characterIds.join(',')} scene=${s.sceneId ?? '-'}`,
        )
        .join('\n')}`
    : '';
  return `请从下面的文本中提取角色/场景/道具。${shotsHint}\n\n【文本】\n${input.text.slice(0, 4000)}`;
}

function normalizeCharacters(arr: NonNullable<LLMExtract['characters']>): CharacterAnchor[] {
  return arr.map((c, i) => {
    const variants: CostumeVariant[] | undefined =
      Array.isArray(c.costumeVariants) && c.costumeVariants.length
        ? c.costumeVariants.map((v) => ({
            id: String(v.id ?? 'default'),
            description: String(v.description ?? ''),
          }))
        : undefined;
    return {
      id: `char_${Date.now()}_${i}`,
      name: String(c.name ?? `角色${i + 1}`),
      appearance: String(c.appearance ?? ''),
      gender: normalizeGender(c.gender),
      ageGroup: normalizeAgeGroup(c.ageGroup),
      costumeVariants: variants,
      firstAppearShotIndex: clampIndex(c.firstAppearShotIndex),
    };
  });
}

function normalizeScenes(arr: NonNullable<LLMExtract['scenes']>): SceneAnchor[] {
  return arr.map((s, i) => ({
    id: `scene_${Date.now()}_${i}`,
    name: String(s.name ?? `场景${i + 1}`),
    description: String(s.description ?? ''),
    firstAppearShotIndex: clampIndex(s.firstAppearShotIndex),
  }));
}

function normalizeProps(arr: NonNullable<LLMExtract['props']>): PropSpec[] {
  return arr.map((p, i) => ({
    id: `prop_${Date.now()}_${i}`,
    name: String(p.name ?? `道具${i + 1}`),
    description: String(p.description ?? ''),
  }));
}

function mergeCharacters(
  fresh: CharacterAnchor[],
  existing: CharacterAnchor[],
): CharacterAnchor[] {
  if (!existing.length) return fresh;
  const merged = new Map(existing.map((c) => [c.name, { ...c }]));
  for (const c of fresh) {
    const prev = merged.get(c.name);
    if (prev) {
      // 合并描述,优先采信新提取
      prev.appearance = c.appearance || prev.appearance;
      prev.costumeVariants = c.costumeVariants ?? prev.costumeVariants;
      prev.gender = c.gender ?? prev.gender;
      prev.ageGroup = c.ageGroup ?? prev.ageGroup;
    } else {
      merged.set(c.name, c);
    }
  }
  return Array.from(merged.values());
}

function emptyResult(input: ExtractInput): ExtractResult {
  return {
    characters: input.existingCharacters ?? [],
    scenes: [],
    props: [],
    resolvedShots: input.shots,
  };
}

function normalizeGender(v: unknown): CharacterAnchor['gender'] {
  return v === 'male' || v === 'female' ? v : 'unknown';
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

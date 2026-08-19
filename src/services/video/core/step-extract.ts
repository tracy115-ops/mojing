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
import { detectInputLanguage } from './lang-detector';
import { useSettingsStore } from '@/stores/settingsStore';

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
  const lang = detectInputLanguage(input.text);
  const customSystem = lang === 'zh'
    ? useSettingsStore.getState().settings.creative.promptTemplates?.extractZh
    : useSettingsStore.getState().settings.creative.promptTemplates?.extractEn;

  const systemPrompt = customSystem && customSystem.trim()
    ? customSystem
    : lang === 'zh'
      ? SYSTEM_PROMPT_ZH
      : SYSTEM_PROMPT_EN;

  const request: LLMGenerateRequest = {
    taskType: 'extraction',
    systemPrompt,
    userPrompt: buildUserPrompt(input),
    responseFormat: 'json',
    temperature: 0.3,
    maxTokens: 4096,
  };

  try {
    const resp = await providerRouter.generate(request);
    let parsed: any = parseLLMJson<any>(resp.content);
    if (!parsed) return fallbackHeuristicExtract(input);

    if (parsed.result && typeof parsed.result === 'object') parsed = parsed.result;
    else if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) parsed = parsed.data;

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
    console.warn('stepExtract: LLM failed, using heuristic rule fallback', err);
    return fallbackHeuristicExtract(input);
  }
}

const SYSTEM_PROMPT_ZH = `你是剧本分析师。从给定文本中提取结构化的角色/场景/道具信息。所有输出的描述文本必须使用 100% 纯中文！严禁包含英文单词或英汉混排。

【输出 JSON】严格遵循:
{
  "characters": [
    {
      "name": "角色名",
      "appearance": "纯中文完整外貌描述:性别/年龄/脸型/发型发色/服饰/体型特征",
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
    {"name": "场景名", "description": "纯中文环境描述", "firstAppearShotIndex": 0}
  ],
  "props": [
    {"name": "道具名", "description": "纯中文描述"}
  ],
  "characterIdMap": {"char_0": "角色名", "char_1": "角色名"},
  "sceneIdMap":     {"scene_0": "场景名"}
}

【规则】
- 同名角色合并,描述取所有提及的并集
- 换装场景必须输出 costumeVariants
- characterIdMap / sceneIdMap 用于回填分镜里的占位 id
- 道具只提取推动剧情的关键道具,不提取背景物件

【服饰与特色设定必须 100% 严格忠实于原文，绝对禁止篡改】
若原文中明确提及了角色的具体服装与造型（例如：JK裙/JK制服、水手服、现代服饰、西装、风衣、黄色古风僧袍、黑色圆墨镜、铠甲、特定颜色发饰丝带等），appearance 字段中必须 100% 优先并完整包含原文指定的服装与配饰！
绝对严禁将现代服装/JK裙脑补篡改成古装或素色汉服！必须原汁原味忠实体现剧本的所有核心设定（如古风庭院中身穿JK裙的冲突美感）！

【appearance 字段必须区分多角色 — 极重要】
多个角色同时出现时,每个角色的 appearance **必须**写出可识别的、互不重叠的面部特征,
不能只换衣服或换发型。必须包含:
1. 脸型 + 五官特征(如:方脸浓眉/圆脸大眼/瘦削高鼻梁/苹果脸颊)
2. 肤色 + 明显的标记(如:苍白肤色/小麦色皮肤/雀斑/疤痕/痣)
3. 发色 + 发长 + 发型(如:黑色齐刘海短发/银白色波浪长发/红色扎马尾)
4. 体型 + 身高(如:瘦高/娇小/健壮)
5. 服饰(必须严格包含原文指定服装，如 JK制服/黄色僧袍)
6. 年龄感(如:20 岁出头/近 40 岁/少年)

【动物 / 拟人化角色 / 灵兽 / 宠物 — 必须 100% 作为独立角色（character）提取】
- 剧本中的任何动物角色（例如：胖橘猫、猫大师、大黄狗、灵狐、宠物、神兽、妖怪等），只要有动作、台词、交互或神态，**必须 100% 提取到 characters 数组中作为独立角色！绝对严禁遗漏！绝对严禁误放入道具（props）或场景中！**
- 角色名称：忠实保留原文称谓（例如 "胖橘猫" 或 "猫大师"）。
- appearance 字段：必须详尽描述其物理生物形态（如：一只体型圆滚微胖的橘色斑纹猫咪，白肚皮）以及服饰道具（如：佩戴一副精致的黑色圆墨镜，身穿黄色古风僧袍，神态沉稳老成）。

如果原文没明确给出某些细节,请根据角色名字、性格、剧情定位主动补充合理的区分性特征,
保证两个角色站在一起时,观众能一眼分辨谁是谁。
不要写"普通长相""年轻女性"这种泛化描述。`;

const SYSTEM_PROMPT_EN = `You are a script analyzer. Extract structured character, scene, and prop information from the text. All description fields MUST be 100% in English!

[Output JSON Specs]:
{
  "characters": [
    {
      "name": "Character Name",
      "appearance": "Full English appearance: gender/age/face/hair/clothing/distinguishing features",
      "gender": "male | female | unknown",
      "ageGroup": "child | teen | young | middle | elder | unknown",
      "costumeVariants": [
        {"id": "default", "description": "default outfit"}
      ],
      "firstAppearShotIndex": 0
    }
  ],
  "scenes": [
    {"name": "Scene Name", "description": "English environment description", "firstAppearShotIndex": 0}
  ],
  "props": [
    {"name": "Prop Name", "description": "English description"}
  ],
  "characterIdMap": {"char_0": "Character Name"},
  "sceneIdMap":     {"scene_0": "Scene Name"}
}

[Rules]
- Merge characters with the same name.
- Non-human / animal / unique characters (like anthropomorphic chubby orange cat wearing sunglasses and monk robes) MUST be extracted as characters, NEVER omit them or classify as props!
- Keep descriptions clear and distinct.`;

function buildUserPrompt(input: ExtractInput): string {
  const shotsHint = input.shots?.length
    ? `\n\n【已切分的镜头(含占位 id)】\n${input.shots
        .map(
          (s, i) =>
            `- 镜头${i}: id=${s.id} prompt=${(s.videoPrompt || s.sourceText || '').slice(0, 100)} characters=${s.characterIds.join(',')} scene=${s.sceneId ?? '-'}`,
        )
        .join('\n')}`
    : '';
  return `请从下面的文本中提取所有角色（包含所有人类角色、动物/拟人化角色如胖橘猫/灵兽等，严禁遗漏动物角色！）、场景与道具。

【重要约束】
1. 绝对不要遗漏任何出场角色（包括人类、宠物、动物大师、灵兽等，如胖橘猫必须作为角色提取）！
2. 角色服饰（如 JK裙、黄色僧袍等）必须严格遵循原文，绝不可篡改！
${shotsHint}

【正文与分镜文本】
${input.text.slice(0, 6000)}`;
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

function fallbackHeuristicExtract(input: ExtractInput): ExtractResult {
  const characters: CharacterAnchor[] = [...(input.existingCharacters ?? [])];
  const charNames = new Set(characters.map((c) => c.name));

  // 1. 从 shots 的 dialogue 和 sourceText/videoPrompt 中提取角色
  if (input.shots && input.shots.length > 0) {
    for (const shot of input.shots) {
      if (shot.dialogue && shot.dialogue.length > 0) {
        for (const d of shot.dialogue) {
          const name = d.speaker?.trim();
          if (name && name !== '未知' && name !== '旁白' && !charNames.has(name)) {
            charNames.add(name);
            const isFemale = /女|妹|姐|娘|妇|姬|雪|琳|雅|母|儿|师妹|清雪/i.test(name);
            const isMale = /男|哥|弟|汉|僧|师兄|大师|宗主|尊者|父|林墨|张小凡|凡/i.test(name);
            characters.push({
              id: `char_${Date.now()}_${characters.length}`,
              name,
              gender: isFemale ? 'female' : isMale ? 'male' : 'unknown',
              ageGroup: 'young',
              appearance: `${name}，生动传神的形象外貌，服饰细节完整，高清电影级质感。`,
              firstAppearShotIndex: shot.index ?? 0,
            });
          }
        }
      }
    }
  }

  // 2. 从 input.text 中通过正则匹配 "角色名：" 或 "【角色名】"
  const speakerRegex = /(?:^|\n)(?:【([^】\n]+)】|([^\s:：\n"“]{2,8}))[：:]/g;
  let match: RegExpExecArray | null;
  while ((match = speakerRegex.exec(input.text)) !== null) {
    const name = (match[1] || match[2])?.trim();
    if (name && name !== '未知' && name !== '旁白' && !charNames.has(name) && name.length <= 8) {
      charNames.add(name);
      const isFemale = /女|妹|姐|娘|妇|姬|雪|琳|雅|母|儿|师妹|清雪/i.test(name);
      const isMale = /男|哥|弟|汉|僧|师兄|大师|宗主|尊者|父|林墨|张小凡|凡/i.test(name);
      characters.push({
        id: `char_${Date.now()}_${characters.length}`,
        name,
        gender: isFemale ? 'female' : isMale ? 'male' : 'unknown',
        ageGroup: 'young',
        appearance: `${name}，生动传神的形象外貌，服饰细节完整，高清电影级质感。`,
        firstAppearShotIndex: 0,
      });
    }
  }

  // 3. 若依然没有提取到任何角色，构造一个默认主角
  if (characters.length === 0) {
    characters.push({
      id: `char_${Date.now()}_0`,
      name: '故事主角',
      gender: 'unknown',
      ageGroup: 'young',
      appearance: '故事核心主角，五官生动传神，服饰细节精致，高清电影级质感。',
      firstAppearShotIndex: 0,
    });
  }

  // 4. 构造默认场景
  const scenes: SceneAnchor[] = [
    {
      id: `scene_${Date.now()}_0`,
      name: '故事主场景',
      description: '电影级故事环境背景，光影流动，环境细节丰富。',
      firstAppearShotIndex: 0,
    },
  ];

  // 5. 回填 shots 的 characterIds
  const nameToId = new Map(characters.map((c) => [c.name, c.id]));
  const resolvedShots = input.shots?.map((sh) => {
    const matchedIds = new Set<string>();
    if (sh.dialogue) {
      for (const d of sh.dialogue) {
        const id = nameToId.get(d.speaker);
        if (id) matchedIds.add(id);
      }
    }
    for (const c of characters) {
      if (sh.videoPrompt?.includes(c.name) || sh.sourceText?.includes(c.name)) {
        matchedIds.add(c.id);
      }
    }
    return {
      ...sh,
      characterIds: matchedIds.size > 0 ? Array.from(matchedIds) : (characters[0] ? [characters[0].id] : []),
      sceneId: scenes[0].id,
    };
  });

  return {
    characters,
    scenes,
    props: [],
    resolvedShots: resolvedShots || input.shots,
  };
}

function normalizeGender(v: unknown): CharacterAnchor['gender'] {
  if (typeof v !== 'string') return 'unknown';
  const s = v.trim().toLowerCase();
  if (!s) return 'unknown';
  // 英文
  if (s === 'male' || s === 'm' || s === 'man' || s === 'boy' || s === 'guy') return 'male';
  if (s === 'female' || s === 'f' || s === 'woman' || s === 'girl' || s === 'lady') return 'female';
  // 中文(常见写法)
  if (s.includes('男')) return 'male';
  if (s.includes('女')) return 'female';
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

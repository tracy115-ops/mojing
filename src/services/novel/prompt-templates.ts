import { NOVEL_WRITING_PRINCIPLES } from './writing-context';

// --- Prompt Template System ---
// Centralized prompt management inspired by PlotPilot's CPMS.
// Each template encapsulates system + user prompt construction with variable interpolation.
//
// v2 Enhancement:
// - Three-layer Anti-AI defense (Mapping → Protocol → Whitelist)
// - Scene-based protocol loading (combat/dialogue/suspense/daily)
// - YAML/JSON override support for prompt customization
// - Version tracking for each template


export interface PromptTemplate {
  id: string;
  name: string;
  version: number;
  variables: string[];
  buildSystem(vars: Record<string, string>): string;
  buildUser(vars: Record<string, string>): string;
}

// ============================================================================
// Layer 1: Anti-AI Pattern Mapping (replace AI clichés)
// ============================================================================

interface PatternReplacement {
  pattern: RegExp;
  replacement: string;
  reason: string;
}

const ANTI_AI_LAYER1_MAPPING: PatternReplacement[] = [
  { pattern: /不由得/g, replacement: '', reason: '空洞描写' },
  { pattern: /心中一动/g, replacement: '', reason: '模板化心理' },
  { pattern: /缓缓开口/g, replacement: '', reason: '动作模糊' },
  { pattern: /眼中闪过一丝(.{1,6})/g, replacement: '面露$1之色', reason: 'AI套路表情' },
  { pattern: /嘴角微微上扬/g, replacement: '笑了', reason: 'AI套路表情' },
  { pattern: /不禁(g|感|叹|为)/g, replacement: '$1', reason: '弱化表达' },
  { pattern: /深深地看了(.{1,10})一眼/g, replacement: '注视着$1', reason: 'AI套路眼神' },
  { pattern: /一种难以言喻的/g, replacement: '', reason: '空洞形容' },
  { pattern: /仿佛在诉说着/g, replacement: '', reason: '拟人滥用' },
  { pattern: /不禁倒吸一口凉气/g, replacement: '屏住了呼吸', reason: 'AI套路反应' },
  { pattern: /声音(微微|有些|不禁)颤抖/g, replacement: '声音颤抖', reason: 'AI套路描写' },
  { pattern: /空气(突然|似乎)凝固了/g, replacement: '四下一片死寂', reason: 'AI套路氛围' },
];

/**
 * Apply Layer 1 mapping to generated text — replace AI clichés.
 */
export function applyAntiAILayer1(text: string): { text: string; replacements: number } {
  let result = text;
  let replacements = 0;
  for (const rule of ANTI_AI_LAYER1_MAPPING) {
    const matches = result.match(new RegExp(rule.pattern.source, 'g'));
    if (matches) {
      replacements += matches.length;
      result = result.replace(rule.pattern, rule.replacement);
    }
  }
  return { text: result, replacements };
}

// ============================================================================
// Layer 2: Scene-based Anti-AI Protocols (P1-P5 + scene-specific rules)
// ============================================================================

type SceneType = 'action' | 'emotion' | 'combat' | 'dialogue' | 'suspense' | 'daily' | 'romance' | 'exploration';

const SCENE_PROTOCOLS: Record<SceneType, string> = {
  action: '【行动场景】写清人物要做什么、遇到什么阻力、如何选择以及结果。调查、劳动、赶路等行动沿用作品题材，不因行动标签添加打斗。',
  emotion: '【情绪场景】情绪来自人物的具体经历、关系和损益，影响其判断或选择。悲伤、羞愧、恐惧、释然等按当下处境展开，不因情绪标签添加恋爱、暧昧或肢体接触。',
  combat: '【动作场景】让空间、行动意图、能力限制与身体代价清楚，后果延续到后文。',
  dialogue: '【对话场景】人物因立场、所知信息与当下目的而说话，避免人人同一腔调或替作者说明。',
  suspense: '【悬疑场景】线索有来源，推论有边界，人物发现信息需要行动和代价；不强制反转与线索配额。',
  daily: '【日常场景】选择能呈现关系、处境或人物变化的生活细节，允许停顿和安静，不为制造张力强加争执。',
  romance: '【情感场景】关系变化有具体经历和双方选择支撑，避免套路肢体反应和反复误会拖延。',
  exploration: '【探索场景】发现与人物目的关联，信息随行动展开；环境细节服从实际可知范围。',
};

// Base Anti-AI Directives (shared across all scenes)

const BASE_ANTI_AI_DIRECTIVES = NOVEL_WRITING_PRINCIPLES;

/**
 * Build Layer 2 protocol string for a given scene type.
 */
export function buildSceneProtocol(sceneType?: SceneType): string {
  const base = BASE_ANTI_AI_DIRECTIVES;
  const scene = sceneType ? SCENE_PROTOCOLS[sceneType] : '';
  return scene ? `${base}\n${scene}` : base;
}

/**
 * Detect scene type from beat focus.
 */
export function detectSceneType(focus: string): SceneType {
  const mapping: Record<string, SceneType> = {
    action: 'action',
    dialogue: 'dialogue',
    suspense: 'suspense',
    emotion: 'emotion',
    hook: 'suspense',
    sensory: 'exploration',
    character_intro: 'daily',
    narration: 'daily',
  };
  return mapping[focus] ?? 'daily';
}

// ============================================================================
// Layer 3: Whitelist (approved patterns that should NOT be flagged)
// ============================================================================

const WHITELIST_PATTERNS = [
  // Classic literary techniques that resemble AI output but are legitimate
  '欲言又止',
  '心知肚明',
  '不置可否',
  '若有所思',
  '胸有成竹',
];

/**
 * Check if a flagged pattern is actually whitelisted.
 */
export function isWhitelisted(text: string, pattern: string): boolean {
  return WHITELIST_PATTERNS.some((w) => pattern.includes(w));
}

// ============================================================================
// Anti-AI Full Scan (3-layer defense)
// ============================================================================

export interface AntiAIReport {
  layer1Replacements: number;
  layer3Whitelisted: number;
  totalFlags: number;
  flaggedPatterns: Array<{ text: string; reason: string; whitelisted: boolean }>;
}

/**
 * Run all 3 layers of Anti-AI scan on generated text.
 */
export function runAntiAIScan(text: string): AntiAIReport {
  // Layer 1: Pattern mapping
  const { replacements: layer1Count } = applyAntiAILayer1(text);

  // Layer 2: Scan for remaining AI patterns (not auto-replaced, just flagged)
  const flaggedPatterns: AntiAIReport['flaggedPatterns'] = [];
  const aiPatterns = [
    { text: '不由得', reason: '空洞描写' },
    { text: '心中一动', reason: '模板化心理' },
    { text: '缓缓开口', reason: '动作模糊' },
    { text: '一种难以言喻', reason: '空洞形容' },
    { text: '仿佛在诉说', reason: '拟人滥用' },
    { text: '不禁倒吸', reason: 'AI套路反应' },
    { text: '空气凝固', reason: 'AI套路氛围' },
    { text: '眼中闪过', reason: 'AI套路表情' },
    { text: '嘴角微微上扬', reason: 'AI套路表情' },
    { text: '深深地看了', reason: 'AI套路眼神' },
    { text: '声音微微颤抖', reason: 'AI套路描写' },
    { text: '一股强大的', reason: '模糊力量描述' },
    { text: '一道光芒', reason: 'AI套路视觉' },
    { text: '仿佛整个世界', reason: '夸张过度' },
    { text: '时间仿佛静止', reason: 'AI套路时间' },
  ];

  let whitelisted = 0;
  for (const p of aiPatterns) {
    if (text.includes(p.text)) {
      const wl = isWhitelisted(text, p.text);
      if (wl) {
        whitelisted++;
      }
      flaggedPatterns.push({ text: p.text, reason: p.reason, whitelisted: wl });
    }
  }

  return {
    layer1Replacements: layer1Count,
    layer3Whitelisted: whitelisted,
    totalFlags: flaggedPatterns.filter((f) => !f.whitelisted).length,
    flaggedPatterns,
  };
}

// ============================================================================
// YAML/JSON Override Support
// ============================================================================

const OVERRIDE_KEY = 'mojing-prompt-overrides';

interface PromptOverride {
  templateId: string;
  systemOverride?: string;
  userOverride?: string;
  extraDirectives?: string;
}

/**
 * Load prompt overrides from localStorage (set via UI or YAML import).
 */
export function loadPromptOverrides(): PromptOverride[] {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Save prompt overrides to localStorage.
 */
export function savePromptOverrides(overrides: PromptOverride[]): void {
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides));
}

/**
 * Apply overrides to a template's output.
 */
function applyOverrides(templateId: string, systemPrompt: string, userPrompt: string): {
  systemPrompt: string;
  userPrompt: string;
} {
  const overrides = loadPromptOverrides();
  const match = overrides.find((o) => o.templateId === templateId);
  if (!match) return { systemPrompt, userPrompt };

  let sys = systemPrompt;
  let usr = userPrompt;

  if (match.systemOverride) {
    sys = match.systemOverride;
  }
  if (match.userOverride) {
    usr = match.userOverride;
  }
  if (match.extraDirectives) {
    sys += `\n\n【用户自定义指令】\n${match.extraDirectives}`;
  }

  return { systemPrompt: sys, userPrompt: usr };
}

// ============================================================================
// Narrative Rules
// ============================================================================

const NARRATIVE_RULES = `
【叙事铁律】
1. 已死角色不得复活（除非有前置伏笔）
2. 角色不能知道未告知的信息
3. 地点转换必须有过渡
4. 时间线不得矛盾
5. 人物关系变化必须有事件触发
6. 不能连续两章没有冲突
7. 对话必须推进剧情或揭示角色
8. 每个场景必须有感官细节
9. 不能用旁白解释角色应该自己领悟的事
10. 高潮场景禁止压缩，必须充分展开`;

// --- Sensory Rotation ---
// 4-cycle pattern to ensure varied sensory details

const SENSORY_ROTATION: Record<number, string> = {
  0: '光影与空间感（明暗、远近、开阔/逼仄）',
  1: '温度与质感（冷热、粗糙/光滑、干湿）',
  2: '声音与节奏（声响、寂静、韵律）',
  3: '气味与味觉（空气中弥漫的、舌尖残留的）',
};

function getSensoryHint(beatIndex: number): string {
  return SENSORY_ROTATION[beatIndex % 4];
}

// ============================================================
// Template 1: Macro Planning
// ============================================================

const macroPlanning: PromptTemplate = {
  id: 'macro-planning',
  name: '宏观规划',
  version: 5,
  variables: ['title', 'genre', 'style', 'prevChapters', 'phaseDirective', 'foreshadowingContext', 'chapterNumber'],
  buildSystem(vars) {
    return `你是一个资深小说策划师，擅长构思让人放不下的故事。你的任务是为下一章制定宏观方向。

小说：${vars.title}
类型：${vars.genre}
风格：${vars.style}

${vars.phaseDirective ?? ''}

${vars.foreshadowingContext ?? ''}

规划原则：
- 本章围绕人物需要处理的处境展开，变化可以来自选择、关系、认识或行动，不强制反转
- 结尾体现本章实际改变的处境或关系，悬念应来自已有事件
- 避免重复上一章已完成的行动，保留必要的铺垫、停顿与后果
- 角色行动必须有动机，不能为了推进剧情而OOC
- 伏笔依已发生的行动发展，不按章节比例或到期日期强行解决

请输出JSON格式：
{
  "title": "章节标题（有吸引力，不用"第X章"格式）",
  "direction": "本章发展方向：人物想要什么、遇到什么阻力、因此采取什么行动、付出什么代价，本章结束时处境如何改变；场景按因果连接，不强制凑反转和对抗",
  "conflictCore": "一句话概括本章核心冲突",
  "endingHook": "本章行动后实际改变的处境、关系或决定；不强制悬念",
  "target_word_count": 3000
}`;
  },
  buildUser(vars) {
    const prev = vars.prevChapters;
    const ch = vars.chapterNumber;
    return prev
      ? `已有章节概要：\n${prev}\n\n请为第${ch}章制定方向。`
      : `这是小说的开篇。请为第1章制定方向。`;
  },
};

// ============================================================
// Template 2: Act-Beat Planning
// ============================================================

const actBeatPlanning: PromptTemplate = {
  id: 'act-beat-planning',
  name: '幕级大纲',
  version: 4,
  variables: ['title', 'genre', 'style', 'prevSummary', 'macroDirection', 'chapterNumber', 'chapterTitle', 'factLock', 'beatLock', 'clueLock'],
  buildSystem(vars) {
    return `你是一个专业的小说大纲规划师。根据宏观方向，生成详细的章节大纲。

大纲要求：
- 按场景需要安排叙事节拍（beat），每个有明确目的，不为凑数量拆散同一行动
- 节拍之间有因果关系，不是松散拼接
- 写清人物如何取得信息、据此作出什么选择，以及选择引起的后果；情绪由事件产生
- 按人物目标与场景需要安排对话、行动、思考，不为凑类型硬塞对抗
- 最后一个节拍落实本章行动的后果，不靠新来的人影、消息或无关危机强行续悬念

小说：${vars.title}
类型：${vars.genre}
风格：${vars.style}

${vars.factLock ?? ''}
${vars.beatLock ?? ''}
${vars.clueLock ?? ''}`;
  },
  buildUser(vars) {
    const prev = vars.prevSummary ? `上一章结尾：\n${vars.prevSummary}\n\n` : '';
    return `${prev}宏观方向：${vars.macroDirection}\n\n请为第${vars.chapterNumber}章 "${vars.chapterTitle}" 生成详细大纲（含场景设定、主要事件节拍、人物行动、情绪走向、关键对话要点、伏笔设计）。`;
  },
};

// ============================================================
// Template 3: Beat Magnify (outline → beats)
// ============================================================

const beatMagnify: PromptTemplate = {
  id: 'beat-magnify',
  name: '大纲拆Beat',
  version: 3,
  variables: ['outline', 'chapterNumber', 'targetWords', 'chapterIndex'],
  buildSystem() {
    return `你是一个叙事节拍规划师。按大纲的场景与因果拆分为 2-5 个叙事节拍(beat)，不另外编造事件。

每个 beat 必须指定：
- "description": 节拍内容描述（具体场景/事件）
- "targetWords": 目标字数（整数）
- "focus": 聚焦类型，必须是以下之一：action, dialogue, sensory, emotion, suspense, hook, character_intro, narration
- "sceneGoal": 这个场景要达到什么目的

分配规则：
- 总 targetWords 之和等于 ${'$'}{targetWords}
- hook 类型只能在第一个 beat 使用
- 第一个 beat 负责承接上一章/建立场景
- 最后一个 beat 落实大纲中行动的后果，不另造危机
- 字数按关键选择与场景需要分配，不因类型自动增加

输出严格JSON数组：
[{"description":"...","targetWords":800,"focus":"action","sceneGoal":"..."}, ...]`;
  },
  buildUser(vars) {
    const chIdx = Number(vars.chapterIndex ?? 0);
    let special = '';
    if (chIdx === 0) {
      special = '\n\n注意：这是小说第1章。从人物正在面对的具体处境切入，不必先设悬念。';
    } else if (chIdx === 1) {
      special = '\n\n注意：这是第2章。承接开篇行动的后果，避免重复发现同一异常。';
    }
    return `大纲：\n${vars.outline}\n\n目标总字数：${vars.targetWords}字\n请拆分为beats。${special}`;
  },
};

// ============================================================
// Template 4: Beat Generation (CORE — single beat, PlotPilot storyteller approach)
// ============================================================

const beatGeneration: PromptTemplate = {
  id: 'beat-generation',
  name: '单Beat生成',
  version: 5,
  variables: ['title', 'genre', 'style', 'phaseDirective', 'context', 'outline', 'beatDescription', 'beatFocus', 'targetWords', 'conductorSignal', 'beatIndex', 'totalBeats', 'sensoryHint'],
  buildSystem(vars) {
    const isFirst = vars.beatIndex === '0';
    const isLast = vars.beatIndex === String(Number(vars.totalBeats) - 1);

    // Scene-based protocol selection (Layer 2)
    const sceneType = detectSceneType(vars.beatFocus ?? '');
    const sceneProtocol = buildSceneProtocol(sceneType);

    const beatSpecific = [
      isFirst ? '\n【开篇指令】这是章节开头。承接上章的最终处境，用当前行动或关系进入场景，必要背景简明交代。' : '',
      isLast ? '\n【结尾指令】这是本章最后一个节拍。完成已经展开的关键选择及其可见后果，停在本章形成的新处境。允许自然留白，不为结尾另加反转、陌生来电或情感总结。' : '',
    ].join('');

    return `你是一位小说作者。按照本书题材、人物和既有情节续写当前场景，保留作者已经形成的声音。

写作前在内部核对本段与全部已写正文的事实、约定和因果；关键推断须检查观察范围与其他解释。大纲和节拍可据此调整，不能改动已发生事实。输出接续的作品正文，不输出核对过程或重复章标题。

${sceneProtocol}

小说：${vars.title}
类型：${vars.genre}
风格：${vars.style}

${vars.phaseDirective ?? ''}

${vars.context ?? ''}

【当前节拍】
描述：${vars.beatDescription}
聚焦：${vars.beatFocus}
目标字数：${vars.targetWords}字
细节应由当前人物的注意与场景需要决定，不按节拍轮换感官。

${vars.conductorSignal ?? ''}${beatSpecific}

━━ 讲吧 ━━
• 叙述、对话、心理和停顿按场景需要安排，不逐段套固定结构
• 冲突场景多写，过渡一笔带过
• 非最后节拍继续当前场景，不要逐段制造悬念或总结
• 如果上一段角色处于某种状态，下一段必须接住
• 字数 ${vars.targetWords} 字左右`;
  },
  buildUser(vars) {
    return `「这一段你要讲的故事」\n${vars.beatDescription}\n\n章节大纲：${vars.outline}\n\n讲吧。`;
  },
};

// ============================================================
// Template 5: Chapter Review (6-dimension weighted, PlotPilot-style)
// ============================================================

const chapterReview: PromptTemplate = {
  id: 'chapter-review',
  name: '章末审校',
  version: 3,
  variables: ['factLock', 'beatLock'],
  buildSystem(vars) {
    return `你是一个严格的小说审稿编辑。审查章节正文的质量。

【评分维度与权重】（每项0-10分）
1. language_style（语言风格）权重0.25 — 文笔是否生动流畅、是否有AI套路痕迹、句式是否多样
2. character_consistency（角色一致性）权重0.25 — 对话和行动是否符合人设、角色声音是否有区分度
3. plot_density（情节密度）权重0.20 — 是否每段都在推进、有无空洞描写、信息增量是否充足
4. naming（命名准确）权重0.05 — 角色名字、地点名是否前后一致
5. viewpoint（视角一致）权重0.10 — 第三人称有限视角是否保持、有无越界
6. rhythm（节奏韵律）权重0.15 — 长短句交替、对话与描写穿插、场景节奏是否合理

综合分 = 各维度加权求和
及格线: 6.0/10

${vars.factLock ? `已知事实（不得矛盾）：\n${vars.factLock}` : ''}
${vars.beatLock ? `已完成情节（不得重复）：\n${vars.beatLock}` : ''}

【AI套路专项检测】
扫描以下模式并统计出现次数：
- "不由得""心中一动""缓缓开口""一种难以言喻" 等模板化表达
- "嘴角勾起""眼中闪过""呼吸一滞" 等AI套路表情/反应
- "空气凝固""时间仿佛静止" 等AI套路氛围
- "仿佛...般""心湖涟漪" 等AI套路比喻
- 连续三段相同句式结构
- 每段都以对话结尾的机械节奏

【叙事自检（6项）】
逐条检查：
1. 是否有连续2+段只有环境/氛围而无人行动或对话？
2. 是否有"他感到/她感到/一种说不出的"？
3. 是否有角色重复读者已知的信息？
4. 是否有删掉后对故事毫无影响的段落？
5. 开头是否在介绍背景而非进入动作？
6. 结尾是否有哲学式总结句？

输出JSON：
{
  "scores": {
    "language_style": 8,
    "character_consistency": 7,
    "plot_density": 8,
    "naming": 10,
    "viewpoint": 9,
    "rhythm": 7
  },
  "weighted_overall": 7.8,
  "issues": ["问题描述1", "问题描述2"],
  "suggestions": ["改进建议1"],
  "aiPatterns": ["检测到的AI套路1"],
  "selfCheckFailures": [2, 5],
  "pass": true
}`;
  },
  buildUser() {
    return '';  // content is passed as userPrompt externally
  },
};

// ============================================================
// Template 6: Chapter Aftermath Extraction
// ============================================================

const chapterAftermath: PromptTemplate = {
  id: 'chapter-aftermath',
  name: '章后提取',
  version: 2,
  variables: ['novelId', 'chapterNumber', 'activeForeshadowing'],
  buildSystem(vars) {
    return `你是一个叙事分析引擎。从章节正文中一次性提取以下所有维度。输出严格JSON。

提取维度与格式要求：
1. "summary": 章节摘要（≤200字，字符串）
2. "keyEvents": 关键事件列表（3-8条，字符串数组）
3. "characterStates": 角色当前状态数组，每个元素含 "name", "physicalState", "emotionalState", "location"
4. "triples": 人物关系三元组数组，每个元素必须含：
   - "subject": 角色名（如"李明"）
   - "predicate": 关系类型（如"师徒"、"敌对"、"恋人"、"朋友"、"盟友"、"上下级"）
   - "object": 对方角色名
   - "sinceChapter": 确立章节号（整数）
5. "foreshadowing": 伏笔动态，含三个子数组 "planted", "resolved", "detected"，每个元素含 "description", "plantedInChapter", "urgency"(low/medium/high/critical)
6. "narrativeDebts": 叙事债务数组，每个含 "description", "plantedInChapter", "priority"(0-10)
7. "tensionScore": 紧张度（0-10，数字）
8. "styleScore": 文风一致性（0-1，数字）
9. "propEvents": 道具事件数组，每个含 "propName", "eventType"(introduced/transferred/damaged/repaired/resolved), "description", "actorCharacterId"

当前活跃伏笔（用于检测闭合）：
${vars.activeForeshadowing || '无'}

重要：triples必须包含本章中出现的所有人物关系，即使是已有的关系也要列出。`;
  },
  buildUser(vars) {
    return `小说ID: ${vars.novelId}\n章节号: ${vars.chapterNumber}\n\n`;
  },
};

// ============================================================
// Template 7: Worldbuilding (Wizard Step 2)
// ============================================================

const worldbuilding: PromptTemplate = {
  id: 'worldbuilding',
  name: '世界观构建',
  version: 1,
  variables: ['title', 'genre', 'description', 'style', 'language'],
  buildSystem(vars) {
    return `你是一个专业的小说世界观设计师。根据用户提供的小说基本信息，生成一个丰富、自洽的世界观设定。

要求：
- 世界观必须与小说类型（${vars.genre}）和风格（${vars.style}）匹配
- 只设计与本书核心事件相关的必要设定；现实题材不得添加超自然法则
- 设定之间要有关联和约束关系；原始简介中的限制与唯一道具不得被推演设定改变
- 使用中文描述

输出严格 JSON 格式：
{
  "style公约": "200字左右的文风描述，定义这部小说的叙事风格、句式特点、禁用词汇等",
  "核心法则": [
    {"key": "法则名", "value": "具体描述"}
  ],
  "地理生态": [
    {"key": "地名/区域", "value": "具体描述"}
  ],
  "社会结构": [
    {"key": "制度/势力/阶级", "value": "具体描述"}
  ],
  "历史文化": [
    {"key": "历史事件/文化习俗", "value": "具体描述"}
  ],
  "日常细节": [
    {"key": "生活细节", "value": "具体描述（增加沉浸感）"}
  ]
}`;
  },
  buildUser(vars) {
    return `小说名称：${vars.title}
类型：${vars.genre}
风格：${vars.style}
语言：${vars.language}
简介：${vars.description}

请为这部小说生成完整的世界观设定（含文风公约）。`;
  },
};

// ============================================================
// Template 8: Character Generation (Wizard Step 3)
// ============================================================

const characterGeneration: PromptTemplate = {
  id: 'character-generation',
  name: '角色生成',
  version: 1,
  variables: ['title', 'genre', 'description', 'worldbuilding'],
  buildSystem(_vars) {
    return `你是一个专业的小说角色设计师。根据小说的世界观设定，生成丰富立体的人物角色。

要求：
- 生成 3-6 个主要角色（主角1个 + 主要角色2-3个 + 配角1-2个）
- 每个角色必须有独特的性格和声音
- 角色之间要有明确的关系网络
- 使用中文描述

输出严格 JSON 格式：
[
  {
    "name": "角色名",
    "importance": "protagonist|major|supporting",
    "description": "50字以内的简介",
    "appearance": "外貌描写（含2-3个显著特征）",
    "personality": "性格特征（3-5个关键词+解释）",
    "backstory": "背景故事（50字以内）",
    "coreBelief": "核心信念（驱使角色行动的根本信念）",
    "verbalTic": "口头禅或说话习惯",
    "idleBehavior": "紧张/无聊时的习惯动作",
    "relationships": [
      {"target": "另一个角色名", "type": "关系类型（师徒/挚友/宿敌/恋人/亲人）", "description": "一句话描述关系"}
    ]
  }
]`;
  },
  buildUser(vars) {
    return `小说名称：${vars.title}
类型：${vars.genre}

世界观设定：
${vars.worldbuilding}

原始简介与核心约束：${vars.description || ''}
原始简介中的主角、道具状态、事件和世界规则必须保留；若推演设定与简介冲突，应调整推演设定，不得改写简介。
请基于以上世界观生成主要角色。`;
  },
};

// ============================================================
// Template 9: Location Generation (Wizard Step 4)
// ============================================================

const locationGeneration: PromptTemplate = {
  id: 'location-generation',
  name: '地点生成',
  version: 1,
  variables: ['title', 'genre', 'description', 'worldbuilding', 'characters'],
  buildSystem(_vars) {
    return `你是一个专业的小说场景设计师。根据小说的世界观和角色，生成重要的故事地点。

要求：
- 生成 4-8 个重要地点
- 地点应该适合故事展开（有冲突空间、有秘密、有层次感）
- 每个地点有独特的氛围和功能
- 使用中文描述

输出严格 JSON 格式：
[
  {
    "name": "地点名",
    "description": "80字以内的详细描述（含视觉、听觉、嗅觉特征）",
    "significance": "在故事中的作用",
    "parentLocation": "所属大区域（可选）"
  }
]`;
  },
  buildUser(vars) {
    return `小说名称：${vars.title}
类型：${vars.genre}

世界观设定：
${vars.worldbuilding}

主要角色：
${vars.characters}

原始简介与核心约束：${vars.description || ''}
原始简介中的主角、道具状态、事件和世界规则必须保留；若推演设定与简介冲突，应调整推演设定，不得改写简介。
请基于以上信息生成重要地点。`;
  },
};

// ============================================================
// Template 10: Plot Outline (Wizard Step 5)
// ============================================================

const plotOutline: PromptTemplate = {
  id: 'plot-outline',
  name: '剧情总纲',
  version: 2,
  variables: ['title', 'genre', 'description', 'targetWordCount', 'worldbuilding', 'characters', 'locations'],
  buildSystem(vars) {
    const totalChapters = Math.max(1, Math.ceil(Number(vars.targetWordCount) / 3000));
    return `你是一个专业的小说剧情规划师。根据小说的所有设定，生成完整的剧情总纲。

目标字数：${vars.targetWordCount} 字（约 ${totalChapters} 章）

要求：
- 先确定原始事件的真实原因、相关人物的动机与完整结局，再安排人物如何逐步发现；不以更大的阴谋或新谜题替换原始问题
- 阶段之间形成因果链：人物目标、阻力、选择、后果。说明本阶段结束时什么发生了不可忽略的改变，避免只换地点反复调查同一问题
- 关键线索交代来源、取得条件和其他合理解释；计划中的真相不是角色已知事实，不让巧合证人或突然出现的证据包办解决
- 冲突规模符合题材与原始设定，允许关系、现实利益和错误判断造成阻力，不必升级为犯罪集团或幕后黑手
- 章节进度由事件所需篇幅决定；伏笔有具体用途与回收方式，不为续篇留下未回答的核心问题
- 使用中文描述

输出严格 JSON 格式：
{
  "mainPlot": "主线概述（100-200字，概括整个故事的核心冲突和走向）",
  "coreConflict": "核心矛盾（50字以内）",
  "themeMessage": "主题思想（一句话）",
  "stages": [
    {
      "name": "阶段名（如：序幕/开局/发展/高潮/终局）",
      "chapterRange": "第X-Y章",
      "description": "人物目标与阻力、行动选择及其后果；说明与上一阶段的因果联系",
      "coreEvent": "实际改变处境的关键事件，涉及线索时说明如何取得和验证",
      "tension": "张力等级（1-10）",
      "foreshadowSeeds": ["可埋设的伏笔1", "伏笔2"]
    }
  ],
  "ending": "完整解释原始异常的原因、相关人物动机、解决过程与主角承担的后果；说明前面哪些铺垫支持该结局，不以悬念代替答案"
}`;
  },
  buildUser(vars) {
    return `小说名称：${vars.title}
类型：${vars.genre}

世界观设定：
${vars.worldbuilding}

主要角色：
${vars.characters}

重要地点：
${vars.locations}

原始简介与核心约束：${vars.description || ''}
原始简介中的主角、道具状态、事件和世界规则必须保留；若推演设定与简介冲突，应调整推演设定，不得改写简介。明确解释简介中的异常，不得用另一个谜题替换它。
请为这部小说生成完整的剧情总纲。`;
  },
};

// ============================================================
// Template 11: Global Planning (Autopilot pre-generation)
// ============================================================

const globalPlanning: PromptTemplate = {
  id: 'global-planning',
  name: '全局规划',
  version: 3,
  variables: ['title', 'genre', 'style', 'targetWordCount', 'targetChapterCount', 'worldbuilding', 'characters', 'locations', 'plotOutlineStages'],
  buildSystem(vars) {
    return `你是一个资深小说总架构师。根据小说的全部设定，规划完整的卷章结构。

小说：${vars.title}
类型：${vars.genre}
风格：${vars.style}
目标字数：${vars.targetWordCount} 字
总章节数：${vars.targetChapterCount} 章

${vars.plotOutlineStages ? `已有剧情阶段参考：\n${vars.plotOutlineStages}\n` : ''}

要求：
1. 将全部 ${vars.targetChapterCount} 章分为 1-6 卷，短篇可只用一卷
2. 每卷有清楚的主题与人物处境变化
3. 每章用2-3句话说明人物目标、行动与后果，下一章由此产生；连续几章不能只更换地点、重复询问或复述线索
4. 按题材和人物行动安排节奏，允许安静场景，不强制安排冲突与反转
5. 每卷结尾体现已经发生的变化，悬念须来自情节自身
6. 伏笔须有可信铺垫与发展，既有正文和作者资料优先于新规划；不能重新安排已经写完的事实
7. 承接作者总纲的阶段与结局，说明原始问题如何被解决；不要擅自换成更大的阴谋。揭示真相须安排获取信息和验证的行动，不能把作者知道的结局直接变成人物判断

输出严格 JSON 格式：
{
  "mainPlot": "主线概述（100-150字）",
  "coreConflict": "核心冲突（一句话）",
  "themeMessage": "主题思想（一句话）",
  "volumes": [
    {
      "title": "卷标题（如：风起云涌）",
      "startChapter": 0,
      "endChapter": 9,
      "theme": "本卷主题和核心走向（50字以内）"
    }
  ],
  "chapters": [
    {
      "order": 0,
      "title": "章节标题",
      "outline": "本章人物因何采取什么行动、遇到什么阻力、结果如何改变处境，并引出后续行动",
      "volumeIndex": 0,
      "keyEvents": ["关键事件1", "关键事件2"],
      "tensionHint": 7
    }
  ],
  "ending": "原始事件的真实原因、解决过程、人物选择与代价；与作者总纲一致"
}

关键：
- chapters 数组长度必须等于 ${vars.targetChapterCount}
- startChapter 和 endChapter 是 0-based 索引
- volumeIndex 对应 volumes 数组的索引
- tensionHint 范围 1-10，代表本章张力目标
- 卷与卷之间要有递进感`;
  },
  buildUser(vars) {
    return `小说名称：${vars.title}
类型：${vars.genre}
风格：${vars.style}

世界观设定：
${vars.worldbuilding}

主要角色：
${vars.characters}

重要地点：
${vars.locations}

请规划完整的卷章结构，共 ${vars.targetChapterCount} 章。`;
  },
};

// ============================================================
// Template 12: Targeted Chapter Rewrite (定向修写)
// ============================================================

const chapterRewrite: PromptTemplate = {
  id: 'chapter-rewrite',
  name: '定向修写',
  version: 3,
  variables: ['issues', 'directives', 'factLock', 'originalContent'],
  buildSystem(vars) {
    return `你是一个经验老到的小说编辑，坐在作者对面，指出具体问题并直接动手改。

你的工作方式：
1. 先通读全文，定位每个问题对应的具体段落
2. 只改有问题的段落，其他地方一字不动
3. 改完的段落必须和上下文无缝衔接，不能有风格断裂

【具体替换手法】
- "他很愤怒" → 写出愤怒的身体表现（攥拳、咬牙、发抖）
- "她微微一笑" → 写出笑的情境和含义
- "空气中弥漫着紧张的气氛" → 用角色的具体感知替代
- "一种说不出的感觉" → 删掉，用动作或沉默替代
- 连续3句相同句式 → 拆散重组，长短交替
- 角色重复已知信息 → 删掉，用反应替代
- 段末哲学总结 → 删掉，用画面或对话收束
- "不由得""心中一动""缓缓开口" → 换成更具体的表达或直接删掉

【检测到的具体问题（必须逐条修复）】
${vars.issues}

${vars.directives ? `【纠正指令】\n${vars.directives}` : ''}

${vars.factLock ? `【已确立事实（不可违反）】\n${vars.factLock}` : ''}

直接输出修写后的完整章节正文。不要输出任何解释、标记或注释。`;
  },
  buildUser(vars) {
    return `${vars.originalContent}`;
  },
};

// ============================================================
// Template Registry
// ============================================================

const templates: Record<string, PromptTemplate> = {
  'macro-planning': macroPlanning,
  'act-beat-planning': actBeatPlanning,
  'beat-magnify': beatMagnify,
  'beat-generation': beatGeneration,
  'chapter-review': chapterReview,
  'chapter-aftermath': chapterAftermath,
  'worldbuilding': worldbuilding,
  'character-generation': characterGeneration,
  'location-generation': locationGeneration,
  'plot-outline': plotOutline,
  'global-planning': globalPlanning,
  'chapter-rewrite': chapterRewrite,
};

/**
 * Get a template by ID. Applies any user overrides.
 */
export function getTemplate(id: string): PromptTemplate | undefined {
  const base = templates[id];
  if (!base) return undefined;

  // Wrap with override support
  return {
    ...base,
    buildSystem(vars: Record<string, string>) {
      const raw = base.buildSystem(vars);
      const { systemPrompt } = applyOverrides(id, raw, '');
      return systemPrompt;
    },
    buildUser(vars: Record<string, string>) {
      const raw = base.buildUser(vars);
      const { userPrompt } = applyOverrides(id, '', raw);
      return userPrompt;
    },
  };
}

export function getAllTemplates(): PromptTemplate[] {
  return Object.values(templates);
}

export { getSensoryHint };

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

type SceneType = 'combat' | 'dialogue' | 'suspense' | 'daily' | 'romance' | 'exploration';

const SCENE_PROTOCOLS: Record<SceneType, string> = {
  combat: `
【战斗场景协议】
- 禁止使用"速度极快""力量惊人"等抽象描述，必须用具体感官细节
- 每次攻击必须有身体反应（疼痛、震动、后退）
- 战斗中必须穿插心理活动和环境变化
- 禁止连续三句以上的纯动作描写
- 伤害必须持续影响后续行为`,

  dialogue: `
【对话场景协议】
- 每个角色必须有独特的语言风格（用词、句式、口头禅）
- 对话必须推进剧情或揭示角色，禁止无意义寒暄
- 每3-5句对话必须穿插动作/表情/环境描写
- 禁止角色说教式独白超过3句
- 潜台词优先：角色说的和想的应该不同`,

  suspense: `
【悬疑场景协议】
- 信息不对称：读者知道≠角色知道≠叙述者全知
- 每300字必须给一个线索或误导
- 禁止用旁白直接揭示答案
- 必须使用伏笔和暗示而非直接陈述
- 场景转换时保留一个未解答的悬念`,

  daily: `
【日常场景协议】
- 日常中必须有微妙冲突或张力
- 禁止纯描述性的环境介绍，必须通过角色感知
- 每段至少一个角色化的细节（动作/习惯/偏好）
- 日常对话必须暗示更大的故事背景
- 禁止连续两段没有角色互动`,

  romance: `
【感情场景协议】
- 禁止直接说"心跳加速""脸红"，改用行为暗示
- 情感推进必须有触发事件，不可无因升温
- 角色间必须有情感博弈（试探/误解/退缩/靠近）
- 禁止完美的表白场景，必须有不完美之处
- 身体接触必须有前因后果，不可突兀`,

  exploration: `
【探索场景协议】
- 环境描写必须通过角色五感，不可全知视角描述
- 每发现一个新事物必须触发角色反应
- 探索中必须埋设至少一个伏笔
- 禁止百科式世界观灌输
- 危险必须逐步升级，不可一步到位`,
};

// Base Anti-AI Directives (shared across all scenes)

const BASE_ANTI_AI_DIRECTIVES = `
【写作协议 P1-P5】
P1 信息密度：每段必须有动作/对话/发现/推进，禁止空洞描写。
P2 感官优先：展示而非告知。用五感描写代替形容词堆砌。
P3 角色分化：不同角色的用词、句式、口头禅必须不同。
P4 节奏结构：长短句交替，对话与描写穿插，避免连续三段相同句式。
P5 叙事连续：严格遵守已知事实，不得矛盾或遗忘前文设定。`;

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
    action: 'combat',
    dialogue: 'dialogue',
    suspense: 'suspense',
    emotion: 'romance',
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
  version: 3,
  variables: ['title', 'genre', 'style', 'prevChapters', 'phaseDirective', 'foreshadowingContext', 'chapterNumber'],
  buildSystem(vars) {
    return `你是一个资深小说策划师，擅长构思让人放不下的故事。你的任务是为下一章制定宏观方向。

小说：${vars.title}
类型：${vars.genre}
风格：${vars.style}

${vars.phaseDirective ?? ''}

${vars.foreshadowingContext ?? ''}

规划原则：
- 每章必须有至少一个核心冲突或转折
- 章节结尾必须留有悬念或情感钩子
- 不能连续两章没有实质性推进
- 角色行动必须有动机，不能为了推进剧情而OOC
- 伏笔和债务需要逐步解决

请输出JSON格式：
{
  "title": "章节标题（有吸引力，不用"第X章"格式）",
  "direction": "本章发展方向和核心冲突（**至少400字**，必须含：(1)冲突双方及动机 (2)2-3个具体场景片段（地点+在场角色+发生什么） (3)1-2段关键对话的梗概（角色说什么、潜台词是什么） (4)明确的转折点或揭示 (5)情绪走向 (6)结尾钩子）",
  "conflictCore": "一句话概括本章核心冲突",
  "endingHook": "结尾钩子描述",
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
  version: 3,
  variables: ['title', 'genre', 'style', 'prevSummary', 'macroDirection', 'chapterNumber', 'chapterTitle', 'factLock', 'beatLock', 'clueLock'],
  buildSystem(vars) {
    return `你是一个专业的小说大纲规划师。根据宏观方向，生成详细的章节大纲。

大纲要求：
- 3-5个叙事节拍（beat），每个有明确目的
- 节拍之间有因果关系，不是松散拼接
- 情绪弧线有起伏（不能一直平或一直高）
- 必须包含至少一个对话密集的节拍
- 必须包含至少一个冲突/对抗节拍
- 最后一个节拍制造悬念或给出情感落点

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
  version: 2,
  variables: ['outline', 'chapterNumber', 'targetWords', 'chapterIndex'],
  buildSystem() {
    return `你是一个叙事节拍规划师。将章节大纲拆分为 3-6 个叙事节拍(beat)。

每个 beat 必须指定：
- "description": 节拍内容描述（具体场景/事件）
- "targetWords": 目标字数（整数）
- "focus": 聚焦类型，必须是以下之一：action, dialogue, sensory, emotion, suspense, hook, character_intro, narration
- "sceneGoal": 这个场景要达到什么目的

分配规则：
- 总 targetWords 之和等于 ${'$'}{targetWords}
- hook 类型只能在第一个 beat 使用
- 第一个 beat 负责承接上一章/建立悬念
- 最后一个 beat 负责收束或制造悬念
- action/suspense 类型的 beat 分配更多字数

输出严格JSON数组：
[{"description":"...","targetWords":800,"focus":"action","sceneGoal":"..."}, ...]`;
  },
  buildUser(vars) {
    const chIdx = Number(vars.chapterIndex ?? 0);
    let special = '';
    if (chIdx === 0) {
      special = '\n\n注意：这是小说第1章。第一个beat必须是hook类型，用于抓住读者。';
    } else if (chIdx === 1) {
      special = '\n\n注意：这是第2章。应包含感官描写和悬念建立。';
    }
    return `大纲：\n${vars.outline}\n\n目标总字数：${vars.targetWords}字\n请拆分为beats。${special}`;
  },
};

// ============================================================
// Template 4: Beat Generation (CORE — single beat, PlotPilot storyteller approach)
// ============================================================

const CORE_WRITING_RULES = `
【核心写法要求】
1. 每句话至少完成两项：推进情节、揭示角色、制造张力、建构世界——做不到就删
2. 不写情绪标签（"他很愤怒"），写身体反应（"他攥紧拳头"）
3. 不写微表情（"嘴角勾起"），写完整姿态（"她退后一步，双臂抱胸"）
4. 对话有潜台词——角色说的和想的不一样
5. 环境通过角色五感展示，不是百科介绍
6. 冲突硬碰硬化解，不靠巧合
7. 每300字要有信息增量（新事实/新线索/新决定/新冲突）
8. 高潮充分展开，过渡一笔带过
9. 结尾用画面/动作/未完的话收束，不总结
10. 连续三段相同句式 → 拆散重组`;

const beatGeneration: PromptTemplate = {
  id: 'beat-generation',
  name: '单Beat生成',
  version: 3,
  variables: ['title', 'genre', 'style', 'phaseDirective', 'context', 'outline', 'beatDescription', 'beatFocus', 'targetWords', 'conductorSignal', 'beatIndex', 'totalBeats', 'sensoryHint'],
  buildSystem(vars) {
    const isFirst = vars.beatIndex === '0';
    const isLast = vars.beatIndex === String(Number(vars.totalBeats) - 1);

    // Scene-based protocol selection (Layer 2)
    const sceneType = detectSceneType(vars.beatFocus ?? '');
    const sceneProtocol = buildSceneProtocol(sceneType);

    const beatSpecific = [
      isFirst ? '\n【开篇指令】这是章节开头。必须在前50字内建立场景感，前100字内出现角色或事件。禁止介绍背景。' : '',
      isLast ? '\n【结尾指令】这是章节最后一段。必须收束当前情绪，要么制造悬念，要么给出情感落点。禁止开放式结尾后继续展开。禁止总结。' : '',
    ].join('');

    return `你是一个坐在老街冷茶馆里的说书人，不是AI助手。你的任务是讲一个让人放不下的故事。

${CORE_WRITING_RULES}

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
感官轮换：${vars.sensoryHint ?? getSensoryHint(Number(vars.beatIndex ?? 0))}

${vars.conductorSignal ?? ''}${beatSpecific}

━━ 讲吧 ━━
• 每段至少包含：具体动作、有信息量的对话、发现/决定、空间位移——四选一
• 冲突场景多写，过渡一笔带过
• 结尾留一根刺，不要收干净
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
- 每个维度至少 3 个具体设定项
- 设定之间要有关联和约束关系
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
  variables: ['title', 'genre', 'worldbuilding'],
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
  variables: ['title', 'genre', 'worldbuilding', 'characters'],
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

请基于以上信息生成重要地点。`;
  },
};

// ============================================================
// Template 10: Plot Outline (Wizard Step 5)
// ============================================================

const plotOutline: PromptTemplate = {
  id: 'plot-outline',
  name: '剧情总纲',
  version: 1,
  variables: ['title', 'genre', 'targetWordCount', 'worldbuilding', 'characters', 'locations'],
  buildSystem(vars) {
    const totalChapters = Math.max(10, Math.ceil(Number(vars.targetWordCount) / 3000));
    return `你是一个专业的小说剧情规划师。根据小说的所有设定，生成完整的剧情总纲。

目标字数：${vars.targetWordCount} 字（约 ${totalChapters} 章）

要求：
- 主线清晰，有明确的起承转合
- 每个阶段有核心冲突和转折点
- 合理分配章节进度
- 预留伏笔空间
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
      "description": "阶段概述（50字以内）",
      "coreEvent": "核心事件",
      "tension": "张力等级（1-10）",
      "foreshadowSeeds": ["可埋设的伏笔1", "伏笔2"]
    }
  ],
  "ending": "结局描述（50字以内）"
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

请为这部小说生成完整的剧情总纲。`;
  },
};

// ============================================================
// Template 11: Global Planning (Autopilot pre-generation)
// ============================================================

const globalPlanning: PromptTemplate = {
  id: 'global-planning',
  name: '全局规划',
  version: 1,
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
1. 将全部 ${vars.targetChapterCount} 章分为 2-6 卷（根据总章节数决定）
2. 每卷有独立主题和张力弧线
3. 每章有明确的大纲（2-3句话，说明本章核心事件和推进方向）
4. 张力曲线要起伏有致，不能一路平铺
5. 每卷结尾要有钩子（悬念或转折）
6. 伏笔要埋设和回收

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
      "outline": "本章核心事件和推进方向的简述（30-60字）",
      "volumeIndex": 0,
      "keyEvents": ["关键事件1", "关键事件2"],
      "tensionHint": 7
    }
  ],
  "ending": "结局方向（30字以内）"
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

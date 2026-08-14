// ============================================================================
// Chapter Slicer — 把章节正文切成可单独生成视频的段落（"raw shots"）
// ============================================================================
// 切片启发式：
//   1. 优先按场景分隔（空行 + 地点/时间线索）
//   2. 段落字符数到达上限（默认 600-1200 字）时强制切
//   3. 对话密集区合并、动作描写区分细
//
// 输出：RawShot[] —— 尚未生成 videoPrompt，等待 storyboard-prompt.ts 优化。

export interface RawShot {
  id: string;
  index: number;
  sourceChapterId: string;
  sourceChapterNumber: number;
  rawText: string;
  characters: string[];
  location?: string;
  mood?: string;
  hasDialogue: boolean;
  hasAction: boolean;
}

export interface SliceOptions {
  /** 单镜头目标字数（默认 800，剧本模式默认 100） */
  targetWordsPerShot?: number;
  /** 最小字数（小于此值合并到上一段） */
  minWordsPerShot?: number;
  /** 最大字数（超过此值强制切分） */
  maxWordsPerShot?: number;
  /** 是否为剧本模式（针对分镜/剧本格式优化切片与分镜粒度） */
  isScript?: boolean;
}

const DEFAULT_OPTS: Required<SliceOptions> = {
  targetWordsPerShot: 800,
  minWordsPerShot: 300,
  maxWordsPerShot: 1500,
  isScript: false,
};

interface ChapterInput {
  id: string;
  number: number;
  content: string;
}

/**
 * 将多章节正文切成 RawShot 序列。
 */
export function sliceChapters(chapters: ChapterInput[], opts: SliceOptions = {}): RawShot[] {
  const isScript = opts.isScript || chapters.some((c) => /^(镜头|第?\d+镜|Shot\s*\d+|Scene\s*\d+|【镜头|【分镜|【场)/im.test(c.content));
  const o: Required<SliceOptions> = {
    targetWordsPerShot: isScript ? 100 : (opts.targetWordsPerShot ?? DEFAULT_OPTS.targetWordsPerShot),
    minWordsPerShot: isScript ? 10 : (opts.minWordsPerShot ?? DEFAULT_OPTS.minWordsPerShot),
    maxWordsPerShot: isScript ? 400 : (opts.maxWordsPerShot ?? DEFAULT_OPTS.maxWordsPerShot),
    isScript,
  };
  const shots: RawShot[] = [];
  let globalIndex = 0;

  for (const ch of chapters) {
    const paragraphs = splitParagraphs(ch.content);
    const groups = groupParagraphs(paragraphs, o);

    for (const group of groups) {
      const text = group.join('\n\n').trim();
      if (!text) continue;

      shots.push({
        id: `shot_${ch.number}_${globalIndex}`,
        index: globalIndex,
        sourceChapterId: ch.id,
        sourceChapterNumber: ch.number,
        rawText: text,
        characters: detectCharacters(text),
        location: detectLocation(text),
        mood: detectMood(text),
        hasDialogue: /["「『":：]/.test(text),
        hasAction: /(vs\.|战斗|冲|跑|打|撞|刺|劈|射|爆炸|闪避|拔剑|出手|跃起)/.test(text),
      });
      globalIndex += 1;
    }
  }

  return shots;
}

// --- internals ---

function splitParagraphs(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}|\n(?=(?:镜头|第?\d+镜|Shot\s*\d+|Scene\s*\d+|【镜头|【分镜|【场|第\d+场))/i)            // 段间空行或镜头前缀
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 按目标字数和场景边界把段落分组。
 * 简单策略：累加段落字数，达到 targetWords 或检测到场景切换就切。
 */
function groupParagraphs(paragraphs: string[], o: Required<SliceOptions>): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    const totalWords = current.reduce((s, p) => s + countChars(p), 0);
    // 太短且不是剧本模式 → 合并到上一组（如果有）
    if (!o.isScript && totalWords < o.minWordsPerShot && groups.length > 0) {
      const prev = groups[groups.length - 1];
      prev.push(...current);
    } else {
      groups.push(current);
    }
    current = [];
    currentWords = 0;
  };

  for (const para of paragraphs) {
    const words = countChars(para);
    const sceneChanged = isSceneBoundary(para);

    // 遇到新场景/镜头标记，或者超长，先 flush 前面积累的内容
    if (sceneChanged && current.length > 0) {
      flush();
    } else if (currentWords + words > o.maxWordsPerShot && current.length > 0) {
      flush();
    } else if (currentWords + words > o.targetWordsPerShot && current.length > 0) {
      flush();
    }

    current.push(para);
    currentWords += words;

    // 如果是剧本模式且当前段落已经是完整镜头描述，直接切
    if (o.isScript && (words >= o.minWordsPerShot || sceneChanged)) {
      flush();
    }
  }
  flush();

  return groups;
}

function countChars(s: string): number {
  // 中文字符按 1 计，英文按单词（粗略 1 字符）
  return [...s].filter((c) => !/\s/.test(c)).length;
}

/**
 * 启发式检测：段落开头是否暗示场景切换或镜头切换
 *   - 镜头标记："镜头1" / "第1镜" / "Shot 1"
 *   - "第二天 / 当晚 / 三日后" 等时间词
 *   - "在 xxx / xxx 客栈" 等地点词开头
 *   - 全大写或带【】的场景标记
 */
function isSceneBoundary(para: string): boolean {
  const trimmed = para.trim();
  if (/^(镜头|第?\d+镜|分镜|Shot\s*\d+|Scene\s*\d+|【镜头|【分镜|【场|第\d+场|场\s*\d+)/i.test(trimmed)) {
    return true;
  }
  if (/^(第二天|当晚|当夜|三日后|数日后|次日|黄昏|清晨|夜晚|午后|几天后|不久|与此同时)/.test(trimmed)) {
    return true;
  }
  if (/^【.+】/.test(trimmed)) return true;
  if (/^场景[:：]/.test(trimmed)) return true;
  if (/^(第一章|第二章|第三章|第\S+章)/.test(trimmed)) return true;
  return false;
}

function detectCharacters(text: string): string[] {
  // 启发式：从小说对话引用或剧本对话中提取说话人
  const speakers = new Set<string>();
  // 1. "xxx说" / 「xxx」xxx 道
  const novelPatterns = [
    /["「『"]([^"」』"]{1,8}?)["」』"]\s*[说道笑道喊道问]/g,
    /^(\S{1,8})[说道笑道喊道问]/gm,
  ];
  for (const re of novelPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]?.trim();
      if (name && name.length <= 8 && !/[\s，。！？]/.test(name)) {
        speakers.add(name);
      }
    }
  }

  // 2. 剧本格式：角色名：/ 角色名: / 角色名（动作）：
  const scriptPatterns = [
    /^([一-龥A-Za-z0-9_]{1,8})(?:（[^）]+）|\([^)]+\))?[:：]/gm,
    /【([一-龥A-Za-z0-9_]{1,8})】/g,
  ];
  for (const re of scriptPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]?.trim();
      if (name && name.length <= 8 && !/[\s，。！？]/.test(name) && !['场景', '镜头', '旁白', '画面', '音乐', '音效', '时间', '地点'].includes(name)) {
        speakers.add(name);
      }
    }
  }

  return [...speakers].slice(0, 6);
}

function detectLocation(text: string): string | undefined {
  // "在 xxx" / "xxx 内" / "xxx 之外" / "地点：xxx"
  const locMatch = text.match(/(?:地点|场景)[:：]\s*([一-龥A-Za-z0-9_]{2,12})/);
  if (locMatch) return locMatch[1];

  const m = text.match(/(?:在|回到|进入|离开|来到)([一-龥A-Za-z]{2,8}?)(?:的|里|内|中|前|后|之外|之上|之下)?(?:[，。！？\s])/);
  return m?.[1];
}

function detectMood(text: string): string | undefined {
  if (/(战斗|杀|血|死亡|恐惧|愤怒|咆哮|爆炸)/.test(text)) return 'intense';
  if (/(笑|温柔|温暖|拥抱|亲吻|爱)/.test(text)) return 'warm';
  if (/(悲伤|哭泣|眼泪|失去|孤独|绝望)/.test(text)) return 'melancholic';
  if (/(神秘|阴影|悄然|诡异|黑暗)/.test(text)) return 'mysterious';
  if (/(日出|清晨|光明|希望|新生)/.test(text)) return 'hopeful';
  return undefined;
}

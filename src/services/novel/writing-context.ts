import type { NovelChapter, NovelMetadata } from '@/types';
import type { StoryBible } from '@/types/narrative';

export interface NovelWritingSource {
  title: string;
  description: string;
  genre: string;
  style: string;
  language?: string;
}

export interface ChapterMemory {
  chapter: number;
  contentFingerprint?: string;
  continuityNotes?: Array<{ fact: string; quote: string }>;
}

// Cache invalidation only; this is not a security hash.
export function textFingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export function getNovelChapters(metadata: NovelMetadata): NovelChapter[] {
  const nodes = metadata.storyNodes?.filter(n => n.nodeType === 'chapter').sort((a, b) => a.order - b.order);
  return nodes?.length ? nodes.map((n, order) => ({
    id: n.id, title: n.title, order, outline: n.outline ?? '', content: n.content ?? '',
    wordCount: n.wordCount ?? 0, status: n.status ?? 'planned', volumeId: n.parentId ?? undefined,
  })) : [...metadata.chapters].sort((a, b) => a.order - b.order);
}

export const NOVEL_WRITING_PRINCIPLES = `【叙事与语言】
- 因果推进：人物因欲望、认知和处境作出选择，选择产生后果；解决问题要付出可信的代价。不要靠恰好出现的新线索、新人物或无端降智推动。
- 人物有自己的立场和知识边界。对话是人物要达成目的的行动，不是替作者说明背景；不要求每句都带动作、口头禅或潜台词。
- 承接前文的时间、地点、在场者、伤势、道具归属、信息来源。传闻、猜想与已验证事实分开；不得让角色提前知道尚未获知的事。
- 让重要的选择和冲突充分发生，省略没有变化的重复检查与路程；安静场景也可以有价值，不为制造反转破坏人物和题材。
- 文风设定服务于内容；若旧公约要求机械堆叠环境、动作、微表情或禁止必要心理叙述，以人物可信、叙事清楚和阅读节奏为先。不要为了显得“文学”延后核心事件，也不要为了快节奏省掉关键动机与后果。
- 用符合这个人物和场景的准确细节。叙述、对话、心理和必要的直接说明自然交替；不强制长短句轮换、感官配额、每段动作或固定字数钩子。
- 减少重复比喻、身体反应、解释句和抽象感悟，尤其避免先展示再解释同一情绪。正常的“感到”、比喻、环境描写无需一律删除。
- 结尾停在本章真正改变的处境、决定、行动或问题上；不重复制造同一种悬念，不追加人生总结。只输出作品正文，不输出自评或写作说明。`;

export function buildWritingContext(
  source: NovelWritingSource,
  bible: StoryBible,
  chapters: NovelChapter[],
  chapterIndex: number,
  memories: ChapterMemory[] = [],
): string {
  const previous = chapters.filter(c => c.order < chapterIndex && c.content.trim()).sort((a, b) => a.order - b.order);
  const sections = [
    `【作者原始设定，优先于推演规划】\n小说：《${source.title}》\n类型：${source.genre}\n风格：${source.style}\n语言：${source.language || '中文'}\n简介与创作约束：${source.description}`,
    `【故事设定】\n文风公约：${bible.styleNotes.map(n => `${n.key}: ${n.value}`).join('\n')}\n世界设定：${bible.worldSettings.map(w => `${w.name}: ${w.description}`).join('\n')}\n人物设定：${bible.characters.map(c => `${c.name}: ${c.description}; 外貌:${c.appearance}; 性格:${c.personality}; 信念:${c.psyche?.coreBelief || ''}; 说话习惯:${c.voiceAnchor?.speechStyle || c.voiceAnchor?.verbalTic || ''}`).join('\n')}\n地点：${bible.locations.map(l => `${l.name}: ${l.description}`).join('\n')}`,
    `【待实现的剧情规划，不是已发生事实】\n${bible.timelineNotes.filter(n => n.id === 'plot-outline').map(n => `${n.event}\n${n.significance || ''}`).join('\n')}\n规划与原始简介冲突时保留原始约束，调整规划。前文正文已发生的事情不能因大纲不同而被当作没发生。`,
  ];
  const recentIds = new Set(previous.slice(-3).map(c => c.id));
  for (const c of previous) {
    if (recentIds.has(c.id)) continue;
    const memory = memories.find(m => m.chapter === c.order && m.contentFingerprint === textFingerprint(c.content));
    const notes = memory?.continuityNotes?.filter(n => c.content.includes(n.quote));
    sections.push(notes?.length
      ? `【第${c.order + 1}章已发生事实，附原文依据】\n${notes.map(n => `${n.fact}（原文：${n.quote}）`).join('\n')}`
      : `【第${c.order + 1}章片段，尚无有效审稿记录，不能据此证明整章连续性】\n${c.content.slice(0, 350)}\n……\n${c.content.slice(-550)}`);
  }
  for (const c of previous.filter(c => recentIds.has(c.id))) {
    const text = c.content.length <= 12000 ? c.content : `${c.content.slice(0, 5000)}\n【中段超出上下文预算，未提供；审稿不能推断其内容】\n${c.content.slice(-7000)}`;
    sections.push(`【第${c.order + 1}章《${c.title}》${c.content.length <= 12000 ? '正文' : '正文节选'}，已发生事实】\n${text}`);
  }
  if (!previous.length) sections.push('【前文】这是开篇，尚无已发生的章节。');
  return sections.join('\n\n');
}

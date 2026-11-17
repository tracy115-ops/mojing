import type { NovelChapter, NovelMetadata } from '@/types';
import type { StoryBible, Worldbuilding, Storyline, ChapterCast, Foreshadowing, RelationshipTriple } from '@/types/narrative';
import type { Prop, PropEvent } from './prop-manager';

export const WRITING_REFERENCE_KEYS = ['bible', 'worldbuilding', 'storylines', 'casts', 'foreshadowing', 'triples', 'props', 'prop-events', 'chapter-reviews'] as const;

export interface WritingReferences {
  worldbuilding?: Worldbuilding;
  storylines?: Storyline[];
  casts?: ChapterCast[];
  foreshadowing?: Foreshadowing[];
  triples?: RelationshipTriple[];
  props?: Prop[];
  propEvents?: PropEvent[];
}

function referenceSections(bible: StoryBible, chapterIndex: number, refs: WritingReferences): string[] {
  const sections: string[] = [];
  const name = (id: string) => bible.characters.find(c => c.id === id || c.name === id)?.name || id;
  if (refs.worldbuilding) {
    const labels = { coreRules: '核心法则', geography: '地理生态', society: '社会结构', culture: '历史文化', dailyLife: '日常生活' };
    for (const [key, dimension] of Object.entries(refs.worldbuilding.dimensions)) {
      const fields = Object.entries(dimension.fields).filter(([, value]) => value.trim());
      if (fields.length) sections.push(`【作者世界观资料：${dimension.title || labels[key as keyof typeof labels]}】\n${fields.map(([field, value]) => `${field}: ${value}`).join('\n')}`);
    }
  }
  for (const line of refs.storylines || []) {
    if (line.chapterRange[0] > chapterIndex || line.status === 'paused') continue;
    // A later completion marker does not prove the ending has already happened.
    const milestones = line.milestones.filter(m => m.chapter <= chapterIndex).map(m => `第${m.chapter + 1}章计划：${m.label}`);
    sections.push(`【作者剧情规划：${line.name}，不是已发生事实】\n${line.description}\n计划第${line.chapterRange[0] + 1}～${line.chapterRange[1] + 1}章展开。${milestones.join('\n')}`);
  }
  const cast = refs.casts?.find(c => c.chapterIndex === chapterIndex);
  if (cast?.lockedCharacters.length) sections.push(`【作者本章出场计划】\n${cast.lockedCharacters.map(name).join('、')}。安排符合在场条件与人物目的的参与；不能仅为点名而插入场景，也不能因此让角色提前知道消息。`);
  for (const f of refs.foreshadowing || []) {
    if (f.plantedInChapter > chapterIndex + 1) continue;
    const resolvedEarlier = f.status === 'resolved' && f.resolvedInChapter !== undefined && f.resolvedInChapter <= chapterIndex;
    const status = resolvedEarlier ? `台账记为第${f.resolvedInChapter}章已回收，须与前文核对` : f.status === 'abandoned' ? '作者已搁置' : '待发展的线索';
    sections.push(`【伏笔台账，不能代替正文证据】\n${f.description}\n${status}。${f.suggestedResolveChapter ? `原计划第${f.suggestedResolveChapter}章考虑回收，` : ''}回收与否依人物行动和情节因果决定，日期经过不等于已经解决，不强制本章闭合。`);
  }
  for (const t of refs.triples || []) {
    // Extracted/inferred relations have no supporting quotations; do not promote them to facts.
    if (t.source !== 'bible' || t.sinceChapter > chapterIndex) continue;
    sections.push(`【作者关系记录】\n${t.subject} — ${t.predicate} → ${t.object}。关系不等于共享所有消息，角色知情须有来源。`);
  }
  for (const p of refs.props || []) {
    if (p.introducedChapter !== undefined && p.introducedChapter > chapterIndex + 1) continue;
    const events = (refs.propEvents || []).filter(e => e.propId === p.id && e.chapterNumber <= chapterIndex).sort((a, b) => a.chapterNumber - b.chapterNumber);
    const hasLaterEvent = (refs.propEvents || []).some(e => e.propId === p.id && e.chapterNumber > chapterIndex);
    const attributes = Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join('；');
    sections.push(`【道具资料：${p.name}，状态须与前文核对】\n${p.description}${attributes ? `\n${attributes}` : ''}${!hasLaterEvent ? `\n台账状态：${p.lifecycleState}${p.holderCharacterId ? `；持有者：${name(p.holderCharacterId)}` : ''}` : ''}${events.length ? `\n前文事件记录：${events.map(e => `第${e.chapterNumber}章 ${e.description}${e.toHolderId ? `；交给${name(e.toHolderId)}` : ''}`).join('\n')}` : ''}`);
  }
  return sections;
}

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
- 推断要经得起其他可能的检验：“没有看见”“记录里没有”不等于没有发生。人眼、镜头、记忆与记录各有覆盖范围，不能凭一处痕迹断定唯一来源；人物可以误判，但叙述要保留证据与推论的距离，不能让所有人无依据地接受同一个结论。
- 人物的承诺、约定和处理条件对后续行动有效。改变立场或违反约定时，要让原因、选择与后果实际发生。人物知道新消息须有来源；距离、楼层、朝向和遮挡须支持人物看到的细节。
- 让重要的选择和冲突充分发生，省略没有变化的重复检查与路程；安静场景也可以有价值，不为制造反转破坏人物和题材。
- 转述给另一人物时只写新问题或新反应，不把读者刚看过的过程完整复述多遍。下一步由已有证据和人物选择产生，不为填补因果空缺而临时追加可疑痕迹、失联人物或巧合消息；新线索须有铺垫与可信的取得过程。
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
  purpose: 'writing' | 'review' = 'writing',
  references: WritingReferences = {},
): string {
  const previous = chapters.filter(c => c.order < chapterIndex && c.content.trim()).sort((a, b) => a.order - b.order);
  const sections = [
    '【创作依据的使用边界】\n先核对已写事实、人物约定和信息来源，再展开本章。规划中的推断尚未得到证明；缺少观察不等于排除了其他可能，不能为了推进而补成唯一答案。',
    `【作者原始设定，优先于推演规划】\n小说：《${source.title}》\n类型：${source.genre}\n风格：${source.style}\n语言：${source.language || '中文'}\n简介与创作约束：${source.description}`,
    `【文风偏好，服务于内容，不是事实或逐句禁令】\n${purpose === 'review' ? '审读以实际阅读效果为准，不能仅因心理直述、句子长短、缺少手势或人物偶尔偏离性格标签报错。只有确实造成阅读障碍才提出修改，并说明影响。' : '沿用作品的声音；不把偏好执行成动作、环境、比喻的配额。'}\n${bible.styleNotes.map(n => `${n.key}: ${n.value}`).join('\n')}`,
    ...bible.worldSettings.map(w => `【世界设定：${w.name}】\n${w.description}${w.constraints?.length ? `\n约束：${w.constraints.join('；')}` : ''}`),
    ...bible.characters.map(c => `【人物设定：${c.name}】\n${c.description}\n外貌:${c.appearance}; 性格:${c.personality}; 经历:${c.backstory || ''}; 信念:${c.psyche?.coreBelief || ''}; 禁忌:${c.psyche?.taboo || ''}; 说话习惯:${c.voiceAnchor?.speechStyle || c.voiceAnchor?.verbalTic || ''}${c.relationships?.length ? `\n作者关系设定：${c.relationships.filter(r => r.sinceChapter <= chapterIndex).map(r => `${bible.characters.find(other => other.id === r.targetCharacterId)?.name || r.targetCharacterId}：${r.type} ${r.description}`).join('；')}` : ''}`),
    ...bible.locations.map(l => `【地点：${l.name}】\n${l.description}${l.parentLocation ? `\n所在区域：${l.parentLocation}` : ''}${l.significance ? `\n用途：${l.significance}` : ''}`),
    `【待实现的剧情规划，不是已发生事实】\n${bible.timelineNotes.filter(n => n.id === 'plot-outline').map(n => `${n.event}\n${n.significance || ''}`).join('\n')}\n规划与原始简介冲突时保留原始约束，调整规划。前文正文已发生的事情不能因大纲不同而被当作没发生。`,
    ...referenceSections(bible, chapterIndex, references),
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

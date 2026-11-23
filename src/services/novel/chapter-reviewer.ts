import { NarrativeRepository } from './narrative-repository';
import { providerRouter } from '@/services/providers';
import type { NovelChapter } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';
import { buildWritingContext, NOVEL_WRITING_PRINCIPLES, textFingerprint, type NovelWritingSource } from './writing-context';
import {
  EDITORIAL_DIMENSIONS, parseEditorialAssessment, needsEditorialRevision, parseEditorialEdits,
  labelEditorialParagraphs, parseOutlineAssessment,
  type EditorialAssessment, type EditorialEdit,
} from './editorial-review';

export interface ChapterReviewContext {
  source: NovelWritingSource;
  chapters: NovelChapter[];
  outline?: string;
}
export interface DimensionScore { name: string; score: number; issues: string[] }
export interface ChapterReviewReport extends EditorialAssessment {
  novelId: string;
  chapter: number;
  overallScore: number;
  suggestions: string[];
  timestamp: string;
  contentFingerprint: string;
  contextFingerprint: string;
  status: 'reviewed' | 'needs-revision';
}

export class ChapterReviewer {
  private repo: NarrativeRepository;
  constructor(private novelId: string) { this.repo = new NarrativeRepository(novelId); }

  private async generateEditorial(request: LLMGenerateRequest) {
    try {
      return await providerRouter.generate(request);
    } catch (error) {
      const outputBudget = request.maxTokens ?? 16384;
      if (!(error instanceof Error) || !error.message.includes('LLM output was truncated at max_tokens=') || outputBudget >= 32768) throw error;
      return providerRouter.generate({ ...request, maxTokens: Math.min(outputBudget * 2, 32768) });
    }
  }

  buildContext(chapterIndex: number, context: ChapterReviewContext, purpose: 'writing' | 'review' = 'review'): string {
    return buildWritingContext(context.source, this.repo.loadBible(), context.chapters, chapterIndex, this.loadHistory(), purpose, this.repo.loadWritingReferences())
      + `\n\n【本章写作意图，不能当作正文已经实现】\n${context.outline || '未提供'} `;
  }

  async prepareOutline(chapterIndex: number, outline: string, context: ChapterReviewContext): Promise<string> {
    const reference = buildWritingContext(context.source, this.repo.loadBible(), context.chapters, chapterIndex, this.loadHistory(), 'writing', this.repo.loadWritingReferences());
    const contextFingerprint = textFingerprint(reference);
    const saved = this.repo.loadCustomData<{ contextFingerprint: string; outlineFingerprint: string } | null>('chapter-outline:' + chapterIndex, null);
    if (saved?.contextFingerprint === contextFingerprint && saved.outlineFingerprint === textFingerprint(outline)) return outline;
    const response = await this.generateEditorial({
      taskType: 'review', responseFormat: 'json', temperature: 0.25, maxTokens: 12288, thinking: true,
      systemPrompt: `你是小说策划编辑，负责在正文写作前审读并修正章节方案。目标是好读、可信、确有推进的故事，而非符合模板的术语清单。
${NOVEL_WRITING_PRINCIPLES}
检查人物目标与已有处境是否相接，冒险、隐瞒、违规或退让是否有具体动机及相称的代价；不能把性格标签当行动理由。确认关键线索有可获得的来源，角色不会因大纲透露就提前知道答案。职业、空间与时间细节须符合故事规则和常识。区分普通异常与已知危险，不强迫人物恐慌或报警来增加紧张。
检查已有问题是否推进、场景是否改变处境；删除无变化的检查、来回搬动、装饰性景物和结尾突然闪现的人影等通用悬念。允许合理的等待、日常与心理，不能用动作配额或故作神秘替代内容。不要强制反转，不把伏笔暂未回收视为错误。
把每个关键结论反过来核对：证据的可见范围和取得条件是什么，是否仍有常见的其他解释；不要把未看见、无记录、物品表面状态等写成排除其他来源的证据。新线索可以发生，但须来自人物本次行动，不能凭空追加新痕迹或失联人物。不要重复前章已经经历的申请、拒绝、转述过程。先前人物的处理条件仍然有效，本章若违背须有明确动机和后果。
保留原始简介、作者本章意图和前文已发生事实。修正方案不能改前文、偷换核心谜题、额外塞入信物或未铺垫的关系。若关键矛盾无法在本章合理修正，ready=false并说明，不能假装已解决。
输出JSON：{"ready":true,"outline":"完整可写的修正大纲，约600～1000字；围绕重要场景说明人物目标、阻力、选择、后果及章末状态，不逐项规定比喻、手势和秒数","changes":["具体修正及阅读收益，没有则空数组"],"unresolvedIssues":[]}。不输出正文，不宣称文学质量达标。`,
      userPrompt: `${reference}\n\n【待审本章方案，是计划，不是已发生事实】\n${outline}`,
    });
    const result = parseOutlineAssessment(response.content);
    this.repo.saveCustomData('chapter-outline:' + chapterIndex, { ...result, originalOutline: outline, contextFingerprint, outlineFingerprint: textFingerprint(result.outline), timestamp: new Date().toISOString() });
    if (!result.ready) throw new Error('大纲仍需调整：' + (result.unresolvedIssues.join('；') || '未形成可写方案'));
    return result.outline;
  }

  async reviewChapter(chapterIndex: number, content: string, context: ChapterReviewContext, options: { persist?: boolean } = {}): Promise<ChapterReviewReport> {
    const reference = this.buildContext(chapterIndex, context);
    const systemPrompt = `你是一位认真通读作品的小说编辑。判断阅读效果，分数只是辅助，不是文学质量证书。
${NOVEL_WRITING_PRINCIPLES}
审读六个维度：
premise_fidelity：是否兑现原始题材和故事承诺，是否偷换谜题或新增矛盾设定；
character_consistency：人物动机、选择、立场和知识边界是否可信，对话是否能区分人物；
timeline_consistency：时间、空间、道具归属、伤势、行动和消息来源是否承接前文；
plot_coherence：场景是否有目的、阻力、选择和后果，是否推进已有问题，是否靠巧合、解释或重复检查凑篇幅；
foreshadowing_usage：线索和承诺的建立、发展与兑现是否可信。允许伏笔暂不回收，不要求每章制造新谜题；
voice_quality：语言是否准确自然，是否重复意象、句式和身体反应，是否展示后又解释，角色是否像在朗读作者观点。

先作为读者通读，再给编辑意见：本章谁想达成什么，关键选择改变了什么，哪里让人信服、困惑或失去耐心。优先发现会影响后续阅读的动机、现实常识、因果与承接问题，再看语言。检查是否用大量准备动作推迟主要事件、是否只有气氛却没有变化、人物的实际行动是否与其目标相悖且没有交代。争论双方是否确有相斥的目标，关键冲突有没有实际行动、让步或代价来收束；口头表态和答应稍后去做，不能冒充已经完成的后果，但有合理安排的暂缓不必强行本章解决。
结合前文通读完整正文，重点检查章间衔接和结尾。原始简介优先；规划不等于已发生事实；人物猜想不等于事实。文风公约也要接受阅读效果检验，不能因为遵守了“白描”“微表情”“环境外化”等要求就给出好评。不能因只命中一个普通词、出现比喻或叙述较安静就判定“AI写作”。不得捏造漏洞、要求未提供的章节证据，或为了凑数量报错。悬念暂未解释不等于缺陷，不要建议增加神秘表情、回避动作、新比喻来替代真实的动机和推进；没有改善作用的换词不要报。
必要的心理直述、平常的说明、人物在压力下偶尔反问，不违反“克制”或“冷静”。不要按旧文风公约或性格标签逐句执法；不得建议用捏手指、看窗外等无实质作用的动作替代清楚的心理。职业判断须有已提供的规则或可靠常识支持，不能臆造单位规章或断言照片等同实物鉴定。
每个问题必须用 paragraphId 指向本章对应段落（例如C12）；涉及连续多段可用C12-C15，最多连续20段。如声称前后冲突，referenceId须指向对照原文：本章其他段落用C编号（如C7），前文/设定用R编号（如R3）；其他问题填空字符串。两种编号不能混为同一范围。引用由系统从段落编号提取，你不要重新抄写或改写引文。问题需要解释读者为何受到影响，并给出具体修订方向。
critical 是硬事实矛盾或核心承诺被破坏，major 是影响阅读的因果/人物/节奏/语言问题，minor 是可选的局部改善。重大问题不能被其他高分抵消。
只输出严格 JSON，最多8个确有依据且按影响排序的问题。summary指出具体阅读效果，不泛泛称赞氛围或细腻。提取本章最多10条对后文重要的已发生事实或未解问题；每条只写所指段落直接支持的一件事，区分推测与确认，不能把设定、大纲或其他段落的信息补进来，不凑数量：
{"dimensions":[${EDITORIAL_DIMENSIONS.map(name => `{"name":"${name}","score":80}`).join(',')}],"summary":"具体的阅读判断，包含长处与仍存问题","findings":[{"dimension":"plot_coherence","severity":"major","paragraphId":"C12","referenceId":"R3","problem":"具体问题及影响","suggestion":"具体修订方向"}],"continuityNotes":[{"fact":"人物/时间/地点/道具/信息来源/未解问题，保持事实与推测的区别","paragraphId":"C2"}]}`;
    let correction = '';
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.generateEditorial({
        taskType: 'review', systemPrompt,
        userPrompt: `【创作约束与前文，R编号】\n${labelEditorialParagraphs(reference, 'R')}\n\n【待审第${chapterIndex + 1}章完整正文，C编号】\n${labelEditorialParagraphs(content)}${correction}`,
        responseFormat: 'json', temperature: 0.2, maxTokens: 16384, thinking: true,
      });
      try {
        const assessment = parseEditorialAssessment(response.content, content, reference);
        const report: ChapterReviewReport = {
          ...assessment, novelId: this.novelId, chapter: chapterIndex,
          overallScore: Math.round(assessment.dimensions.reduce((sum, d) => sum + d.score, 0) / assessment.dimensions.length),
          suggestions: assessment.findings.map(f => f.suggestion), timestamp: new Date().toISOString(),
          contentFingerprint: textFingerprint(content), contextFingerprint: textFingerprint(reference),
          status: needsEditorialRevision(assessment) ? 'needs-revision' : 'reviewed',
        };
        if (options.persist !== false) this.saveReview(report);
        return report;
      } catch (error) {
        failure = error;
        this.repo.saveCustomData((options.persist === false ? 'chapter-candidate-review-failure:' : 'chapter-review-failure:') + chapterIndex, { contentFingerprint: textFingerprint(content), raw: response.content, error: String(error), timestamp: new Date().toISOString() });
        correction = `\n\n上次审稿校验失败：${String(error)}。只使用上面实际存在的C/R段落编号，确保六个维度齐全。没有依据的问题不要报告。`;
      }
    }
    throw failure instanceof Error ? failure : new Error('审稿未完成，正文保留为草稿');
  }

  async proposeRevision(chapterIndex: number, content: string, context: ChapterReviewContext, mode: 'polish' | 'rewrite' | 'expand' | 'review', report?: ChapterReviewReport): Promise<EditorialEdit[]> {
    const purposes = {
      polish: '改善不准确、重复、解释过多或节奏机械的语言，保留有辨识度的表达。',
      rewrite: '修正影响阅读的叙事与表达问题，保留事件、人物立场、有效细节和章末承接。',
      expand: '只补足缺失的动机、行动过程或对话反应，不为增加字数而补环境、身体反应和重复心理。',
      review: '逐条修复审稿发现的具体问题，不能引入新的事实矛盾。',
    };
    const response = await this.generateEditorial({
      taskType: 'rewrite', responseFormat: 'json', temperature: 0.35, maxTokens: 16384, thinking: true,
      systemPrompt: `你是小说责任编辑。${purposes[mode]}\n${NOVEL_WRITING_PRINCIPLES}
先通读本章与前文，独立判断审稿建议是否成立，再修复最影响内容的地方。审稿意见可能错漏，不要机械执行；优先动机与因果、实质推进、前后承接，再改语言。
同一个问题若涉及相邻多段，应一起改清行动、反应与后果。例如人物已把物件交出，后文再次使用前须有取回过程；已经讲过的调查过程再次转述，只保留接收者的新反应及其造成的变化。修改后核对范围前后的站位、道具、时间、信息来源与指代，不让局部修订产生新矛盾。
删掉冗余就是有效修订，无需用新比喻、更多环境或神秘动作补回字数。保留人物和作品本来的声音，不把全文改成整齐的短句或同一种腔调。不得靠增加错别字、随机口语、无关经历或替换同义词制造自然感。
提出最多12处有明确阅读收益的修改；没有值得采用的修改就返回空edits。paragraphId可用单段C12或连续范围C12-C15，最多连续20段。每处after替换所指范围的全部正文，保留范围内仍有效的事件与细节，可用空字符串删除冗余。各范围不得重叠，也不得同时对一个范围和其内部单段提出修改。
保持范围外的原文，不缩写整章、不丢结尾。不得修改原始故事约束，不能靠新增信物、失忆、幕后消息或超自然能力填补逻辑。reason说明具体问题和修改对阅读的帮助。只输出严格JSON：{"edits":[{"paragraphId":"C12-C15","after":"改后完整语段，段间保留换行","reason":"理由"}]}`,
      userPrompt: `${this.buildContext(chapterIndex, context)}\n\n【本章完整正文，C编号】\n${labelEditorialParagraphs(content)}\n\n【审稿问题】\n${report ? JSON.stringify(report.findings) : '请通读全文，找出最影响阅读的具体语段。'}`,
    });
    return parseEditorialEdits(response.content, content);
  }

  saveReview(report: ChapterReviewReport): void {
    const history = this.loadHistory();
    const index = history.findIndex(h => h.chapter === report.chapter);
    if (index >= 0) history[index] = report; else history.push(report);
    this.repo.saveCustomData('chapter-reviews', history);
  }
  loadHistory(): ChapterReviewReport[] { return this.repo.loadCustomData('chapter-reviews', []); }
  getLatestReview(): ChapterReviewReport | null {
    const history = this.loadHistory().sort((a, b) => a.chapter - b.chapter);
    return history[history.length - 1] ?? null;
  }
}

import { NarrativeRepository } from './narrative-repository';
import { providerRouter } from '@/services/providers';
import { useProviderStore } from '@/stores/providerStore';
import type { NovelChapter } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';
import { buildWritingContext, NOVEL_WRITING_PRINCIPLES, textFingerprint, type NovelWritingSource } from './writing-context';
import {
  EDITORIAL_DIMENSIONS, parseEditorialAssessment, needsEditorialRevision, parseEditorialEdits,
  labelEditorialParagraphs, parseOutlineAssessment, applyEditorialEdits, isReviewCurrent,
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

export type ChapterReviewStage = 'reviewingProse' | 'revisingProse' | 'reviewingRevision';
interface ChapterReviewTarget {
  chapter: Pick<NovelChapter, 'id' | 'order' | 'content'>;
  context: ChapterReviewContext;
}
interface ReviewDraftOptions {
  revisionFocus?: string;
  current: () => ChapterReviewTarget | undefined;
  reuseReview?: boolean;
  maxRevisionPasses?: number;
  applyRevision?: (content: string) => void;
  restoreFrom?: string;
  signal?: AbortSignal;
  onStage?: (stage: ChapterReviewStage) => void;
}

export class ChapterReviewer {
  private repo: NarrativeRepository;
  private readonly directEditorialRoutes = new Set<string>();
  constructor(private novelId: string) { this.repo = new NarrativeRepository(novelId); }

  private async generateEditorial(request: LLMGenerateRequest, signal?: AbortSignal) {
    const providers = useProviderStore.getState();
    const config = providers.config.llm;
    const route = JSON.stringify([providers.getActiveEndpoint('llm')?.id, config.defaultModel, config.models, request.taskType]);
    const preferred = request.thinking && this.directEditorialRoutes.has(route)
      ? { ...request, thinking: false }
      : request;
    const isTruncated = (error: unknown) => error instanceof Error && error.message.includes('LLM output was truncated at max_tokens=');
    const isTransportTimeout = (error: unknown) => (error instanceof Error && error.name === 'TimeoutError')
      || /^Request (cancelled|canceled|timed out)$/i.test(error instanceof Error ? error.message : String(error));
    const generateCompact = () => {
      signal?.throwIfAborted();
      const instruction = request.taskType === 'rewrite'
        ? '请只处理最严重的两处问题及直接依赖它们的段落，返回必要的局部编辑。'
        : '只报告最多三处有依据、最影响阅读的问题，并保留关键事实记录。';
      return providerRouter.generate({
        ...request,
        thinking: false,
        systemPrompt: request.systemPrompt + '\n上一次未能完成。' + instruction + '保持规定的 JSON 字段完整，尽量简短。',
      }, signal);
    };
    signal?.throwIfAborted();
    try {
      return await providerRouter.generate(preferred, signal);
    } catch (error) {
      if (error instanceof Error && /^LLM API error (502|503|504):/.test(error.message)) {
        signal?.throwIfAborted();
        await new Promise<void>(resolve => setTimeout(resolve, 1500));
        signal?.throwIfAborted();
        return providerRouter.generate(preferred, signal);
      }
      if (request.thinking && isTransportTimeout(error)) return generateCompact();
      const outputBudget = request.maxTokens ?? 16384;
      if (!isTruncated(error) || outputBudget >= 32768) throw error;
      signal?.throwIfAborted();
      try {
        // Reserve the shared output budget for the structured result while
        // keeping the full editorial brief and its supporting passages.
        const response = await providerRouter.generate({
          ...request, thinking: false, maxTokens: Math.min(outputBudget * 2, 32768),
        }, signal);
        if (request.thinking) this.directEditorialRoutes.add(route);
        return response;
      } catch (retryError) {
        if (request.thinking && (isTruncated(retryError) || isTransportTimeout(retryError))) return generateCompact();
        throw retryError;
      }
    }
  }

  buildContext(chapterIndex: number, context: ChapterReviewContext, purpose: 'writing' | 'review' = 'review', sceneFocus = '', fits?: (text: string) => boolean): string {
    const references = this.repo.loadWritingReferences();
    const plan = this.repo.loadGlobalPlan();
    const closesBook = !!plan?.chapters.length
      && chapterIndex === Math.max(...plan.chapters.map(chapter => chapter.order))
      && !context.chapters.some(chapter => chapter.order > chapterIndex);
    const ending = closesBook ? references.plotOutline?.ending || plan.ending : '';
    const focus = [sceneFocus, ending, context.outline].filter(Boolean).join('\n');
    const chapterBrief = (ending ? `\n\n【全书收尾，核对实际正文】\n预定结局：${ending}\n核对主角最终作了什么选择、承担什么后果，以及支撑核心答案的线索分别何时出现、由谁取得、怎样相互印证。回收可以已在前几章完成，无需在末章重复解释；缺了关键证据或选择才提出修订。` : '')
      + `\n\n【本章写作意图，不能当作正文已经实现】\n${context.outline || '未提供'} `;
    return buildWritingContext(context.source, this.repo.loadBible(), context.chapters, chapterIndex, this.loadHistory(), purpose, references, focus,
      fits && (text => fits(text + chapterBrief))) + chapterBrief;
  }

  async prepareOutline(chapterIndex: number, outline: string, context: ChapterReviewContext, options: { scope?: string; signal?: AbortSignal } = {}): Promise<string> {
    options.signal?.throwIfAborted();
    const writingContext = buildWritingContext(context.source, this.repo.loadBible(), context.chapters, chapterIndex, this.loadHistory(), 'writing', this.repo.loadWritingReferences(), outline);
    const reference = options.scope ? writingContext + '\n\n' + options.scope : writingContext;
    const contextFingerprint = textFingerprint(reference);
    const saved = this.repo.loadCustomData<{ ready: boolean; contextFingerprint: string; outlineFingerprint: string } | null>('chapter-outline:' + chapterIndex, null);
    if (saved?.ready && saved.contextFingerprint === contextFingerprint && saved.outlineFingerprint === textFingerprint(outline)) return outline;
    const request: LLMGenerateRequest = {
      taskType: 'review', responseFormat: 'json', temperature: 0.25, maxTokens: 12288, thinking: true,
      systemPrompt: `你是小说策划编辑，负责在正文写作前审读并修正章节方案。目标是好读、可信、确有推进的故事，而非符合模板的术语清单。
${NOVEL_WRITING_PRINCIPLES}
检查人物目标与已有处境是否相接，冒险、隐瞒、违规或退让是否有具体动机及相称的代价；不能把性格标签当行动理由。确认关键线索有可获得的来源，角色不会因大纲透露就提前知道答案。职业、空间与时间细节须符合故事规则和常识。区分普通异常与已知危险，不强迫人物恐慌或报警来增加紧张。
检查已有问题是否推进、场景是否改变处境；删除无变化的检查、来回搬动、装饰性景物和结尾突然闪现的人影等通用悬念。允许合理的等待、日常与心理，不能用动作配额或故作神秘替代内容。不要强制反转，不把伏笔暂未回收视为错误。
如果给出了本章与后续章节的安排，逐个核对拟写场景的归属。属于后续章节的行动、证据或揭示要从本章方案移除；本章该写的行动已在前文发生时，保留它对人物下一步选择造成的后果。
把每个关键结论反过来核对：证据的可见范围和取得条件是什么，是否仍有常见的其他解释；不要把未看见、无记录、物品表面状态等写成排除其他来源的证据。新线索可以发生，但须来自人物本次行动，不能凭空追加新痕迹或失联人物。不要重复前章已经经历的申请、拒绝、转述过程。先前人物的处理条件仍然有效，本章若违背须有明确动机和后果。
保留原始简介、作者本章意图和前文已发生事实。修正方案不能改前文、偷换核心谜题、额外塞入信物或未铺垫的关系。unresolvedIssues只列出阻止当前章节落笔的具体矛盾；留到后续查证的线索和悬念不属于此列。能写时ready=true，outline包含完整方案，unresolvedIssues为空。若关键矛盾无法在本章合理修正，ready=false并说明。
输出JSON：{"ready":true,"outline":"完整可写的修正大纲，约600～1000字；围绕重要场景说明人物目标、阻力、选择、后果及章末状态，不逐项规定比喻、手势和秒数","changes":["具体修正及阅读收益，没有则空数组"],"unresolvedIssues":[]}。不输出正文，不宣称文学质量达标。`,
      userPrompt: `${reference}\n\n【待审本章方案，是计划，不是已发生事实】\n${outline}`,
    };
    const response = await this.generateEditorial(request, options.signal);
    options.signal?.throwIfAborted();
    let result: ReturnType<typeof parseOutlineAssessment>;
    try {
      result = parseOutlineAssessment(response.content);
    } catch {
      const repaired = await this.generateEditorial({
        ...request,
        temperature: 0.1,
        userPrompt: request.userPrompt + '\n\n上次回复未通过格式检查。重新审读并只返回一个JSON对象，完整包含布尔值ready、字符串outline、字符串数组changes和unresolvedIssues。ready为true时outline必须有正文可用的完整大纲，unresolvedIssues必须为空数组。有阻止落笔的矛盾时返回ready=false并写明矛盾。不要输出代码围栏。',
      }, options.signal);
      options.signal?.throwIfAborted();
      result = parseOutlineAssessment(repaired.content);
    }
    if (!result.ready && options.scope && result.unresolvedIssues.length) {
      const replanned = await this.generateEditorial({
        ...request,
        userPrompt: request.userPrompt
          + '\n\n【阻止落笔的问题】\n' + JSON.stringify(result.unresolvedIssues)
          + '\n前一稿无法落笔。根据已写正文重新安排这一章，必须从前一章实际结尾之后继续。'
          + '原全书规划中的日期和拟写行动若与已写内容不符，可以改变本章安排，保留它在主线中的作用。'
          + '已发生的走访、问话、递件或取证只写产生的后果，不回到旧日期再演一次。'
          + '规划写过但正文未发生的事情不能算发生。若无需改变前文或提前揭示后续答案即可修正，给出完整新方案；若仍存在硬冲突，明确列出。',
      }, options.signal);
      options.signal?.throwIfAborted();
      result = parseOutlineAssessment(replanned.content);
    }
    this.repo.saveCustomData('chapter-outline:' + chapterIndex, { ...result, originalOutline: outline, contextFingerprint, outlineFingerprint: textFingerprint(result.outline), timestamp: new Date().toISOString() });
    if (!result.ready) throw new Error('大纲仍需调整：' + (result.unresolvedIssues.join('；') || '未形成可写方案'));
    return result.outline;
  }

  async reviewChapter(chapterIndex: number, content: string, context: ChapterReviewContext, options: {
    persist?: boolean;
    candidate?: boolean;
    previousFindings?: EditorialAssessment['findings'];
    revisionFocus?: string;
    signal?: AbortSignal;
  } = {}): Promise<ChapterReviewReport> {
    const reference = this.buildContext(chapterIndex, context);
    const factSources = [context.source.description,
      ...this.repo.loadBible().worldSettings.flatMap(setting => setting.constraints ?? []),
      ...Object.values(this.repo.loadWorldbuilding().dimensions.coreRules?.fields ?? {}),
      ...context.chapters.filter(chapter => chapter.order < chapterIndex).map(chapter => chapter.content),
    ];
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
若人物当场用照片、记录、信物或证词作出关键判断，核对正文是否写明取得过程，以及它确实包含人物声称看到的内容。比如只拍到包口的照片，不能直接用来辨认票面日期。已经用来推进剧情却缺少取得过程的，指出实际使用处和需要补足的动作，归为因果缺口；后续才会验证的证据可以暂留。
按场景先后核对关键知识：角色首次看到批注、听到证词或收到通知之前，不能把内容当成已知信息来决定行动。记录在手机、纸本或档案中时，核对后文重新使用的是否是同一份记录，并查找是否有明确的转抄或移交。收到新消息、角色转述、实际验证是不同事件。
必要的心理直述、平常的说明、人物在压力下偶尔反问，不违反“克制”或“冷静”。不要按旧文风公约或性格标签逐句执法；不得建议用捏手指、看窗外等无实质作用的动作替代清楚的心理。职业判断须有已提供的规则或可靠常识支持，不能臆造单位规章或断言照片等同实物鉴定。
每个问题必须用 paragraphId 指向本章对应段落（例如C12）；涉及连续多段可用C12-C15，最多连续20段。如声称前后冲突，referenceId须指向对照原文：本章其他段落用C编号（如C7），前文/设定用R编号（如R3）；其他问题填空字符串。两种编号不能混为同一范围。引用由系统从段落编号提取，你不要重新抄写或改写引文。问题需要解释读者为何受到影响，并给出具体修订方向。
每条用 basis 标记依据。conflict 表示两处明确的表述不能同时成立，currentEvidence 和 referenceEvidence 分别逐字摘录各自段落里直接冲突的短句。对照只采用本章、前文、作者原始约束或明确的世界规则。推演的方案只用来讨论叙事，不能证明事实矛盾。
只输出当前仍需处理的问题。如果意见本身认为当前文字已修复、两处可以同时成立、或者只是提醒保持现状，请省略该意见。“6月15日的日期戳是前一天晚上盖的”和“6月14日晚盖戳”表示同一晚，不能因为读者需要换算日期而判定事实冲突。
判断章间时序时，允许新章从上一章已完成的交接之后接着写。比如前章写完交件和返回，本章从“她回来后”开始，这两处一致。核对当前句是否明确倒置顺序、重复发生或改变状态，再判为冲突；省略已写的过程本身不用报，确需补一句定位时按叙事意见处理。并列句各自有明确宾语时按各自宾语理解，例如“按程序询问包的特征；日期不主动问”与“不主动问日期”一致。不能把读者可能联想到的事件写成正文已经发生的事实。
同一证人对同一次谈话给出相互排斥的版本时，核对正文是否把改口、隐瞒或记忆变化写成了情节。若正文未经交代就把两个版本都当作可靠依据，分别引用两处口供并按矛盾报告。证人可靠与否、访客身份是否属实仍可留待核实。用原文里的时间写法摘录证据，只有原文明确写出上午、晚上等时段时才换算成24小时制。
如认为正文混入报错、对话指令或写作标记，要引用C段中实际出现的字样。例如叙述把“第16章”写成人物行动或备忘录的来源时，要求改成故事内的时间或事件；角色读到真实存在的文件章节、条款和编号可以保留。行文像梗概、句子简短、R段有审读记录或上一轮发生接口错误，都不足以认定正文包含系统文字。仍可指出有原文依据的叙事和语言问题。
uncertain 表示读者需要核对的疑点，说明尚缺的事实。保留人物口供和推测的归属。举例：23点45分到站，“二十分钟前”是相对转述时间。文中未写转述时刻，就不能先假定23:55再宣布23:35来访；也不能把两个未确认身份的人算成同一人。勿为修复疑点补造精确时刻、距离、证词。craft 用于有明确阅读影响的结构和文字建议。
critical 用于有直接证据的硬事实矛盾或核心承诺被破坏，major 是影响阅读的因果、人物、节奏或语言问题，minor 是可选的局部改善。只在 summary 中写原文支持的阅读判断。
判断场景的作用时看人物获得的新信息是否改变后续行动、证据能否引用或者责任由谁承担。查清一条规则的适用边界并据此改变做法，可以完成一场戏；没有争吵、额外阻拦或明显损失，不是独立的 major 问题。若认为场景仍重复，指出前文已完成的同一行动和本章缺少的具体变化。
只输出严格 JSON，最多8个确有依据且按影响排序的问题。summary指出具体阅读效果，不泛泛称赞氛围或细腻。提取本章最多10条对后文重要的已发生事实或未解问题；每条只写所指段落直接支持的一件事，区分推测与确认，不能把设定、大纲或其他段落的信息补进来，不凑数量：
给每条续写记录标注 kind：clue 是原文出现的线索或未解问题，prop 是重要物件的来源、特征、归属或移交，world 是正文明确体现的长期规则或社会制度，event 是其他对后文重要的事件或人物关系。同一记录标注最直接相关的一类。道具记录应明确物件名和它在文中可核对的状态，例如“帆布包和车票由刘姐封袋后锁入铁皮柜”。用手机拍照是取证过程，应记作线索或事件；如果记录的是照片这份物证本身，应写清照片记下了什么、保存在何处或交给了谁。普通景物不属于世界规则，人物猜想不得写成结论。
续写记录可附 link。kind 为 relationship 时，两个端点必须是有明确称呼的人物，predicate 写出交接、拒绝、承诺或立场变化等具体行为。kind 为 fact 时，优先连接证词、记录、物件、地点或行动，predicate 保留信息来源与核实程度。subject 和 object 必须逐字出现在所指段落。只有同场、姓名提及或猜测时省略 link，不能推断身份或私交。
{"dimensions":[${EDITORIAL_DIMENSIONS.map(name => `{"name":"${name}","score":80}`).join(',')}],"summary":"具体的阅读判断，包含长处与仍存问题","findings":[{"dimension":"plot_coherence","severity":"major","basis":"craft","paragraphId":"C12","referenceId":"","currentEvidence":"","referenceEvidence":"","problem":"具体问题及影响","suggestion":"具体修订方向"}],"continuityNotes":[{"kind":"event","fact":"人物/时间/地点/道具/信息来源/未解问题，保持事实与推测的区别","paragraphId":"C2","link":{"kind":"fact","subject":"原文中的物件","predicate":"关联动作","object":"原文中的位置"}}]}`;
    const previousIssues = [...new Set(options.previousFindings?.filter(finding => needsEditorialRevision({ findings: [finding] }))
      .map(finding => finding.problem.replace(/\b[CR]\d+(?:[-–—][CR]?\d+)?\b/g, '旧稿段落')))];
    const revisionCheck = previousIssues.length
      ? '\n\n【复审需逐条核查的原稿与上轮改稿问题】\n'
        + '这些是旧稿意见，不能当作当前正文的事实。逐条在当前全文中重新查找。声称某行动没发生前，先通读整段场景，核对前后是否已经有同类行动，或是否已有交代为什么无法继续；不要仅凭某一段没写就判定全文没写。认为两处时间冲突时，分别核对时间和对应物件或动作是否为同一件事。修复成立时无需再报。问题仍存在时，按当前段号和证据重新报告。继续检查新引入的问题。\n'
        + JSON.stringify(previousIssues)
      : '';
    const focusCheck = options.revisionFocus
      ? '\n\n【作者要求复核的修改重点】\n' + options.revisionFocus + '\n根据当前正文逐条核对。这个要求不能作为已发生事实或问题证据。'
      : '';
    let correction = '';
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const invalidJson = failure instanceof SyntaxError;
      const response = await this.generateEditorial({
        taskType: 'review', systemPrompt: invalidJson ? systemPrompt + '\n直接输出 JSON 对象。首个非空白字符必须是 {。JSON 之外不得有读后感、说明或代码围栏。' : systemPrompt,
        userPrompt: `【创作约束与前文，R编号】\n${labelEditorialParagraphs(reference, 'R')}\n\n【待审第${chapterIndex + 1}章完整正文，C编号】\n${labelEditorialParagraphs(content)}${revisionCheck}${focusCheck}${correction}`,
        responseFormat: 'json', temperature: 0.2, maxTokens: 16384, thinking: !invalidJson,
      }, options.signal);
      options.signal?.throwIfAborted();
      try {
        const assessment = parseEditorialAssessment(response.content, content, reference, excerpt => factSources.some(source => source.includes(excerpt)));
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
        this.repo.saveCustomData((options.candidate ? 'chapter-candidate-review-failure:' : 'chapter-review-failure:') + chapterIndex, { contentFingerprint: textFingerprint(content), raw: response.content, error: String(error), timestamp: new Date().toISOString() });
        correction = `\n\n上次审稿校验失败：${String(error)}。只使用上面实际存在的C/R段落编号，确保六个维度齐全。没有依据的问题不要报告。`;
      }
    }
    throw failure instanceof Error ? failure : new Error('审稿未完成，正文保留为草稿');
  }

  async proposeRevision(chapterIndex: number, content: string, context: ChapterReviewContext, mode: 'polish' | 'rewrite' | 'expand' | 'review', report?: ChapterReviewReport, signal?: AbortSignal, revisionFocus = ''): Promise<EditorialEdit[]> {
    const findings = report?.findings.filter(finding => finding.basis !== 'uncertain');
    if (mode === 'review' && findings?.length === 0 && !revisionFocus) return [];
    const unresolvedQuestions = mode === 'review' ? report?.findings.filter(finding =>
      finding.basis === 'uncertain' && finding.severity !== 'minor').map(({ problem, quote, referenceQuote }) => ({
      problem, quote, referenceQuote,
    })) : undefined;
    const purposes = {
      polish: '改善不准确、重复、解释过多或节奏机械的语言，保留有辨识度的表达。',
      rewrite: '修正影响阅读的叙事与表达问题，保留事件、人物立场、有效细节和章末承接。',
      expand: '只补足缺失的动机、行动过程或对话反应，不为增加字数而补环境、身体反应和重复心理。',
      review: '逐条修复审稿发现的具体问题，不能引入新的事实矛盾。',
    };
    const request: LLMGenerateRequest = {
      taskType: 'rewrite', responseFormat: 'json', temperature: 0.35, maxTokens: 16384, thinking: true,
      systemPrompt: `你是小说责任编辑。${purposes[mode]}\n${NOVEL_WRITING_PRINCIPLES}
先通读本章与前文，独立判断审稿建议是否成立，再修复最影响内容的地方。审稿意见可能错漏，不要机械执行；优先动机与因果、实质推进、前后承接，再改语言。
改动取证过程前核对谁在场、谁说过什么、事件和转述分别何时发生。正文只给相对时间或证人估计时，保留其范围。缺少证据时可以让人物保留疑问或删去武断判断，不补造具体时刻、记录、权限或人物身份。
同一个问题若涉及相邻多段，应一起改清行动、反应与后果。例如人物已把物件交出，后文再次使用前须有取回过程；已经讲过的调查过程再次转述，只保留接收者的新反应及其造成的变化。修改后核对范围前后的站位、道具、时间、信息来源与指代，不让局部修订产生新矛盾。
同一条口供、物件状态或决定若在后文被引用，先列出本章所有依赖它的段落，再一起修改；删去一个无来源的细节后，人物的记录、推断和下一步行动也要随之修正。保留证词的归属、仍有效的说法与已明确标出的未核实状态。
如需修复人物照抄别人决定或场景原地打转，让人物实际比较眼前可行的做法、主动选择并承担已有情境下的后果。结尾用选择造成的新处境或下一步行动承接，不重复解释同一决定。
删掉冗余就是有效修订，无需用新比喻、更多环境或神秘动作补回字数。保留人物和作品本来的声音，不把全文改成整齐的短句或同一种腔调。不得靠增加错别字、随机口语、无关经历或替换同义词制造自然感。
提出最多12处有明确阅读收益的修改；没有值得采用的修改就返回空edits。paragraphId可用单段C12或连续范围C12-C15。改写最多连续20段。只有整块删除重复场景时，才能使用更长范围，并将after设为空字符串。每处after替换所指范围的全部正文，保留范围内仍有效的事件与细节。各范围不得重叠。
保持范围外的原文，不缩写整章、不丢结尾。不得修改原始故事约束，不能靠新增信物、失忆、幕后消息或超自然能力填补逻辑。reason说明具体问题和修改对阅读的帮助。只输出严格JSON：{"edits":[{"paragraphId":"C12-C15","after":"改后完整语段，段间保留换行","reason":"理由"}]}`,
      userPrompt: `${this.buildContext(chapterIndex, context)}\n\n【本章完整正文，C编号】\n${labelEditorialParagraphs(content)}\n\n【审稿问题】\n${findings?.length ? JSON.stringify(findings) : '请通读全文，找出最影响阅读的具体语段。'}${unresolvedQuestions?.length ? '\n\n【修订涉及这些段落时一并核对的疑点】\n只有原文能确认的问题才修改。保留合理的待查线索，不能补造证词或定论。\n' + JSON.stringify(unresolvedQuestions) : ''}`,
    };
    if (revisionFocus) {
      request.userPrompt += '\n\n【本轮修改重点】\n' + revisionFocus
        + '\n按此重点处理，连带修改直接受影响的段落，保留其余已成立的事实。';
    }
    const response = await this.generateEditorial(request, signal);
    signal?.throwIfAborted();
    try {
      return parseEditorialEdits(response.content, content);
    } catch (error) {
      const corrected = await this.generateEditorial({
        ...request, userPrompt: request.userPrompt + `\n\n上一份修订未通过校验（${String(error)}）。重出完整修订清单，先逐项核对段号、范围及是否重叠。`,
      }, signal);
      signal?.throwIfAborted();
      return parseEditorialEdits(corrected.content, content);
    }
  }

  async reviewDraft({ chapter, context }: ChapterReviewTarget, options: ReviewDraftOptions) {
    const { id, order, content } = chapter;
    const reference = this.buildContext(order, context);
    const checkCurrent = () => {
      options.signal?.throwIfAborted();
      const current = options.current();
      if (!current || current.chapter.order !== order || current.chapter.content !== content
        || this.buildContext(order, current.context) !== reference) {
        throw new Error('正文或创作依据在审读期间已改变，请重新审读。');
      }
    };
    checkCurrent();

    let report = options.reuseReview
      ? this.loadHistory().find(item => item.chapter === order && isReviewCurrent(item, content, reference))
      : undefined;
    if (!report) {
      options.onStage?.('reviewingProse');
      report = await this.reviewChapter(order, content, context, { persist: false, signal: options.signal });
      checkCurrent();
      this.saveReview(report);
    }
    const revisionFocus = options.revisionFocus?.trim() ?? '';
    if (!options.applyRevision) return { content, report, revised: false };

    const beforeFingerprint = textFingerprint(content);
    const contextFingerprint = textFingerprint(reference);
    const candidateKey = 'chapter-revision-candidate:' + id;
    const pendingKey = 'chapter-revision-pending:' + id;
    const unreviewed = options.reuseReview ? this.loadPendingRevision(id, content, reference) : null;
    let pending = unreviewed && (!revisionFocus || revisionFocus === unreviewed.revisionFocus) ? unreviewed : null;
    if (!pending && report.status !== 'needs-revision' && !revisionFocus) return { content, report, revised: false };
    const reusable = options.reuseReview ? this.loadCurrentRevisionCandidate(id, content, reference) : null;
    let candidate = reusable?.content ?? content;
    let candidateReview = reusable?.review ?? report;
    for (let pass = 0; pass < (options.maxRevisionPasses ?? 1); pass++) {
      if (!pending && candidateReview.status === 'reviewed' && (pass > 0 || !revisionFocus)) break;
      if (!pending) {
        options.onStage?.('revisingProse');
        const edits = await this.proposeRevision(order, candidate, context, 'review', candidateReview, options.signal, revisionFocus);
        checkCurrent();
        if (!edits.length) break;
        const revised = applyEditorialEdits(candidate, edits);
        if (revised === candidate || revised === content) break;
        pending = { beforeFingerprint, contextFingerprint, content: revised, edits, revisionFocus };
        this.repo.saveCustomData(pendingKey, pending);
      }
      options.onStage?.('reviewingRevision');
      candidateReview = await this.reviewChapter(order, pending.content, context, {
        persist: false, candidate: true, previousFindings: candidateReview.findings, revisionFocus: pending.revisionFocus, signal: options.signal,
      });
      checkCurrent();
      candidate = pending.content;
      this.repo.saveCustomData(candidateKey, { beforeFingerprint, content: candidate, edits: pending.edits, review: candidateReview, timestamp: new Date().toISOString() });
      this.repo.saveCustomData(pendingKey, null);
      pending = null;
    }
    if (candidateReview.status !== 'reviewed' || candidate === content) return { content, report, revised: false };

    this.saveRevisionBackup(id, options.restoreFrom || content, candidate);
    options.applyRevision(candidate);
    this.saveReview(candidateReview);
    return { content: candidate, report: candidateReview, revised: true };
  }

  loadPendingRevision(chapterId: string, content: string, reference: string) {
    const saved = this.repo.loadCustomData<{
      beforeFingerprint: string; contextFingerprint: string; content: string; edits: EditorialEdit[]; revisionFocus?: string;
    } | null>('chapter-revision-pending:' + chapterId, null);
    return saved?.beforeFingerprint === textFingerprint(content) && saved.contextFingerprint === textFingerprint(reference) ? saved : null;
  }

  loadCurrentRevisionCandidate(chapterId: string, content: string, reference: string) {
    const saved = this.repo.loadCustomData<{ beforeFingerprint: string; content: string; review: ChapterReviewReport } | null>(
      'chapter-revision-candidate:' + chapterId, null,
    );
    return saved?.beforeFingerprint === textFingerprint(content) && isReviewCurrent(saved.review, saved.content, reference)
      ? saved : null;
  }

  saveRevisionBackup(chapterId: string, before: string, after: string): void {
    if (before && before !== after) this.repo.saveCustomData('chapter-revision:' + chapterId,
      { before, afterFingerprint: textFingerprint(after), timestamp: new Date().toISOString() });
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

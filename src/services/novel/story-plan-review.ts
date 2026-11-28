import { providerRouter } from '@/services/providers';
import { NOVEL_WRITING_PRINCIPLES } from './writing-context';
import { generatePlanningResponse } from './planning-generation';
import { applyStoryPlanAssessment, InvalidStoryPlanEdits, UnresolvedStoryPlan } from './story-plan-contract';
import { labelEditorialParagraphs } from './editorial-review';
import { parseStoryPlanSectionReview, type StoryPlanText } from './story-plan-section';

export async function reviewStoryPlanSection(text: StoryPlanText, context: string, signal?: AbortSignal) {
  const fields = Object.entries(text).map(([field, value]) => [field, labelEditorialParagraphs(value)]);
  const schema = { findings: [{ field: fields[0][0], paragraphId: 'C1', referenceId: 'R1', reason: '具体问题与原因', replacement: '完整替换语段' }] };
  const ask = (correction = '') => generatePlanningResponse(maxTokens => providerRouter.generate({
    taskType: 'review', responseFormat: 'json', temperature: 0.2, maxTokens, thinking: false, timeoutMs: 180_000,
    systemPrompt: '你是小说责编，负责局部情节审读。仅检查提供的待审字段。对照作者设定、范文提炼、已写章节和全书方案，区别事实、人物推测和未写计划。先跨段核对同一关键道具在哪里遗失、在哪里被发现，中间是否有可追溯的移动过程。再检查时间、人物动机、信息来源及其他因果。若一段有多处可修问题，合并成一条替换并说明各处修改，保留无关内容。没有把握时把疑问说清楚，replacement 用 null。没有问题时返回空数组。引用待审字段内真实的 C 段落编号和依据中的 R 段落编号。只有问题能由本段独立说明时，referenceId 才可为空。段落标签只用于定位，replacement 只写大纲文字。避免重叠修改。最多六项。只返回严格 JSON。',
    userPrompt: ['【对照依据】', labelEditorialParagraphs(context, 'R'), '【待审字段】',
      JSON.stringify(Object.fromEntries(fields)), 'JSON 格式示例', JSON.stringify(schema), correction].join('\n\n'),
  }, signal), 4096);
  const response = await ask();
  try {
    return parseStoryPlanSectionReview(response.content, text, context);
  } catch (error) {
    const corrected = await ask('上次审读无法定位修改。' + String(error) + '。请使用已提供的字段与段落编号，再返回一次完整 JSON。');
    return parseStoryPlanSectionReview(corrected.content, text, context);
  }
}

export async function reviewStoryPlan(context: string, plan: string, signal?: AbortSignal) {
  // Reserve the model's output budget for the proposed edits.
  const ask = (draft: string, correction = '') => generatePlanningResponse(maxTokens => providerRouter.generate({
    taskType: 'review', responseFormat: 'json', temperature: 0.25, maxTokens, thinking: false,
    timeoutMs: 360_000,
    systemPrompt: `你是小说情节编辑，在正文动笔前审读整部故事方案。目标是值得读下去、人物可信、因果成立的故事；不是用评分替代阅读，也不是承诺签约或通过AI检测。
${NOVEL_WRITING_PRINCIPLES}
先检查故事的独特看点和读者期待是否清楚，开篇是否进入人物真正的处境。主角要有具体欲望与难以两全的选择；配角有自己的利益、认知和行动，不能只当线索发放员。人物关系随事件改变，不只重复性格标签或口头禅。
沿全书事件核对时间、年龄、日期、距离、道具数量与归属。结局必须解释原始问题，不能为煽情改写购票/死亡日期，为悬念在“只有一件物品”的包里加信物，或升级成无关阴谋。线索要有取得条件；“可以查证”不能代替实际证据，不能凭没证件、没被看到、登记缺项就认定唯一动机或答案。
检查中段是否反复询问、查监控、解释同一线索，是否只换地点而处境不变。事件之间靠人物行动及其后果连接；重大揭示应有铺垫和验证，高潮由此前的选择造成，并留下相称后果。允许安静和余味，不强制每章反转或悬崖结尾。
资料中的AI推演是可修改的设计，不是已证实事实；原始简介和既有正文优先。现实制度、职业流程、医疗和法律说法不能凭空当成行业规则；必要的虚构背景应作为本书设定，仍要说明人物为何能取得记录、调用资源或改变流程。
修订未写的方案，保留题材与作者意图，不修改已写事实。不要用增加微表情、句式配额、替换普通词语来冒充情节改进。没有实质收益就保留原文。先按本次 edits 生效后的方案判断 ready。只有无法在未写大纲中修复、会阻止落笔的矛盾才列入 unresolvedIssues 并设 ready=false。主动保留的悬念、是否展开的背景、已修正的问题和可以留给正文的衔接细节不列入。
输出严格 JSON：{"ready":true,"edits":[{"path":["stages",0,"description"],"replacement":"修订后的完整字段文字","reason":"说明具体改动及其阅读收益"}],"unresolvedIssues":[]}。
系统会将 edits 中的替换文字直接写入大纲。path 从待审方案根节点起，数组位置从 0 开始，每条定位到一个现有文字字段。每个字段最多修订一次。连同结局、阶段描述、关键事件或章节大纲中受同一改动影响的文字一起修订。保留原有章节范围、顺序和数组数量。无需修改时返回空 edits。`,
    userPrompt: `【创作依据，原始简介与正文优先】\n${context}${correction}\n\n【待审全书方案，尚未发生】\n${draft}`,
  }, signal), 16384);
  const response = await ask(plan);
  try {
    return applyStoryPlanAssessment(response.content, plan);
  } catch (error) {
    if (error instanceof UnresolvedStoryPlan) {
      const draft = JSON.stringify(error.candidate.plan);
      const repaired = await ask(draft, `\n\n以下是上轮仍需核查的问题。请针对当前候选方案修订并复核。已经解决的事项从待修清单移除。\n${error.message}`);
      const result = applyStoryPlanAssessment(repaired.content, draft);
      return { plan: result.plan, changes: [...error.candidate.changes, ...result.changes] };
    }
    if (!(error instanceof InvalidStoryPlanEdits)) throw error;
    const corrected = await ask(plan, `\n\n上次修订未通过格式检查。原因如下。\n${error.message}\n请从这份待审方案重新生成一份完整的修订列表，使用实际存在的字段与从 0 开始的数组位置。同一字段的改动请合并到一条。`);
    return applyStoryPlanAssessment(corrected.content, plan);
  }
}

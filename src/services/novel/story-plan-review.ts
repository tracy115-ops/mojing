import { providerRouter } from '@/services/providers';
import { NOVEL_WRITING_PRINCIPLES } from './writing-context';
import { generatePlanningResponse } from './planning-generation';
import { parseStoryPlanAssessment } from './story-plan-contract';

export async function reviewStoryPlan(context: string, plan: string, signal?: AbortSignal) {
  const response = await generatePlanningResponse(maxTokens => providerRouter.generate({
    taskType: 'review', responseFormat: 'json', temperature: 0.25, maxTokens, thinking: true,
    systemPrompt: `你是小说情节编辑，在正文动笔前审读整部故事方案。目标是值得读下去、人物可信、因果成立的故事；不是用评分替代阅读，也不是承诺签约或通过AI检测。
${NOVEL_WRITING_PRINCIPLES}
先检查故事的独特看点和读者期待是否清楚，开篇是否进入人物真正的处境。主角要有具体欲望与难以两全的选择；配角有自己的利益、认知和行动，不能只当线索发放员。人物关系随事件改变，不只重复性格标签或口头禅。
沿全书事件核对时间、年龄、日期、距离、道具数量与归属。结局必须解释原始问题，不能为煽情改写购票/死亡日期，为悬念在“只有一件物品”的包里加信物，或升级成无关阴谋。线索要有取得条件；“可以查证”不能代替实际证据，不能凭没证件、没被看到、登记缺项就认定唯一动机或答案。
检查中段是否反复询问、查监控、解释同一线索，是否只换地点而处境不变。事件之间靠人物行动及其后果连接；重大揭示应有铺垫和验证，高潮由此前的选择造成，并留下相称后果。允许安静和余味，不强制每章反转或悬崖结尾。
资料中的AI推演是可修改的设计，不是已证实事实；原始简介和既有正文优先。现实制度、职业流程、医疗和法律说法不能凭空当成行业规则；必要的虚构背景应作为本书设定，仍要说明人物为何能取得记录、调用资源或改变流程。
修订未写的方案，保留题材与作者意图，不修改已写事实。不要用增加微表情、句式配额、替换普通词语来冒充情节改进。没有实质收益就保留原文。不能修复时ready=false，说明具体矛盾，禁止假装已解决。
输出严格JSON：{"ready":true,"plan":{完整修订方案，保持待审方案的字段结构、章节编号及数量},"changes":["具体修改及其阅读收益，无则空数组"],"unresolvedIssues":[]}。plan不可缺省或只返回改动片段。`,
    userPrompt: `【创作依据，原始简介与正文优先】\n${context}\n\n【待审全书方案，尚未发生】\n${plan}`,
  }, signal), 16384);
  return parseStoryPlanAssessment(response.content);
}

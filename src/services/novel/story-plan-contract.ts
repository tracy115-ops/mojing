import { parseLLMJson } from './llm-json.ts';

export interface StoryPlanAssessment {
  ready: boolean;
  plan: Record<string, unknown>;
  changes: string[];
  unresolvedIssues: string[];
}

export function parseStoryPlanAssessment(text: string): StoryPlanAssessment {
  const result = parseLLMJson<StoryPlanAssessment>(text);
  if (!result || typeof result.ready !== 'boolean' || !Array.isArray(result.changes) || !Array.isArray(result.unresolvedIssues)
    || [...result.changes, ...result.unresolvedIssues].some(value => typeof value !== 'string' || !value.trim())) throw new Error('全书情节审读结果不完整，未采用新方案。');
  if (!result.ready || result.unresolvedIssues.length) throw new Error('全书情节仍需调整：' + (result.unresolvedIssues.join('；') || '未形成可写方案'));
  if (!result.plan || typeof result.plan !== 'object' || Array.isArray(result.plan)) throw new Error('全书情节审读没有返回完整方案。');
  return result;
}

export function validateWizardPlot(plan: Record<string, unknown>): void {
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();
  if (!nonempty(plan.mainPlot) || !nonempty(plan.ending) || !Array.isArray(plan.stages) || !plan.stages.length
    || plan.stages.some(stage => !stage || !nonempty(stage.description) || !nonempty(stage.coreEvent))) throw new Error('剧情总纲缺少主线、结局或阶段事件，未采用不完整方案。');
}

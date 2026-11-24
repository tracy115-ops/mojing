import { parseLLMJson } from './llm-json.ts';

interface StoryPlanAssessment {
  ready: boolean;
  edits: { path: (string | number)[]; replacement: string; reason: string }[];
  unresolvedIssues: string[];
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

const readField = (object: unknown, key: string): unknown =>
  object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    ? (object as Record<string, unknown>)[key]
    : undefined;

export function applyStoryPlanAssessment(text: string, draft: string) {
  const result = parseLLMJson<StoryPlanAssessment>(text);
  if (!result || typeof result.ready !== 'boolean' || !Array.isArray(result.edits) || !Array.isArray(result.unresolvedIssues)
    || !result.unresolvedIssues.every(nonempty)) throw new Error('全书情节审读结果不完整，未采用新方案。');
  if (!result.ready || result.unresolvedIssues.length) throw new Error('全书情节仍需调整：' + (result.unresolvedIssues.join('；') || '未形成可写方案'));
  const plan = parseLLMJson(draft);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('待审全书方案格式不完整。');

  const changes: string[] = [];
  const editedFields = new Set<string>();
  for (const edit of result.edits) {
    if (!edit || !Array.isArray(edit.path) || !edit.path.length || !edit.path.every(key => nonempty(key) || Number.isSafeInteger(key))
      || !nonempty(edit.replacement) || !nonempty(edit.reason)) throw new Error('全书情节修订缺少位置、修改后文字或理由。');
    const path = edit.path.map(String);
    const field = JSON.stringify(path);
    const key = path.pop()!;
    const parent = path.reduce<unknown>(readField, plan);
    const before = readField(parent, key);
    if (editedFields.has(field) || typeof before !== 'string' || before.trim() === edit.replacement.trim()) {
      throw new Error('全书情节修订未能应用到对应文字：' + edit.path.join(' → '));
    }
    (parent as Record<string, unknown>)[key] = edit.replacement.trim();
    editedFields.add(field);
    changes.push(edit.reason.trim());
  }
  return { plan, changes };
}

export function validateWizardPlot(plan: Record<string, unknown>): void {
  if (!nonempty(plan.mainPlot) || !nonempty(plan.ending) || !Array.isArray(plan.stages) || !plan.stages.length
    || plan.stages.some(stage => !stage || !nonempty(stage.description) || !nonempty(stage.coreEvent))) throw new Error('剧情总纲缺少主线、结局或阶段事件，未采用不完整方案。');
}

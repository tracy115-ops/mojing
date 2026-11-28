import { applyEditorialEdits, resolveEditorialCitation } from './editorial-review.ts';
import { parseLLMJson } from './llm-json.ts';
import type { AuthorPlotOutline } from './writing-context.ts';

export type StoryPlanSectionId = 'main' | 'ending' | number;
export type StoryPlanText = Record<string, string>;

export function readStoryPlanSection(plan: AuthorPlotOutline, id: StoryPlanSectionId): StoryPlanText | null {
  if (id === 'main') return { mainPlot: plan.mainPlot ?? '', coreConflict: plan.coreConflict ?? '', themeMessage: plan.themeMessage ?? '' };
  if (id === 'ending') return { ending: plan.ending ?? '' };
  const stage = plan.stages?.[id];
  return stage ? { description: stage.description ?? '', coreEvent: stage.coreEvent ?? '' } : null;
}

export function writeStoryPlanSection(plan: AuthorPlotOutline, id: StoryPlanSectionId, text: StoryPlanText): AuthorPlotOutline {
  if (id === 'main') return { ...plan, mainPlot: text.mainPlot, coreConflict: text.coreConflict, themeMessage: text.themeMessage };
  if (id === 'ending') return { ...plan, ending: text.ending };
  return { ...plan, stages: plan.stages?.map((stage, index) => index === id
    ? { ...stage, description: text.description, coreEvent: text.coreEvent }
    : stage) };
}

export interface StoryPlanFinding {
  field: string;
  before: string;
  replacement: string | null;
  evidence: string;
  reason: string;
}

export interface StoryPlanSectionReview {
  findings: StoryPlanFinding[];
  revised: StoryPlanText;
}

export function parseStoryPlanSectionReview(raw: string, text: StoryPlanText, context: string): StoryPlanSectionReview {
  const result = parseLLMJson<{ findings?: unknown[] }>(raw);
  if (!Array.isArray(result?.findings) || result.findings.length > 6) throw new Error('审读须返回至多六处可定位的问题');

  const findings = result.findings.map(input => {
    const item = input as { field?: unknown; paragraphId?: unknown; referenceId?: unknown; replacement?: unknown; reason?: unknown } | null;
    if (!item || typeof item.field !== 'string' || !Object.prototype.hasOwnProperty.call(text, item.field)
      || typeof item.reason !== 'string' || !item.reason.trim() || typeof item.referenceId !== 'string'
      || (typeof item.replacement !== 'string' && item.replacement !== null)) throw new Error('审读问题缺少本段位置、修改意见或依据编号');
    const before = resolveEditorialCitation(text[item.field], item.paragraphId);
    const evidence = item.referenceId ? resolveEditorialCitation(context, item.referenceId, 'R') : '';
    const replacement = item.replacement?.replace(/^\[C[1-9]\d*\][ \t]*\r?\n/gm, '') ?? null;
    return { field: item.field, before, evidence, reason: item.reason.trim(),
      replacement: replacement === before ? null : replacement };
  });

  const revised = { ...text };
  for (const field of Object.keys(revised)) {
    const edits = findings.flatMap(finding => finding.field === field && finding.replacement !== null
      ? [{ before: finding.before, after: finding.replacement, reason: finding.reason }]
      : []);
    if (edits.length) revised[field] = applyEditorialEdits(text[field], edits);
  }
  return { findings, revised };
}

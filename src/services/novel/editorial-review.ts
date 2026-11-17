export const EDITORIAL_DIMENSIONS = [
  'premise_fidelity', 'character_consistency', 'timeline_consistency',
  'plot_coherence', 'foreshadowing_usage', 'voice_quality',
] as const;
export type EditorialDimension = typeof EDITORIAL_DIMENSIONS[number];
export interface EditorialFinding {
  dimension: EditorialDimension;
  severity: 'minor' | 'major' | 'critical';
  quote: string;
  referenceQuote: string;
  problem: string;
  suggestion: string;
}
export interface EditorialEdit { before: string; after: string; reason: string }
export interface EditorialAssessment {
  dimensions: Array<{ name: string; score: number; issues: string[] }>;
  summary: string;
  findings: EditorialFinding[];
  continuityNotes: Array<{ fact: string; quote: string }>;
}

export function parseOutlineAssessment(raw: string): { ready: boolean; outline: string; changes: string[]; unresolvedIssues: string[] } {
  const value = record(JSON.parse(raw));
  if (typeof value.ready !== 'boolean' || typeof value.outline !== 'string'
    || !Array.isArray(value.changes) || !value.changes.every(s => typeof s === 'string')
    || !Array.isArray(value.unresolvedIssues) || !value.unresolvedIssues.every(s => typeof s === 'string' && s.trim())
    || (value.ready && (!value.outline.trim() || value.unresolvedIssues.length))) throw new Error('大纲审读结果不完整或仍有未解决的问题');
  return { ready: value.ready, outline: value.outline, changes: value.changes, unresolvedIssues: value.unresolvedIssues };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('审稿结果不是有效对象');
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('审稿缺少必要文字或原文依据');
  return value;
}

export function editorialParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}
export function labelEditorialParagraphs(text: string, prefix = 'C'): string {
  return editorialParagraphs(text).map((p, i) => `[${prefix}${i + 1}]\n${p}`).join('\n\n');
}
export function resolveEditorialParagraph(text: string, id: unknown, prefix = 'C'): string {
  if (typeof id !== 'string' || !new RegExp(`^${prefix}[1-9]\\d*$`).test(id)) throw new Error('审稿段落编号无效');
  const paragraph = editorialParagraphs(text)[Number(id.slice(1)) - 1];
  if (!paragraph) throw new Error('审稿引用了未提供的段落');
  return paragraph;
}

/** Reject invented evidence and incomplete scores rather than reporting a false pass. */
export function parseEditorialAssessment(raw: string, content: string, context: string): EditorialAssessment {
  const value = record(JSON.parse(raw));
  if (!Array.isArray(value.dimensions) || value.dimensions.length !== EDITORIAL_DIMENSIONS.length || !Array.isArray(value.findings) || !Array.isArray(value.continuityNotes)) throw new Error('审稿维度或事实记录不完整');
  const dimensions = EDITORIAL_DIMENSIONS.map(name => {
    const matches = (value.dimensions as unknown[]).map(record).filter(d => d.name === name);
    if (matches.length !== 1 || typeof matches[0].score !== 'number' || !Number.isFinite(matches[0].score) || matches[0].score < 0 || matches[0].score > 100) throw new Error(`审稿缺少有效评分：${name}`);
    return { name, score: matches[0].score, issues: [] as string[] };
  });
  const findings = value.findings.map(input => {
    const f = record(input);
    if (!EDITORIAL_DIMENSIONS.includes(f.dimension as EditorialDimension) || !['minor', 'major', 'critical'].includes(String(f.severity))) throw new Error('审稿问题分类无效');
    const quote = f.paragraphId ? resolveEditorialParagraph(content, f.paragraphId) : nonempty(f.quote);
    const referenceQuote = f.referenceId ? resolveEditorialParagraph(context, f.referenceId, 'R') : typeof f.referenceQuote === 'string' ? f.referenceQuote : '';
    if (!content.includes(quote) || (referenceQuote && !context.includes(referenceQuote))) throw new Error('审稿引用无法对应提供的原文或前文');
    return { dimension: f.dimension as EditorialDimension, severity: f.severity as EditorialFinding['severity'], quote, referenceQuote, problem: nonempty(f.problem), suggestion: nonempty(f.suggestion) };
  });
  const continuityNotes = value.continuityNotes.map(input => {
    const note = record(input);
    const quote = note.paragraphId ? resolveEditorialParagraph(content, note.paragraphId) : nonempty(note.quote);
    if (!content.includes(quote)) throw new Error('章后事实引用无法对应正文');
    return { fact: nonempty(note.fact), quote };
  });
  for (const d of dimensions) d.issues = findings.filter(f => f.dimension === d.name).map(f => `${f.problem}（原文：${f.quote}）`);
  return { dimensions, findings, continuityNotes, summary: nonempty(value.summary) };
}

/** Exact, non-overlapping edits preserve every unedited character, including the ending. */
export function applyEditorialEdits(content: string, edits: EditorialEdit[]): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > 12) throw new Error('修订必须包含 1～12 处具体修改');
  const spans = edits.map(edit => {
    if (!edit || typeof edit.before !== 'string' || !edit.before || typeof edit.after !== 'string' || !edit.reason?.trim()) throw new Error('修订缺少原文、改文或理由');
    const start = content.indexOf(edit.before);
    if (start < 0 || content.indexOf(edit.before, start + 1) >= 0) throw new Error('修订原文不存在或出现多次，请提供唯一的完整语段');
    return { start, end: start + edit.before.length, edit };
  }).sort((a, b) => a.start - b.start);
  if (spans.some((span, i) => i > 0 && span.start < spans[i - 1].end)) throw new Error('修订语段相互重叠');
  let result = content;
  for (const span of spans.reverse()) result = result.slice(0, span.start) + span.edit.after + result.slice(span.end);
  if (!result.trim()) throw new Error('修订不能清空章节');
  return result;
}

export function needsEditorialRevision(assessment: EditorialAssessment): boolean {
  return assessment.findings.some(f => f.severity !== 'minor') || assessment.dimensions.some(d => d.score < 65);
}

import { textFingerprint } from './writing-context.ts';

export const EDITORIAL_DIMENSIONS = [
  'premise_fidelity', 'character_consistency', 'timeline_consistency',
  'plot_coherence', 'foreshadowing_usage', 'voice_quality',
] as const;
export type EditorialDimension = typeof EDITORIAL_DIMENSIONS[number];
export interface EditorialFinding {
  dimension: EditorialDimension;
  severity: 'minor' | 'major' | 'critical';
  basis?: 'conflict' | 'uncertain' | 'craft';
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

/** Resolve a single paragraph or adjacent paragraphs without changing source separators. */
export function resolveEditorialCitation(text: string, id: unknown, prefix = 'C'): string {
  if (typeof id !== 'string') throw new Error('审稿段落编号无效');
  const match = new RegExp(`^${prefix}([1-9]\\d*)(?:-${prefix}([1-9]\\d*))?$`).exec(id);
  if (!match) throw new Error('审稿段落编号无效');
  const start = Number(match[1]), end = Number(match[2] || match[1]);
  const paragraphs = editorialParagraphs(text);
  if (start > end || end - start >= 20) throw new Error('审稿引用范围无效，最多连续20段');
  if (!paragraphs[start - 1] || !paragraphs[end - 1]) throw new Error('审稿引用了未提供的段落');
  let offset = 0, from = 0, to = 0;
  for (let i = 0; i < end; i++) {
    const position = text.indexOf(paragraphs[i], offset);
    if (i === start - 1) from = position;
    offset = position + paragraphs[i].length;
    to = offset;
  }
  return text.slice(from, to);
}

export function isReviewCurrent(report: { contentFingerprint?: string; contextFingerprint?: string } | null | undefined, content: string, context: string): boolean {
  return !!report && report.contentFingerprint === textFingerprint(content) && report.contextFingerprint === textFingerprint(context);
}

function clockTimes(text: string): string[] {
  return Array.from(text.normalize('NFKC').matchAll(/\b([01]?\d|2[0-3])\s*[:点时]\s*([0-5]\d)(?!\d)/g),
    ([, hour, minute]) => `${Number(hour)}:${minute}`);
}

/** Keep unsupported comparisons visible for the author without treating them as errors. */
export function parseEditorialAssessment(
  raw: string, content: string, context: string,
  isFactReference?: (excerpt: string) => boolean,
): EditorialAssessment {
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
    const quote = f.paragraphId ? resolveEditorialCitation(content, f.paragraphId) : nonempty(f.quote);
    const referencePrefix = typeof f.referenceId === 'string' && f.referenceId.startsWith('C') ? 'C' : 'R';
    const referenceSource = referencePrefix === 'C' ? content : context;
    const referenceQuote = f.referenceId ? resolveEditorialCitation(referenceSource, f.referenceId, referencePrefix) : typeof f.referenceQuote === 'string' ? f.referenceQuote : '';
    if (!content.includes(quote) || (referenceQuote && !referenceSource.includes(referenceQuote))) throw new Error('审稿引用无法对应提供的原文或前文');
    const problem = nonempty(f.problem);
    const severity = f.severity as EditorialFinding['severity'];
    let basis: EditorialFinding['basis'] = f.basis === 'uncertain' ? 'uncertain' : 'craft';
    if (f.basis === 'conflict' || (severity === 'critical' && basis !== 'uncertain')) {
      const currentEvidence = typeof f.currentEvidence === 'string' ? f.currentEvidence.trim() : '';
      const referenceEvidence = typeof f.referenceEvidence === 'string' ? f.referenceEvidence.trim() : '';
      const supported = currentEvidence && referenceEvidence && currentEvidence !== referenceEvidence
        && quote.includes(currentEvidence) && referenceQuote.includes(referenceEvidence)
        && (referencePrefix === 'C' || (isFactReference?.(referenceEvidence) ?? true));
      basis = supported ? 'conflict' : 'uncertain';
    }
    if (f.dimension === 'timeline_consistency') {
      const citedClocks = new Set(clockTimes(`${quote}\n${referenceQuote}`));
      if (clockTimes(problem).some(time => !citedClocks.has(time))) basis = 'uncertain';
    }
    return { dimension: f.dimension as EditorialDimension, severity: basis === 'conflict' ? 'critical' : severity, basis, quote, referenceQuote, problem, suggestion: nonempty(f.suggestion) };
  });
  const continuityNotes = value.continuityNotes.map(input => {
    const note = record(input);
    const quote = note.paragraphId ? resolveEditorialCitation(content, note.paragraphId) : nonempty(note.quote);
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

/** Resolve model-selected paragraph spans against the actual draft before preview or adoption. */
export function parseEditorialEdits(raw: string, content: string): EditorialEdit[] {
  const value = record(JSON.parse(raw));
  if (!Array.isArray(value.edits)) throw new Error('修订结果缺少具体段落');
  if (!value.edits.length) return [];
  const edits = value.edits.map(input => {
    const edit = record(input);
    return {
      before: edit.paragraphId ? resolveEditorialCitation(content, edit.paragraphId) : nonempty(edit.before),
      after: typeof edit.after === 'string' ? edit.after : nonempty(edit.after),
      reason: nonempty(edit.reason),
    };
  });
  applyEditorialEdits(content, edits);
  return edits;
}

export function needsEditorialRevision(assessment: EditorialAssessment): boolean {
  return assessment.findings.some(f => f.basis === 'conflict' || (f.severity !== 'minor' && f.basis !== 'uncertain'));
}

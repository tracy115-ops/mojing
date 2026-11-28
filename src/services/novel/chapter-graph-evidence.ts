import type { RelationshipTriple } from '@/types/narrative';

export interface ChapterGraphLink {
  kind: 'relationship' | 'fact';
  subject: string;
  predicate: string;
  object: string;
}

export interface ChapterGraphEdge extends RelationshipTriple {
  evidence: { fact: string; quote: string; pending: boolean };
}

export function parseChapterGraphLink(value: unknown, quote: string): ChapterGraphLink | undefined {
  if (!value || typeof value !== 'object') return;
  const { kind, subject, predicate, object } = value as Record<string, unknown>;
  if (kind !== 'relationship' && kind !== 'fact') return;
  if (typeof subject !== 'string' || typeof predicate !== 'string' || typeof object !== 'string') return;
  const from = subject.trim(), label = predicate.trim(), to = object.trim();
  if (!from || !to || !label || from === to || !quote.includes(from) || !quote.includes(to)) return;
  if (from.length > 40 || to.length > 40 || label.length > 30 || /[\r\n]/.test(from + to + label)) return;
  return { kind, subject: from, predicate: label, object: to };
}

export function quoteChapterGraphLink(link: ChapterGraphLink, quote: string): string | undefined {
  const subject = quote.indexOf(link.subject);
  const object = quote.indexOf(link.object);
  if (subject < 0 || object < 0) return;
  const start = Math.min(subject, object);
  const end = Math.max(subject + link.subject.length, object + link.object.length);
  if (end - start > 500) return;
  const excerptStart = Math.max(0, start - Math.min(80, 500 - (end - start)));
  return quote.slice(excerptStart, Math.min(quote.length, excerptStart + 500)).trim();
}

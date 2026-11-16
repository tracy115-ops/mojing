// character-dna.ts - shared subject identity and shot binding helpers

import type { CharacterAnchor } from '@/types/video';

export interface CharacterDnaTokens {
  zh: string;
  en: string;
}

export interface CharacterDnaOptions {
  /** The assigned reference image is authoritative for visual identity. */
  referenceBound?: boolean;
}

/** Return the entity form declared by the extraction stage. */
export function isNonHumanCharacter(character: CharacterAnchor): boolean {
  return character.entityType === 'non_human';
}

/**
 * A model-facing contract derived only from the current shot binding. It is
 * intentionally language-neutral so a prompt language detector cannot change
 * the subject count or introduce a different set of negative examples.
 */
export function buildExactSubjectConstraint(characters: CharacterAnchor[]): string {
  if (!characters.length) {
    return '[Visible Subject Contract] No character is bound to this shot. Keep the foreground free of unbound character entities.';
  }

  const subjectList = characters
    .map((character, index) => {
      const form = character.entityType && character.entityType !== 'unknown'
        ? `, entity form=${character.entityType}`
        : '';
      return `S${index + 1}=[${character.name}${form}]`;
    })
    .join('; ');
  const knownForms = characters
    .filter((character) => character.entityType && character.entityType !== 'unknown')
    .map((character) => character.entityType)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(', ');
  return [
    '[Visible Subject Contract]',
    `Foreground bound subject count=${characters.length}. Render exactly one visible instance of each bound subject and no other foreground entity.`,
    `Bound subjects: ${subjectList}.`,
    knownForms ? `Allowed entity forms in the foreground: ${knownForms}. Preserve each form; do not convert one form into another.` : '',
    'Do not clone, duplicate, merge, replace, or add an unbound foreground entity.',
  ].filter(Boolean).join(' ');
}

/** Generic image-side exclusion terms derived from the binding contract. */
export function buildSubjectExclusionPrompt(): string {
  return 'duplicate or cloned bound subjects, extra unbound foreground entities, merged subjects, identity drift, clothing drift';
}

/** Keep explicit off-frame bindings visible to every generation modality. */
export function buildOffscreenBindingText(shot: {
  offscreenCharacterIds?: string[];
}): string {
  if (!(shot.offscreenCharacterIds?.length)) return '';
  return '[Frame exclusion contract] Keep every off-frame entity outside the image. Render only the bound visible subjects and do not introduce an unbound foreground subject.';
}

/** Build one identity record per bound subject, preserving the extracted text. */
export function buildCharacterDnaTokens(
  character: CharacterAnchor,
  costumeDesc?: string,
  options: CharacterDnaOptions = {},
): CharacterDnaTokens {
  const name = character.name.trim();
  const appearance = character.appearance.trim();
  const outfit = costumeDesc?.trim();
  const form = character.entityType && character.entityType !== 'unknown'
    ? `entity form: ${character.entityType}`
    : '';
  const tags = character.consistencyTags?.map((tag) => tag.trim()).filter(Boolean).join(', ');
  const wardrobe = outfit
    ? `explicit costume variant: ${outfit}`
    : 'use the canonical wardrobe in this appearance record and its bound reference; do not change or borrow wardrobe details';
  const identity = [
    `subject name: ${name}`,
    options.referenceBound
      ? 'the assigned reference image is authoritative for face, hair, body, clothing, colors, and accessories; preserve it exactly'
      : appearance ? `canonical appearance and wardrobe: ${appearance}` : '',
    form,
    !options.referenceBound && tags ? `consistency tags: ${tags}` : '',
    !options.referenceBound ? wardrobe : '',
  ]
    .filter(Boolean)
    .join('; ');

  return { zh: identity, en: identity };
}

/**
 * Resolve the visible characters for one shot. Explicit bindings are
 * authoritative, including an explicit empty list. Legacy inferred shots may
 * recover exact names/aliases from visual text, but never infer by gender,
 * species, count, or a project-wide "only candidate" rule.
 */
export function findMatchingCharacters(
  shot: {
    characterIds?: string[];
    visibleCharacterIds?: string[];
    offscreenCharacterIds?: string[];
    characterBinding?: 'explicit' | 'inferred';
    videoPrompt?: string;
    sourceText?: string;
    location?: string;
    startState?: string;
    endState?: string;
    narration?: string;
    dialogue?: Array<{ speaker: string; text: string }>;
  },
  characters?: CharacterAnchor[],
): CharacterAnchor[] {
  if (!characters?.length) return [];

  const visibleRefs = Array.isArray(shot.visibleCharacterIds)
    ? shot.visibleCharacterIds
    : shot.characterIds || [];
  const offscreenRefs = new Set((shot.offscreenCharacterIds || []).map(normalizeReference).filter(Boolean));
  const matchesReference = (character: CharacterAnchor, reference: string): boolean => identityReferences(character)
    .some((candidate) => normalizeReference(candidate) === normalizeReference(reference));
  const isOffscreen = (character: CharacterAnchor): boolean => identityReferences(character)
    .some((candidate) => offscreenRefs.has(normalizeReference(candidate)));

  if (isExplicitBinding(shot)) {
    const ordered: CharacterAnchor[] = [];
    const added = new Set<string>();
    for (const reference of visibleRefs) {
      const character = characters.find((candidate) => !isOffscreen(candidate) && matchesReference(candidate, reference));
      if (character && !added.has(character.id)) {
        ordered.push(character);
        added.add(character.id);
      }
    }
    return ordered;
  }

  const matched = new Set<CharacterAnchor>();

  const visualText = [
    shot.videoPrompt || shot.sourceText || '',
    shot.location || '',
    shot.startState || '',
    shot.endState || '',
    ...(shot.dialogue || []).map((dialogue) => dialogue.speaker || ''),
  ].filter(Boolean).join(' ');
  const normalizedText = normalizeReference(visualText);
  if (normalizedText) {
    for (const character of characters) {
      if (isOffscreen(character)) continue;
      const namedInText = identityReferences(character)
        .map(normalizeReference)
        .filter((name) => name.length >= 2)
        .some((name) => normalizedText.includes(name));
      if (namedInText) matched.add(character);
    }
  }

  return Array.from(matched);
}

function isExplicitBinding(shot: {
  characterIds?: string[];
  visibleCharacterIds?: string[];
  characterBinding?: 'explicit' | 'inferred';
}): boolean {
  if (shot.characterBinding === 'explicit') return true;
  if (shot.characterBinding === 'inferred') return false;
  if (Array.isArray(shot.visibleCharacterIds)) return true;
  return (shot.characterIds || []).length > 0;
}

function identityReferences(character: CharacterAnchor): string[] {
  return [character.id, character.name, ...(character.aliases || [])];
}

function normalizeReference(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s·・._-]/g, '');
}

/** Shared identity list for T2V and keyframe prompts. */
export function buildMultiCharacterDnaTokens(
  characters: CharacterAnchor[],
  costumeVariantRefs?: Record<string, string>,
  options: CharacterDnaOptions = {},
): string {
  if (!characters.length) {
    return '[Bound Subject Identities] No character identity is supplied for this shot.';
  }

  const parts = characters.map((character, index) => {
    const variantId = costumeVariantRefs?.[character.id] || costumeVariantRefs?.[character.name];
    const variant = variantId
      ? character.costumeVariants?.find((candidate) => candidate.id === variantId)
      : undefined;
    const dna = buildCharacterDnaTokens(character, variant?.description, options).en;
    return `S${index + 1} ${dna}. Face, hair, body, clothing, colors, and accessories belong only to S${index + 1}; never transfer them to another subject.`;
  });

  return `[Bound Subject Identities] ${parts.join(' ')} Preserve each identity as a separate subject throughout the shot.`;
}

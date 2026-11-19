import type { ImageReferenceCapability } from '../../../types/providers.ts';

/**
 * A provider can accept several image payloads without understanding what
 * each payload represents. That is not a semantic reference contract.
 */
export type ImageReferenceStrategy =
  | 'none'
  | 'manual_shot_reference'
  | 'semantic_slots'
  | 'single_reference'
  | 'blocked';

export interface ImageReferenceStrategyInput {
  candidateCount: number;
  visibleSubjectCount: number;
  hasManualShotReference: boolean;
  /** A rendered whole-shot frame can carry several subjects without slot semantics. */
  hasSingleCompleteReference?: boolean;
  capability: ImageReferenceCapability;
}

export function canComposeFromOrderedReferences(capability: ImageReferenceCapability, subjects: number): boolean {
  return capability.supported && capability.mode === 'multiple' && capability.maxImages >= subjects;
}

export interface ContinuityReferencePolicyInput {
  hasMatchingContinuityShot: boolean;
  continuityReferenceCount: number;
  hasManualShotReference: boolean;
}

/**
 * A previously generated frame is the strongest identity and layout anchor
 * when the next shot keeps both its scene and its visible subject set. A
 * manually approved shot reference remains an explicit override.
 */
export function shouldPreferContinuityReference(
  input: ContinuityReferencePolicyInput,
): boolean {
  return !input.hasManualShotReference
    && input.hasMatchingContinuityShot
    && input.continuityReferenceCount > 0;
}

/**
 * Decide how image references must reach a storyboard provider.
 *
 * This is intentionally independent of characters, languages, or story
 * genres. An untyped endpoint gets one visual authority. Multiple separate
 * subject images are blocked because the provider cannot know which image
 * belongs to which subject; a whole-shot frame or a semantic-slot model is
 * required instead.
 */
export function chooseImageReferenceStrategy(
  input: ImageReferenceStrategyInput,
): ImageReferenceStrategy {
  if (input.candidateCount <= 0) {
    return input.visibleSubjectCount > 0 ? 'blocked' : 'none';
  }
  if (!input.capability.supported || input.capability.maxImages <= 0) return 'blocked';
  if (input.hasManualShotReference) return 'manual_shot_reference';
  if (input.capability.supportsReferenceRoles === true) return 'semantic_slots';
  // An untyped provider cannot distinguish a subject, environment, custom
  // reference, or continuity frame by array position. One visible subject
  // therefore gets one identity anchor, even when a scene asset is also
  // available. A multi-subject shot is safe only when the one input already
  // contains the complete composition.
  if (input.visibleSubjectCount > 1 && !input.hasSingleCompleteReference) return 'blocked';
  return 'single_reference';
}

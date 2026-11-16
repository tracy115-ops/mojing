import assert from 'node:assert/strict';
import {
  chooseImageReferenceStrategy,
  shouldPreferContinuityReference,
} from '../src/services/video/core/reference-strategy.ts';
import { resolveCharacterReferenceImage } from '../src/services/video/core/character-asset-binding.ts';

const capability = (overrides = {}) => ({
  supported: true,
  maxImages: 4,
  mode: 'multiple',
  supportsReferenceRoles: false,
  ...overrides,
});

assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 0, visibleSubjectCount: 0, hasManualShotReference: false, capability: capability() }),
  'none',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 2, visibleSubjectCount: 2, hasManualShotReference: true, capability: capability({ maxImages: 1 }) }),
  'manual_shot_reference',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 2, visibleSubjectCount: 2, hasManualShotReference: false, capability: capability({ maxImages: 1 }) }),
  'blocked',
  'an untyped provider must block separate references for multiple visible subjects',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 3, visibleSubjectCount: 1, hasManualShotReference: false, capability: capability({ maxImages: 1 }) }),
  'single_reference',
  'an untyped provider must keep a one-subject shot on one identity anchor',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 4, visibleSubjectCount: 0, hasManualShotReference: false, capability: capability({ maxImages: 4 }) }),
  'single_reference',
  'an untyped provider must use one environment or custom anchor when no subject is visible',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 1, visibleSubjectCount: 2, hasManualShotReference: false, capability: capability({ maxImages: 4 }) }),
  'blocked',
  'a single untyped input is not assumed to be a complete composition without an explicit marker',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 1, visibleSubjectCount: 2, hasSingleCompleteReference: true, hasManualShotReference: false, capability: capability({ maxImages: 4 }) }),
  'single_reference',
  'a complete continuity frame is one authority even for multiple subjects',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 2, visibleSubjectCount: 2, hasManualShotReference: false, capability: capability({ supportsReferenceRoles: true }) }),
  'semantic_slots',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 1, visibleSubjectCount: 1, hasManualShotReference: false, capability: capability({ maxImages: 1 }) }),
  'single_reference',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 1, visibleSubjectCount: 1, hasManualShotReference: false, capability: capability({ supported: false, maxImages: 0 }) }),
  'blocked',
);
assert.equal(
  chooseImageReferenceStrategy({ candidateCount: 1, visibleSubjectCount: 1, hasManualShotReference: true, capability: capability({ supported: false, maxImages: 0 }) }),
  'blocked',
  'a manual reference cannot be sent to a provider that accepts no reference images',
);

assert.equal(
  shouldPreferContinuityReference({
    hasMatchingContinuityShot: true,
    continuityReferenceCount: 1,
    hasManualShotReference: false,
  }),
  true,
  'same-scene matching subjects should use the previous frame as the continuity authority',
);
assert.equal(
  shouldPreferContinuityReference({
    hasMatchingContinuityShot: true,
    continuityReferenceCount: 1,
    hasManualShotReference: true,
  }),
  false,
  'a human-approved shot reference must remain an explicit override',
);
assert.equal(
  shouldPreferContinuityReference({
    hasMatchingContinuityShot: false,
    continuityReferenceCount: 1,
    hasManualShotReference: false,
  }),
  false,
  'a scene or subject change must fall back to the bound asset strategy',
);

const baseCharacter = {
  id: 'subject-a',
  name: 'Subject A',
  appearance: 'short hair',
  costumeVariants: [{ id: 'school', portraitImage: 'variant-portrait' }],
  portraitImage: 'canonical-portrait',
  turnaroundImage: 'turnaround-sheet',
  turnaroundSourcePortrait: 'canonical-portrait',
};
assert.deepEqual(
  resolveCharacterReferenceImage(baseCharacter, 'school'),
  { imageUrl: 'variant-portrait', source: 'variant' },
  'a selected costume portrait is the strongest identity input',
);
assert.deepEqual(
  resolveCharacterReferenceImage(baseCharacter),
  { imageUrl: 'canonical-portrait', source: 'portrait' },
  'the canonical portrait must beat a turnaround sheet',
);
assert.deepEqual(
  resolveCharacterReferenceImage({ ...baseCharacter, portraitImage: undefined }),
  { imageUrl: 'turnaround-sheet', source: 'turnaround' },
  'a turnaround is a fallback only when no portrait exists',
);

console.log('reference strategy contract tests passed (18 cases)');

import assert from 'node:assert/strict';
import {
  alignReferenceSlots,
  assertReferenceInputBundle,
  materializeReferenceInputBundle,
} from '../src/services/providers/reference-contract.ts';

const first = 'data:image/png;base64,Zmlyc3Q=';
const second = 'data:image/png;base64,c2Vjb25k';

const bundle = materializeReferenceInputBundle(
  [first, second],
  [
    { id: 'subject-a', role: 'subject', image: first, subjectId: 'a' },
    { id: 'environment', role: 'environment', image: second },
  ],
  'custom',
  'image request',
);
assert.deepEqual(bundle.images, [first, second]);
assert.equal(bundle.slots[0].role, 'subject');
assert.equal(bundle.slots[1].role, 'environment');

assert.throws(
  () => materializeReferenceInputBundle(
    [first],
    [{ id: 'subject-a', role: 'subject', image: first }, { id: 'extra', role: 'custom', image: second }],
    'custom',
    'mismatched request',
  ),
  /reference contract mismatch/,
);
assert.throws(
  () => materializeReferenceInputBundle(
    [first, second],
    [
      { id: 'subject-a', role: 'subject', image: second },
      { id: 'environment', role: 'environment', image: first },
    ],
    'custom',
    'reordered request',
  ),
  /does not match its payload/,
);
assert.throws(
  () => assertReferenceInputBundle(
    [first, second],
    [
      { id: 'duplicate', role: 'custom', image: first },
      { id: 'duplicate', role: 'custom', image: second },
    ],
    'duplicate request',
  ),
  /id is duplicated/,
);

const normalized = alignReferenceSlots(
  [
    { id: 'first-frame-original', role: 'custom', image: first, label: 'opening' },
    { id: 'last-frame-original', role: 'custom', image: second, label: 'tail' },
  ],
  [
    { id: 'first-frame', role: 'first_frame', image: first },
    { id: 'last-frame', role: 'last_frame', image: second },
  ],
  'video request',
);
assert.deepEqual(normalized.map((slot) => slot.role), ['first_frame', 'last_frame']);
assert.deepEqual(normalized.map((slot) => slot.image), [first, second]);
assert.deepEqual(normalized.map((slot) => slot.label), ['opening', 'tail']);

console.log('reference input contract tests passed (8 assertions)');

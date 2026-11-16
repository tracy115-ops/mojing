import assert from 'node:assert/strict';
import { normalizeTimelineState } from '../src/services/video/core/timeline-state.ts';

const state = normalizeTimelineState({
  shotOrder: ['shot_2', 'shot_2', 'deleted', 'shot_1'],
  disabledShotIds: ['deleted', 'shot_2'],
  trims: {
    shot_2: { startSeconds: -2, endSeconds: 1.5 },
    deleted: { startSeconds: 4, endSeconds: 4 },
  },
  dialogueVolume: 1.25,
}, ['shot_1', 'shot_2', 'shot_3']);

assert.deepEqual(state.shotOrder, ['shot_2', 'shot_1', 'shot_3']);
assert.deepEqual(state.disabledShotIds, ['shot_2']);
assert.deepEqual(state.trims.shot_2, { startSeconds: 0, endSeconds: 1.5 });
assert.equal(state.trims.deleted, undefined);
assert.equal(state.dialogueVolume, 1.25);

const migrated = normalizeTimelineState(undefined, ['shot_1', 'shot_2']);
assert.deepEqual(migrated.shotOrder, ['shot_1', 'shot_2']);
assert.deepEqual(migrated.disabledShotIds, []);
assert.equal(migrated.dialogueVolume, 1);

console.log('timeline state contract tests passed (2 cases)');

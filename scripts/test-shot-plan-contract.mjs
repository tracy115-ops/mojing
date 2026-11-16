import assert from 'node:assert/strict';
import {
  assertShotPlanContract,
  validateShotPlanContract,
} from '../src/services/video/core/shot-plan-contract.ts';

const valid = [
  {
    id: 'shot-1',
    index: 0,
    sourceText: 'A technician enters the lab.',
    videoPrompt: 'The technician walks into the lab.',
    imagePrompt: 'Medium shot of the lab entrance.',
    durationSeconds: 5,
    sceneId: 'lab',
    location: 'Lab',
    visibleCharacterIds: ['technician'],
    offscreenCharacterIds: [],
    characterBinding: 'explicit',
    endState: 'The technician stands beside the console.',
  },
  {
    id: 'shot-2',
    index: 1,
    sourceText: 'The technician checks the console.',
    videoPrompt: 'The technician checks the console.',
    imagePrompt: 'Over-shoulder view of the console.',
    durationSeconds: 5,
    sceneId: 'lab',
    location: 'Lab',
    visibleCharacterIds: ['technician'],
    offscreenCharacterIds: [],
    characterBinding: 'explicit',
    startState: 'The technician stands beside the console.',
  },
];

assert.doesNotThrow(() => assertShotPlanContract(valid, {
  characters: [{ id: 'technician', name: 'Technician' }],
  scenes: [{ id: 'lab', name: 'Lab' }],
  requireAssetBindings: true,
}));
assert.ok(validateShotPlanContract([
  ...valid,
  { ...valid[1], id: 'shot-3', index: 2, offscreenCharacterIds: ['technician'] },
]).some((issue) => issue.code === 'visible-offscreen-conflict'));
assert.ok(validateShotPlanContract([
  valid[0],
  { ...valid[1], id: 'shot-3', index: 0 },
]).some((issue) => issue.code === 'duplicate-shot-index'));
assert.ok(validateShotPlanContract([
  valid[0],
  { ...valid[1], id: 'shot-4', index: 1, startState: undefined },
]).some((issue) => issue.code === 'missing-continuity-start-state'));
assert.throws(
  () => assertShotPlanContract([
    { ...valid[0], id: 'shot-5', index: 4, visibleCharacterIds: ['unknown'] },
  ], {
    characters: [{ id: 'technician', name: 'Technician' }],
    scenes: [{ id: 'lab', name: 'Lab' }],
    requireAssetBindings: true,
  }),
  /unresolved-visible-subject/,
);
assert.ok(validateShotPlanContract([
  { ...valid[0], id: 'shot-implicit', characterBinding: 'inferred' },
], {
  characters: [{ id: 'technician', name: 'Technician' }],
  scenes: [{ id: 'lab', name: 'Lab' }],
  requireAssetBindings: true,
}).some((issue) => issue.code === 'implicit-visible-binding'));

console.log('shot plan contract tests passed (6 assertions)');

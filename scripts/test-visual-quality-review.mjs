import assert from 'node:assert/strict';
import { normalizeVisualReview } from '../src/services/video/core/visual-quality-normalizer.ts';

const checks = ['subject_count', 'subject_identity', 'scene_match', 'composition', 'temporal_consistency']
  .map((id) => ({ id, status: 'pass', score: 92, message: `${id} is consistent`, evidence: 'sample evidence' }));

const passed = normalizeVisualReview(JSON.stringify({
  overallScore: 92,
  summary: 'All sampled frames match the declared shot contract.',
  checks,
}), {
  reviewedAt: '2026-09-13T00:00:00.000Z',
  provider: 'custom',
  model: 'vision-model',
  frameCount: 3,
});
assert.equal(passed.status, 'passed');
assert.equal(passed.checks.length, 5);

const failed = normalizeVisualReview(JSON.stringify({
  overallScore: 42,
  checks: checks.map((check) => check.id === 'subject_count'
    ? { ...check, status: 'fail', score: 20, message: 'An unbound entity appears in the frame.' }
    : check),
}), {
  reviewedAt: '2026-09-13T00:00:00.000Z',
  provider: 'custom',
  model: 'vision-model',
  frameCount: 3,
});
assert.equal(failed.status, 'failed');
assert.equal(failed.checks.find((check) => check.id === 'subject_count')?.status, 'fail');

const incomplete = normalizeVisualReview('{"overallScore":90}', {
  reviewedAt: '2026-09-13T00:00:00.000Z',
  provider: 'custom',
  model: 'vision-model',
  frameCount: 2,
});
assert.equal(incomplete.status, 'unavailable');

console.log('visual quality review contract tests passed (3 cases)');

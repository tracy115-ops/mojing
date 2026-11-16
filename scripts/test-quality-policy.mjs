import assert from 'node:assert/strict';
import { DEFAULT_PIPELINE_OPTIONS, DIRECT_MODE_PRESETS } from '../src/types/video.ts';
import {
  resolveAssemblyQualityRequirements,
  resolveVideoQualityPolicy,
} from '../src/services/video/core/quality-policy.ts';
import { resolveTemporalAuthority } from '../src/services/video/core/shot-continuity.ts';

const draft = resolveVideoQualityPolicy(undefined);
assert.equal(draft.profile, 'draft', 'missing options remain compatible with legacy projects');
assert.equal(draft.keyframeCandidatesPerShot, 1);
assert.equal(draft.videoCandidatesPerShot, 1);
assert.equal(draft.visualReviewRequired, false);
assert.equal(draft.continuityMode, 'approved_keyframe');

const quality = resolveVideoQualityPolicy(DEFAULT_PIPELINE_OPTIONS);
assert.equal(quality.profile, 'quality', 'new projects use the quality profile');
assert.equal(quality.keyframeCandidatesPerShot, 2);
assert.equal(quality.videoCandidatesPerShot, 2);
assert.equal(quality.visualReviewRequired, true);
assert.equal(quality.blockOnVisualReviewUnavailable, true);
assert.equal(quality.continuityMode, 'previous_tail');

const bounded = resolveVideoQualityPolicy({
  qualityProfile: 'balanced',
  keyframeCandidatesPerShot: 0,
  videoCandidatesPerShot: 99,
});
assert.equal(bounded.keyframeCandidatesPerShot, 1, 'candidate count has a lower bound');
assert.equal(bounded.videoCandidatesPerShot, 3, 'candidate count has a bounded upper limit');
assert.equal(bounded.continuityMode, 'previous_tail');

const t2v = resolveVideoQualityPolicy({ enableKeyframe: false, enableI2V: false });
assert.equal(t2v.profile, 'draft', 'pure T2V does not force visual review');
assert.equal(t2v.visualReviewRequired, false);

const advisory = resolveVideoQualityPolicy({
  qualityProfile: 'quality',
  enableVisualQualityGate: false,
  blockOnVisualReviewUnavailable: false,
});
assert.equal(advisory.visualReviewRequired, false);
assert.equal(advisory.blockOnVisualReviewUnavailable, false);
assert.deepEqual(resolveAssemblyQualityRequirements(DEFAULT_PIPELINE_OPTIONS), {
  visualReviewRequired: true,
  blockOnVisualReviewUnavailable: true,
});
assert.equal(DIRECT_MODE_PRESETS.pure.continuityMode, 'approved_keyframe');
assert.equal(DIRECT_MODE_PRESETS.multishot.continuityMode, 'previous_tail');

const previous = {
  id: 'shot-1',
  index: 0,
  sceneId: 'scene-1',
  visibleCharacterIds: ['subject-1'],
};
const current = {
  id: 'shot-2',
  index: 1,
  sceneId: 'scene-1',
  visibleCharacterIds: ['subject-1'],
};
assert.equal(
  resolveTemporalAuthority('previous_tail', previous, current),
  'approved_keyframe',
  'a matching shot without an approved previous clip must use its approved keyframe',
);
assert.equal(resolveTemporalAuthority('previous_tail', previous, { ...current, sceneId: 'scene-2' }), 'approved_keyframe');
assert.equal(resolveTemporalAuthority('previous_tail', previous, { ...current, manualReferenceImage: 'approved.png' }), 'approved_keyframe');

console.log('quality policy contract tests passed (20 assertions)');

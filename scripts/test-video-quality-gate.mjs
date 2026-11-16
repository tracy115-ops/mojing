import assert from 'node:assert/strict';
import { evaluateVideoClipQuality } from '../src/services/video/core/video-quality-gate.ts';

const shot = {
  id: 'shot-generic-1',
  index: 0,
  sourceText: 'An engineer repairs a solar array while a service robot holds the cable.',
  videoPrompt: 'The engineer secures the cable as the robot stabilizes the panel.',
  characterIds: ['engineer', 'robot'],
  sceneId: 'orbital-platform',
  durationSeconds: 5,
};

const clip = {
  shotId: shot.id,
  videoUrl: 'C:\\media\\shot-1.mp4',
  durationSeconds: 5,
  provider: 'custom',
  model: 'video-model',
  hasAudio: false,
  generatedAt: '2026-09-10T00:00:00.000Z',
  videoReferenceMode: 'i2v',
  videoControlMode: 'keyframe',
  lastFrameImage: 'C:\\media\\shot-1-tail.png',
  videoReferenceAssets: [{
    id: 'shot-1-keyframe',
    kind: 'keyframe',
    label: 'Shot keyframe',
    imageUrl: 'C:\\media\\shot-1.png',
    sentToProvider: true,
    providerIndex: 0,
  }],
};

const passed = evaluateVideoClipQuality(shot, clip, {
  assetAvailable: true,
  requireI2V: true,
  requireTailFrame: true,
  reviewedAt: '2026-09-10T00:00:00.000Z',
});
assert.equal(passed.status, 'passed');
assert.equal(passed.score, 100);

const missingAsset = evaluateVideoClipQuality(shot, clip, {
  assetAvailable: false,
  requireI2V: true,
});
assert.equal(missingAsset.status, 'failed');
assert.ok(missingAsset.checks.some((check) => check.id === 'asset' && check.status === 'fail'));

const noReference = evaluateVideoClipQuality(shot, {
  ...clip,
  videoReferenceMode: 't2v',
  videoReferenceAssets: [],
}, {
  assetAvailable: true,
  requireI2V: true,
});
assert.equal(noReference.status, 'failed');
assert.equal(noReference.checks.filter((check) => check.status === 'fail').length, 2);

const omittedReference = evaluateVideoClipQuality(shot, {
  ...clip,
  videoReferenceMode: 'i2v',
  videoReferenceAssets: [{
    ...clip.videoReferenceAssets[0],
    sentToProvider: false,
    providerIndex: undefined,
    omittedReason: 'provider reference limit',
  }],
}, {
  assetAvailable: true,
  requireI2V: true,
});
assert.equal(omittedReference.status, 'failed');
assert.ok(omittedReference.checks.some((check) => check.id === 'reference_payload' && check.status === 'fail'));

const warning = evaluateVideoClipQuality(shot, {
  ...clip,
  durationSeconds: 8,
  lastFrameImage: undefined,
}, {
  assetAvailable: true,
  requireI2V: true,
  requireTailFrame: true,
});
assert.equal(warning.status, 'warning');
assert.equal(warning.score, 80);

const wrongControlMode = evaluateVideoClipQuality(shot, {
  ...clip,
  videoControlMode: 'reference',
}, {
  assetAvailable: true,
  requireI2V: true,
  requiredControlMode: 'keyframe',
});
assert.equal(wrongControlMode.status, 'failed');
assert.ok(wrongControlMode.checks.some((check) => check.id === 'reference_mode' && check.status === 'fail'));

const approvedKeyframeAuthority = evaluateVideoClipQuality(shot, {
  ...clip,
  generationContext: { temporalAuthority: 'approved_keyframe' },
}, {
  assetAvailable: true,
  requireI2V: true,
  requiredControlMode: 'keyframe',
  requiredTemporalAuthority: 'approved_keyframe',
});
assert.equal(approvedKeyframeAuthority.status, 'passed');
assert.ok(approvedKeyframeAuthority.checks.some((check) => check.id === 'temporal_authority' && check.status === 'pass'));

const ambiguousAuthority = evaluateVideoClipQuality(shot, clip, {
  assetAvailable: true,
  requireI2V: true,
  requiredControlMode: 'keyframe',
  requiredTemporalAuthority: 'approved_keyframe',
});
assert.equal(ambiguousAuthority.status, 'failed');
assert.ok(ambiguousAuthority.checks.some((check) => check.id === 'temporal_authority' && check.status === 'fail'));

const missingContinuityHandoff = evaluateVideoClipQuality(shot, clip, {
  assetAvailable: true,
  requireI2V: true,
  requiredControlMode: 'keyframe',
  requirePreviousTail: true,
});
assert.equal(missingContinuityHandoff.status, 'failed');
assert.ok(missingContinuityHandoff.checks.some((check) => check.id === 'continuity_handoff' && check.status === 'fail'));

const continuityHandoff = evaluateVideoClipQuality(shot, {
  ...clip,
  videoReferenceAssets: [
    ...clip.videoReferenceAssets,
    {
      id: 'shot-0-tail',
      kind: 'previous',
      label: 'Previous shot tail',
      imageUrl: 'C:\\media\\shot-0-tail.png',
      sentToProvider: true,
      providerIndex: 0,
    },
  ],
}, {
  assetAvailable: true,
  requireI2V: true,
  requiredControlMode: 'keyframe',
  requirePreviousTail: true,
});
assert.equal(continuityHandoff.status, 'passed');
assert.ok(continuityHandoff.checks.some((check) => check.id === 'continuity_handoff' && check.status === 'pass'));

console.log('video quality gate contract tests passed (9 cases)');

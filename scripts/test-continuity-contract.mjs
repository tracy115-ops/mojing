import assert from 'node:assert/strict';
import {
  getContinuityHandoffIssue,
  getEffectiveShotSeed,
  getSubjectContinuityShot,
  resolveTemporalAuthority,
  shouldUseRenderedTailAsFirstFrame,
} from '../src/services/video/core/shot-continuity.ts';
import { fingerprintShotInputs } from '../src/services/video/core/shot-generation-receipt.ts';
import { buildVideoGenerationPrompt } from '../src/services/video/core/shot-motion-prompt.ts';
import {
  isApprovedVideoClip,
  isShotKeyframeApproved,
} from '../src/services/video/core/shot-production-contract.ts';

const previous = {
  id: 'shot-1',
  index: 0,
  sceneId: 'room',
  visibleCharacterIds: ['subject'],
  sourceText: 'The subject waits by the window.',
  videoPrompt: 'The subject waits by the window.',
};
const current = {
  id: 'shot-2',
  index: 1,
  sceneId: 'room',
  visibleCharacterIds: ['subject'],
  sourceText: 'The subject turns toward the door.',
  videoPrompt: 'The subject turns toward the door.',
};

const directed = { ...current, cameraMovement: 'pan_right', startState: 'Standing at the window', endState: 'Facing the door' };
const temporalPrompt = buildVideoGenerationPrompt(directed, [], 'keyframe');
assert.match(temporalPrompt, /smooth pan right/, 'edited camera direction must reach the video prompt');
assert.match(temporalPrompt, /Standing at the window/);
assert.match(temporalPrompt, /Facing the door/);
assert.match(temporalPrompt, /supplied first frame is authoritative/);
const subjectPrompt = buildVideoGenerationPrompt(directed, [], 'reference');
assert.match(subjectPrompt, /identity references/);
assert.doesNotMatch(subjectPrompt, /supplied first frame is authoritative/, 'subject-reference mode must not invent a temporal first frame');
const textPrompt = buildVideoGenerationPrompt(directed, [{ id: 'subject', name: 'Alex', appearance: 'blue coat' }], 'text');
assert.match(textPrompt, /blue coat/, 'text generation must restore the canonical appearance contract');
assert.equal(buildVideoGenerationPrompt({ ...current, videoPrompt: '', sourceText: '' }, [], 'text'), '');
assert.notEqual(fingerprintShotInputs({ ...directed, transition: 'cut' }, 'video'), fingerprintShotInputs({ ...directed, transition: 'continue' }, 'video'), 'continuity edits must invalidate old video receipts');

assert.equal(
  getContinuityHandoffIssue(previous, current, undefined),
  'missing_previous_clip',
  'a matching sequence requires the earlier clip',
);
assert.equal(
  getContinuityHandoffIssue(previous, current, { videoUrl: 'clip.mp4' }),
  'missing_tail_frame',
  'a matching sequence requires the earlier tail frame',
);
assert.equal(
  getContinuityHandoffIssue(previous, current, { videoUrl: 'clip.mp4', lastFrameImage: 'tail.png' }),
  undefined,
  'a real tail frame completes the handoff',
);
assert.equal(
  getContinuityHandoffIssue(previous, { ...current, sceneId: 'hall' }, undefined),
  undefined,
  'a scene change starts a new continuity segment',
);
assert.equal(
  getContinuityHandoffIssue(previous, { ...current, visibleCharacterIds: ['other'] }, undefined),
  undefined,
  'a subject change starts a new continuity segment',
);
assert.equal(
  shouldUseRenderedTailAsFirstFrame({
    required: true,
    hasMatchingPreviousShot: true,
    hasPreviousTailFrame: true,
    supportsFirstFrame: true,
    requestedMode: 'keyframe',
    hasManualShotReference: false,
    temporalAuthority: 'previous_tail',
  }),
  true,
  'a matching rendered tail becomes the temporal first frame',
);
assert.equal(
  shouldUseRenderedTailAsFirstFrame({
    required: true,
    hasMatchingPreviousShot: true,
    hasPreviousTailFrame: true,
    supportsFirstFrame: true,
    requestedMode: 'keyframe',
    hasManualShotReference: true,
    temporalAuthority: 'previous_tail',
  }),
  false,
  'a human whole-shot reference remains an explicit override',
);
assert.equal(
  shouldUseRenderedTailAsFirstFrame({
    required: true,
    hasMatchingPreviousShot: true,
    hasPreviousTailFrame: true,
    supportsFirstFrame: false,
    requestedMode: 'keyframe',
    hasManualShotReference: false,
    temporalAuthority: 'previous_tail',
  }),
  false,
  'providers without first-frame control cannot claim a temporal handoff',
);
assert.equal(
  shouldUseRenderedTailAsFirstFrame({
    required: true,
    hasMatchingPreviousShot: true,
    hasPreviousTailFrame: true,
    supportsFirstFrame: true,
    requestedMode: 'keyframe',
    hasManualShotReference: false,
    temporalAuthority: 'approved_keyframe',
  }),
  false,
  'the approved keyframe remains the default temporal authority',
);

const keyframeContext = {
  provider: 'mock-image',
  model: 'mock-still',
  aspectRatio: '16:9',
};
const draftAdjacent = {
  ...previous,
  keyframeImage: 'draft-keyframe.png',
  keyframeGenerationContext: keyframeContext,
  keyframeInputFingerprint: fingerprintShotInputs({
    ...previous,
    keyframeImage: 'draft-keyframe.png',
  }, 'keyframe', [], keyframeContext),
  versionHistory: [{
    id: 'draft-keyframe-version',
    type: 'image',
    url: 'draft-keyframe.png',
    createdAt: '2026-09-14T00:00:00.000Z',
    inputFingerprint: fingerprintShotInputs({
      ...previous,
      keyframeImage: 'draft-keyframe.png',
    }, 'keyframe', [], keyframeContext),
    imageGenerationContext: keyframeContext,
    reviewStatus: 'unreviewed',
  }],
  selectedVersionId: 'draft-keyframe-version',
};
assert.equal(isShotKeyframeApproved(draftAdjacent), false);
assert.equal(
  getSubjectContinuityShot([draftAdjacent, current], current),
  undefined,
  'an unreviewed keyframe must not become a later shot reference',
);

const approvedKeyframeShot = {
  ...previous,
  keyframeImage: 'approved-keyframe.png',
  keyframeGenerationContext: keyframeContext,
  keyframeInputFingerprint: fingerprintShotInputs({
    ...previous,
    keyframeImage: 'approved-keyframe.png',
  }, 'keyframe', [], keyframeContext),
  versionHistory: [{
    id: 'approved-keyframe-version',
    type: 'image',
    url: 'approved-keyframe.png',
    createdAt: '2026-09-14T00:00:00.000Z',
    inputFingerprint: fingerprintShotInputs({
      ...previous,
      keyframeImage: 'approved-keyframe.png',
    }, 'keyframe', [], keyframeContext),
    imageGenerationContext: keyframeContext,
    reviewStatus: 'approved',
  }],
  selectedVersionId: 'approved-keyframe-version',
};
assert.equal(isShotKeyframeApproved(approvedKeyframeShot), true);
assert.equal(
  getSubjectContinuityShot([approvedKeyframeShot, draftAdjacent, { ...current, id: 'shot-3', index: 2 }], { ...current, id: 'shot-3', index: 2 }),
  approvedKeyframeShot,
  'the nearest approved keyframe may be reused when the adjacent candidate is unreviewed',
);

const videoContext = {
  provider: 'mock-video',
  model: 'mock-motion',
  endpointId: 'mock-video-endpoint',
  aspectRatio: '16:9',
  resolution: '1280x720',
  fps: 24,
};
const approvedVideoShot = {
  ...approvedKeyframeShot,
  versionHistory: [{
    id: 'approved-video-version',
    type: 'video',
    url: 'approved-clip.mp4',
    createdAt: '2026-09-14T00:00:00.000Z',
    inputFingerprint: fingerprintShotInputs(approvedKeyframeShot, 'video', [], videoContext),
    generationContext: videoContext,
    reviewStatus: 'approved',
  }],
  selectedVersionId: 'approved-video-version',
};
const approvedVideoClip = {
  shotId: approvedVideoShot.id,
  shotVersionId: 'approved-video-version',
  videoUrl: 'approved-clip.mp4',
  lastFrameImage: 'approved-tail.png',
  durationSeconds: 5,
  provider: 'mock-video',
  model: 'mock-motion',
  hasAudio: false,
  generatedAt: '2026-09-14T00:00:00.000Z',
  inputFingerprint: approvedVideoShot.versionHistory[0].inputFingerprint,
  generationContext: videoContext,
};
assert.equal(isApprovedVideoClip(approvedVideoShot, approvedVideoClip), true);
assert.equal(
  resolveTemporalAuthority('previous_tail', approvedVideoShot, current, approvedVideoClip),
  'previous_tail',
  'an approved current video with a real tail may become the temporal authority',
);
assert.equal(
  resolveTemporalAuthority('previous_tail', draftAdjacent, current, {
    ...approvedVideoClip,
    shotVersionId: 'draft-keyframe-version',
  }),
  'approved_keyframe',
  'an unreviewed previous candidate must fall back to the current approved keyframe',
);

const characterSeed = 42;
assert.notEqual(
  getEffectiveShotSeed({ id: previous.id }, characterSeed),
  getEffectiveShotSeed({ id: current.id }, characterSeed),
  'a shared batch seed must derive distinct seeds per shot',
);
assert.equal(
  getEffectiveShotSeed({ id: current.id, seed: 777 }, characterSeed),
  777,
  'an explicit shot seed must override the batch seed',
);
assert.equal(
  getEffectiveShotSeed({ id: current.id }, characterSeed),
  getEffectiveShotSeed({ id: current.id }, characterSeed),
  'the same shot and batch seed must remain reproducible',
);

console.log('continuity contract tests passed (12 assertions)');

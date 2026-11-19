import assert from 'node:assert/strict';
import { getProductionReadiness } from '../src/services/video/core/production-readiness.ts';

const stageNames = [
  'script_slicing',
  'storyboard_prompt',
  'extraction',
  'character_anchor',
  'scene_image',
  'keyframe_image',
  'voice_assignment',
  'tts',
  'video_generation',
  'video_review',
  'audio_merge',
  'composing',
];

function makeStages(extractionStatus) {
  return Object.fromEntries(stageNames.map((stage) => [
    stage,
    {
      stage,
      status: stage === 'extraction' ? extractionStatus : 'pending',
      progress: stage === 'extraction' ? 1 : 0,
    },
  ]));
}

function makeProject(extractionStatus, channel = 'novel') {
  return {
    novelProjectId: 'planning-checkpoint-test',
    selectedChapterIds: ['chapter-1'],
    spec: {
      aspectRatio: '16:9',
      resolution: '1920x1080',
      fps: 24,
      shotDurationSeconds: 5,
      videoTier: 'value',
      imageTier: 'value',
      ttsTier: 'free',
      hardcodeSubtitles: false,
    },
    stages: makeStages(extractionStatus),
    currentStage: 'extraction',
    shots: [],
    sceneSpec: {
      characters: [],
      scenes: [],
      shots: [{
        id: 'shot-1',
        index: 0,
        sourceText: 'A subject crosses the room.',
        videoPrompt: 'A subject crosses the room.',
        characterIds: [],
        durationSeconds: 5,
      }],
      meta: {
        channel,
        sourceMode: 'multishot',
        aspectRatio: '16:9',
        defaultShotDuration: 5,
      },
    },
    anchorImages: [],
    clips: [],
    audios: [],
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  };
}

const waiting = getProductionReadiness(makeProject('awaiting_review'), { sourceText: 'A source story.' });
assert.equal(waiting.planningReady, true);
assert.equal(waiting.planningApproved, false);
assert.equal(waiting.planningReviewRequired, true);
assert.equal(waiting.action, 'review_plan');
assert.equal(waiting.phase, 'script');
assert.equal(waiting.overall, 'review');
assert.ok(waiting.blockers.some((blocker) => blocker.code === 'planning_review_required'));

const approved = getProductionReadiness(makeProject('completed'), { sourceText: 'A source story.' });
assert.equal(approved.planningApproved, true);
assert.equal(approved.planningReviewRequired, false);
assert.notEqual(approved.action, 'review_plan');

const direct = getProductionReadiness(makeProject('awaiting_review', 'direct'), { sourceText: 'A source story.' });
assert.equal(direct.planningReviewRequired, false, 'direct projects do not need the novel planning checkpoint');

const saved = makeProject('completed');
saved.sceneSpec.characters.push({ id: 'cat', name: 'Cat' });
const originalShot = saved.sceneSpec.shots[0];
delete originalShot.sourceText;
originalShot.characterIds = ['cat'];
const legacy = getProductionReadiness(saved, { sourceText: 'A source story.' });
assert.equal(legacy.planningApproved, true);
assert.equal(legacy.action, 'prepare_assets', 'legacy authored shots with only a video prompt can proceed to references');
assert.equal(originalShot.imagePrompt, undefined, 'readiness does not overwrite the original plan');
saved.options = { qualityProfile: 'quality' };
assert.equal(getProductionReadiness(saved, { sourceText: 'A source story.' }).planningReady, false, 'new authored plans still require explicit source and still prompts');

console.log('planning checkpoint tests passed');

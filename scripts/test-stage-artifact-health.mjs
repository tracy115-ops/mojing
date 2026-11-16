import assert from 'node:assert/strict';
import { isStageLiveCompleted } from '../src/services/video/core/stage-artifact-health.ts';
import { ENVIRONMENT_REFERENCE_VERSION } from '../src/services/video/core/asset-reference-contract.ts';

const dependencies = {
  isAssetAvailable: async (url) => !!url,
  isValidVideoClip: (clip) => !!clip?.videoUrl && /^https?:\/\//.test(clip.videoUrl),
  environmentReferenceVersion: ENVIRONMENT_REFERENCE_VERSION,
};

const isLive = (project, stage) => isStageLiveCompleted(project, stage, dependencies);

const stage = (name, input) => ({
  stage: name,
  status: 'completed',
  progress: 1,
  input,
});

const makeProject = (overrides = {}) => {
  const shots = overrides.shots ?? [{
    id: 'shot-1',
    index: 0,
    videoPrompt: 'A person walks through the room.',
    sourceText: 'A person walks through the room.',
    characterIds: ['person'],
    durationSeconds: 5,
  }];
  const sceneSpec = overrides.sceneSpec ?? {
    shots,
    characters: [],
    scenes: [],
    meta: { aspectRatio: '16:9', defaultShotDuration: 5, sourceMode: 'multishot', channel: 'novel' },
  };
  return {
    novelProjectId: 'health-test',
    selectedChapterIds: [],
    spec: { resolution: '1920x1080', fps: 24, videoTier: 'value' },
    stages: {
      character_anchor: stage('character_anchor'),
      scene_image: stage('scene_image'),
      keyframe_image: stage('keyframe_image'),
      video_generation: stage('video_generation'),
      video_review: stage('video_review'),
      tts: stage('tts'),
      audio_merge: stage('audio_merge'),
    },
    currentStage: 'complete',
    shots,
    sceneSpec,
    anchorImages: [],
    clips: [],
    audios: [],
    ...overrides,
  };
};

const character = {
  id: 'person',
  name: 'Person',
  appearance: 'A person',
  portraitImage: 'https://assets.test/person.png',
  turnaroundImage: 'https://assets.test/person-turnaround.png',
  turnaroundSourcePortrait: 'https://assets.test/person.png',
};

const characterProject = makeProject({
  sceneSpec: {
    ...makeProject().sceneSpec,
    characters: [character],
  },
});
assert.equal(await isLive(characterProject, 'character_anchor'), true);
assert.equal(await isLive(makeProject({
  sceneSpec: { ...characterProject.sceneSpec, characters: [{ ...character, turnaroundImage: undefined }] },
}), 'character_anchor'), false);
assert.equal(await isLive(makeProject({
  stages: { ...characterProject.stages, character_anchor: stage('character_anchor', { anchorMode: 'single' }) },
  sceneSpec: { ...characterProject.sceneSpec, characters: [{ ...character, turnaroundImage: undefined }] },
}), 'character_anchor'), true);

const verifiedScene = {
  id: 'room',
  name: 'Room',
  description: 'A room',
  firstAppearShotIndex: 0,
  backgroundImage: 'https://assets.test/room.png',
  backgroundReferenceRole: 'environment_only',
  backgroundReferenceVersion: 2,
};
assert.equal(await isLive(makeProject({
  sceneSpec: { ...makeProject().sceneSpec, scenes: [verifiedScene] },
}), 'scene_image'), true);
assert.equal(await isLive(makeProject({
  sceneSpec: { ...makeProject().sceneSpec, scenes: [{ ...verifiedScene, backgroundReferenceVersion: 1 }] },
}), 'scene_image'), false);

const audioShot = { ...makeProject().shots[0], audioTrack: 'https://assets.test/shot-1.mp3' };
assert.equal(await isLive(makeProject({
  shots: [audioShot],
  sceneSpec: { ...makeProject().sceneSpec, shots: [audioShot] },
}), 'tts'), true);
assert.equal(await isLive(makeProject({
  shots: [audioShot],
  sceneSpec: { ...makeProject().sceneSpec, shots: [{ ...audioShot, audioTrack: undefined }] },
}), 'tts'), false);

const clip = {
  shotId: 'shot-1',
  videoUrl: 'https://assets.test/shot-1.mp4',
  durationSeconds: 5,
  provider: 'custom',
  model: 'video-model',
  hasAudio: false,
  generatedAt: '2026-09-10T00:00:00.000Z',
  videoReferenceMode: 'i2v',
  videoControlMode: 'keyframe',
  qualityReview: {
    status: 'passed',
    score: 100,
    reviewedAt: '2026-09-10T00:00:00.000Z',
    checks: [],
  },
};
const completeVideoProject = makeProject({ clips: [clip] });
assert.equal(await isLive(completeVideoProject, 'video_generation'), true);
assert.equal(await isLive(completeVideoProject, 'video_review'), true);
assert.equal(await isLive(makeProject({ clips: [{ ...clip, shotId: 'unknown' }] }), 'video_generation'), false);
assert.equal(await isLive(makeProject({ clips: [{ ...clip, qualityReview: undefined }] }), 'video_review'), false);

const mergedShot = { ...audioShot, audioTrack: 'https://assets.test/merged.mp4' };
assert.equal(await isLive(makeProject({
  sceneSpec: { ...makeProject().sceneSpec, shots: [mergedShot] },
  clips: [{ ...clip, hasAudio: true }],
}), 'audio_merge'), true);
assert.equal(await isLive(makeProject({
  sceneSpec: { ...makeProject().sceneSpec, shots: [mergedShot] },
  clips: [clip],
}), 'audio_merge'), false);

console.log('stage artifact health contract tests passed (11 cases)');

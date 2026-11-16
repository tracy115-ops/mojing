import assert from 'node:assert/strict';
import {
  evaluatePipelinePreflight,
  getPipelineRequiredCategories,
} from '../src/services/video/core/pipeline-preflight-rules.ts';

const fullOptions = {
  enableCharacterAnchor: true,
  enableSceneImage: true,
  enableTTS: true,
  enableKeyframe: true,
  enableI2V: true,
  enableAudioMerge: true,
  enableSubtitles: true,
  characterAnchorLimit: 5,
};

const pureOptions = {
  enableCharacterAnchor: false,
  enableSceneImage: false,
  enableTTS: false,
  enableKeyframe: false,
  enableI2V: false,
  enableAudioMerge: false,
  enableSubtitles: false,
  characterAnchorLimit: 0,
};

const imageCapabilities = {
  modality: 'image',
  provider: 'agnes-image',
  model: 'agnes-image-2.1-flash',
  adapterAvailable: true,
  references: {
    supported: true,
    maxImages: 4,
    mode: 'multiple',
    supportsReferenceRoles: false,
  },
  parameters: [],
};

const videoCapabilities = {
  modality: 'video',
  provider: 'kling',
  model: 'kling-v2',
  adapterAvailable: true,
  references: {
    supported: true,
    maxImages: 2,
    mode: 'first_last',
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsSubjectReferences: false,
  },
  parameters: [],
};

const readyProviders = {
  llm: { category: 'llm', endpointId: 'llm-1', provider: 'glm', model: 'glm-5.2' },
  image: {
    category: 'image',
    endpointId: 'image-1',
    provider: 'agnes-image',
    model: imageCapabilities.model,
    adapterAvailable: true,
    imageCapabilities,
  },
  video: {
    category: 'video',
    endpointId: 'video-1',
    provider: 'kling',
    model: videoCapabilities.model,
    adapterAvailable: true,
    videoCapabilities,
  },
  tts: { category: 'tts', endpointId: 'tts-1', provider: 'edge-tts', model: 'edge-tts' },
};

const sceneSpec = {
  characters: [{ id: 'char-1' }],
  scenes: [{ id: 'scene-1' }],
  shots: [{ videoPrompt: 'A shot', sourceText: 'Narration' }],
};

assert.deepEqual(
  getPipelineRequiredCategories({
    channel: 'direct',
    sourceMode: 'pure',
    options: pureOptions,
    sceneSpec,
  }),
  ['video'],
);

const missing = evaluatePipelinePreflight({
  channel: 'novel',
  options: fullOptions,
  sceneSpec,
  providers: {},
});
assert.equal(missing.ok, false);
assert.deepEqual(missing.blocking.map((issue) => issue.category), ['llm', 'image', 'tts', 'video']);
assert.ok(missing.blocking.every((issue) => issue.code === 'missing-endpoint'));

const unsupported = evaluatePipelinePreflight({
  channel: 'direct',
  sourceMode: 'extract',
  options: fullOptions,
  sceneSpec,
  providers: {
    video: {
      category: 'video',
      provider: 'sora',
      model: 'sora-1',
      adapterAvailable: false,
      videoCapabilities: { ...videoCapabilities, provider: 'sora', adapterAvailable: false },
    },
    image: readyProviders.image,
  },
  planningRequired: false,
  hasSpeech: false,
});
assert.equal(unsupported.ok, false);
assert.ok(unsupported.blocking.some((issue) => issue.code === 'adapter-unavailable'));

const noFirstFrame = evaluatePipelinePreflight({
  channel: 'direct',
  sourceMode: 'extract',
  options: fullOptions,
  sceneSpec,
  providers: {
    image: readyProviders.image,
    video: {
      ...readyProviders.video,
      videoCapabilities: {
        ...videoCapabilities,
        references: { ...videoCapabilities.references, supportsFirstFrame: false },
      },
    },
  },
  planningRequired: false,
  hasSpeech: false,
});
assert.ok(noFirstFrame.blocking.some((issue) => issue.code === 'i2v-first-frame-unsupported'));

const ready = evaluatePipelinePreflight({
  channel: 'novel',
  options: fullOptions,
  sceneSpec,
  providers: readyProviders,
});
assert.equal(ready.ok, true);
assert.deepEqual(ready.blocking, []);

const multiSubjectScene = {
  characters: [
    { id: 'subject-a', name: 'Subject A' },
    { id: 'subject-b', name: 'Subject B' },
  ],
  scenes: [{ id: 'scene-1', name: 'Scene 1' }],
  shots: [{
    id: 'multi-shot',
    index: 0,
    videoPrompt: 'Two subjects cross the room.',
    imagePrompt: 'A wide shot of two subjects crossing the room.',
    sourceText: 'Two subjects cross the room.',
    durationSeconds: 5,
    sceneId: 'scene-1',
    visibleCharacterIds: ['subject-a', 'subject-b'],
    characterIds: ['subject-a', 'subject-b'],
    characterBinding: 'explicit',
  }],
};
const multiSubjectBlocked = evaluatePipelinePreflight({
  channel: 'direct',
  sourceMode: 'multishot',
  options: fullOptions,
  sceneSpec: multiSubjectScene,
  providers: readyProviders,
  planningRequired: false,
  hasSpeech: false,
});
assert.ok(multiSubjectBlocked.blocking.some((issue) => issue.code === 'multi-subject-reference-unsupported'));

const semanticSlotProviders = {
  ...readyProviders,
  image: {
    ...readyProviders.image,
    imageCapabilities: {
      ...imageCapabilities,
      references: { ...imageCapabilities.references, supportsReferenceRoles: true },
    },
  },
};
const semanticSlotReady = evaluatePipelinePreflight({
  channel: 'direct',
  sourceMode: 'multishot',
  options: fullOptions,
  sceneSpec: multiSubjectScene,
  providers: semanticSlotProviders,
  planningRequired: false,
  hasSpeech: false,
});
assert.equal(semanticSlotReady.blocking.some((issue) => issue.code === 'multi-subject-reference-unsupported'), false);

const unsupportedPlannerParameters = evaluatePipelinePreflight({
  channel: 'direct',
  sourceMode: 'extract',
  options: fullOptions,
  sceneSpec: {
    ...sceneSpec,
    shots: [{
      id: 'shot-unsupported-parameters',
      imageParameters: { unsupportedImageParameter: true },
      videoParameters: { unsupportedVideoParameter: true },
      videoPrompt: 'A shot',
      sourceText: 'Narration',
    }],
  },
  providers: {
    image: readyProviders.image,
    video: readyProviders.video,
  },
  planningRequired: false,
  hasSpeech: false,
});
assert.equal(unsupportedPlannerParameters.ok, false);
assert.deepEqual(
  unsupportedPlannerParameters.blocking.map((issue) => issue.code),
  ['planner-parameter-unsupported', 'planner-parameter-unsupported'],
);
assert.deepEqual(
  unsupportedPlannerParameters.blocking.map((issue) => issue.shotId),
  ['shot-unsupported-parameters', 'shot-unsupported-parameters'],
);

const resumed = evaluatePipelinePreflight({
  channel: 'direct',
  sourceMode: 'multishot',
  startStage: 'video_generation',
  options: fullOptions,
  sceneSpec,
  providers: { video: readyProviders.video },
  planningRequired: false,
  hasSpeech: false,
});
assert.equal(resumed.ok, true);
assert.deepEqual(resumed.requiredCategories, ['video']);

console.log('pipeline preflight tests passed');

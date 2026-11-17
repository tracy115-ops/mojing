import assert from 'node:assert/strict';
import {
  filterGenerationParameters,
  formatCapabilitiesForPrompt,
  getLLMGenerationCapabilities,
  getImageGenerationCapabilities,
  getImageModelCapabilities,
  getVideoGenerationCapabilities,
  parseEndpointGenerationCapabilities,
  selectVideoControlMode,
  validateImageReferences,
  validateVideoReferences,
} from '../src/services/providers/provider-capabilities.ts';
import { applyUnconsumedGenerationParameters } from '../src/services/providers/parameter-transport.ts';
import { getAgnesImageOutput, getAgnesImageWireParameterSnapshot, normalizeAgnesImageSeed, pickAgnesImageRatio } from '../src/services/providers/image-wire-contract.ts';
import { hasCurrentTurnaround, needsTurnaroundGeneration } from '../src/services/video/core/character-asset-binding.ts';

const dalle = getImageGenerationCapabilities('dalle', 'dall-e-3');
assert.deepEqual(
  dalle.parameters.map((parameter) => parameter.key),
  ['model', 'size', 'quality', 'style'],
);
assert.ok(formatCapabilitiesForPrompt({
  ...dalle,
  availableModels: ['dall-e-3', 'dall-e-2'],
  modelCapabilities: getImageModelCapabilities('dalle', ['dall-e-3', 'dall-e-2']),
}).includes('availableModels=dall-e-3|dall-e-2'));

const kling = getVideoGenerationCapabilities('kling', 'kling-v2');
assert.equal(getLLMGenerationCapabilities('deepseek', 'deepseek-chat').supportsImageInputs, false);
assert.equal(getLLMGenerationCapabilities('custom', 'proxy-vision', 'ep-llm', {
  supportsImageInputs: true,
  maxImageInputs: 4,
}).maxImageInputs, 4);
const agnes = getImageGenerationCapabilities('agnes-image', 'agnes-image-2.1-flash');
assert.deepEqual([normalizeAgnesImageSeed(-1), normalizeAgnesImageSeed(0), normalizeAgnesImageSeed(999), normalizeAgnesImageSeed(1110732956), normalizeAgnesImageSeed(1127510575)], [-1, 0, 999, 956, 575]);
assert.throws(() => normalizeAgnesImageSeed(-2), /integer/);
assert.throws(() => normalizeAgnesImageSeed(1.5), /integer/);
assert.equal(getAgnesImageWireParameterSnapshot({ taskType: 'storyboard', prompt: 'frame', seed: 1110732956 }).seed, 956);
assert.equal(filterGenerationParameters({ seed: 1000 }, agnes).rejectedKeys[0], 'seed');
assert.equal(filterGenerationParameters({ seed: -1 }, agnes).values.seed, -1);
const agnesVideo = getVideoGenerationCapabilities('agnes-video', 'agnes-video-2.5-flash');
const agnesStandardVideo = getVideoGenerationCapabilities('agnes-video', 'agnes-video-2.5');
const agnesProVideo = getVideoGenerationCapabilities('agnes-video', 'agnes-video-2.5-pro');
const doubaoFastVideo = getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-0-fast-260128');
const doubaoStandardVideo = getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-0-260128');
assert.equal(agnes.references.supportsReferenceRoles, false);
assert.deepEqual(agnesVideo.resolutionTiers?.map((tier) => tier.id), ['720p']);
assert.deepEqual(agnesStandardVideo.resolutionTiers?.map((tier) => tier.id), ['720p', '1080p']);
assert.deepEqual(agnesProVideo.resolutionTiers?.map((tier) => tier.id), ['720p', '1080p']);
assert.deepEqual(doubaoFastVideo.resolutionTiers?.map((tier) => tier.id), ['720p']);
assert.deepEqual(doubaoStandardVideo.resolutionTiers?.map((tier) => tier.id), ['720p', '1080p']);
assert.equal(
  selectVideoControlMode({ hasFirstFrame: true, hasSubjectReferences: true }, agnesVideo),
  'keyframe',
);
assert.equal(
  selectVideoControlMode({
    hasFirstFrame: true,
    hasSubjectReferences: true,
    preferSubjectReferences: true,
  }, agnesVideo),
  'reference',
);
const agnesParameters = filterGenerationParameters({
  model: 'agnes-image-2.1-flash',
  aspectRatio: '16:9',
  negativePrompt: 'duplicate subjects',
  width: 1280,
}, agnes);
assert.deepEqual(agnesParameters.rejectedKeys, []);
assert.equal(agnesParameters.values.width, 1280);
assert.equal(agnesParameters.values.negativePrompt, 'duplicate subjects');
const agnesImageWire = getAgnesImageWireParameterSnapshot({
  taskType: 'storyboard',
  prompt: 'A storyboard frame.',
  model: 'agnes-image-2.1-flash',
  width: 1920,
  height: 1080,
  aspectRatio: '16:9',
  negativePrompt: 'duplicate subjects',
  referenceImages: ['data:image/png;base64,reference'],
});
assert.equal(agnesImageWire.size, '2K');
assert.equal(agnesImageWire.ratio, '16:9');
assert.equal(agnesImageWire.width, undefined);
assert.equal(agnesImageWire.height, undefined);
assert.equal(agnesImageWire.aspectRatio, undefined);
assert.equal(agnesImageWire.extra_body.response_format, 'b64_json');
assert.deepEqual(agnesImageWire.extra_body.image, { count: 1 });
assert.deepEqual(getAgnesImageOutput({ taskType: 'storyboard', prompt: 'frame', aspectRatio: '16:9' }), {
  size: '2K', ratio: '16:9', width: 2624, height: 1472,
});
assert.equal(getAgnesImageOutput({ taskType: 'character', prompt: 'portrait', size: '1K' }).size, '1K');
assert.equal(getAgnesImageOutput({ taskType: 'scene', prompt: 'scene', size: '4K' }).size, '4K');
assert.equal(getAgnesImageOutput({ taskType: 'storyboard', prompt: 'frame', width: 3840, height: 2160 }).size, '3K');
assert.throws(() => getAgnesImageOutput({ taskType: 'scene', prompt: 'scene', size: '8K' }), /size must be/);
for (const [width, height, ratio] of [[1600, 1200, '4:3'], [1200, 1600, '3:4'], [1500, 1000, '3:2'], [2100, 900, '21:9']]) {
  assert.equal(pickAgnesImageRatio(width, height), ratio, 'image framing must preserve the requested aspect');
}
assert.equal(agnesVideo.references.maxImages, 5);
assert.equal(agnesStandardVideo.references.maxImages, 8);
assert.equal(agnesVideo.parameters.find((parameter) => parameter.key === 'durationSeconds').max, 12);
assert.throws(() => validateVideoReferences({ controlMode: 'reference', referenceImages: Array(6).fill('ref') }, agnesVideo), /at most 5/);
assert.equal(getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-5-260628').references.supportsLastFrame, true);
assert.deepEqual(getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-5-flash-261115').resolutionTiers?.map((tier) => tier.id), ['720p']);
assert.equal(getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-5-260628').parameters.find((parameter) => parameter.key === 'durationSeconds').max, 30);

const valid = filterGenerationParameters({
  model: 'kling-v2',
  durationSeconds: 5,
  aspectRatio: '16:9',
  seed: 42,
}, { ...kling, availableModels: ['kling-v2'] });
assert.deepEqual(valid.rejectedKeys, []);
assert.deepEqual(valid.values, {
  model: 'kling-v2',
  durationSeconds: 5,
  aspectRatio: '16:9',
  seed: 42,
});

const invalid = filterGenerationParameters({
  model: 'not-advertised',
  durationSeconds: 7,
  aspectRatio: '2:1',
  seed: -1,
  unknown: true,
}, { ...kling, availableModels: ['kling-v2'] });
assert.deepEqual(invalid.rejectedKeys.sort(), ['aspectRatio', 'durationSeconds', 'model', 'seed', 'unknown']);
assert.deepEqual(invalid.values, {});

const override = {
  parameters: [
    { key: 'model', type: 'string', description: 'Model id.' },
    {
      key: 'quality',
      type: 'enum',
      description: 'Quality.',
      enumValues: ['draft', 'high'],
      transport: { key: 'quality_level', location: 'parameters' },
    },
  ],
  references: { supported: true, maxImages: 2, mode: 'multiple', supportsReferenceRoles: true },
};
const overridden = getImageGenerationCapabilities('custom', 'proxy-image', 'ep-image', override);
assert.deepEqual(overridden.parameters.map((parameter) => parameter.key), ['model', 'quality']);
assert.equal(overridden.references.maxImages, 2);
assert.equal(overridden.references.supportsReferenceRoles, true);
const videoOverride = {
  resolutionTiers: [{ id: 'custom-hd', label: 'Custom HD', shortEdge: 900 }],
};
assert.deepEqual(
  getVideoGenerationCapabilities('doubao-video', 'proxy-video', 'ep-video', videoOverride).resolutionTiers,
  videoOverride.resolutionTiers,
);
const transportedBody = { parameters: { existing: true } };
applyUnconsumedGenerationParameters(
  transportedBody,
  {
    parameters: { model: 'proxy-image', quality: 'high' },
    parameterSpecs: overridden.parameters,
  },
  ['model'],
);
assert.deepEqual(transportedBody, {
  parameters: { existing: true, quality_level: 'high' },
});
const modelContracts = getImageModelCapabilities(
  'custom',
  ['proxy-image', 'other-image'],
  'ep-image',
  { 'proxy-image': override },
);
assert.deepEqual(modelContracts[0].parameters.map((parameter) => parameter.key), ['model', 'quality']);
assert.deepEqual(modelContracts[1].parameters.map((parameter) => parameter.key), ['model', 'width', 'height']);
assert.deepEqual(
  parseEndpointGenerationCapabilities(JSON.stringify({ image: { 'proxy-image': override } })),
  { image: { 'proxy-image': override } },
);
assert.deepEqual(
  parseEndpointGenerationCapabilities(JSON.stringify({ video: { 'proxy-video': videoOverride } })),
  { video: { 'proxy-video': videoOverride } },
);
assert.deepEqual(
  parseEndpointGenerationCapabilities(JSON.stringify({ llm: { 'proxy-vision': { supportsImageInputs: true, maxImageInputs: 4 } } })),
  { llm: { 'proxy-vision': { supportsImageInputs: true, maxImageInputs: 4 } } },
);
assert.throws(
  () => parseEndpointGenerationCapabilities('{"image":{"proxy":{"parameters":[{"key":"x","type":"invalid","description":"x"}]}}}'),
  /type must be string, number, integer, boolean, or enum/,
);
assert.throws(
  () => parseEndpointGenerationCapabilities('{"image":{"proxy":{"parameters":[{"key":"x","type":"enum","description":"x"}]}}}'),
  /enumValues must contain at least one value/,
);

assert.throws(
  () => validateImageReferences(['ref'], dalle),
  /does not support reference images/,
);
const siliconT2V = getVideoGenerationCapabilities(
  'siliconflow-video',
  'Wan-AI/Wan2.2-T2V-A14B',
);
assert.throws(
  () => validateVideoReferences({
    controlMode: 'keyframe',
    firstFrame: 'ref',
  }, siliconT2V),
  /does not support reference material/,
);
const siliconI2V = getVideoGenerationCapabilities(
  'siliconflow-video',
  'Wan-AI/Wan2.1-I2V-14B-720P',
);
assert.doesNotThrow(() => validateVideoReferences({
  controlMode: 'keyframe',
  firstFrame: 'ref',
}, siliconI2V));

assert.equal(hasCurrentTurnaround({
  portraitImage: 'portrait-v2',
  turnaroundImage: 'turnaround-v2',
  turnaroundSourcePortrait: 'portrait-v2',
}), true);
assert.equal(hasCurrentTurnaround({
  portraitImage: 'portrait-v2',
  turnaroundImage: 'turnaround-v1',
}), false);
assert.equal(needsTurnaroundGeneration({
  portraitImage: 'portrait-v2',
  turnaroundImage: 'turnaround-v1',
  turnaroundSourcePortrait: 'portrait-v1',
}), true);

console.log('provider capability contract tests passed');

import assert from 'node:assert/strict';
import { initialStudioInput, normalizeStudioVideoInput } from '../src/services/video-studio/input.ts';
import { getVideoGenerationCapabilities } from '../src/services/providers/provider-capabilities.ts';
import { getShotSubtitleText } from '../src/services/video/core/shot-subtitles.ts';

const agnes = getVideoGenerationCapabilities('agnes-video', 'agnes-video-2.5-flash');
const h3 = getVideoGenerationCapabilities('siliconflow-video', 'MiniMaxAI/MiniMax-H3');
const firstFrameOnly = getVideoGenerationCapabilities('siliconflow-video', 'Wan-AI/Wan2.2-I2V-A14B');
const framed = {
  ...initialStudioInput(), controlMode: 'keyframe', durationSeconds: 10,
  firstFrameAssetId: 'lead-and-cat', lastFrameAssetId: 'courtyard-ending',
  audioReferenceAssetIds: ['dialogue'], videoReferenceAssetIds: ['motion'],
};
const textOnly = normalizeStudioVideoInput(framed, h3);
assert.equal(textOnly.controlMode, 'text');
assert.equal(textOnly.firstFrameAssetId, undefined, 'changing to a text-only model must not leave hidden first-frame controls');
assert.equal(textOnly.lastFrameAssetId, undefined);
assert.deepEqual(textOnly.audioReferenceAssetIds, []);
assert.deepEqual(textOnly.videoReferenceAssetIds, []);
assert.equal(textOnly.durationSeconds, 5, 'unsupported 10-second settings must not survive as an apparent model preset');
assert.equal(framed.firstFrameAssetId, 'lead-and-cat', 'normalization cannot mutate prior drafts');

const firstOnly = normalizeStudioVideoInput(framed, firstFrameOnly);
assert.equal(firstOnly.controlMode, 'keyframe');
assert.equal(firstOnly.firstFrameAssetId, 'lead-and-cat');
assert.equal(firstOnly.lastFrameAssetId, undefined, 'a supported first frame must survive removal of an unsupported last frame');

const subjectInput = { ...framed, controlMode: 'reference', referenceAssetIds: ['lead', 'cat'] };
const subjects = normalizeStudioVideoInput(subjectInput, agnes);
assert.deepEqual(subjects.referenceAssetIds, ['lead', 'cat']);
assert.equal(subjects.firstFrameAssetId, undefined, 'subject and temporal image controls cannot be mixed');
assert.equal(subjects.durationSeconds, 10, 'Agnes accepts the requested long shot without a slow-motion workaround');
assert.deepEqual(subjects.audioReferenceAssetIds, ['dialogue']);
assert.deepEqual(subjects.videoReferenceAssetIds, [], 'Flash does not accept video references');
assert.deepEqual(normalizeStudioVideoInput(subjects, h3).referenceAssetIds, []);

assert.equal(getShotSubtitleText({ dialogue: [{ speaker: '甲', text: '  等等我！ ' }], narration: '' }), '等等我！');
assert.equal(getShotSubtitleText({ dialogue: [{ speaker: '甲', text: '等等我！' }, { speaker: '乙', text: '快来。' }], narration: '等等我！' }), '等等我！\n快来。', 'legacy narration aliases must not duplicate the first spoken line');
assert.equal(getShotSubtitleText({ dialogue: [], narration: ' 门缓缓打开。 ' }), '门缓缓打开。');
assert.equal(getShotSubtitleText({ dialogue: [{ speaker: '甲', text: ' ' }], narration: '' }), null, 'a silent shot must not receive camera directions as captions');
assert.equal(getShotSubtitleText(undefined), null);
console.log('Live-video regressions passed: model transitions, supported durations, mixed reference controls, dialogue-only subtitles and silent shots.');

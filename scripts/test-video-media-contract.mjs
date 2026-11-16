import assert from 'node:assert/strict';
import { getVideoGenerationCapabilities, normalizeVideoReferences, parseEndpointGenerationCapabilities } from '../src/services/providers/provider-capabilities.ts';
import { buildVideoRequestSnapshot } from '../src/services/providers/generation-snapshot.ts';
import { assertPublicMediaUrl } from '../src/services/providers/video-media-contract.ts';
import { studioInputAssetIds, studioVideoMediaReferences } from '../src/services/video-studio/media.ts';
import { parseStudioBundle } from '../src/services/video-studio/document.ts';

const audio = { id: 'voice', url: 'https://cdn.example.com/voice.wav', durationSeconds: 5, mimeType: 'audio/wav' };
const video = { id: 'motion', url: 'https://cdn.example.com/motion.mp4', durationSeconds: 5, mimeType: 'video/mp4' };
const localAudio = { ...audio, url: 'data:audio/wav;base64,YXVkaW8=' };
const flash = getVideoGenerationCapabilities('agnes-video', 'agnes-video-2.5-flash');
const agnes = getVideoGenerationCapabilities('agnes-video', 'agnes-video-2.5');
const seed20 = getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-0-260128');
const seed25 = getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-5-260628');
const seedFlash = getVideoGenerationCapabilities('doubao-video', 'doubao-seedance-2-5-flash-261115');
assert.equal(flash.references.audio.maxCount, 3);
assert.equal(flash.references.video, undefined);
assert.equal(agnes.references.video.maxCount, 1);
assert.equal(seed20.references.audioRequiresVisual, true);
assert.equal(seed25.references.maxImages, 30);
assert.equal(seedFlash.references.maxImages, 10);
assert.equal(seed25.references.video.maxCount, 10);
assert.equal(seedFlash.references.audio.maxCount, 5);
assert.equal(seed25.references.audio.maxTotalSeconds, 30);

const normalized = normalizeVideoReferences({ audioReferences: [audio] }, flash);
assert.equal(normalized.controlMode, 'reference', 'audio alone must infer reference mode');
assert.deepEqual(normalized.audioReferences, [audio], 'audio is retained through normalization');
assert.deepEqual(normalizeVideoReferences({ videoReferences: [video] }, agnes).videoReferences, [video]);
assert.deepEqual(normalizeVideoReferences({ audioReferences: [localAudio] }, seed25).audioReferences, [localAudio]);
assert.throws(() => normalizeVideoReferences({ videoReferences: [video] }, flash), /does not support video/);
assert.throws(() => normalizeVideoReferences({ audioReferences: [localAudio] }, flash), /public audio URL/);
assert.throws(() => normalizeVideoReferences({ audioReferences: [audio] }, seed20), /requires an image or video/);
assert.doesNotThrow(() => normalizeVideoReferences({ audioReferences: [audio], videoReferences: [video] }, seed20));
assert.throws(() => normalizeVideoReferences({ controlMode: 'keyframe', firstFrame: 'image', audioReferences: [audio] }, seed25), /cannot be mixed/);
assert.throws(() => normalizeVideoReferences({ controlMode: 'text', audioReferences: [audio] }, flash), /require reference mode/);
assert.throws(() => normalizeVideoReferences({ audioReferences: Array.from({ length: 4 }, () => audio) }, flash), /at most 3/);
assert.throws(() => normalizeVideoReferences({ audioReferences: [{ ...audio, durationSeconds: 1 }] }, flash), /2–12 seconds/);
assert.throws(() => normalizeVideoReferences({ audioReferences: [{ ...audio, durationSeconds: 7 }, { ...audio, durationSeconds: 6 }] }, flash), /Total audio/);
assert.throws(() => normalizeVideoReferences({ audioReferences: [{ ...audio, sizeBytes: 16 * 1024 * 1024 }] }, seed25), /at most 15 MB/);
assert.throws(() => normalizeVideoReferences({ videoReferences: [{ ...video, mimeType: 'video/webm' }] }, seed25), /Unsupported video format/);
assert.throws(() => normalizeVideoReferences({ videoReferences: [{ ...video, url: 'data:video/mp4;base64,dmlkZW8=' }] }, seed25), /public video URL/);
assert.throws(() => normalizeVideoReferences({ videoReferences: [video, video] }, agnes), /at most 1 video/);
for (const url of ['http://localhost/file.mp4', 'http://127.1/file.mp4', 'http://192.168.1.2/file.mp4', 'http://[::1]/f.mp4', 'http://[::ffff:192.168.1.1]/f.mp4', 'file:///C:/file.mp4', 'https://u:p@example.com/f.mp4', 'http://asset.localhost/f.mp4']) assert.throws(() => assertPublicMediaUrl(url), /public|local/);
assert.equal(assertPublicMediaUrl(audio.url), audio.url);

const override = parseEndpointGenerationCapabilities(JSON.stringify({ video: { 'seedance-proxy': { references: seed25.references } } }));
assert.deepEqual(override.video['seedance-proxy'].references.audio, seed25.references.audio);
assert.throws(() => parseEndpointGenerationCapabilities(JSON.stringify({ video: { 'bad': { references: { ...seed25.references, audio: { ...seed25.references.audio, transport: 'anything' } } } } })), /transport/);

const request = { taskType: 'clip', prompt: 'Move in time with the audio', controlMode: 'reference', audioReferences: [audio], videoReferences: [video], generateAudio: true };
const snapshot = buildVideoRequestSnapshot(request, [], []);
assert.deepEqual(snapshot.referenceSlots.map((slot) => slot.mediaKind), ['audio', 'video']);
assert.ok(snapshot.referenceSlots.every((slot) => slot.payloadFingerprint.startsWith('fnv1a-')));
assert.ok(!JSON.stringify(snapshot).includes(audio.url), 'snapshots keep fingerprints, not media URLs/payloads');

const inputs = { referenceAssetIds: ['still'], firstFrameAssetId: 'still', audioReferenceAssetIds: ['voice'], videoReferenceAssetIds: ['motion'] };
assert.deepEqual(studioInputAssetIds(inputs), ['still', 'voice', 'motion']);
const refs = await studioVideoMediaReferences(inputs, [{ id: 'voice', kind: 'audio', name: 'Voice', url: 'C:/voice.wav', durationSeconds: 5 }, { id: 'motion', kind: 'video', name: 'Motion', url: 'data:video/mp4;base64,dmlkZW8=', sourceUrl: video.url, durationSeconds: 5 }], seed25, async () => localAudio.url);
assert.equal(refs.audioReferences[0].url, localAudio.url, 'local audio is read as data only when supported');
assert.equal(refs.videoReferences[0].url, video.url, 'portable embedded media retains its provider-readable public source');
const bundle = { canvas: { id: 'canvas', name: 'Media', nodes: [{ id: 'v', kind: 'video', name: 'Video', prompt: '', x: 0, y: 0, generation: { audioReferenceAssetIds: ['voice'], videoReferenceAssetIds: ['motion'] } }], edges: [] }, assets: [
  { id: 'voice', name: 'Voice', kind: 'audio', url: localAudio.url, category: 'reference' }, { id: 'motion', name: 'Motion', kind: 'video', url: video.url, category: 'reference' },
] };
const imported = parseStudioBundle(bundle, 'canvas');
assert.equal(imported.canvas.nodes[0].generation.audioReferenceAssetIds[0], imported.assets[0].id);
assert.equal(imported.canvas.nodes[0].generation.videoReferenceAssetIds[0], imported.assets[1].id);
assert.throws(() => parseStudioBundle({ ...bundle, assets: bundle.assets.slice(0, 1) }, 'canvas'), /missing a generation reference/);
assert.throws(() => parseStudioBundle({ ...bundle, assets: [{ ...bundle.assets[0], kind: 'image' }, bundle.assets[1]] }, 'canvas'), /incompatible generation reference/);
assert.throws(() => parseStudioBundle({ ...bundle, canvas: { ...bundle.canvas, nodes: [{ ...bundle.canvas.nodes[0], generation: { audioReferenceAssetIds: 'voice' } }] } }, 'canvas'), /Invalid canvas generation references/);
console.log('Video media contracts passed: native limits, modes, transport, snapshots and portable media references.');

import assert from 'node:assert/strict';
import { createWorld, createWorldObject, parseWorldDocument, parseStudioBundle } from '../src/services/video-studio/document.ts';
import { defaultWorldAnimationPlayback, worldAnimationRange, worldAnimationTimeAt } from '../src/services/video-studio/world-model-animation.ts';

const playback = { startTime: 2, inPoint: 1, outPoint: 3, speed: 2, loop: 'repeat' };
assert.deepEqual(defaultWorldAnimationPlayback(), { startTime: 0, inPoint: 0, speed: 1, loop: 'repeat' });
for (const [time, expected] of [[-1, 1], [0, 1], [2, 1], [2.25, 1.5], [2.75, 2.5], [3, 1], [3.25, 1.5], [10, 1]]) {
  assert.equal(worldAnimationTimeAt(playback, 4, time), expected, `trimmed repeat at ${time}`);
}
for (const time of [3, 5, 60]) assert.equal(worldAnimationTimeAt({ ...playback, loop: 'once' }, 4, time), 3);
assert.equal(worldAnimationTimeAt({ ...playback, loop: 'once' }, 4, 2.25), 1.5, 'backward seek after completion does not stay at the last pose');
assert.equal(worldAnimationTimeAt({ ...playback, speed: 0.5 }, 4, 3), 1.5);
assert.equal(worldAnimationTimeAt(undefined, 4, 4.5), 0.5, 'old worlds still repeat the entire clip at 1x');
assert.equal(worldAnimationTimeAt(undefined, 0, 20), 0);
assert.equal(worldAnimationTimeAt({ ...playback, inPoint: 10, outPoint: 12 }, 4, 20), 4, 'source ranges clamp to actual GLB duration');
assert.deepEqual(worldAnimationRange(playback, 2), { inPoint: 1, outPoint: 2, span: 1 });

const world = createWorld('Animation fixture'), object = createWorldObject('model', 'Animated prop');
object.assetId = 'mesh'; object.animationClip = 0; object.animationPlayback = playback; world.objects = [object];
const parsed = parseWorldDocument(world);
assert.deepEqual(parsed.objects[0].animationPlayback, playback);
assert.notEqual(parsed.objects[0].animationPlayback, playback, 'imported controls do not share mutable state');
const bundle = { format: 'mojing.world/1', world, assets: [{ id: 'mesh', kind: 'model', name: 'Prop.glb', url: 'data:model/gltf-binary;base64,Z2xURg==', category: 'reference' }] };
const imported = parseStudioBundle(bundle, 'world');
assert.deepEqual(imported.world.objects[0].animationPlayback, playback);
assert.equal(imported.world.objects[0].assetId, imported.assets[0].id);
assert.notEqual(imported.assets[0].id, 'mesh');
const canvas = { id: 'canvas', name: 'Animation canvas', nodes: [{ id: 'node', name: 'World', kind: 'world', worldId: world.id, x: 0, y: 0, prompt: '' }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const canvasCopy = parseStudioBundle({ canvas, worlds: [world], assets: bundle.assets }, 'canvas');
assert.deepEqual(canvasCopy.worlds[0].objects[0].animationPlayback, playback);
assert.equal(canvasCopy.canvas.nodes[0].worldId, canvasCopy.worlds[0].id);

const invalid = patch => assert.throws(() => parseWorldDocument({ ...world, objects: [{ ...object, animationPlayback: { ...playback, ...patch } }] }), /animation playback/);
for (const patch of [{ speed: 0 }, { speed: 4.01 }, { speed: NaN }, { speed: '2' }, { startTime: -1 }, { startTime: 61 }, { inPoint: -1 }, { inPoint: 3601 }, { outPoint: 1 }, { outPoint: 3601 }, { outPoint: Infinity }, { loop: 'pingpong' }]) invalid(patch);
for (const animationPlayback of [null, true, 'loop']) assert.throws(() => parseWorldDocument({ ...world, objects: [{ ...object, animationPlayback }] }), /animation playback/);
assert.throws(() => parseWorldDocument({ ...world, objects: [{ ...object, animationClip: undefined }] }), /animation playback/);
assert.throws(() => parseWorldDocument({ ...world, objects: [{ ...object, kind: 'actor' }] }), /animation playback/);
assert.equal(parseWorldDocument({ ...world, objects: [{ ...object, animationPlayback: undefined }] }).objects[0].animationPlayback, undefined);
console.log('World model animation passed: trimmed source ranges, speed, delayed start, repeat/hold endpoints, backward seek, legacy playback and portable document validation.');

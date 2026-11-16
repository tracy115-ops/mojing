import assert from 'node:assert/strict';
import { addWorldPath, createWorld, createWorldObject, parseStudioBundle, parseWorldDocument, worldCameraAt, worldTransformAt } from '../src/services/video-studio/document.ts';
import { cameraWithMove } from '../src/services/video-studio/world-animation.ts';
import { retimeWorldCamera, withWorldCameraAt, worldCameraContextAt, worldCameraPoseAt, worldPlaybackDuration, worldSequenceSpans } from '../src/services/video-studio/world-sequence.ts';

const world = createWorld('Coverage');
world.duration = 6;
world.objects = [addWorldPath(createWorldObject('actor', 'Lead'), [-3, 0, 0], [3, 0, 0], 6, 'walk')];
world.camera = cameraWithMove(world.camera, 'push', 6);
const original = structuredClone(world);
assert.equal(worldPlaybackDuration(world), 6);
assert.deepEqual(worldCameraPoseAt(world, 3), { ...worldCameraAt(world.camera, 3), focalLength: 35 }, 'legacy worlds keep the main camera');
world.cameraSequence = { enabled: true, shots: [
  { id: 'wide', name: 'Wide', duration: 2, camera: retimeWorldCamera(world.camera, 6, 2) },
  { id: 'reverse', name: 'Reverse', duration: 3, camera: { position: [-7, 2, 0], target: [0, 1, 0], focalLength: 85, keyframes: [] } },
] };
assert.equal(worldPlaybackDuration(world), 5);
assert.deepEqual(worldSequenceSpans(world).map(({ start, end }) => [start, end]), [[0, 2], [2, 5]]);
assert.equal(worldCameraContextAt(world, -100).time, 0);
assert.equal(worldCameraContextAt(world, 1.999).shot.id, 'wide');
assert.equal(worldCameraContextAt(world, 2).shot.id, 'reverse', 'exact cut selects the incoming camera');
assert.equal(worldCameraContextAt(world, 2).time, 0);
assert.equal(worldCameraContextAt(world, 5).time, 3);
assert.equal(worldCameraContextAt(world, 100).time, 3, 'the final camera holds at the sequence end');
assert.equal(worldCameraPoseAt(world, 2).focalLength, 85, 'focal length changes with the cut');
assert.deepEqual(worldCameraPoseAt(world, 2).position, [-7, 2, 0]);
assert.deepEqual(worldCameraPoseAt(world, 1).position, worldCameraAt(world.camera, 3).position, 'camera movement is retimed to shot duration');
assert.deepEqual(worldTransformAt(world.objects[0], 2).position, [-1, 0, 0], 'actors use continuous world time across cuts');
assert.deepEqual(worldTransformAt(world.objects[0], 6).position, [3, 0, 0]);
world.cameraSequence.shots[0].camera.position[0] = 99;
assert.deepEqual(world.camera, original.camera, 'camera snapshots cannot modify the main setup or bookmarks');

const changed = withWorldCameraAt(world, 2, { ...world.cameraSequence.shots[1].camera, focalLength: 50 });
assert.equal(changed.cameraSequence.shots[1].camera.focalLength, 50);
assert.equal(world.cameraSequence.shots[1].camera.focalLength, 85, 'editing a shot retains undo snapshots');
assert.deepEqual(changed.camera, original.camera);
assert.equal(changed.cameraSequence.shots[0], world.cameraSequence.shots[0]);
const disabled = { ...world, cameraSequence: { ...world.cameraSequence, enabled: false } };
assert.equal(worldPlaybackDuration(disabled), 6);
assert.deepEqual(worldCameraPoseAt(disabled, 3), { ...worldCameraAt(world.camera, 3), focalLength: 35 });
assert.equal(withWorldCameraAt(disabled, 2, { ...world.camera, focalLength: 40 }).camera.focalLength, 40);

const imported = parseStudioBundle(JSON.parse(JSON.stringify({ world, assets: [] })), 'world').world;
assert.notEqual(imported.id, world.id);
assert.deepEqual(imported.cameraSequence, world.cameraSequence, 'portable projects preserve independent camera snapshots and local timing');
const invalid = (sequence, pattern = /camera sequence/) => assert.throws(() => parseWorldDocument({ ...world, cameraSequence: sequence }), pattern);
const shot = world.cameraSequence.shots[1];
invalid(null);
invalid({ enabled: 1, shots: [] });
invalid({ enabled: true, shots: [] });
invalid({ enabled: false, shots: [shot, shot] });
invalid({ enabled: true, shots: [{ ...shot, duration: 0 }] });
invalid({ enabled: true, shots: [{ ...shot, duration: NaN }] });
invalid({ enabled: true, shots: [{ ...shot, duration: 61 }] });
invalid({ enabled: true, shots: [{ ...shot, duration: 31 }, { ...shot, id: 'other', duration: 30 }] });
invalid({ enabled: true, shots: Array.from({ length: 25 }, (_, i) => ({ ...shot, id: String(i), duration: 1 })) });
invalid({ enabled: true, shots: [{ ...shot, camera: { ...shot.camera, focalLength: Infinity } }] }, /camera/);
invalid({ enabled: true, shots: [{ ...shot, camera: { ...shot.camera, keyframes: [{ time: 3.1, position: [0, 0, 0], target: [0, 0, 1] }] } }] }, /keyframes/);
assert.equal(parseWorldDocument({ ...world, cameraSequence: { enabled: true, shots: [{ ...shot, duration: 0.25 }] } }).cameraSequence.shots[0].duration, 0.25);
assert.equal(parseWorldDocument({ ...world, cameraSequence: { enabled: false, shots: [] } }).cameraSequence.enabled, false);
console.log('World sequence contracts passed: cut boundaries, per-shot focal length, continuous actors, camera retiming, undo isolation, portable import and invalid document rejection.');

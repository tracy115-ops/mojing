import assert from 'node:assert/strict';
import { createWorld } from '../src/services/video-studio/document.ts';
import { worldMonitorCameraAt, worldMonitorLayout, worldMonitorSelection, worldMonitorSources, worldWithMonitorCamera } from '../src/services/video-studio/world-monitor.ts';

const world = createWorld('Monitor fixture'); world.duration = 6;
const front = { position: [0, 2, 8], target: [0, 1, 0], focalLength: 35, keyframes: [{ time: 0, position: [0, 2, 8], target: [0, 1, 0] }, { time: 6, position: [0, 2, 2], target: [0, 1, 0] }] };
const side = { position: [8, 2, 0], target: [0, 1, 0], focalLength: 85, keyframes: [] };
world.camera = structuredClone(front);
world.cameraBookmarks = [{ id: 'front', name: 'Front', camera: structuredClone(front) }, { id: 'side', name: 'Side', camera: structuredClone(side) }];
world.cameraSequence = { enabled: true, shots: [
  { id: 'opening', name: 'Opening', duration: 2, camera: { ...structuredClone(front), keyframes: [{ ...front.keyframes[0], time: 0 }, { ...front.keyframes[1], time: 2 }] } },
  { id: 'reverse', name: 'Reverse', duration: 4, camera: structuredClone(side) },
] };
assert.deepEqual(worldMonitorSources(world).map(s => s.id), ['program', 'main', 'bookmark:front', 'bookmark:side', 'shot:opening', 'shot:reverse']);
assert.deepEqual(worldMonitorSelection(world, undefined, 4), ['program', 'bookmark:front', 'bookmark:side', 'shot:opening']);
assert.deepEqual(worldMonitorSelection(world, ['bookmark:front', 'bookmark:front', 'missing', 'main'], 4), ['bookmark:front', '', '', 'main']);
assert.deepEqual(worldMonitorSelection(world, ['main'], 2), ['main', '']);
assert.deepEqual(worldMonitorSelection(createWorld('Empty'), undefined, 4), ['program', '', '', '']);
assert.deepEqual(worldMonitorSelection({ ...world, cameraBookmarks: [] }, ['program', 'bookmark:front'], 2), ['program', '']);
assert.equal(worldMonitorCameraAt(world, 'missing', 2), undefined);
assert.equal(worldMonitorCameraAt(world, 'program', 2).pose.focalLength, 85, 'program chooses incoming shot exactly at the cut');
assert.equal(worldMonitorCameraAt(world, 'main', 2).pose.focalLength, 35, 'main camera remains independent of program output');
assert.equal(worldMonitorCameraAt(world, 'bookmark:front', 3).pose.position[2], 5);
assert.deepEqual(worldMonitorCameraAt(world, 'shot:opening', 3).pose.position, [0, 2, 2]);
assert.equal(worldMonitorCameraAt(world, 'shot:opening', 3).phase, 'after');
assert.equal(worldMonitorCameraAt(world, 'shot:reverse', 1).phase, 'before');
assert.equal(worldMonitorCameraAt(world, 'shot:reverse', 1).localTime, 0);
assert.equal(worldMonitorCameraAt(world, 'shot:reverse', 3).localTime, 1);
assert.equal(worldMonitorCameraAt(world, 'shot:reverse', 3).phase, 'active');
assert.equal(worldMonitorCameraAt(world, 'program', 3).localTime, 1);
assert.equal(worldMonitorCameraAt(world, 'program', 99).localTime, 4);

const before = structuredClone(world), applied = worldWithMonitorCamera(world, 'bookmark:front', 3);
assert.equal(applied.cameraSequence.shots[1].camera.focalLength, 35);
assert.deepEqual(applied.cameraSequence.shots[1].camera.keyframes.map(f => f.time), [0, 4]);
assert.deepEqual(applied.cameraSequence.shots[0], world.cameraSequence.shots[0]);
assert.deepEqual(world, before, 'adoption does not mutate source cameras or other snapshots');
assert.notEqual(applied.cameraSequence.shots[1].camera, world.cameraBookmarks[0].camera);
applied.cameraSequence.shots[1].camera.position[0] = 100;
assert.equal(world.cameraBookmarks[0].camera.position[0], 0);
const single = { ...world, cameraSequence: { ...world.cameraSequence, enabled: false } };
assert.equal(worldWithMonitorCamera(single, 'bookmark:side', 1).camera.focalLength, 85);
assert.equal(worldWithMonitorCamera(single, 'shot:opening', 1).camera.keyframes.at(-1).time, 6);
assert.throws(() => worldWithMonitorCamera(world, 'deleted', 1), /Missing monitor camera/);

for (const [width, height, count] of [[1001, 501, 4], [1001, 501, 2], [301, 461, 2], [301, 461, 4]]) {
  const cells = worldMonitorLayout(width, height, count);
  assert.equal(cells.length, count); assert.equal(cells.reduce((n, cell) => n + cell.width * cell.height, 0), width * height);
  for (const a of cells) { assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= width && a.y + a.height <= height); for (const b of cells) if (a !== b) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y); }
}
assert.equal(worldMonitorLayout(519, 460, 2)[1].x, 0, 'narrow dual view stacks vertically');
assert.equal(worldMonitorLayout(520, 460, 2)[1].y, 0, 'wide dual view uses columns');
console.log('World monitor passed: source isolation, defaults/deletion, shared time and cut boundaries, curve adoption/retiming, and complete non-overlapping adaptive viewports.');

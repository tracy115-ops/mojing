import assert from 'node:assert/strict';
import {
  addWorldPath, canConnectCanvas, createStudioCanvas, createWorld, createWorldObject,
  parseStudioBundle, parseStudioCanvas, parseWorldDocument, upsertCameraKeyframe,
  upsertWorldKeyframe, worldCameraAt, worldTransformAt,
} from '../src/services/video-studio/document.ts';
import { actorPoseAt, actorPosePreset, cameraWithMove, timedWorldPath, worldWithDrawnPath } from '../src/services/video-studio/world-animation.ts';
import { duplicateCanvasNodes, groupCanvasNodes, layoutCanvasNodes, orderedCanvasNodes, ungroupCanvasNodes } from '../src/services/video-studio/canvas-graph.ts';

const canvas = createStudioCanvas('Shot development');
canvas.nodes = ['a', 'b', 'c'].map((id) => ({ id, kind: 'text', name: id, prompt: '', x: 0, y: 0 }));
assert.equal(canConnectCanvas(canvas, 'a', 'a'), false);
assert.equal(canConnectCanvas(canvas, 'missing', 'b'), false);
assert.equal(canConnectCanvas(canvas, 'a', 'b'), true);
canvas.edges = [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }];
assert.equal(canConnectCanvas(canvas, 'a', 'b'), false);
assert.equal(canConnectCanvas(canvas, 'c', 'a'), false, 'a downstream node cannot feed its own ancestors');
assert.deepEqual(orderedCanvasNodes(canvas, ['c', 'a', 'b']), ['a', 'b', 'c']);
assert.deepEqual(orderedCanvasNodes(canvas, ['c', 'b']), ['b', 'c'], 'dependencies outside the selection remain external inputs');
const duplicate = duplicateCanvasNodes(canvas, ['a', 'b']);
assert.equal(duplicate.canvas.nodes.length, 5);
assert.equal(duplicate.canvas.edges.length, 3, 'copy only edges internal to the duplicated subgraph');
assert.equal(duplicate.canvas.edges.at(-1).from, duplicate.ids[0]);
assert.equal(duplicate.canvas.edges.at(-1).to, duplicate.ids[1]);
const grouped = groupCanvasNodes(canvas, ['a', 'b'], 'Sequence');
assert.equal(grouped.groups.length, 1);
assert.deepEqual(grouped.groups[0].nodeIds, ['a', 'b']);
assert.equal(canvas.groups, undefined, 'grouping cannot mutate the source document');
const regrouped = groupCanvasNodes(grouped, ['b', 'c'], 'Revision');
assert.equal(regrouped.groups.length, 1, 'regrouping removes singleton remnants');
assert.deepEqual(regrouped.groups[0].nodeIds, ['b', 'c']);
assert.equal(ungroupCanvasNodes(grouped, ['a']).groups.length, 0);
const groupedCopy = duplicateCanvasNodes(grouped, ['a', 'b']);
assert.equal(groupedCopy.canvas.groups.length, 2);
assert.deepEqual(groupedCopy.canvas.groups[1].nodeIds, groupedCopy.ids);
assert.notEqual(groupedCopy.canvas.groups[1].id, grouped.groups[0].id);
assert.equal(duplicateCanvasNodes(grouped, ['a']).canvas.groups.length, 1, 'a single copied member does not join the original group');
assert.notEqual(parseStudioCanvas(grouped).groups[0].id, grouped.groups[0].id);
assert.throws(() => parseStudioCanvas({ ...grouped, groups: [...grouped.groups, { id: 'another', name: 'Bad', nodeIds: ['b', 'c'] }] }), /membership/);
assert.throws(() => parseStudioCanvas({ ...grouped, groups: [{ id: 'bad', name: 'Bad', nodeIds: ['a', 'missing'] }] }), /membership/);
assert.throws(() => parseStudioCanvas({ ...canvas, edges: [...canvas.edges, { from: 'c', to: 'a' }] }), /cyclic/);
assert.throws(() => parseStudioCanvas({ ...canvas, nodes: [...canvas.nodes, canvas.nodes[0]] }), /node/);
assert.equal(parseStudioCanvas({ ...canvas, viewport: { x: NaN, y: Infinity, zoom: 100 } }).viewport.zoom, 3);

const actor = createWorldObject('actor', 'Lead');
const walk = addWorldPath(actor, [-3, 0, 0], [3, 0, 0], 6, 'walk');
assert.deepEqual(worldTransformAt(walk, -1).position, [-3, 0, 0]);
assert.deepEqual(worldTransformAt(walk, 3).position, [0, 0, 0]);
assert.deepEqual(worldTransformAt(walk, 10).position, [3, 0, 0]);
assert.equal(walk.transform.rotation[1], Math.PI / 2);
const rotated = upsertWorldKeyframe(upsertWorldKeyframe(actor, 0, { ...actor.transform, rotation: [0, 170 * Math.PI / 180, 0] }), 2, { ...actor.transform, rotation: [0, -170 * Math.PI / 180, 0] });
assert.ok(Math.abs(worldTransformAt(rotated, 1).rotation[1] - Math.PI) < 1e-8, 'Euler interpolation must take the short path');
const replaced = upsertWorldKeyframe(upsertWorldKeyframe(actor, 1.0004, actor.transform), 1.0003, walk.transform);
assert.equal(replaced.keyframes.length, 2, 'a keyframe at the same millisecond is replaced, retaining the automatic opening frame');
assert.deepEqual(actor.keyframes, [], 'animation editing cannot mutate the source object');

const world = createWorld('Blocking');
world.duration = 6; world.objects = [walk];
world.camera = upsertCameraKeyframe(upsertCameraKeyframe(world.camera, 0, { position: [0, 2, 8], target: [0, 1, 0] }), 6, { position: [0, 2, 2], target: [2, 1, 0] });
assert.deepEqual(worldCameraAt(world.camera, 3), { position: [0, 2, 5], target: [1, 1, 0] });
assert.deepEqual(worldCameraAt(world.camera, -1).position, [0, 2, 8]);
assert.deepEqual(worldCameraAt(world.camera, 10).position, [0, 2, 2]);
const pushCamera = cameraWithMove(world.camera, 'push', 6);
assert.ok(worldCameraAt(pushCamera, 6).position[2] < worldCameraAt(pushCamera, 0).position[2]);
assert.equal(cameraWithMove(pushCamera, 'static', 6).keyframes.length, 0);
const path = timedWorldPath([[0, 0, 0], [1, 0, 0], [4, 0, 0]], 8);
assert.deepEqual(path.map((frame) => frame.time), [0, 2, 8], 'path speed depends on distance, not pointer sample count');
assert.throws(() => timedWorldPath([[0, 0, 0], [0, 0, 0]], 5), /distinct/);
const drawn = worldWithDrawnPath(world, walk.id, [[0, 0, 0], [2, 0, 0], [2, 0, 2]]);
assert.equal(drawn.objects[0].keyframes.length, 3);
assert.deepEqual(worldTransformAt(drawn.objects[0], 6).position, [2, 0, 2]);
const cameraPath = worldWithDrawnPath(world, 'camera', [[0, 0, 0], [5, 0, 0]]);
assert.equal(worldCameraAt(cameraPath.camera, 6).position[1], 2, 'a ground path preserves camera height');
const sitting = actorPosePreset('sit'), standing = actorPosePreset('stand');
const posed = upsertWorldKeyframe(upsertWorldKeyframe(actor, 0, actor.transform, standing), 4, actor.transform, sitting);
assert.equal(actorPoseAt(posed, 2).height, sitting.height / 2);
assert.ok(Math.abs(actorPoseAt(posed, 2).joints.leftHip[0] + Math.PI / 4) < 1e-8);
assert.deepEqual(upsertWorldKeyframe(posed, 4, walk.transform).keyframes.at(-1).pose, sitting, 'moving a keyed actor preserves its pose');
assert.notEqual(parseWorldDocument(world).id, world.id);
assert.throws(() => parseWorldDocument({ ...world, objects: [null] }), /object/);
assert.throws(() => parseWorldDocument({ ...world, duration: 2 }), /object|keyframes/);
assert.throws(() => parseWorldDocument({ ...world, lightIntensity: -1 }), /document/);
assert.throws(() => parseWorldDocument({ ...world, objects: [{ ...walk, pose: { height: 0, joints: { rightKnee: [NaN, 0, 0] } } }] }), /pose/);
assert.throws(() => parseWorldDocument({ ...world, camera: { ...world.camera, keyframes: [world.camera.keyframes[0], world.camera.keyframes[0]] } }), /keyframes/);

const modelAsset = { id: 'mesh', kind: 'model', name: 'Set.glb', url: 'data:model/gltf-binary;base64,Z2xURg==', category: 'reference', createdAt: new Date().toISOString() };
world.objects.push({ ...createWorldObject('model', 'Set'), assetId: 'mesh' });
canvas.nodes.push({ id: 'world-node', kind: 'world', name: 'Blocking', prompt: '', x: 300, y: 0, worldId: world.id });
const bundle = { canvas, worlds: [world], assets: [modelAsset] };
const imported = parseStudioBundle(bundle, 'canvas');
assert.notEqual(imported.canvas.id, canvas.id);
assert.notEqual(imported.worlds[0].id, world.id);
assert.notEqual(imported.assets[0].id, modelAsset.id);
assert.equal(imported.canvas.nodes.find((node) => node.kind === 'world').worldId, imported.worlds[0].id);
assert.equal(imported.worlds[0].objects.find((object) => object.kind === 'model').assetId, imported.assets[0].id);
assert.equal(world.objects.at(-1).assetId, 'mesh', 'import cannot overwrite the original bundle IDs');
const again = parseStudioBundle(bundle, 'canvas');
assert.notEqual(again.assets[0].id, imported.assets[0].id, 'importing twice must create independent documents');
assert.throws(() => parseStudioBundle({ ...bundle, assets: [] }, 'canvas'), /missing/);
assert.throws(() => parseStudioBundle({ ...bundle, assets: [modelAsset, modelAsset] }, 'canvas'), /asset/);
assert.throws(() => parseStudioBundle({ ...bundle, assets: [{ ...modelAsset, url: 'file:///C:/private.glb' }] }, 'canvas'), /asset/);
assert.throws(() => parseStudioBundle({ ...bundle, worlds: [] }, 'canvas'), /missing/);
const worldImport = parseStudioBundle({ world, assets: [modelAsset] }, 'world');
assert.equal(worldImport.world.objects.at(-1).assetId, worldImport.assets[0].id);
console.log('Video studio contracts passed: graph cycles, atomic bundle validation, ID isolation, animation and camera keyframes.');

const layoutDoc = { ...createStudioCanvas('Layout'), nodes: [
  { id:'a', kind:'text', name:'A', prompt:'', x:0, y:40, width:220, height:300 },
  { id:'b', kind:'text', name:'B', prompt:'', x:500, y:100, width:300, height:400 },
  { id:'c', kind:'text', name:'C', prompt:'', x:1000, y:200, width:400, height:500 },
] };
assert.deepEqual(layoutCanvasNodes(layoutDoc, ['a','b','c'], 'right').nodes.map(n=>n.x),[1180,1100,1000]);
assert.deepEqual(layoutCanvasNodes(layoutDoc, ['a','b','c'], 'bottom').nodes.map(n=>n.y),[400,300,200]);
assert.deepEqual(layoutCanvasNodes(layoutDoc, ['a','b','c'], 'distributeX').nodes.map(n=>n.x),[0,460,1000]);
assert.deepEqual(layoutCanvasNodes(layoutDoc, ['a','b','c'], 'centerX').nodes.map(n=>n.x),[590,550,500]);
assert.deepEqual(layoutCanvasNodes(layoutDoc, ['a'], 'front').nodes.map(n=>n.id),['b','c','a']);
assert.deepEqual(layoutCanvasNodes(layoutDoc, ['c'], 'back').nodes.map(n=>n.id),['c','a','b']);
const lockedLayout = {...layoutDoc, nodes:layoutDoc.nodes.map(n=>n.id==='a'?{...n,layoutLocked:true}:n),groups:[{id:'g',name:'G',nodeIds:['a','b']}]};
assert.deepEqual(layoutCanvasNodes(lockedLayout,['a','b','c'],'left').nodes,lockedLayout.nodes,'partially locked groups cannot be split by alignment');
assert.deepEqual(parseStudioCanvas(lockedLayout).nodes,lockedLayout.nodes.map(n=>({...n, assetId:undefined, worldId:undefined, generation:undefined, layoutLocked:n.layoutLocked})));
assert.throws(()=>parseStudioCanvas({...layoutDoc,nodes:[{...layoutDoc.nodes[0],width:Infinity}]}),/size/);
assert.throws(()=>parseStudioCanvas({...layoutDoc,nodes:[{...layoutDoc.nodes[0],height:20}]}),/size/);
assert.equal(layoutDoc.nodes[1].x,500,'layout operations leave undo snapshots intact');
console.log('Canvas measured geometry, layer order, locked groups and import validation passed.');

import type { ActorPose, StudioAsset, StudioCanvas, StudioNode, Vec3, WorldCamera, WorldDocument, WorldObject, WorldTransform } from '../../types/video-studio.ts';
import { validateStudioImageEdit } from './image-edit-input.ts';
import { withoutCloudUpload } from './upload-contract.ts';
import { isWorldPropId, populateWorldSet, type WorldPropId, type WorldTemplate } from './world-sets.ts';

export const studioId = () => crypto.randomUUID();
export const studioNow = () => new Date().toISOString();
export const WORLD_SEQUENCE_MAX_SHOTS = 24;
export const WORLD_SEQUENCE_MAX_DURATION = 60;
export const WORLD_SEQUENCE_MIN_SHOT_DURATION = 0.25;
export const unitTransform = (): WorldTransform => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

export function createStudioCanvas(name: string): StudioCanvas {
  return { id: studioId(), name, nodes: [], edges: [], viewport: { x: 80, y: 80, zoom: 1 }, updatedAt: studioNow() };
}
export function createWorld(name: string): WorldDocument {
  return {
    id: studioId(), name, objects: [], camera: { position: [6, 4, 8], target: [0, 1, 0], focalLength: 35, keyframes: [] },
    duration: 5, fps: 24, aspectRatio: '16:9', environment: 'day', lightIntensity: 2.5,
    groundColor: '#777e74', markerA: [-3, 0, 0], markerB: [3, 0, 0], updatedAt: studioNow(),
  };
}
export function createWorldObject(kind: WorldObject['kind'], name: string): WorldObject {
  return { id: studioId(), kind, name, color: kind === 'actor' ? '#c08a66' : '#78958d', transform: unitTransform(), keyframes: [], visible: true };
}

export function worldFromTemplate(name: string, template: WorldTemplate, actorName: string, labels = { backdrop: 'Backdrop', table: 'Table', building: 'Building' }, propName: (id: WorldPropId) => string = id => id): WorldDocument {
  const world = createWorld(name);
  if (template === 'empty') return world;
  if (template === 'town' || template === 'courtyard') return populateWorldSet(world, template, actorName, propName);
  const left = createWorldObject('actor', `${actorName} A`), right = createWorldObject('actor', `${actorName} B`);
  left.transform.position = [-1.5, 0, 0]; left.transform.rotation[1] = Math.PI / 2;
  right.transform.position = [1.5, 0, 0]; right.transform.rotation[1] = -Math.PI / 2; right.color = '#819db7';
  world.objects.push(left, right);
  if (template === 'studio') {
    const backdrop = createWorldObject('box', labels.backdrop); backdrop.transform.position = [0, 0, -3]; backdrop.transform.scale = [10, 4, 0.2]; backdrop.color = '#b4b0a3';
    const table = createWorldObject('box', labels.table); table.transform.position = [0, 0, -0.7]; table.transform.scale = [2, 0.8, 0.8]; table.color = '#9f7959'; world.objects.push(backdrop, table);
    world.camera.position = [0, 2.2, 7]; world.camera.target = [0, 1.1, 0];
  } else {
    world.objects = [addWorldPath(left, world.markerA, world.markerB, world.duration, 'walk')];
    for (let i = 0; i < 4; i++) for (const side of [-1, 1]) {
      const building = createWorldObject('building', `${labels.building} ${i + 1}-${side}`); building.transform.position = [side * 6, 0, i * 5 - 7]; building.color = side < 0 ? '#a49a89' : '#9aa5a9'; world.objects.push(building);
    }
    world.camera.position = [8, 3, 10];
  }
  return world;
}

export function parseWorldDocument(value: unknown): WorldDocument {
  const doc = value as WorldDocument;
  const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000);
  const transform = (v: WorldTransform) => v && vec(v.position) && vec(v.rotation) && vec(v.scale) && v.scale.every((n) => n > 0 && n <= 100);
  const pose = (v: ActorPose | undefined) => v === undefined || v && typeof v === 'object' && Number.isFinite(v.height) && Math.abs(v.height) <= 10 && v.joints && typeof v.joints === 'object' && Object.entries(v.joints).every(([joint, rotation]) => ['spine', 'head', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee'].includes(joint) && vec(rotation));
  if (!doc || typeof doc.name !== 'string' || !Array.isArray(doc.objects) || doc.objects.length > 300 || !vec(doc.markerA) || !vec(doc.markerB) || !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(doc.aspectRatio) || !['day', 'sunset', 'night', 'fog'].includes(doc.environment) || !Number.isFinite(doc.duration) || doc.duration < 1 || doc.duration > 60 || !/^#[0-9a-f]{6}$/i.test(doc.groundColor) || !Number.isFinite(doc.lightIntensity) || doc.lightIntensity < 0 || doc.lightIntensity > 6) throw new Error('Invalid world document');
  const checkCamera = (camera: WorldCamera, duration: number) => {
    if (!camera || !vec(camera.position) || !vec(camera.target) || !Array.isArray(camera.keyframes) || !Number.isFinite(camera.focalLength) || camera.focalLength < 12 || camera.focalLength > 200) throw new Error('Invalid world camera');
    if (camera.keyframes.length > 1000 || camera.keyframes.some((frame) => !frame || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > duration + 1e-6 || !vec(frame.position) || !vec(frame.target)) || new Set(camera.keyframes.map((frame) => frame.time)).size !== camera.keyframes.length) throw new Error('Invalid camera keyframes');
  };
  checkCamera(doc.camera, doc.duration);
  const ids = new Set<string>();
  for (const object of doc.objects) {
    if (!object || typeof object.id !== 'string' || ids.has(object.id) || !['actor', 'box', 'sphere', 'cylinder', 'tree', 'building', 'model'].includes(object.kind) || typeof object.name !== 'string' || typeof object.visible !== 'boolean' || object.motion && !['idle', 'walk', 'run', 'wave'].includes(object.motion) || !/^#[0-9a-f]{6}$/i.test(object.color) || !transform(object.transform) || !Array.isArray(object.keyframes) || object.keyframes.length > 1000 || object.keyframes.some((frame) => !frame || !Number.isFinite(frame.time) || frame.time < 0 || frame.time > doc.duration || !transform(frame.transform)) || new Set(object.keyframes.map((frame) => frame.time)).size !== object.keyframes.length) throw new Error('Invalid world object');
    ids.add(object.id);
    if (object.builtinModel !== undefined && (object.kind !== 'model' || object.assetId !== undefined || !isWorldPropId(object.builtinModel))) throw new Error('Invalid built-in world prop');
    if (!pose(object.pose) || object.keyframes.some((frame) => !pose(frame.pose))) throw new Error('Invalid actor pose');
    if (object.animationClip !== undefined && (!Number.isInteger(object.animationClip) || object.animationClip < 0 || object.animationClip > 1000)) throw new Error('Invalid model animation clip');
    if (object.animationPlayback !== undefined) {
      const playback = object.animationPlayback;
      if (!playback || object.kind !== 'model' || object.animationClip === undefined || !Number.isFinite(playback.startTime) || playback.startTime < 0 || playback.startTime > 60 || !Number.isFinite(playback.inPoint) || playback.inPoint < 0 || playback.inPoint > 3600 || playback.outPoint !== undefined && (!Number.isFinite(playback.outPoint) || playback.outPoint <= playback.inPoint || playback.outPoint > 3600) || !Number.isFinite(playback.speed) || playback.speed < 0.1 || playback.speed > 4 || !['repeat', 'once'].includes(playback.loop)) throw new Error('Invalid model animation playback');
    }
  }
  if (doc.cameraBookmarks !== undefined) {
    if (!Array.isArray(doc.cameraBookmarks) || doc.cameraBookmarks.length > 50 || new Set(doc.cameraBookmarks.map((item) => item?.id)).size !== doc.cameraBookmarks.length) throw new Error('Invalid saved cameras');
    for (const item of doc.cameraBookmarks) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error('Invalid saved camera');
      checkCamera(item.camera, doc.duration);
    }
  }
  if (doc.cameraSequence !== undefined) {
    const sequence = doc.cameraSequence;
    if (!sequence || typeof sequence.enabled !== 'boolean' || !Array.isArray(sequence.shots) || sequence.shots.length > WORLD_SEQUENCE_MAX_SHOTS || new Set(sequence.shots.map((shot) => shot?.id)).size !== sequence.shots.length) throw new Error('Invalid camera sequence');
    let duration = 0;
    for (const shot of sequence.shots) {
      if (!shot || typeof shot.id !== 'string' || !shot.id || typeof shot.name !== 'string' || !Number.isFinite(shot.duration) || shot.duration < WORLD_SEQUENCE_MIN_SHOT_DURATION || shot.duration > WORLD_SEQUENCE_MAX_DURATION) throw new Error('Invalid camera sequence shot');
      duration += shot.duration;
      checkCamera(shot.camera, shot.duration);
    }
    if (duration > WORLD_SEQUENCE_MAX_DURATION + 1e-6 || sequence.enabled && !sequence.shots.length) throw new Error('Invalid camera sequence duration');
  }
  return { ...structuredClone(doc), id: studioId(), fps: [15, 24, 25, 30].includes(doc.fps) ? doc.fps : 24, updatedAt: studioNow() };
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const mixVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
export function worldCameraAt(camera: WorldCamera, time: number): Pick<WorldCamera, 'position' | 'target'> {
  const frames = [...camera.keyframes].sort((a, b) => a.time - b.time);
  if (!frames.length) return { position: camera.position, target: camera.target };
  const a = [...frames].reverse().find((frame) => frame.time <= time) ?? frames[0];
  const b = frames.find((frame) => frame.time >= time) ?? frames[frames.length - 1];
  const t = a.time === b.time ? 0 : (time - a.time) / (b.time - a.time);
  return { position: mixVec3(a.position, b.position, t), target: mixVec3(a.target, b.target, t) };
}
export function upsertCameraKeyframe(camera: WorldCamera, time: number, value: Pick<WorldCamera, 'position' | 'target'>): WorldCamera {
  const rounded = Math.round(time * 1000) / 1000;
  const initial = !camera.keyframes.length && rounded > 0 ? [{ time: 0, position: camera.position, target: camera.target }] : [];
  return { ...camera, keyframes: [...initial, ...camera.keyframes.filter((frame) => frame.time !== rounded), { time: rounded, ...structuredClone(value) }].sort((a, b) => a.time - b.time) };
}
export function worldTransformAt(object: WorldObject, time: number): WorldTransform {
  const frames = [...object.keyframes].sort((a, b) => a.time - b.time);
  if (!frames.length) return object.transform;
  if (time <= frames[0].time) return frames[0].transform;
  if (time >= frames[frames.length - 1].time) return frames[frames.length - 1].transform;
  const right = frames.findIndex((frame) => frame.time > time);
  const a = frames[right - 1], b = frames[right];
  const t = (time - a.time) / (b.time - a.time);
  const rotation = a.transform.rotation.map((value, i) => {
    const delta = Math.atan2(Math.sin(b.transform.rotation[i] - value), Math.cos(b.transform.rotation[i] - value));
    return value + delta * t;
  }) as Vec3;
  return { position: mixVec3(a.transform.position, b.transform.position, t), rotation, scale: mixVec3(a.transform.scale, b.transform.scale, t) };
}
export function upsertWorldKeyframe(object: WorldObject, time: number, transform: WorldTransform, pose?: ActorPose): WorldObject {
  const rounded = Math.round(time * 1000) / 1000;
  const initial = !object.keyframes.length && rounded > 0 ? [{ time: 0, transform: object.transform, pose: object.pose }] : [];
  return { ...object, keyframes: [...initial, ...object.keyframes.filter((frame) => frame.time !== rounded), { time: rounded, transform: structuredClone(transform), pose: structuredClone(pose ?? object.keyframes.find((frame) => frame.time === rounded)?.pose ?? object.pose) }].sort((a, b) => a.time - b.time) };
}
export function addWorldPath(object: WorldObject, from: Vec3, to: Vec3, duration: number, motion: 'walk' | 'run'): WorldObject {
  const rotation: Vec3 = [0, Math.atan2(to[0] - from[0], to[2] - from[2]), 0];
  const start = { ...object.transform, position: [...from] as Vec3, rotation };
  return { ...object, motion, transform: start, keyframes: [{ time: 0, transform: start }, { time: duration, transform: { ...start, position: [...to] as Vec3 } }] };
}

/** Graph references have one direction. Reject cycles before they can become generation dependencies. */
export function canConnectCanvas(canvas: StudioCanvas, from: string, to: string): boolean {
  if (from === to || !canvas.nodes.some((n) => n.id === from) || !canvas.nodes.some((n) => n.id === to)) return false;
  if (canvas.edges.some((edge) => edge.from === from && edge.to === to)) return false;
  const pending = [to], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === from) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...canvas.edges.filter((edge) => edge.from === id).map((edge) => edge.to));
  }
  return true;
}

const finite = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
/** Import is atomic: malformed or oversized graphs never replace a saved canvas. Media stays in the library. */
export function parseStudioCanvas(value: unknown): StudioCanvas {
  const data = value as Partial<StudioCanvas>;
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || data.nodes.length > 1000 || data.edges.length > 4000) throw new Error('Invalid canvas document');
  const kinds = ['image', 'video', 'audio', 'text', 'model', 'world'];
  const ids = new Set<string>();
  const nodes: StudioNode[] = data.nodes.map((node) => {
    if (!node || typeof node.id !== 'string' || ids.has(node.id) || !kinds.includes(node.kind)) throw new Error('Invalid canvas node');
    ids.add(node.id);
    for (const key of ['width', 'height'] as const) {
      if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]) || node[key]! < (key === 'width' ? 220 : 300) || node[key]! > 1600)) throw new Error('Invalid canvas node size');
    }
    if (node.layoutLocked !== undefined && typeof node.layoutLocked !== 'boolean') throw new Error('Invalid canvas layout lock');
    if (node.generation) {
      validateStudioImageEdit({ ...node.generation, kind: node.kind === 'image' ? 'image' : node.kind === 'video' ? 'video' : 'text' });
      for (const key of ['referenceAssetIds', 'audioReferenceAssetIds', 'videoReferenceAssetIds'] as const) {
        const references = node.generation[key];
        if (references !== undefined && (!Array.isArray(references) || references.length > 100 || references.some((id) => typeof id !== 'string' || !id))) throw new Error('Invalid canvas generation references');
      }
      if (node.generation.controlMode && !['text', 'reference', 'keyframe'].includes(node.generation.controlMode)) throw new Error('Invalid canvas reference mode');
    }
    return { id: node.id, kind: node.kind, name: String(node.name ?? '').slice(0, 200), prompt: String(node.prompt ?? ''), x: finite(node.x), y: finite(node.y), width: node.width, height: node.height, layoutLocked: node.layoutLocked, assetId: typeof node.assetId === 'string' ? node.assetId : undefined, worldId: typeof node.worldId === 'string' ? node.worldId : undefined, generation: node.generation && typeof node.generation === 'object' ? structuredClone(node.generation) : undefined };
  });
  const canvas = { ...createStudioCanvas(String(data.name || 'Canvas')), nodes };
  for (const edge of data.edges) {
    if (!edge || !canConnectCanvas(canvas, edge.from, edge.to)) throw new Error('Invalid or cyclic canvas edge');
    canvas.edges.push({ id: studioId(), from: edge.from, to: edge.to });
  }
  if (data.groups !== undefined) {
    if (!Array.isArray(data.groups) || data.groups.length > nodes.length) throw new Error('Invalid canvas groups');
    const members = new Set<string>(), groupIds = new Set<string>();
    canvas.groups = data.groups.map((group) => {
      if (!group || typeof group.id !== 'string' || groupIds.has(group.id) || typeof group.name !== 'string' || !Array.isArray(group.nodeIds) || group.nodeIds.length < 2) throw new Error('Invalid canvas group');
      groupIds.add(group.id);
      for (const id of group.nodeIds) {
        if (!ids.has(id) || members.has(id)) throw new Error('Invalid canvas group membership');
        members.add(id);
      }
      return { id: studioId(), name: group.name.slice(0, 200), nodeIds: [...group.nodeIds] };
    });
  }
  canvas.viewport = { x: finite(data.viewport?.x, 80), y: finite(data.viewport?.y, 80), zoom: Math.max(0.15, Math.min(3, finite(data.viewport?.zoom, 1))) };
  return canvas;
}

/** Validate the complete bundle before importing anything. Every ID is remapped to preserve existing documents. */
export function parseStudioBundle(value: unknown, kind: 'canvas' | 'world'): { canvas?: StudioCanvas; world?: WorldDocument; worlds: WorldDocument[]; assets: StudioAsset[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid studio bundle');
  const data = value as { canvas?: unknown; world?: unknown; worlds?: unknown[]; assets?: StudioAsset[] };
  const rawAssets = data.assets ?? [];
  if (!Array.isArray(rawAssets) || rawAssets.length > 2000) throw new Error('Invalid bundle assets');
  const assetIds = new Map<string, string>();
  const assets = rawAssets.map((asset) => {
    if (!asset || typeof asset.id !== 'string' || assetIds.has(asset.id) || !['image', 'video', 'audio', 'model', 'text'].includes(asset.kind) || typeof asset.name !== 'string' || !['character', 'scene', 'prop', 'reference', 'output'].includes(asset.category) || asset.kind === 'text' && typeof asset.text !== 'string' || asset.kind !== 'text' && (typeof asset.url !== 'string' || !/^(data:|https?:)/i.test(asset.url))) throw new Error('Invalid bundled asset');
    const id = studioId(); assetIds.set(asset.id, id);
    if (asset.tags !== undefined && (!Array.isArray(asset.tags) || asset.tags.length > 20 || asset.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40))) throw new Error('Invalid asset tags');
    return { ...structuredClone(withoutCloudUpload(asset)), id, folderId: undefined, jobId: undefined, worldId: undefined, createdAt: studioNow() };
  });
  const rawWorlds = kind === 'world' ? [data.world ?? value] : data.worlds ?? [];
  if (!Array.isArray(rawWorlds) || rawWorlds.length > 300) throw new Error('Invalid bundled worlds');
  const worldIds = new Map<string, string>();
  const worlds = rawWorlds.map((raw) => {
    const world = parseWorldDocument(raw);
    const oldId = (raw as WorldDocument).id;
    if (typeof oldId !== 'string' || worldIds.has(oldId)) throw new Error('Invalid bundled world ID');
    worldIds.set(oldId, world.id);
    world.objects = world.objects.map((object) => {
      const assetId = object.assetId ? assetIds.get(object.assetId) : undefined;
      if (object.assetId && !assetId) throw new Error('The world bundle is missing a model asset');
      return { ...object, assetId };
    });
    return world;
  });
  if (kind === 'world') return { world: worlds[0], worlds, assets };
  const canvas = parseStudioCanvas(data.canvas ?? value);
  canvas.nodes = canvas.nodes.map((node) => {
    const assetId = node.assetId ? assetIds.get(node.assetId) : undefined;
    const worldId = node.worldId ? worldIds.get(node.worldId) : undefined;
    if (node.assetId && !assetId || node.kind === 'world' && node.worldId && !worldId) throw new Error('The canvas bundle is missing a referenced asset or world');
    const remap = (id: string | undefined, kind: StudioAsset['kind'] = 'image') => {
      if (!id) return undefined;
      const mapped = assetIds.get(id);
      if (!mapped) throw new Error('The canvas bundle is missing a generation reference');
      if (rawAssets.find((asset) => asset.id === id)?.kind !== kind) throw new Error('The canvas bundle has an incompatible generation reference');
      return mapped;
    };
    return { ...node, assetId, worldId, generation: node.generation ? { ...node.generation,
      referenceAssetIds: (node.generation.referenceAssetIds ?? []).map((id) => remap(id)!),
      audioReferenceAssetIds: (node.generation.audioReferenceAssetIds ?? []).map((id) => remap(id, 'audio')!),
      videoReferenceAssetIds: (node.generation.videoReferenceAssetIds ?? []).map((id) => remap(id, 'video')!),
      firstFrameAssetId: remap(node.generation.firstFrameAssetId), lastFrameAssetId: remap(node.generation.lastFrameAssetId), recipeId: undefined,
      imageEdit: node.generation.imageEdit ? { ...node.generation.imageEdit, sourceAssetId: remap(node.generation.imageEdit.sourceAssetId)!, maskAssetId: remap(node.generation.imageEdit.maskAssetId)! } : undefined,
    } : undefined };
  });
  return { canvas, worlds, assets };
}

import type { Vec3, WorldDocument, WorldObject } from '../../types/video-studio.ts';

export const WORLD_TEMPLATES = ['town', 'courtyard', 'studio', 'street', 'empty'] as const;
export type WorldTemplate = typeof WORLD_TEMPLATES[number];
export const WORLD_PROP_IDS = ['house', 'shop', 'tower', 'paving', 'fountain', 'tree', 'tree-round', 'stall-red', 'stall-green', 'cart', 'lantern', 'bench', 'fence', 'rock'] as const;
export type WorldPropId = typeof WORLD_PROP_IDS[number];
export const isWorldPropId = (value: unknown): value is WorldPropId => typeof value === 'string' && WORLD_PROP_IDS.includes(value as WorldPropId);

/** Each preset is a bundled, self-contained CC0 GLB, with no network service. */
export function createWorldProp(id: WorldPropId, name: string): WorldObject {
  return { id: crypto.randomUUID(), kind: 'model', builtinModel: id, name, color: '#b9a17e', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [], visible: true };
}

export function populateWorldSet(world: WorldDocument, template: 'town' | 'courtyard', actorName: string, propName: (id: WorldPropId) => string): WorldDocument {
  const add = (id: WorldPropId, position: Vec3, yaw = 0, scale = 1) => {
    const object = createWorldProp(id, `${propName(id)} ${world.objects.filter(o => o.builtinModel === id).length + 1}`);
    object.transform = { position, rotation: [0, yaw, 0], scale: [scale, scale, scale] }; world.objects.push(object); return object;
  };
  world.groundColor = '#899579'; world.environment = 'sunset'; world.lightIntensity = 3;
  add('paving', [0, 0, 0]);
  add('fountain', [0, .03, -1]);
  if (template === 'town') {
    add('tower', [0, .03, -8]);
    for (const side of [-1, 1]) {
      for (const [index, z] of [-6, 0, 6].entries()) add(index === 1 ? 'shop' : 'house', [side * 7.5, .03, z], side * Math.PI / 2, index === 2 ? .9 : 1);
      add('house', [side * 6, .03, -11], 0, .85);
      for (const z of [-9, -3, 4, 10]) add(z === 4 ? 'tree-round' : 'tree', [side * 11, 0, z], side, z === -3 ? .8 : 1);
      for (const z of [-5, 3, 8]) add('lantern', [side * 4.6, .03, z]);
      for (const z of [-4, 2]) add(side < 0 ? 'stall-red' : 'stall-green', [side * 3.8, .03, z], side * Math.PI / 2);
      add('bench', [side * 2.5, .03, -1], side * Math.PI / 2);
      add('cart', [side * 5, .03, 5], side * .3);
      for (let i = 0; i < 3; i++) add('fence', [side * (6 + i * 1.9), 0, 10.5], Math.PI / 2);
      add('rock', [side * 11.2, 0, -6], side);
    }
    world.camera = { position: [22, 18, 25], target: [0, 1.6, -1], focalLength: 30, keyframes: [] };
  } else {
    // A smaller enclosed set for dialogue and close camera blocking.
    add('shop', [-6.5, .03, -4], Math.PI / 2); add('house', [6.5, .03, -4], -Math.PI / 2);
    add('house', [0, .03, -8], 0);
    for (const side of [-1, 1]) {
      add('tree-round', [side * 6, 0, 3]); add('bench', [side * 3.3, .03, 1], side * Math.PI / 2);
      add('lantern', [side * 3.7, .03, -3.7]); add('stall-green', [side * 6, .03, -8], 0);
      for (let i = 0; i < 3; i++) add('fence', [side * (2 + i * 2), 0, 6], Math.PI / 2);
    }
    world.camera = { position: [14, 11, 17], target: [0, 1.1, -1], focalLength: 30, keyframes: [] };
  }
  world.markerA = [-2.2, .03, 4]; world.markerB = [2.2, .03, 4];
  for (const [index, position] of [world.markerA, world.markerB].entries()) {
    world.objects.push({ id: crypto.randomUUID(), kind: 'actor', name: `${actorName} ${index + 1}`, color: index ? '#758da6' : '#b47754', transform: { position: [...position], rotation: [0, index ? -Math.PI / 2 : Math.PI / 2, 0], scale: [1, 1, 1] }, keyframes: [], visible: true });
  }
  world.cameraBookmarks = [
    { id: crypto.randomUUID(), name: world.name, camera: structuredClone(world.camera) },
    { id: crypto.randomUUID(), name: `${actorName} A`, camera: { position: [0, 2.2, 9], target: [0, 1.1, 4], focalLength: 35, keyframes: [] } },
    { id: crypto.randomUUID(), name: `${actorName} B`, camera: { position: [-5, 2.1, 5], target: [1.5, 1.1, 4], focalLength: 40, keyframes: [] } },
  ];
  return world;
}

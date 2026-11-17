// Rebuild the bundled CC0 prefabs from Kenney Fantasy Town Kit 2.0.
// Usage: node scripts/build-world-town-assets.mjs <unpacked-pack-directory>
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const input = resolve(process.argv[2] || 'artifacts/kenney-fantasy-town');
const output = resolve('public/world/town');
await mkdir(output, { recursive: true });
const source = join(input, 'Models', 'GLB format'), cache = new Map();
const palette = await readFile(join(source, 'Textures', 'colormap.png'));
const part = (model, position = [0, 0, 0], scale = [1, 1, 1], yaw = 0) => ({ model, position, scale, yaw });
async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const buffer = await readFile(join(source, name + '.glb'));
  const size = buffer.readUInt32LE(12), doc = JSON.parse(buffer.subarray(20, 20 + size).toString());
  const binary = buffer.subarray(28 + size);
  const types = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const attribute = index => {
    const a = doc.accessors[index], view = doc.bufferViews[a.bufferView], Type = types[a.componentType], n = components[a.type];
    if (!Type || !n || view.byteStride && view.byteStride !== n * Type.BYTES_PER_ELEMENT || a.sparse) throw new Error('Unsupported source accessor');
    const data = binary.subarray((view.byteOffset || 0) + (a.byteOffset || 0), (view.byteOffset || 0) + (a.byteOffset || 0) + a.count * n * Type.BYTES_PER_ELEMENT);
    return new THREE.BufferAttribute(new Type(Uint8Array.from(data).buffer), n, Boolean(a.normalized));
  };
  const nodes = doc.nodes.map(node => {
    const object = new THREE.Object3D();
    if (node.matrix) object.applyMatrix4(new THREE.Matrix4().fromArray(node.matrix));
    else { if (node.translation) object.position.fromArray(node.translation); if (node.rotation) object.quaternion.fromArray(node.rotation); if (node.scale) object.scale.fromArray(node.scale); }
    return object;
  });
  doc.nodes.forEach((node, index) => node.children?.forEach(child => nodes[index].add(nodes[child])));
  const root = new THREE.Group(); doc.scenes[doc.scene || 0].nodes.forEach(index => root.add(nodes[index])); root.updateMatrixWorld(true);
  const primitives = [];
  doc.nodes.forEach((node, index) => {
    for (const primitive of doc.meshes?.[node.mesh]?.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error('Expected triangle mesh');
      const geometry = new THREE.BufferGeometry();
      for (const [gltf, key] of [['POSITION', 'position'], ['NORMAL', 'normal'], ['TEXCOORD_0', 'uv']]) {
        if (primitive.attributes[gltf] !== undefined) geometry.setAttribute(key, attribute(primitive.attributes[gltf]));
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2));
      geometry.setIndex(primitive.indices === undefined ? Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i) : Array.from(attribute(primitive.indices).array));
      geometry.applyMatrix4(nodes[index].matrixWorld);
      const material = structuredClone(doc.materials[primitive.material]);
      if (material.pbrMetallicRoughness?.baseColorTexture) material.pbrMetallicRoughness.baseColorTexture = { index: 0 };
      primitives.push({ geometry, material });
    }
  });
  cache.set(name, primitives); return primitives;
}
async function save(name, parts) {
  const groups = new Map();
  for (const p of parts) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(...p.scale));
    for (const { geometry, material } of await load(p.model)) {
      const key = JSON.stringify(material);
      if (!groups.has(key)) groups.set(key, { material, geometries: [] });
      groups.get(key).geometries.push(geometry.clone().applyMatrix4(matrix));
    }
  }
  const binary = [], views = [], accessors = [], materials = [], primitives = []; let offset = 0;
  const append = data => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength), index = views.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }); binary.push(bytes); offset += bytes.length;
    const pad = (4 - offset % 4) % 4; if (pad) { binary.push(Buffer.alloc(pad)); offset += pad; } return index;
  };
  const accessor = (attribute, type, componentType, min, max) => {
    const index = accessors.length;
    accessors.push({ bufferView: append(attribute.array), componentType, count: attribute.count, type, ...(min ? { min, max } : {}) }); return index;
  };
  for (const { material, geometries } of groups.values()) {
    const geometry = mergeGeometries(geometries); geometry.computeBoundingBox();
    const attributes = { POSITION: accessor(geometry.getAttribute('position'), 'VEC3', 5126, geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()), NORMAL: accessor(geometry.getAttribute('normal'), 'VEC3', 5126), TEXCOORD_0: accessor(geometry.getAttribute('uv'), 'VEC2', 5126) };
    const indices = accessor(new THREE.Uint32BufferAttribute(geometry.index.array, 1), 'SCALAR', 5125);
    primitives.push({ attributes, indices, material: materials.length }); materials.push(material);
    geometry.dispose(); geometries.forEach(g => g.dispose());
  }
  const imageView = append(palette);
  const doc = { asset: { version: '2.0', generator: 'MoJing CC0 prefab builder', copyright: 'Kenney · CC0 1.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }], meshes: [{ primitives }], materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }], images: [{ bufferView: imageView, mimeType: 'image/png' }], samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }], textures: [{ source: 0, sampler: 0 }] };
  const json = Buffer.from(JSON.stringify(doc)), jsonSize = Math.ceil(json.length / 4) * 4, body = Buffer.concat(binary), result = Buffer.alloc(28 + jsonSize + body.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8); result.writeUInt32LE(jsonSize, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(32, 20, 20 + jsonSize); json.copy(result, 20); result.writeUInt32LE(body.length, 20 + jsonSize); result.writeUInt32LE(0x004e4942, 24 + jsonSize); body.copy(result, 28 + jsonSize);
  await writeFile(join(output, name + '.glb'), result); console.log(name + ': ' + result.length + ' bytes');
}
function house(floors, width, depth, roof = 'roof-point') {
  const parts = [];
  for (let level = 0; level < floors; level++) for (let side = 0; side < 4; side++) parts.push(part(level ? 'wall-wood-window-shutters' : side === 3 ? 'wall-door' : 'wall-window-shutters', [0, level * 2.5, 0], side % 2 ? [depth, 2.5, width] : [width, 2.5, depth], side * Math.PI / 2));
  parts.push(part(roof, [0, floors * 2.5, 0], [width, 2.1, depth]));
  if (floors < 3) parts.push(part('chimney', [width * .25, floors * 2.5 + .6, 0], [.9, 1.5, .9]));
  return parts;
}
await save('house', house(1, 3.8, 4.2));
await save('shop', [...house(2, 4.2, 4.2), part('overhang', [0, 2.2, 2.5], [1.5, 1.5, 4.2], -Math.PI / 2)]);
await save('tower', house(3, 3.8, 3.8, 'roof-high-point'));
await save('paving', Array.from({ length: 100 }, (_, i) => part('road', [(i % 10 - 4.5) * 2, 0, (Math.floor(i / 10) - 4.5) * 2], [2, 1, 2])));
await save('fountain', [part('fountain-round', [0, 0, 0], [1.7, 1.7, 1.7]), part('fountain-center', [0, 0, 0], [1.7, 1.7, 1.7])]);
for (const [name, original, scale] of [['tree', 'tree', 1.8], ['tree-round', 'tree-high-round', 1.4], ['stall-red', 'stall-red', 2], ['stall-green', 'stall-green', 2], ['cart', 'cart', 1.8], ['lantern', 'lantern', 1.8], ['bench', 'stall-bench', 2], ['fence', 'fence', 2], ['rock', 'rock-large', 1.8]]) await save(name, [part(original, [0, 0, 0], [scale, scale, scale])]);
await copyFile(join(input, 'License.txt'), join(output, 'LICENSE.txt'));

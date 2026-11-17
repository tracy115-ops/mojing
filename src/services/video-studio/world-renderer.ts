import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, WebMOutputFormat } from 'mediabunny';
import type { StudioAsset, Vec3, WorldDocument, WorldObject, WorldTransform } from '@/types/video-studio';
import { worldTransformAt } from './document';
import { worldCameraPoseAt, worldPlaybackDuration } from './world-sequence';
import { ACTOR_JOINTS, actorPoseAt } from './world-animation';
import { worldAnimationTimeAt } from './world-model-animation';
import { worldMonitorCameraAt, worldMonitorLayout } from './world-monitor';
import type { WorldFramePlan } from './world-offline-plan';
import { isWorldPropId } from './world-sets';
import { toWebviewUrl, resolveLocalPath } from '@/services/video/asset-store';

export type WorldRenderMode = 'solid' | 'clay' | 'depth';
export type WorldViewMode = 'orbit' | 'shot' | 'monitor';
interface WorldRenderObject { key: string; root: THREE.Group; mixer?: THREE.AnimationMixer; clips?: THREE.AnimationClip[]; activeClip?: number; loading?: boolean; modelLoaded?: boolean; loadError?: string }
function stopAnimation(entry: WorldRenderObject) { if (entry.mixer) { entry.mixer.stopAllAction(); entry.mixer.uncacheRoot(entry.mixer.getRoot()); } }
const environmentColors = { day: 0xbfd4e0, sunset: 0xe2ad81, night: 0x17233b, fog: 0xc0cbd0 };
function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Sprite) {
      if (!(child instanceof THREE.Sprite)) geometries.add(child.geometry);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
    }
  });
  for (const material of materials) { for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); material.dispose(); }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
}
function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number]): THREE.Mesh {
  const item = new THREE.Mesh(geometry, material); item.position.set(...position); item.castShadow = true; item.receiveShadow = true; return item;
}
function actor(color: string): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
  const spine = new THREE.Group(); spine.name = 'spine'; spine.position.y = 0.95;
  spine.add(mesh(new THREE.CapsuleGeometry(0.22, 0.3, 6, 12), material, [0, 0.22, 0]));
  const head = new THREE.Group(); head.name = 'head'; head.position.y = 0.65; head.add(mesh(new THREE.SphereGeometry(0.19, 20, 16), material, [0, 0, 0])); spine.add(head); group.add(spine);
  for (const side of [-1, 1]) {
    const prefix = side < 0 ? 'left' : 'right';
    const arm = new THREE.Group(); arm.name = `${prefix}Shoulder`; arm.position.set(side * 0.3, 0.42, 0); arm.add(mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 8), material, [0, -0.14, 0]));
    const elbow = new THREE.Group(); elbow.name = `${prefix}Elbow`; elbow.position.y = -0.28; elbow.add(mesh(new THREE.CapsuleGeometry(0.06, 0.2, 4, 8), material, [0, -0.14, 0])); arm.add(elbow); spine.add(arm);
    const leg = new THREE.Group(); leg.name = `${prefix}Hip`; leg.position.set(side * 0.13, 0.85, 0); leg.add(mesh(new THREE.CapsuleGeometry(0.09, 0.23, 4, 8), material, [0, -0.18, 0]));
    const knee = new THREE.Group(); knee.name = `${prefix}Knee`; knee.position.y = -0.36; knee.add(mesh(new THREE.CapsuleGeometry(0.075, 0.27, 4, 8), material, [0, -0.2, 0])); knee.add(mesh(new THREE.BoxGeometry(0.16, 0.1, 0.3), material, [0, -0.43, 0.07])); leg.add(knee); group.add(leg);
  }
  return group;
}
function primitive(object: WorldObject): THREE.Group {
  if (object.kind === 'actor') return actor(object.color);
  const group = new THREE.Group(), material = new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.8 });
  if (object.kind === 'tree') {
    group.add(mesh(new THREE.CylinderGeometry(0.12, 0.18, 1.8, 10), new THREE.MeshStandardMaterial({ color: 0x7b5940 }), [0, 0.9, 0]));
    group.add(mesh(new THREE.ConeGeometry(1, 2.8, 12), material, [0, 2.6, 0]));
  } else if (object.kind === 'sphere') group.add(mesh(new THREE.SphereGeometry(0.5, 24, 16), material, [0, 0.5, 0]));
  else if (object.kind === 'cylinder') group.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 20), material, [0, 0.5, 0]));
  else if (object.kind === 'building') {
    group.add(mesh(new THREE.BoxGeometry(3, 5, 3), material, [0, 2.5, 0]));
    const windowMaterial = new THREE.MeshStandardMaterial({ color: 0xb9d9dd, roughness: 0.25 });
    for (let level = 0; level < 3; level++) for (const x of [-0.75, 0.75]) group.add(mesh(new THREE.BoxGeometry(0.65, 0.75, 0.04), windowMaterial, [x, 1.3 + level * 1.3, 1.52]));
  } else if (object.kind !== 'model') group.add(mesh(new THREE.BoxGeometry(1, 1, 1), material, [0, 0.5, 0]));
  return group;
}

/** A self-contained Three.js viewport; no upstream server or editor dependency is required. */
export class WorldViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly orbitCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  readonly shotCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 150);
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  readonly objects = new Map<string, WorldRenderObject>();
  private document?: WorldDocument;
  private view: WorldViewMode = 'orbit';
  private monitorSources: string[] = [];
  private readonly monitorCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 150);
  private mode: WorldRenderMode = 'solid';
  private selected?: string;
  private width = 800;
  private height = 500;
  private time = 0;
  private readonly grid = new THREE.GridHelper(60, 60, 0x77818b, 0x8b949b);
  private readonly markers = new THREE.Group();
  private readonly ground = mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x777e74, roughness: 1 }), [0, -0.015, 0]);
  private readonly keyLight = new THREE.DirectionalLight(0xfff4dc, 2.5);
  private readonly clay = new THREE.MeshStandardMaterial({ color: 0xd3d6d4, roughness: 1 });
  private readonly depth = new THREE.ShaderMaterial({
    uniforms: { near: { value: 0.1 }, far: { value: 40 } },
    vertexShader: `varying float viewDepth;
      #include <common>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      void main() {
        #include <skinbase_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        vec4 p = modelViewMatrix * vec4(transformed, 1.0);
        viewDepth = -p.z; gl_Position = projectionMatrix * p;
      }`,
    fragmentShader: 'uniform float near; uniform float far; varying float viewDepth; void main() { float d = 1.0 - clamp((viewDepth - near) / (far - near), 0.0, 1.0); gl_FragColor = vec4(vec3(d), 1.0); }',
  });
  private readonly observer: ResizeObserver;
  private disposed = false;
  private pointerStart?: { x: number; y: number };
  private recordStop?: () => void;
  private drawingPath = false;
  private pathPoints: Vec3[] = [];
  private pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 2 }));
  readonly callbacks: { onSelect?: (id?: string) => void; onTransform?: (id: string, transform: WorldTransform) => void; onModelError?: (error: string) => void; onModelLoaded?: (id: string, clips: Array<{ name: string; duration: number }>) => void; onPath?: (points: Vec3[]) => void } = {};
  recording = false;

  constructor(private readonly element: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.element.appendChild(this.renderer.domElement);
    this.orbitCamera.position.set(8, 6, 10);
    this.controls = new OrbitControls(this.orbitCamera, this.renderer.domElement); this.controls.target.set(0, 1, 0); this.controls.enableDamping = false; this.controls.update();
    this.controls.addEventListener('change', () => { if (!this.recording) this.render(); });
    this.ground.rotation.x = -Math.PI / 2; this.scene.add(this.ground, this.grid, this.markers);
    this.scene.add(this.pathLine);
    this.scene.add(new THREE.HemisphereLight(0xdceaff, 0x686553, 2));
    this.keyLight.position.set(6, 12, 5); this.keyLight.castShadow = true; this.keyLight.shadow.mapSize.set(1024, 1024); this.keyLight.shadow.camera.left = -20; this.keyLight.shadow.camera.right = 20; this.keyLight.shadow.camera.top = 20; this.keyLight.shadow.camera.bottom = -20; this.scene.add(this.keyLight);
    this.keyLight.shadow.camera.near = .5; this.keyLight.shadow.camera.far = 70;
    this.keyLight.shadow.bias = -.0003; this.keyLight.shadow.normalBias = .03;
    this.transform = new TransformControls(this.orbitCamera, this.renderer.domElement);
    this.transform.setSize(0.8); this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (event) => { this.controls.enabled = !event.value && this.view === 'orbit'; });
    this.transform.addEventListener('objectChange', () => this.render());
    this.transform.addEventListener('mouseUp', () => {
      const object = this.transform.object;
      if (object && this.selected) this.callbacks.onTransform?.(this.selected, { position: object.position.toArray() as WorldTransform['position'], rotation: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.toArray() as WorldTransform['scale'] });
    });
    for (const [index, color] of [0x3b82f6, 0xe2a44d].entries()) {
      const marker = new THREE.Group(); marker.add(mesh(new THREE.RingGeometry(0.3, 0.4, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }), [0, 0.03, 0])); marker.children[0].rotation.x = -Math.PI / 2;
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96; const ctx = canvas.getContext('2d')!; ctx.fillStyle = `#${color.toString(16)}`; ctx.font = 'bold 70px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(index === 0 ? 'A' : 'B', 48, 75);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })); label.position.y = 0.7; label.scale.set(0.7, 0.7, 1); marker.add(label); this.markers.add(marker);
    }
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(element); this.resize();
  }
  setPathDrawing(enabled: boolean) {
    this.drawingPath = enabled; this.pathPoints = []; this.pathLine.visible = enabled;
    this.controls.enabled = !enabled && this.view === 'orbit' && !this.recording;
    if (enabled) this.transform.detach();
    this.renderer.domElement.style.cursor = enabled ? 'crosshair' : '';
    this.render();
  }
  private pathPoint(event: PointerEvent) {
    const bounds = this.renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), this.orbitCamera);
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!point || Math.abs(point.x) > 100 || Math.abs(point.z) > 100 || this.pathPoints.length >= 250) return;
    if (this.pathPoints.length && point.distanceTo(new THREE.Vector3(...this.pathPoints[this.pathPoints.length - 1])) < 0.15) return;
    this.pathPoints.push([point.x, 0, point.z]);
    this.pathLine.geometry.dispose(); this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(this.pathPoints.map((item) => new THREE.Vector3(item[0], 0.06, item[2]))); this.render();
  }
  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.view === 'monitor') return;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    if (this.drawingPath) { event.preventDefault(); this.pathPoints = []; this.renderer.domElement.setPointerCapture(event.pointerId); this.pathPoint(event); }
  };
  private onPointerMove = (event: PointerEvent) => { if (this.drawingPath && this.pointerStart) this.pathPoint(event); };
  private onPointerUp = (event: PointerEvent) => {
    if (this.view === 'monitor') return;
    if (this.drawingPath) {
      this.pathPoint(event); this.pointerStart = undefined;
      const points = this.pathPoints; this.setPathDrawing(false);
      if (points.length > 1) this.callbacks.onPath?.(points);
      return;
    }
    if (!this.pointerStart || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5 || this.transform.dragging || this.recording) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const width = this.view === 'shot' ? Math.min(bounds.width, bounds.height * this.shotCamera.aspect) : bounds.width;
    const height = this.view === 'shot' ? width / this.shotCamera.aspect : bounds.height;
    const x = event.clientX - bounds.left - (bounds.width - width) / 2, y = event.clientY - bounds.top - (bounds.height - height) / 2;
    if (x < 0 || y < 0 || x > width || y > height) return;
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / width * 2 - 1, -y / height * 2 + 1), this.view === 'shot' ? this.shotCamera : this.orbitCamera);
    const hits = ray.intersectObjects([...this.objects.values()].map((item) => item.root).filter((root) => root.visible), true);
    let object: THREE.Object3D | null = hits[0]?.object ?? null;
    while (object && !object.userData.entityId) object = object.parent;
    this.callbacks.onSelect?.(object?.userData.entityId);
  };
  resize() {
    if (this.recording) return;
    this.width = Math.max(1, this.element.clientWidth); this.height = Math.max(1, this.element.clientHeight);
    this.renderer.setSize(this.width, this.height); this.orbitCamera.aspect = this.width / this.height; this.orbitCamera.updateProjectionMatrix(); this.render();
  }
  sync(document: WorldDocument, assets: StudioAsset[], selected: string | undefined, mode: WorldRenderMode, view: WorldViewMode, transformMode: 'translate' | 'rotate' | 'scale', monitorSources: string[] = []) {
    if (!this.document && document.objects.some(object => object.builtinModel)) {
      this.orbitCamera.position.set(...document.camera.position); this.controls.target.set(...document.camera.target); this.controls.update();
    }
    this.document = document; this.mode = mode; this.view = view; this.selected = selected;
    this.monitorSources = monitorSources;
    const ids = new Set(document.objects.map((object) => object.id));
    for (const [id, entry] of this.objects) if (!ids.has(id)) { if (this.transform.object === entry.root) this.transform.detach(); stopAnimation(entry); this.scene.remove(entry.root); disposeObject(entry.root); this.objects.delete(id); }
    for (const object of document.objects) {
      const key = `${object.kind}:${object.color}:${object.assetId ?? ''}:${object.builtinModel ?? ''}`;
      const existing = this.objects.get(object.id);
      if (existing?.key === key) continue;
      if (existing) { this.transform.detach(); stopAnimation(existing); this.scene.remove(existing.root); disposeObject(existing.root); }
      const root = primitive(object), entry: WorldRenderObject = { key, root }; root.userData.entityId = object.id; this.objects.set(object.id, entry); this.scene.add(root);
      const asset = object.assetId && assets.find((item) => item.id === object.assetId);
      const modelUrl = isWorldPropId(object.builtinModel) ? `${import.meta.env.BASE_URL}world/town/${object.builtinModel}.glb` : asset && asset.url ? toWebviewUrl(resolveLocalPath(asset.url)) : undefined;
      if (object.kind === 'model' && !modelUrl) entry.loadError = 'Missing 3D asset';
      if (object.kind === 'model' && modelUrl) { entry.loading = true; new GLTFLoader().load(modelUrl, (gltf) => {
        if (this.disposed || this.objects.get(object.id)?.root !== root) { disposeObject(gltf.scene); return; }
        gltf.scene.traverse((child) => { if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; } }); root.add(gltf.scene);
        entry.clips = gltf.animations; entry.mixer = new THREE.AnimationMixer(gltf.scene);
        entry.loading = false; entry.modelLoaded = true;
        this.callbacks.onModelLoaded?.(object.id, gltf.animations.map((clip) => ({ name: clip.name, duration: clip.duration })));
        this.animate(this.time);
      }, undefined, (error) => { entry.loading = false; entry.loadError = String(error); this.callbacks.onModelError?.(String(error)); }); }
    }
    this.scene.background = new THREE.Color(environmentColors[document.environment]);
    this.scene.fog = document.environment === 'fog' ? new THREE.Fog(environmentColors.fog, 5, 35) : null;
    this.keyLight.intensity = document.lightIntensity * (document.environment === 'night' ? 0.2 : 1);
    this.keyLight.color.set(document.environment === 'sunset' ? 0xffbf82 : 0xfff4dc);
    (this.ground.material as THREE.MeshStandardMaterial).color.set(document.groundColor);
    this.markers.children[0].position.set(...document.markerA); this.markers.children[1].position.set(...document.markerB);
    this.controls.enabled = view === 'orbit' && !this.recording && !this.drawingPath;
    this.transform.setMode(transformMode);
    const target = selected ? this.objects.get(selected)?.root : undefined;
    if (target && view === 'orbit' && !this.recording && !this.drawingPath) this.transform.attach(target); else this.transform.detach();
    this.render();
  }
  animate(time: number) {
    this.time = time;
    const doc = this.document;
    if (!doc) return;
    for (const object of doc.objects) {
      const entry = this.objects.get(object.id), root = entry?.root;
      if (!root || this.transform.dragging && this.transform.object === root) continue;
      const transform = worldTransformAt(object, time);
      root.position.set(...transform.position); root.rotation.set(...transform.rotation); root.scale.set(...transform.scale); root.visible = object.visible;
      if (entry?.mixer) {
        if (entry.activeClip !== object.animationClip) {
          entry.mixer.stopAllAction(); entry.activeClip = object.animationClip;
        }
        const clip = object.animationClip !== undefined ? entry.clips?.[object.animationClip] : undefined;
        if (clip) {
          const action = entry.mixer.clipAction(clip);
          // Reset clears the paused endpoint of LoopOnce before sampling backwards.
          action.reset().setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
          entry.mixer.setTime(worldAnimationTimeAt(object.animationPlayback, clip.duration, time));
        }
      }
      if (object.kind === 'actor') {
        const pose = actorPoseAt(object, time); root.position.y += pose.height;
        for (const joint of ACTOR_JOINTS) {
          const part = root.getObjectByName(joint); if (!part) continue;
          part.rotation.set(...(pose.joints[joint] ?? [0, 0, 0]));
          const phase = joint.startsWith('left') ? 0 : Math.PI, walking = object.motion === 'walk' || object.motion === 'run';
          if (walking && (joint.endsWith('Hip') || joint.endsWith('Shoulder'))) part.rotation.x += Math.sin(time * (object.motion === 'run' ? 11 : 6) + phase) * (object.motion === 'run' ? 0.8 : 0.45) * (joint.endsWith('Shoulder') ? -1 : 1);
          if (walking && joint.endsWith('Knee')) part.rotation.x += Math.max(0, Math.sin(time * (object.motion === 'run' ? 11 : 6) + phase)) * 0.7;
          if (object.motion === 'wave' && joint === 'rightShoulder') part.rotation.z += -2.3 + Math.sin(time * 7) * 0.25;
        }
      }
    }
    const { position, target, focalLength } = worldCameraPoseAt(doc, time);
    const [w, h] = doc.aspectRatio.split(':').map(Number); this.shotCamera.aspect = w / h;
    this.shotCamera.position.set(...position); this.shotCamera.lookAt(new THREE.Vector3(...target)); this.shotCamera.setFocalLength(focalLength);
    this.shotCamera.updateProjectionMatrix();
    this.render();
  }
  render() {
    if (this.disposed) return;
    const helperVisible = this.view === 'orbit'; this.grid.visible = helperVisible; this.markers.visible = helperVisible; this.transform.getHelper().visible = helperVisible && !!this.transform.object;
    this.pathLine.visible = helperVisible && this.drawingPath;
    this.scene.overrideMaterial = this.mode === 'clay' ? this.clay : this.mode === 'depth' ? this.depth : null;
    this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, this.width, this.height); this.renderer.setClearColor(0x000000, 1); this.renderer.clear();
    if (this.view === 'monitor' && this.document) {
      const doc = this.document, [w, h] = doc.aspectRatio.split(':').map(Number), aspect = w / h;
      const cells = worldMonitorLayout(this.width, this.height, this.monitorSources.length === 2 ? 2 : 4);
      try {
        this.renderer.setScissorTest(true);
        cells.forEach((cell, index) => {
          const frame = worldMonitorCameraAt(doc, this.monitorSources[index], this.time);
          if (!frame) return;
          const width = Math.min(cell.width, cell.height * aspect), height = width / aspect;
          const x = cell.x + (cell.width - width) / 2, y = this.height - cell.y - (cell.height + height) / 2;
          const { position, target, focalLength } = frame.pose;
          this.monitorCamera.position.set(...position); this.monitorCamera.lookAt(new THREE.Vector3(...target)); this.monitorCamera.aspect = aspect; this.monitorCamera.setFocalLength(focalLength); this.monitorCamera.updateProjectionMatrix();
          this.renderer.setScissor(x, y, width, height); this.renderer.setViewport(x, y, width, height);
          this.renderer.render(this.scene, this.monitorCamera);
        });
      } finally { this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, this.width, this.height); }
      return;
    }
    if (this.view === 'shot' && this.document) {
      const ratio = this.shotCamera.aspect, width = Math.min(this.width, this.height * ratio), height = width / ratio;
      this.renderer.setViewport((this.width - width) / 2, (this.height - height) / 2, width, height);
    }
    this.renderer.render(this.scene, this.view === 'shot' ? this.shotCamera : this.orbitCamera);
  }
  alignCamera(): Pick<WorldDocument['camera'], 'position' | 'target'> {
    return { position: this.orbitCamera.position.toArray() as WorldDocument['camera']['position'], target: this.controls.target.toArray() as WorldDocument['camera']['target'] };
  }
  frameScene() {
    const bounds = new THREE.Box3();
    for (const entry of this.objects.values()) if (entry.root.visible) bounds.expandByObject(entry.root);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3()), direction = new THREE.Vector3(1, .85, 1.2).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize(), up = new THREE.Vector3().crossVectors(direction, right);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.orbitCamera.fov) / 2);
    let distance = 1;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const point = new THREE.Vector3(x, y, z).sub(center), depth = point.dot(direction);
      distance = Math.max(distance, depth + Math.abs(point.dot(right)) / (tangent * this.orbitCamera.aspect), depth + Math.abs(point.dot(up)) / tangent);
    }
    this.controls.target.copy(center); this.orbitCamera.position.copy(center).add(direction.multiplyScalar(distance * 1.1));
    this.controls.update(); this.render();
  }
  capture(time: number, mode = this.mode, cameraSourceId = 'program'): string {
    const oldView = this.view, oldMode = this.mode, ratio = this.renderer.getPixelRatio(), oldTime = this.time;
    const [w, h] = (this.document?.aspectRatio ?? '16:9').split(':').map(Number);
    const width = w >= h ? 1280 : Math.round(1280 * w / h), height = w >= h ? Math.round(1280 * h / w) : 1280;
    this.view = 'shot'; this.mode = mode; this.renderer.setPixelRatio(1); this.renderer.setSize(width, height, false);
    const previous = { width: this.width, height: this.height }; this.width = width; this.height = height;
    try {
      this.animate(time);
      if (cameraSourceId !== 'program') {
        const frame = this.document && worldMonitorCameraAt(this.document, cameraSourceId, time);
        if (!frame) throw new Error('Missing monitor camera');
        this.shotCamera.position.set(...frame.pose.position); this.shotCamera.lookAt(new THREE.Vector3(...frame.pose.target)); this.shotCamera.setFocalLength(frame.pose.focalLength); this.render();
      }
      return this.renderer.domElement.toDataURL('image/png');
    }
    finally { this.width = previous.width; this.height = previous.height; this.view = oldView; this.mode = oldMode; this.renderer.setPixelRatio(ratio); this.renderer.setSize(this.width, this.height); this.animate(oldTime); }
  }
  /** Render every scheduled timestamp, awaiting durable frame writes instead of wall-clock playback. */
  async renderFrames(plan: WorldFramePlan, options: { write: (index: number, png: string) => Promise<void>; signal: AbortSignal; onProgress: (completed: number) => void; world: WorldDocument; mode: WorldRenderMode }): Promise<void> {
    const { write, signal, onProgress } = options;
    if (!this.document || this.recording || this.disposed) throw new Error('Viewport unavailable for frame rendering');
    if (JSON.stringify(this.document) !== JSON.stringify(options.world)) throw new Error('Scene changed; reopen frame export to review the current scene');
    const previous = { document: this.document, view: this.view, mode: this.mode, time: this.time, ratio: this.renderer.getPixelRatio(), width: this.width, height: this.height, controls: this.controls.enabled };
    this.document = structuredClone(options.world); this.mode = options.mode; this.recording = true; this.view = 'shot'; this.controls.enabled = false;
    const check = () => { signal.throwIfAborted(); if (this.disposed) throw new DOMException('Viewport closed', 'AbortError'); if (this.renderer.getContext().isContextLost()) throw new Error('WebGL context was lost'); };
    try {
      const deadline = Date.now() + 60000;
      while ([...this.objects.values()].some(entry => entry.loading)) {
        check(); if (Date.now() > deadline) throw new Error('3D model loading timed out');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      for (const object of this.document.objects) if (object.kind === 'model') {
        const entry = this.objects.get(object.id); if (!entry?.modelLoaded || entry.loadError) throw new Error(entry?.loadError || '3D model is not ready');
      }
      this.width = plan.width; this.height = plan.height; this.renderer.setPixelRatio(1); this.renderer.setSize(plan.width, plan.height, false);
      for (let index = 0; index < plan.frameCount; index++) {
        check(); this.animate(index / plan.fps);
        await write(index, this.renderer.domElement.toDataURL('image/png'));
        check(); onProgress(index + 1);
      }
    } finally {
      this.document = previous.document; this.view = previous.view; this.mode = previous.mode; this.time = previous.time; this.width = previous.width; this.height = previous.height; this.recording = false;
      if (!this.disposed) { this.renderer.setPixelRatio(previous.ratio); this.resize(); this.controls.enabled = previous.controls; this.animate(previous.time); }
    }
  }
  async record(onTime: (time: number) => void): Promise<Blob> {
    if (!this.document || this.recording || typeof VideoEncoder === 'undefined') throw new Error('Video capture is unavailable');
    const doc = this.document, oldView = this.view, oldRatio = this.renderer.getPixelRatio();
    const duration = worldPlaybackDuration(doc);
    const [w, h] = doc.aspectRatio.split(':').map(Number);
    const previous = { width: this.width, height: this.height };
    let encoder: VideoEncoder | undefined, output: Output | undefined, cancelled = false, encodingError: Error | undefined;
    try {
      this.width = w >= h ? 1280 : Math.round(1280 * w / h); this.height = w >= h ? Math.round(1280 * h / w) : 1280;
      // Use the same camera framing and resolution as still capture, independent of the editor panel size.
      this.renderer.setPixelRatio(1); this.renderer.setSize(this.width, this.height, false);
      this.recording = true; this.view = 'shot'; this.controls.enabled = false;
      this.recordStop = () => { cancelled = true; if (encoder && encoder.state !== 'closed') encoder.close(); };
      const check = () => {
        if (cancelled || this.disposed) throw new Error('Video capture cancelled');
        if (encodingError) throw encodingError;
      };
      this.animate(0); onTime(0);
      const config: VideoEncoderConfig = { codec: 'vp8', width: this.width, height: this.height, bitrate: 5_000_000, framerate: doc.fps, hardwareAcceleration: 'prefer-software' };
      const support = await VideoEncoder.isConfigSupported(config);
      check(); if (!support.supported) throw new Error('VP8 video encoding is unavailable');
      const deadline = Date.now() + 60000;
      while ([...this.objects.values()].some(entry => entry.loading)) {
        check(); if (Date.now() > deadline) throw new Error('3D model loading timed out');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      for (const object of doc.objects) if (object.kind === 'model') {
        const entry = this.objects.get(object.id); if (!entry?.modelLoaded || entry.loadError) throw new Error(entry?.loadError || '3D model is not ready');
      }
      const target = new BufferTarget(), source = new EncodedVideoPacketSource('vp8');
      output = new Output({ target, format: new WebMOutputFormat() });
      output.addVideoTrack(source, { frameRate: doc.fps }); await output.start(); check();
      let packetWrites = Promise.resolve();
      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const packet = EncodedPacket.fromEncodedChunk(chunk).clone({ duration: Math.min(1 / doc.fps, duration - chunk.timestamp / 1_000_000) });
          packetWrites = packetWrites.then(() => source.add(packet, metadata)).catch((error: Error) => { encodingError = error; });
        },
        error: (error) => { encodingError = error; },
      });
      encoder.configure(config);
      // Scene timestamps, rather than encoder startup or render speed, define
      // the movie. Slow software rendering must not drop a short take or add a
      // frozen opening. Bound the encoding queue and keep the UI responsive.
      for (let index = 0; index < Math.ceil(duration * doc.fps); index++) {
        check(); const time = index / doc.fps; this.animate(time);
        const timestamp = Math.round(time * 1_000_000);
        const frame = new VideoFrame(this.renderer.domElement, { timestamp, duration: Math.round(Math.min(duration, (index + 1) / doc.fps) * 1_000_000) - timestamp });
        try { encoder.encode(frame, { keyFrame: index % (doc.fps * 2) === 0 }); } finally { frame.close(); }
        onTime(time);
        if (encoder.encodeQueueSize >= 4) { await encoder.flush(); await packetWrites; check(); }
        if (index % 4 === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      await encoder.flush(); await packetWrites; check(); await output.finalize();
      this.animate(duration); onTime(duration);
      if (!target.buffer?.byteLength) throw new Error('Video capture produced no encoded frames');
      return new Blob([target.buffer], { type: 'video/webm' });
    } finally {
      if (encoder && encoder.state !== 'closed') encoder.close();
      if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
      this.recordStop = undefined; this.recording = false; this.view = oldView;
      this.width = previous.width; this.height = previous.height;
      if (!this.disposed) { this.renderer.setPixelRatio(oldRatio); this.resize(); this.controls.enabled = oldView === 'orbit'; }
    }
  }
  dispose() {
    this.disposed = true; this.recordStop?.(); this.observer.disconnect(); this.controls.dispose(); this.transform.dispose(); this.scene.remove(this.transform.getHelper());
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown); this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp); this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    for (const entry of this.objects.values()) stopAnimation(entry);
    disposeObject(this.scene); this.keyLight.shadow.dispose(); this.clay.dispose(); this.depth.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

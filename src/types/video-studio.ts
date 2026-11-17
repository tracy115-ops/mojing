import type { VideoControlMode, GenerationRequestSnapshot, GenerationResponseSnapshot } from './providers';
import type { StudioCloudMedia } from './studio-upload';

export type StudioPage = 'home' | 'projects' | 'canvas' | 'world' | 'image' | 'video' | 'commerce' | 'assets' | 'tasks' | 'skills' | 'plugins';
export type StudioMediaKind = 'image' | 'video' | 'audio' | 'text' | 'model';
export interface StudioAsset {
  id: string;
  name: string;
  kind: StudioMediaKind;
  url?: string;
  text?: string;
  category: 'character' | 'scene' | 'prop' | 'reference' | 'output';
  createdAt: string;
  model?: string;
  provider?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  jobId?: string;
  worldId?: string;
  requestSnapshot?: GenerationRequestSnapshot;
  responseSnapshot?: GenerationResponseSnapshot;
  /** Local pixels are derived from a model candidate; its provider receipt belongs to the raw candidate. */
  editResult?: { mode: 'native_mask' | 'local_composite'; sourceFingerprint: string; maskFingerprint: string; candidateFingerprint: string; preserveOutside: true };
  storage?: 'disk' | 'embedded' | 'remote';
  storageError?: string;
  /** Public origin retained for providers that cannot read embedded/local media. */
  sourceUrl?: string;
  /** Verified uploaded copy; the original local URL is kept for editing and export. */
  cloudUpload?: StudioCloudMedia;
  mimeType?: string;
  sizeBytes?: number;
  folderId?: string;
  tags?: string[];
}
export interface StudioAssetFolder { id: string; name: string; parentId?: string }
export interface StudioTrashedAsset extends StudioAsset { trashedAt: string }
export interface StudioGenerationInput {
  kind: 'image' | 'video' | 'text';
  prompt: string;
  negativePrompt?: string;
  endpointId?: string;
  model?: string;
  aspectRatio: string;
  imageSize: string;
  durationSeconds: number;
  /** Provider capability tier ID; its dimensions come from the capability declaration. */
  resolution: string;
  controlMode: VideoControlMode;
  referenceAssetIds: string[];
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  audioReferenceAssetIds?: string[];
  videoReferenceAssetIds?: string[];
  generateAudio?: boolean;
  seed?: number;
  recipeId?: string;
  /** Freeze the recipe at submission so editing it cannot change a queued job or retry. */
  recipePrompt?: string;
  imageEdit?: { mode: 'native_mask' | 'local_composite'; sourceAssetId: string; maskAssetId: string; strength: number; instruction?: string };
}
export interface StudioJob {
  id: string;
  name: string;
  input: StudioGenerationInput;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputAssetId?: string;
  /** Retained before local mask composition; retry can finish without another model request. */
  rawOutputAssetId?: string;
  error?: string;
  canvasId?: string;
  nodeId?: string;
}
export interface StudioRecipe {
  id: string;
  name: string;
  description: string;
  kind: 'image' | 'video' | 'text';
  prompt: string;
  tags: string[];
  source?: string;
}
export interface StudioCommerceProject {
  id: string;
  name: string;
  product: string;
  facts: string;
  audience: string;
  platform: string;
  style: string;
  references: Array<{ assetId: string; role: 'product' | 'detail' | 'style' | 'logo' | 'model' }>;
  aspectRatio: string;
  imageSize: string;
  plan: Array<{ id: string; name: string; prompt: string }>;
  jobIds: string[];
  updatedAt: string;
}
export interface StudioNode {
  id: string;
  kind: StudioMediaKind | 'world';
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Locks layout geometry; prompts and generation remain editable. */
  layoutLocked?: boolean;
  prompt: string;
  assetId?: string;
  worldId?: string;
  generation?: Partial<StudioGenerationInput>;
}
export interface StudioCanvas {
  id: string;
  name: string;
  nodes: StudioNode[];
  edges: Array<{ id: string; from: string; to: string }>;
  groups?: Array<{ id: string; name: string; nodeIds: string[] }>;
  viewport: { x: number; y: number; zoom: number };
  updatedAt: string;
}
export type Vec3 = [number, number, number];
export interface WorldTransform { position: Vec3; rotation: Vec3; scale: Vec3 }
export type ActorJoint = 'spine' | 'head' | 'leftShoulder' | 'rightShoulder' | 'leftElbow' | 'rightElbow' | 'leftHip' | 'rightHip' | 'leftKnee' | 'rightKnee';
export interface ActorPose { height: number; joints: Partial<Record<ActorJoint, Vec3>> }
export interface WorldKeyframe { time: number; transform: WorldTransform; pose?: ActorPose }
export interface WorldAnimationPlayback {
  /** World time at which the selected source range starts playing. */
  startTime: number;
  inPoint: number;
  /** Undefined uses the embedded clip's actual end. Source times are in seconds. */
  outPoint?: number;
  speed: number;
  loop: 'repeat' | 'once';
}
export interface WorldObject {
  id: string;
  name: string;
  kind: 'actor' | 'box' | 'sphere' | 'cylinder' | 'tree' | 'building' | 'model';
  color: string;
  transform: WorldTransform;
  keyframes: WorldKeyframe[];
  visible: boolean;
  assetId?: string;
  /** Packaged CC0 scene prop. Exclusive with an imported model assetId. */
  builtinModel?: string;
  motion?: 'idle' | 'walk' | 'run' | 'wave';
  pose?: ActorPose;
  /** Index into the GLB's embedded animation clips; undefined keeps its rest pose. */
  animationClip?: number;
  animationPlayback?: WorldAnimationPlayback;
}
export interface WorldCamera {
  position: Vec3;
  target: Vec3;
  focalLength: number;
  keyframes: Array<{ time: number; position: Vec3; target: Vec3 }>;
}
export interface WorldCameraShot {
  id: string;
  name: string;
  duration: number;
  /** Independent camera snapshot; keyframe times are local to this shot. */
  camera: WorldCamera;
}
export interface WorldDocument {
  id: string;
  name: string;
  objects: WorldObject[];
  camera: WorldCamera;
  duration: number;
  fps: number;
  aspectRatio: string;
  environment: 'day' | 'sunset' | 'night' | 'fog';
  lightIntensity: number;
  groundColor: string;
  markerA: Vec3;
  markerB: Vec3;
  updatedAt: string;
  cameraBookmarks?: Array<{ id: string; name: string; camera: WorldCamera }>;
  /** Cuts share continuous scene time. The main camera remains available when disabled. */
  cameraSequence?: { enabled: boolean; shots: WorldCameraShot[] };
}

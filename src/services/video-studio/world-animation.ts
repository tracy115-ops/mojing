import type { ActorJoint, ActorPose, Vec3, WorldCamera, WorldDocument, WorldObject } from '../../types/video-studio.ts';
import { mixVec3, worldCameraAt } from './document.ts';

export const ACTOR_JOINTS: ActorJoint[] = ['spine', 'head', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee'];
export const POSE_PRESETS = ['stand', 'sit', 'crouch', 'reach', 'point', 'armsOpen'] as const;
export type PosePreset = typeof POSE_PRESETS[number];
export function actorPosePreset(preset: PosePreset): ActorPose {
  const joints: ActorPose['joints'] = {};
  let height = 0;
  if (preset === 'sit') { height = -0.43; joints.leftHip = [-Math.PI / 2, 0, 0]; joints.rightHip = [-Math.PI / 2, 0, 0]; joints.leftKnee = [Math.PI / 2, 0, 0]; joints.rightKnee = [Math.PI / 2, 0, 0]; }
  if (preset === 'crouch') { height = -0.48; joints.spine = [0.45, 0, 0]; joints.leftHip = [-1.1, 0, 0]; joints.rightHip = [-1.1, 0, 0]; joints.leftKnee = [2.1, 0, 0]; joints.rightKnee = [2.1, 0, 0]; }
  if (preset === 'reach') { joints.rightShoulder = [-2.4, 0, -0.3]; joints.rightElbow = [-0.2, 0, 0]; joints.head = [-0.2, 0, 0]; }
  if (preset === 'point') { joints.rightShoulder = [-Math.PI / 2, 0, 0]; joints.leftElbow = [-0.3, 0, 0]; }
  if (preset === 'armsOpen') { joints.leftShoulder = [0, 0, -1.3]; joints.rightShoulder = [0, 0, 1.3]; }
  return { height, joints };
}
export function actorPoseAt(object: WorldObject, time: number): ActorPose {
  const base = object.pose ?? { height: 0, joints: {} };
  const frames = object.keyframes.map((frame) => ({ ...frame, pose: frame.pose ?? base })).sort((a, b) => a.time - b.time);
  if (!frames.length) return base;
  const a = [...frames].reverse().find((frame) => frame.time <= time) ?? frames[0], b = frames.find((frame) => frame.time >= time) ?? frames[frames.length - 1];
  const t = a.time === b.time ? 0 : (time - a.time) / (b.time - a.time), left = a.pose!, right = b.pose!;
  const joints: ActorPose['joints'] = {};
  for (const joint of ACTOR_JOINTS) joints[joint] = mixVec3(left.joints[joint] ?? [0, 0, 0], right.joints[joint] ?? [0, 0, 0], t);
  return { height: left.height + (right.height - left.height) * t, joints };
}
export const CAMERA_MOVES = ['static', 'push', 'pull', 'panRight', 'orbitLeft', 'craneUp'] as const;
export function cameraWithMove(camera: WorldCamera, move: typeof CAMERA_MOVES[number], duration: number): WorldCamera {
  const start = worldCameraAt(camera, 0), end = structuredClone(start);
  if (move === 'static') return { ...camera, ...start, keyframes: [] };
  const direction = start.position.map((value, i) => value - start.target[i]) as Vec3;
  if (move === 'push' || move === 'pull') end.position = start.target.map((value, i) => value + direction[i] * (move === 'push' ? 0.65 : 1.4)) as Vec3;
  if (move === 'panRight') { end.position[0] += 3; end.target[0] += 3; }
  if (move === 'orbitLeft') { const angle = -Math.PI / 4; end.position = [start.target[0] + direction[0] * Math.cos(angle) + direction[2] * Math.sin(angle), start.position[1], start.target[2] - direction[0] * Math.sin(angle) + direction[2] * Math.cos(angle)]; }
  if (move === 'craneUp') end.position[1] += 3;
  return { ...camera, keyframes: [{ time: 0, ...start }, { time: duration, ...end }] };
}
/** Resample a drawn ground path at constant spatial speed, preserving the complete route. */
export function timedWorldPath(points: Vec3[], duration: number): Array<{ time: number; position: Vec3 }> {
  const unique = points.filter((point, index) => index === 0 || Math.hypot(...point.map((n, i) => n - points[index - 1][i])) > 0.01);
  if (unique.length < 2) throw new Error('Draw a path with at least two distinct points');
  const distances = [0];
  for (let i = 1; i < unique.length; i++) distances.push(distances[i - 1] + Math.hypot(...unique[i].map((n, axis) => n - unique[i - 1][axis])));
  return unique.map((position, i) => ({ time: Math.round(distances[i] / distances[distances.length - 1] * duration * 1000) / 1000, position }));
}
export function worldWithDrawnPath(world: WorldDocument, targetId: string, points: Vec3[]): WorldDocument {
  const frames = timedWorldPath(points, world.duration);
  if (targetId === 'camera') {
    const initial = worldCameraAt(world.camera, 0), height = initial.position[1], delta = initial.target.map((value, i) => value - initial.position[i]);
    return { ...world, camera: { ...world.camera, keyframes: frames.map((frame) => { const position: Vec3 = [frame.position[0], height, frame.position[2]]; return { time: frame.time, position, target: position.map((value, i) => value + delta[i]) as Vec3 }; }) } };
  }
  return { ...world, objects: world.objects.map((object) => object.id !== targetId ? object : { ...object, motion: object.kind === 'actor' ? 'walk' : object.motion, keyframes: frames.map((frame, index) => { const next = frames[Math.min(index + 1, frames.length - 1)], previous = frames[Math.max(0, index - 1)], from = index === frames.length - 1 ? previous.position : frame.position; return { time: frame.time, transform: { ...object.transform, position: frame.position, rotation: [0, Math.atan2(next.position[0] - from[0], next.position[2] - from[2]), 0] } }; }) }) };
}

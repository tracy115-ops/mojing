import type { WorldCamera, WorldDocument } from '../../types/video-studio.ts';
import { worldCameraAt } from './document.ts';

export { WORLD_SEQUENCE_MAX_SHOTS, WORLD_SEQUENCE_MAX_DURATION, WORLD_SEQUENCE_MIN_SHOT_DURATION } from './document.ts';

export function worldSequenceSpans(world: WorldDocument) {
  let end = 0;
  return (world.cameraSequence?.shots ?? []).map((shot, index) => {
    const start = end;
    end = Math.round((start + shot.duration) * 1e6) / 1e6;
    return { shot, index, start, end };
  });
}

export function worldPlaybackDuration(world: WorldDocument): number {
  const spans = worldSequenceSpans(world);
  return world.cameraSequence?.enabled && world.cameraSequence.shots.length
    ? spans[spans.length - 1].end : world.duration;
}

/** Half-open cut intervals choose the incoming shot exactly at a cut. */
export function worldCameraContextAt(world: WorldDocument, time: number) {
  const spans = world.cameraSequence?.enabled ? worldSequenceSpans(world) : [];
  const clamped = Math.max(0, Math.min(worldPlaybackDuration(world), time));
  const span = spans.find((item) => clamped < item.end) ?? spans[spans.length - 1];
  return span
    ? { camera: span.shot.camera, time: Math.max(0, Math.min(span.shot.duration, clamped - span.start)), ...span }
    : { camera: world.camera, time: clamped, shot: undefined, index: -1, start: 0, end: world.duration };
}

/** Shared by the editor, still capture and recorder, including per-shot focal length. */
export function worldCameraPoseAt(world: WorldDocument, time: number) {
  const context = worldCameraContextAt(world, time);
  return { ...worldCameraAt(context.camera, context.time), focalLength: context.camera.focalLength };
}

export function withWorldCameraAt(world: WorldDocument, time: number, camera: WorldCamera): WorldDocument {
  const { shot } = worldCameraContextAt(world, time);
  return shot && world.cameraSequence
    ? { ...world, cameraSequence: { ...world.cameraSequence, shots: world.cameraSequence.shots.map((item) => item.id === shot.id ? { ...item, camera } : item) } }
    : { ...world, camera };
}

export function retimeWorldCamera(camera: WorldCamera, fromDuration: number, toDuration: number): WorldCamera {
  const copy = structuredClone(camera);
  return { ...copy, keyframes: copy.keyframes.map((frame) => ({ ...frame, time: frame.time / fromDuration * toDuration })) };
}

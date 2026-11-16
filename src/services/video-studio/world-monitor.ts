import type { WorldCamera, WorldDocument } from '../../types/video-studio.ts';
import { worldCameraAt } from './document.ts';
import { retimeWorldCamera, withWorldCameraAt, worldCameraContextAt, worldCameraPoseAt, worldSequenceSpans } from './world-sequence.ts';

export type WorldMonitorCount = 2 | 4;
export interface WorldMonitorSource { id: string; kind: 'program' | 'main' | 'bookmark' | 'shot'; name: string; camera: WorldCamera; duration: number; start: number; index?: number }

export function worldMonitorSources(world: WorldDocument): WorldMonitorSource[] {
  return [
    { id: 'program', kind: 'program', name: '', camera: world.camera, duration: world.duration, start: 0 },
    { id: 'main', kind: 'main', name: '', camera: world.camera, duration: world.duration, start: 0 },
    ...(world.cameraBookmarks ?? []).map(item => ({ id: `bookmark:${item.id}`, kind: 'bookmark' as const, name: item.name, camera: item.camera, duration: world.duration, start: 0 })),
    ...worldSequenceSpans(world).map(({ shot, index, start }) => ({ id: `shot:${shot.id}`, kind: 'shot' as const, name: shot.name, camera: shot.camera, duration: shot.duration, start, index })),
  ];
}

/** View choices are temporary UI state; missing/deleted cameras leave an empty slot. */
export function worldMonitorSelection(world: WorldDocument, selection: string[] | undefined, count: WorldMonitorCount): string[] {
  const sources = worldMonitorSources(world), available = new Set(sources.map(source => source.id)), used = new Set<string>();
  const defaults = ['program', ...sources.filter(source => source.kind === 'bookmark' || source.kind === 'shot').map(source => source.id)];
  return Array.from({ length: count }, (_, index) => {
    const id = (selection ?? defaults)[index] ?? '';
    if (!available.has(id) || used.has(id)) return '';
    used.add(id); return id;
  });
}

export function worldMonitorCameraAt(world: WorldDocument, sourceId: string, time: number) {
  const source = worldMonitorSources(world).find(item => item.id === sourceId);
  if (!source) return undefined;
  if (source.kind === 'program') {
    const context = worldCameraContextAt(world, time);
    return { source: { ...source, camera: context.camera, duration: context.end - context.start, start: context.start }, pose: worldCameraPoseAt(world, time), localTime: context.time, phase: 'program' as const };
  }
  const localTime = Math.max(0, Math.min(source.duration, time - source.start));
  const phase = source.kind !== 'shot' ? 'scene' as const : time < source.start ? 'before' as const : time >= source.start + source.duration ? 'after' as const : 'active' as const;
  return { source, pose: { ...worldCameraAt(source.camera, localTime), focalLength: source.camera.focalLength }, localTime, phase };
}

/** Camera curves are copied and retimed; bookmarks and the other sequence shots stay independent. */
export function worldWithMonitorCamera(world: WorldDocument, sourceId: string, time: number): WorldDocument {
  const source = worldMonitorCameraAt(world, sourceId, time)?.source;
  if (!source) throw new Error('Missing monitor camera');
  const target = worldCameraContextAt(world, time);
  return withWorldCameraAt(world, time, retimeWorldCamera(source.camera, source.duration, target.end - target.start));
}

/** Top-left origin in CSS pixels; the renderer flips Y when setting the GL scissor. */
export function worldMonitorLayout(width: number, height: number, count: WorldMonitorCount) {
  const columns = count === 2 && width < 520 ? 1 : 2, rows = count / columns;
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns, row = Math.floor(index / columns);
    const x = Math.floor(column * width / columns), y = Math.floor(row * height / rows);
    return { x, y, width: Math.floor((column + 1) * width / columns) - x, height: Math.floor((row + 1) * height / rows) - y };
  });
}

import type { WorldFramePlan } from './world-offline-plan';

export interface WorldRenderResult { outputPath: string; width: number; height: number; fps: number; frameCount: number; durationSeconds: number; sizeBytes: number }
async function invoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('Offline MP4 export requires the desktop app');
  const { invoke } = await import('@tauri-apps/api/core'); return invoke<T>(name, args);
}
export const beginWorldRender = (plan: WorldFramePlan) => invoke<string>('world_render_begin', { config: { width: plan.width, height: plan.height, fps: plan.fps, frameCount: plan.frameCount } });
export const writeWorldRenderFrame = (jobId: string, index: number, dataUri: string) => invoke<void>('world_render_frame', { jobId, index, dataUri });
export const finishWorldRender = (jobId: string) => invoke<WorldRenderResult>('world_render_finish', { jobId });
export const cancelWorldRender = (jobId: string) => invoke<void>('world_render_cancel', { jobId });

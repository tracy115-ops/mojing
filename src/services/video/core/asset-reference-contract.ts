import type { SceneAnchor } from '@/types/video';

/** Versioned contract for backgrounds that are safe to reuse as references. */
export const ENVIRONMENT_REFERENCE_VERSION = 2;

export function isReusableEnvironmentReference(scene: SceneAnchor): boolean {
  return !!scene.backgroundImage
    && scene.backgroundReferenceRole === 'environment_only'
    && scene.backgroundReferenceVersion === ENVIRONMENT_REFERENCE_VERSION;
}

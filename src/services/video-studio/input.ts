import type { StudioGenerationInput } from '../../types/video-studio.ts';
import type { VideoGenerationCapabilities } from '../../types/providers.ts';
import { getVideoParameter, normalizeNumberForParameter } from '../video/core/video-capability-utils.ts';

export const initialStudioInput = (): StudioGenerationInput => ({ kind: 'video', prompt: '', aspectRatio: '16:9', imageSize: '2K', durationSeconds: 5, resolution: '720p', controlMode: 'text', referenceAssetIds: [] });

/** Remove controls that cannot be sent after changing the video model. */
export function normalizeStudioVideoInput(input: StudioGenerationInput, capabilities: VideoGenerationCapabilities): StudioGenerationInput {
  const refs = capabilities.references;
  const supportsReference = refs.supportsSubjectReferences || !!refs.audio?.maxCount || !!refs.video?.maxCount;
  const controlMode = input.controlMode === 'keyframe' && !refs.supportsFirstFrame
    || input.controlMode === 'reference' && !supportsReference ? 'text' : input.controlMode;
  const duration = getVideoParameter(capabilities, 'durationSeconds');
  return {
    ...input,
    controlMode,
    durationSeconds: duration ? normalizeNumberForParameter(input.durationSeconds, duration, 5) : 5,
    resolution: capabilities.resolutionTiers?.some(tier => tier.id === input.resolution)
      ? input.resolution : capabilities.resolutionTiers?.[0]?.id ?? '720p',
    referenceAssetIds: controlMode === 'reference' && refs.supportsSubjectReferences ? input.referenceAssetIds : [],
    firstFrameAssetId: controlMode === 'keyframe' ? input.firstFrameAssetId : undefined,
    lastFrameAssetId: controlMode === 'keyframe' && refs.supportsLastFrame ? input.lastFrameAssetId : undefined,
    audioReferenceAssetIds: controlMode === 'reference' && refs.audio?.maxCount ? input.audioReferenceAssetIds : [],
    videoReferenceAssetIds: controlMode === 'reference' && refs.video?.maxCount ? input.videoReferenceAssetIds : [],
  };
}

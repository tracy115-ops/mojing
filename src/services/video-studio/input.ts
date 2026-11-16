import type { StudioGenerationInput } from '../../types/video-studio.ts';

export const initialStudioInput = (): StudioGenerationInput => ({ kind: 'video', prompt: '', aspectRatio: '16:9', imageSize: '2K', durationSeconds: 5, resolution: '720p', controlMode: 'text', referenceAssetIds: [] });

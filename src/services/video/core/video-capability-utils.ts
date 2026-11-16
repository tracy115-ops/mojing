import type {
  GenerationParameterSpec,
  VideoGenerationCapabilities,
  VideoResolutionTier,
} from '@/types/providers';

export const FALLBACK_VIDEO_RESOLUTION_TIERS: VideoResolutionTier[] = [
  { id: '720p', label: '720p', shortEdge: 720 },
];

export function getVideoResolutionTiers(
  capabilities?: VideoGenerationCapabilities,
): VideoResolutionTier[] {
  return capabilities?.resolutionTiers?.filter((tier) => tier.id.trim()) ?? FALLBACK_VIDEO_RESOLUTION_TIERS;
}

export function getVideoParameter(
  capabilities: VideoGenerationCapabilities | undefined,
  key: string,
): GenerationParameterSpec | undefined {
  return capabilities?.parameters.find((parameter) => parameter.key === key);
}

export function normalizeNumberForParameter(
  value: number | undefined,
  parameter: GenerationParameterSpec | undefined,
  fallback: number,
): number {
  const candidate = Number.isFinite(value) ? Number(value) : fallback;
  if (parameter?.allowedValues?.length) {
    return parameter.allowedValues.reduce((closest, allowed) => (
      Math.abs(allowed - candidate) < Math.abs(closest - candidate) ? allowed : closest
    ), parameter.allowedValues[0]);
  }
  const min = parameter?.min ?? -Infinity;
  const max = parameter?.max ?? Infinity;
  const clamped = Math.min(max, Math.max(min, candidate));
  return parameter?.type === 'integer' ? Math.round(clamped) : clamped;
}

export function resolutionForAspect(
  aspectRatio: string,
  tier: VideoResolutionTier,
): string {
  if (tier.width && tier.height) return `${tier.width}x${tier.height}`;
  const shortEdge = tier.shortEdge ?? 720;
  if (aspectRatio === '9:16') return `${shortEdge}x${Math.round(shortEdge * 16 / 9)}`;
  if (aspectRatio === '1:1') return `${shortEdge}x${shortEdge}`;
  if (aspectRatio === '4:3') return `${Math.round(shortEdge * 4 / 3)}x${shortEdge}`;
  if (aspectRatio === '3:4') return `${shortEdge}x${Math.round(shortEdge * 4 / 3)}`;
  if (aspectRatio === '21:9') return `${Math.round(shortEdge * 21 / 9)}x${shortEdge}`;
  return `${Math.round(shortEdge * 16 / 9)}x${shortEdge}`;
}

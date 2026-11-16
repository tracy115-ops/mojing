import type { ImageGenerateRequest, ImageGenerationCapabilities } from '../../types/providers.ts';

export const hasImageMaskAdapter = (provider: string) => ['stable-diffusion', 'flux', 'comfyui'].includes(provider);

export function validateNativeImageEdit(request: ImageGenerateRequest, capabilities: ImageGenerationCapabilities): void {
  if (request.mask === undefined) return;
  if (!hasImageMaskAdapter(capabilities.provider) || !capabilities.references.maskSupported) throw new Error('This image adapter does not support native masks');
  if (!/^data:image\/png;base64,[a-z\d+/=\s]+$/i.test(request.mask)) throw new Error('The image edit mask must be a PNG Data URI');
  if (request.referenceImages?.length !== 1) throw new Error('Native mask editing requires exactly one source image');
  if (request.editStrength !== undefined && (!Number.isFinite(request.editStrength) || request.editStrength < 0 || request.editStrength > 1)) throw new Error('Image edit strength must be between 0 and 1');
}

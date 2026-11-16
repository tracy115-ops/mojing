import type { StudioGenerationInput } from '../../types/video-studio.ts';

export function validateStudioImageEdit(input: Partial<StudioGenerationInput>): void {
  const edit = input.imageEdit;
  if (edit === undefined) return;
  if (!edit || input.kind !== 'image' || !['native_mask', 'local_composite'].includes(edit.mode) || typeof edit.sourceAssetId !== 'string' || !edit.sourceAssetId || typeof edit.maskAssetId !== 'string' || !edit.maskAssetId || edit.maskAssetId === edit.sourceAssetId || !Number.isFinite(edit.strength) || edit.strength < 0 || edit.strength > 1) throw new Error('Invalid image mask edit');
  if (edit.instruction !== undefined && (typeof edit.instruction !== 'string' || !edit.instruction.trim())) throw new Error('Invalid image mask edit instruction');
  if (!Array.isArray(input.referenceAssetIds) || input.referenceAssetIds[0] !== edit.sourceAssetId || input.referenceAssetIds.includes(edit.maskAssetId) || new Set(input.referenceAssetIds).size !== input.referenceAssetIds.length || input.referenceAssetIds.length !== (edit.mode === 'native_mask' ? 1 : 2)) throw new Error('Invalid image mask edit references');
}

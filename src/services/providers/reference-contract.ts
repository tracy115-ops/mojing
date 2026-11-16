import type {
  GenerationReferenceInput,
  GenerationReferenceRole,
} from '../../types/providers.ts';

export interface ReferenceInputBundle {
  images: string[];
  slots: GenerationReferenceInput[];
}

export interface ReferenceSlotDescriptor {
  id: string;
  role: GenerationReferenceRole;
  image: string;
  label?: string;
  subjectId?: string;
  subjectIds?: string[];
}

/**
 * Materialize one provider-facing reference contract. Callers may provide
 * either the legacy image array, semantic slots, or both; when both exist
 * they must describe the exact same payloads in the exact same order.
 */
export function materializeReferenceInputBundle(
  referenceImages: string[] | undefined,
  referenceSlots: GenerationReferenceInput[] | undefined,
  fallbackRole: GenerationReferenceRole = 'custom',
  context = 'generation request',
): ReferenceInputBundle {
  const images = referenceImages
    ? referenceImages.map((image) => image?.trim())
    : (referenceSlots ?? []).map((slot) => slot.image?.trim());

  if (referenceImages && referenceSlots && referenceImages.length !== referenceSlots.length) {
    throw new Error(
      `${context} reference contract mismatch: referenceImages has ${referenceImages.length} item(s), `
        + `but referenceSlots has ${referenceSlots.length}`,
    );
  }

  images.forEach((image, index) => {
    if (!image) throw new Error(`${context} reference ${index + 1} is empty`);
  });

  const slots = referenceSlots
    ? referenceSlots.map((slot, index) => {
        const image = images[index];
        if (slot.image?.trim() !== image) {
          throw new Error(
            `${context} reference slot ${index + 1} does not match its payload; `
              + 'the semantic slot and referenceImages entry must be the same image',
          );
        }
        return { ...slot, image };
      })
    : images.map((image, index) => ({
        id: `reference-${index + 1}`,
        role: fallbackRole,
        image,
      }));

  assertReferenceInputBundle(images, slots, context);
  return { images, slots };
}

export function assertReferenceInputBundle(
  images: string[],
  slots: GenerationReferenceInput[],
  context = 'generation request',
): void {
  if (images.length !== slots.length) {
    throw new Error(
      `${context} reference contract mismatch: ${images.length} payload(s) for ${slots.length} slot(s)`,
    );
  }

  const ids = new Set<string>();
  slots.forEach((slot, index) => {
    if (!slot.id?.trim()) throw new Error(`${context} reference slot ${index + 1} has no id`);
    if (ids.has(slot.id)) throw new Error(`${context} reference slot id is duplicated: ${slot.id}`);
    ids.add(slot.id);
    if (!slot.image?.trim()) throw new Error(`${context} reference slot ${index + 1} is empty`);
    if (slot.image !== images[index]) {
      throw new Error(
        `${context} reference slot ${index + 1} is not byte-for-byte aligned with its provider payload`,
      );
    }
  });
}

/** Align normalized video semantics with the original slot metadata. */
export function alignReferenceSlots(
  sourceSlots: GenerationReferenceInput[] | undefined,
  descriptors: ReferenceSlotDescriptor[],
  context = 'generation request',
): GenerationReferenceInput[] {
  const used = new Set<number>();
  const slots = descriptors.map((descriptor) => {
    const sourceIndex = sourceSlots?.findIndex((slot, index) => (
      !used.has(index)
      && slot.image === descriptor.image
    )) ?? -1;
    if (sourceIndex >= 0) used.add(sourceIndex);
    const source = sourceIndex >= 0 ? sourceSlots?.[sourceIndex] : undefined;
    return {
      id: source?.id ?? descriptor.id,
      role: descriptor.role,
      image: descriptor.image,
      label: descriptor.label ?? source?.label,
      subjectId: descriptor.subjectId ?? source?.subjectId,
      subjectIds: descriptor.subjectIds ?? source?.subjectIds,
    };
  });
  assertReferenceInputBundle(descriptors.map((descriptor) => descriptor.image), slots, context);
  return slots;
}

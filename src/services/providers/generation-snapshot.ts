import type {
  GenerationReferenceInput,
  GenerationReferenceSnapshot,
  GenerationResponseSnapshot,
  GenerationRequestSnapshot,
  LLMGenerateRequest,
  ImageGenerateRequest,
  VideoGenerateRequest,
} from '../../types/providers.ts';
import {
  assertReferenceInputBundle,
  materializeReferenceInputBundle,
} from './reference-contract.ts';

/**
 * A compact, non-cryptographic fingerprint is enough for lineage checks. It
 * avoids persisting large base64 payloads while still showing whether two
 * requests used the same source material.
 */
export function fingerprintPayload(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sample = value.length <= 8192
    ? value
    : `${value.slice(0, 4096)}|${value.slice(-4096)}|length=${value.length}`;
  let hash = 2166136261;
  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`;
}

export function payloadKind(value: string): GenerationReferenceSnapshot['payloadKind'] {
  if (/^data:(image|audio|video)\//i.test(value)) return 'data_uri';
  if (/^https?:\/\//i.test(value)) return 'url';
  if (/^[A-Za-z0-9+/\s]+=*$/.test(value)) return 'base64';
  return 'unknown';
}

export function buildReferenceSnapshots(
  slots: GenerationReferenceInput[],
): GenerationReferenceSnapshot[] {
  assertReferenceInputBundle(
    slots.map((slot) => slot.image),
    slots,
    'request snapshot',
  );
  return slots.map((slot, index) => ({
      id: slot.id,
      role: slot.role,
      label: slot.label,
      subjectId: slot.subjectId,
      subjectIds: slot.subjectIds,
      providerIndex: index,
      payloadFingerprint: fingerprintPayload(slot.image) ?? 'empty',
      payloadKind: payloadKind(slot.image),
    }));
}

export function buildImageRequestSnapshot(
  request: ImageGenerateRequest,
  acceptedParameterKeys: string[],
  rejectedParameterKeys: string[],
  wireParameterValues?: Record<string, unknown>,
): GenerationRequestSnapshot {
  const bundle = materializeReferenceInputBundle(
    request.referenceImages,
    request.referenceSlots,
    'custom',
    'image request snapshot',
  );
  const slots = bundle.slots;
  return {
    schemaVersion: 1,
    taskType: request.taskType,
    model: request.model ?? 'provider-default',
    controlMode: undefined,
    promptFingerprint: fingerprintPayload(request.prompt) ?? 'empty',
    parameterValues: { ...(request.parameters ?? {}) },
    ...(wireParameterValues ? { wireParameterValues: { ...wireParameterValues } } : {}),
    acceptedParameterKeys: [...acceptedParameterKeys],
    rejectedParameterKeys: [...rejectedParameterKeys],
    referenceSlots: [...buildReferenceSnapshots(slots), ...(request.mask ? [{ id: 'image-edit-mask', role: 'custom' as const, label: 'Mask: white edits, black preserves', providerIndex: slots.length, payloadFingerprint: fingerprintPayload(request.mask)!, payloadKind: payloadKind(request.mask), mediaKind: 'image' as const }] : [])],
  };
}

export function buildVideoRequestSnapshot(
  request: VideoGenerateRequest,
  acceptedParameterKeys: string[],
  rejectedParameterKeys: string[],
  wireParameterValues?: Record<string, unknown>,
): GenerationRequestSnapshot {
  const bundle = materializeReferenceInputBundle(
    request.referenceImages,
    request.referenceSlots,
    'custom',
    'video request snapshot',
  );
  const slots = bundle.slots.length > 0
    ? bundle.slots
    : inferVideoReferenceSlots(request);
  return {
    schemaVersion: 1,
    taskType: request.taskType,
    model: request.model ?? 'provider-default',
    controlMode: request.controlMode,
    promptFingerprint: fingerprintPayload(request.prompt) ?? 'empty',
    parameterValues: { ...(request.parameters ?? {}) },
    ...(wireParameterValues ? { wireParameterValues: { ...wireParameterValues } } : {}),
    acceptedParameterKeys: [...acceptedParameterKeys],
    rejectedParameterKeys: [...rejectedParameterKeys],
    referenceSlots: [...buildReferenceSnapshots(slots), ...(['audio', 'video'] as const).flatMap((kind) => (kind === 'audio' ? request.audioReferences ?? [] : request.videoReferences ?? []).map((reference, index) => ({
      id: reference.id, role: 'custom' as const, label: reference.label, mediaKind: kind, providerIndex: index,
      payloadFingerprint: fingerprintPayload(reference.url) ?? 'empty', payloadKind: payloadKind(reference.url),
    })))],
  };
}

export function buildLLMRequestSnapshot(
  request: LLMGenerateRequest,
): GenerationRequestSnapshot {
  return {
    schemaVersion: 1,
    taskType: request.taskType,
    model: request.model ?? 'provider-default',
    controlMode: undefined,
    promptFingerprint: fingerprintPayload(
      `${request.systemPrompt}\n${request.userPrompt}`,
    ) ?? 'empty',
    parameterValues: {
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      responseFormat: request.responseFormat,
    },
    acceptedParameterKeys: ['maxTokens', 'temperature', 'responseFormat'].filter((key) => {
      const value = key === 'maxTokens'
        ? request.maxTokens
        : key === 'temperature'
          ? request.temperature
          : request.responseFormat;
      return value !== undefined;
    }),
    rejectedParameterKeys: [],
    referenceSlots: (request.imageInputs ?? []).map((image, index) => ({
      id: `llm-image-${index + 1}`,
      role: 'custom' as const,
      label: `visual input ${index + 1}`,
      providerIndex: index,
      payloadFingerprint: fingerprintPayload(image) ?? 'empty',
      payloadKind: payloadKind(image),
    })),
  };
}

export function buildResponseSnapshot(
  category: 'image' | 'video' | 'tts',
  response: {
    imageData?: string;
    videoData?: string;
    audioData?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    provider: string;
    model: string;
  },
): GenerationResponseSnapshot {
  const outputKind = category === 'image' ? 'image' : category === 'video' ? 'video' : 'audio';
  const output = response.imageData ?? response.videoData ?? response.audioData;
  return {
    schemaVersion: 1,
    outputKind,
    outputFingerprint: fingerprintPayload(output),
    width: response.width,
    height: response.height,
    durationSeconds: response.durationSeconds,
    provider: response.provider,
    model: response.model,
  };
}

function inferVideoReferenceSlots(request: VideoGenerateRequest): GenerationReferenceInput[] {
  if (request.controlMode === 'keyframe' || request.firstFrame || request.lastFrame) {
    const slots: GenerationReferenceInput[] = [];
    const firstFrame = request.firstFrame ?? request.referenceImages?.[0];
    const lastFrame = request.lastFrame ?? request.referenceImages?.[1];
    if (firstFrame) slots.push({ id: 'first-frame', role: 'first_frame', image: firstFrame });
    if (lastFrame) slots.push({ id: 'last-frame', role: 'last_frame', image: lastFrame });
    return slots;
  }
  if (request.controlMode === 'reference' || request.subjectReferences?.length) {
    return (request.subjectReferences ?? request.referenceImages?.map((image, index) => ({
      id: `subject-${index + 1}`,
      image,
      label: `subject ${index + 1}`,
    })) ?? []).map((reference) => ({
      id: reference.id,
      role: 'subject' as const,
      image: reference.image,
      label: reference.label,
      subjectId: reference.id,
    }));
  }
  return [];
}

import type {
  GenerationParameterLocation,
  GenerationParameterSpec,
} from '../../types/providers.ts';

type ParameterizedRequest = {
  parameters?: Record<string, unknown>;
  parameterSpecs?: GenerationParameterSpec[];
};

const locationTargets: Record<GenerationParameterLocation, string> = {
  body: '',
  input: 'input',
  parameters: 'parameters',
  extraBody: 'extra_body',
};

/**
 * Forward only contract-declared parameters that an adapter did not map
 * explicitly. This keeps provider-specific fields extensible without sending
 * arbitrary planner output to an API.
 */
export function applyUnconsumedGenerationParameters(
  body: Record<string, unknown>,
  request: ParameterizedRequest,
  handledKeys: ReadonlySet<string> | readonly string[],
  defaultLocation: GenerationParameterLocation = 'body',
): void {
  const values = request.parameters;
  if (!values || !request.parameterSpecs?.length) return;

  const handled = handledKeys instanceof Set ? handledKeys : new Set(handledKeys);
  for (const spec of request.parameterSpecs) {
    if (handled.has(spec.key) || !Object.prototype.hasOwnProperty.call(values, spec.key)) continue;
    const value = values[spec.key];
    if (value === undefined || value === null) continue;

    const location = spec.transport?.location ?? defaultLocation;
    const targetKey = locationTargets[location];
    const target = targetKey
      ? ensureObject(body, targetKey)
      : body;
    target[spec.transport?.key ?? spec.key] = value;
  }
}

function ensureObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = body[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  body[key] = next;
  return next;
}

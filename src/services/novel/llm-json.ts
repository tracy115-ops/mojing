/**
 * Robust JSON parser for LLM responses.
 * Handles markdown fences, trailing commas, and partial JSON extraction.
 */

export function parseLLMJson<T = Record<string, unknown>>(raw: string): T | null {
  let text = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Strip trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(text) as T;
  } catch {
    // Last resort: extract first { ... } block
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(text.slice(braceStart, braceEnd + 1)) as T;
      } catch { /* give up */ }
    }

    // Try array form too
    const bracketStart = text.indexOf('[');
    const bracketEnd = text.lastIndexOf(']');
    if (bracketStart !== -1 && bracketEnd > bracketStart) {
      try {
        return JSON.parse(text.slice(bracketStart, bracketEnd + 1)) as T;
      } catch { /* give up */ }
    }

    console.warn('parseLLMJson: could not parse LLM response');
    return null;
  }
}

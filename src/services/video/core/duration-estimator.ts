// Estimate a shot duration from explicit timing and available speech facts.
// Content-specific keyword lists do not belong in the execution pipeline.

export interface DurationEstimateParams {
  text?: string;
  narration?: string;
  dialogue?: { speaker?: string; text: string }[];
  /** Kept for call-site compatibility; timing is not inferred from camera labels. */
  cameraMovement?: string;
  /** Kept for call-site compatibility; timing is not inferred from story keywords. */
  hasAction?: boolean;
  explicitDuration?: number;
  defaultShotDuration?: number;
}

export function estimateSmartShotDuration(params: DurationEstimateParams): number {
  const explicit = params.explicitDuration;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return clampDuration(explicit);
  }

  const spokenText = params.dialogue?.map((item) => item.text).join(' ').trim()
    || params.narration?.trim()
    || extractQuotedText(params.text || '');
  const spokenUnits = countSpokenUnits(spokenText);

  if (spokenUnits > 0) {
    // This is deliberately a language-neutral estimate. TTS remains the
    // authority for the final duration when audio is generated.
    return clampDuration(Math.max(3, spokenUnits / 4 + 0.6), 3, 12);
  }

  if (typeof params.defaultShotDuration === 'number'
    && Number.isFinite(params.defaultShotDuration)
    && params.defaultShotDuration > 0) {
    return clampDuration(params.defaultShotDuration);
  }

  return 4;
}

function countSpokenUnits(value: string): number {
  const text = value.trim();
  if (!text) return 0;

  const whitespaceTokens = text.split(/\s+/).filter(Boolean);
  if (whitespaceTokens.length > 1) return whitespaceTokens.length * 1.5;

  return [...text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

function extractQuotedText(text: string): string {
  const fragments: string[] = [];
  const patterns = [
    /"([^"\r\n]+)"/g,
    /“([^”\r\n]+)”/g,
    /「([^」\r\n]+)」/g,
    /«([^»\r\n]+)»/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) fragments.push(match[1]);
    }
  }
  return fragments.join(' ');
}

function clampDuration(value: number, min = 2, max = 18): number {
  return Math.max(min, Math.min(max, Math.round(value * 2) / 2));
}

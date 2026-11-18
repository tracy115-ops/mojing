import type { ShotSpec } from '../../../types/video.ts';

export function getShotSubtitleText(shot?: Pick<ShotSpec, 'dialogue' | 'narration'>): string | null {
  const lines = (shot?.dialogue ?? []).map(line => line.text?.trim()).filter((text): text is string => !!text);
  const narration = shot?.narration?.trim();
  // Older plans copied the first dialogue line into narration as well.
  if (narration && !lines.includes(narration)) lines.push(narration);
  return lines.length ? lines.join('\n') : null;
}

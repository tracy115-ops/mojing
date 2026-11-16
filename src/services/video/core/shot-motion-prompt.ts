// Copyright (c) 2026 ddcat and Open AI Canvas contributors.
// Adapted from Open AI Canvas's production/segment_prompt.go (MIT).
// Source and license: docs/video-generation/16-open-ai-canvas-sync.md.
import type { CharacterAnchor, ShotSpec } from '../../../types/video.ts';
import type { VideoControlMode } from '../../../types/providers.ts';
import {
  buildExactSubjectConstraint,
  buildMultiCharacterDnaTokens,
  buildOffscreenBindingText,
} from './character-dna.ts';

const CAMERA_MOVES: Record<string, string> = {
  static: 'fixed camera', zoom_in: 'slow camera push in', zoom_out: 'slow camera pull back',
  pan_left: 'smooth pan left', pan_right: 'smooth pan right',
  orbit: 'gentle camera arc around the subject', tracking: 'smooth tracking shot',
};

export const SHOT_DIRECTION_PLANNING_RULE = 'Give each short shot one primary action and one motivated camera movement. Define a visible opening state and a natural ending state. Split changes of location, wardrobe, time, or several competing actions into separate shots. Keep the ending alive with subtle subject and environmental motion instead of a frozen hold.';

/** Carry the editable shot direction into every actual generation request. */
export function buildVideoGenerationPrompt(
  shot: ShotSpec,
  presentCharacters: CharacterAnchor[],
  controlMode: VideoControlMode,
): string {
  const motion = shot.videoPrompt.trim() || shot.sourceText?.trim();
  if (!motion) return '';
  const facts = [
    motion,
    shot.cameraMovement?.trim()
      ? `[Camera] ${CAMERA_MOVES[shot.cameraMovement.trim()] ?? shot.cameraMovement.trim()}` : '',
    shot.startState?.trim() ? `[Start state] ${shot.startState.trim()}` : '',
    shot.endState?.trim() ? `[End state] ${shot.endState.trim()}` : '',
    shot.transition === 'continue' ? '[Continuity] Continue the declared opening state without resetting subject position, pose, wardrobe, or lighting.' : '',
    buildExactSubjectConstraint(presentCharacters),
    buildOffscreenBindingText(shot),
    '[Shot direction] Render one continuous shot with physically coherent motion. Preserve screen direction and subject positions. End with a natural settling action; keep breathing and environmental motion alive.',
  ];
  if (controlMode === 'keyframe') {
    facts.push('[I2V motion contract] The supplied first frame is authoritative for subject identity, wardrobe, form, composition, lighting, and background. Animate only the declared action, state change, and camera movement. Do not redesign, duplicate, merge, or add a visible subject.');
  } else if (controlMode === 'reference') {
    facts.push('[Subject reference contract] Each supplied reference defines its assigned subject identity and wardrobe. Stage the declared action in the described scene; these images are identity references, not temporal first or last frames.');
    if (presentCharacters.length > 0) {
      facts.push(buildMultiCharacterDnaTokens(presentCharacters, shot.costumeVariantRefs, { referenceBound: true }));
    }
  } else if (presentCharacters.length > 0) {
    facts.push(buildMultiCharacterDnaTokens(presentCharacters, shot.costumeVariantRefs, { referenceBound: false }));
  }
  return facts.filter(Boolean).join('\n\n');
}

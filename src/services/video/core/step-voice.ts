// step-voice.ts — 步 4:分配音色
// Direct 通道:LLM 按 gender/age 推荐默认音色
// Novel 通道:从 NovelBible.voiceRef 注入(后续接 Character store)
// 没配 TTS provider 时跳过,不阻塞

import type { CharacterAnchor } from '@/types/video';

export interface VoiceAssignResult {
  characters: CharacterAnchor[];
}

interface VoicePreset {
  id: string;
  label: string;
  gender: 'male' | 'female';
  ageGroup: 'child' | 'teen' | 'young' | 'middle' | 'elder';
}

// 占位音色库 — 实际接入 TTS provider 时替换成 provider 的音色列表
const VOICE_PRESETS: VoicePreset[] = [
  { id: 'female_young_01', label: '年轻女声 1', gender: 'female', ageGroup: 'young' },
  { id: 'female_middle_01', label: '中年女声 1', gender: 'female', ageGroup: 'middle' },
  { id: 'female_elder_01', label: '老年女声', gender: 'female', ageGroup: 'elder' },
  { id: 'male_young_01', label: '年轻男声 1', gender: 'male', ageGroup: 'young' },
  { id: 'male_middle_01', label: '中年男声 1', gender: 'male', ageGroup: 'middle' },
  { id: 'male_elder_01', label: '老年男声', gender: 'male', ageGroup: 'elder' },
  { id: 'child_01', label: '童声', gender: 'female', ageGroup: 'child' },
];

export async function stepVoice(characters: CharacterAnchor[]): Promise<VoiceAssignResult> {
  // 已有 voiceRef 的不覆盖
  const result: CharacterAnchor[] = characters.map((c) => {
    if (c.voiceRef) return c;
    const preset = pickVoice(c.gender, c.ageGroup);
    return preset ? { ...c, voiceRef: preset.id } : c;
  });
  return { characters: result };
}

function pickVoice(
  gender: CharacterAnchor['gender'],
  ageGroup: CharacterAnchor['ageGroup'],
): VoicePreset | undefined {
  if (gender === 'unknown' && ageGroup === 'unknown') {
    return VOICE_PRESETS.find((v) => v.id === 'female_young_01');
  }
  const matchByGender = VOICE_PRESETS.filter((v) => gender === 'unknown' || v.gender === gender);
  const matchByAge = matchByGender.find((v) => v.ageGroup === ageGroup);
  return matchByAge ?? matchByGender[0];
}

export function listVoicePresets(): VoicePreset[] {
  return VOICE_PRESETS;
}

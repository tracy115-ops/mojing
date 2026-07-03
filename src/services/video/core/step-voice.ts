// step-voice.ts — 步 4:分配音色
// Direct 通道:LLM 按 gender/age 推荐默认音色
// Novel 通道:从 NovelBible.voiceRef 注入(后续接 Character store)
// 没配 TTS provider 时跳过,不阻塞
//
// 重要:voiceRef 必须是 TTS provider 实际认识的音色 ID,而不是占位 ID。
// 否则 provider 收到陌生 voice 会兜底用默认音色(OpenAI 'alloy' 偏男声,
// 会让所有角色都变男音)。这里按当前激活的 TTS provider 类型选真实 ID。

import type { CharacterAnchor } from '@/types/video';
import type { TTSProviderId } from '@/types/providers';
import { providerRouter } from '@/services/providers';

export interface VoiceAssignResult {
  characters: CharacterAnchor[];
}

interface VoicePreset {
  id: string;
  label: string;
  gender: 'male' | 'female';
  ageGroup: 'child' | 'teen' | 'young' | 'middle' | 'elder';
}

// UI 展示用的占位音色库(只用于列表展示,实际 voiceRef 用 REAL_VOICES)
const VOICE_PRESETS: VoicePreset[] = [
  { id: 'female_young_01', label: '年轻女声 1', gender: 'female', ageGroup: 'young' },
  { id: 'female_middle_01', label: '中年女声 1', gender: 'female', ageGroup: 'middle' },
  { id: 'female_elder_01', label: '老年女声', gender: 'female', ageGroup: 'elder' },
  { id: 'male_young_01', label: '年轻男声 1', gender: 'male', ageGroup: 'young' },
  { id: 'male_middle_01', label: '中年男声 1', gender: 'male', ageGroup: 'middle' },
  { id: 'male_elder_01', label: '老年男声', gender: 'male', ageGroup: 'elder' },
  { id: 'child_01', label: '童声', gender: 'female', ageGroup: 'child' },
];

/** 各 TTS provider 的真实音色 ID(按性别 + 年龄档)。
 *  这些是 provider API 实际接受的字符串。 */
const REAL_VOICES: Partial<Record<TTSProviderId, {
  female: { child?: string; teen?: string; young: string; middle: string; elder?: string };
  male: { child?: string; teen?: string; young: string; middle: string; elder?: string };
}>> = {
  // OpenAI TTS 标准 6 个音色:alloy(中性偏男)、echo(男)、fable(中性偏英)、
  // onyx(深男)、nova(女)、shimmer(女)。男声 = echo/onyx,女声 = nova/shimmer。
  'openai-tts': {
    female: { young: 'nova', middle: 'shimmer', elder: 'shimmer' },
    male: { young: 'echo', middle: 'onyx', elder: 'onyx' },
  },
  // Edge TTS 中文音色(微软官方,免费)
  'edge-tts': {
    female: {
      child: 'zh-CN-XiaoyiNeural',
      young: 'zh-CN-XiaoxiaoNeural',
      middle: 'zh-CN-XiaomoNeural',
      elder: 'zh-CN-XiaomengNeural',
    },
    male: {
      child: 'zh-CN-YunjianNeural',
      young: 'zh-CN-YunxiNeural',
      middle: 'zh-CN-YunyangNeural',
      elder: 'zh-CN-YunyeNeural',
    },
  },
  'doubao-tts': {
    female: { young: 'zh_female_qingxin', middle: 'zh_female_wenrou', elder: 'zh_female_wenrou' },
    male: { young: 'zh_male_qingse', middle: 'zh_male_chunhou', elder: 'zh_male_chunhou' },
  },
};

export async function stepVoice(characters: CharacterAnchor[]): Promise<VoiceAssignResult> {
  const providerId = providerRouter.getActiveTTSProviderId();

  // 第一轮:给 gender 已知的角色分配真实音色
  // 第二轮:给 gender=unknown 的角色轮流分配,保证多角色不撞同一音色
  // (之前 unknown 直接跳过 → 该角色永远没 voiceRef → step-tts 选不到)
  const usedVoices = new Set<string>();
  const result: CharacterAnchor[] = characters.map((c) => {
    if (c.voiceRef) {
      usedVoices.add(c.voiceRef);
      return c;
    }
    const realVoice = pickRealVoice(providerId, c.gender, c.ageGroup);
    if (realVoice) {
      usedVoices.add(realVoice);
      return { ...c, voiceRef: realVoice };
    }
    return c;
  });

  // gender=unknown 的角色:轮流从 provider 的全部音色里挑没用过的
  if (providerId && REAL_VOICES[providerId]) {
    const table = REAL_VOICES[providerId];
    // 拍平所有可选音色,先女后男(unknown 时默认倾向女声,中文旁白女声更常见)
    const allVoices: string[] = [
      ...Object.values(table.female),
      ...Object.values(table.male),
    ].filter((v): v is string => typeof v === 'string');
    let nextIdx = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].voiceRef) continue;
      // 找一个没用过的
      let pick: string | undefined;
      for (let k = 0; k < allVoices.length; k++) {
        const idx = (nextIdx + k) % allVoices.length;
        if (!usedVoices.has(allVoices[idx])) {
          pick = allVoices[idx];
          nextIdx = idx + 1;
          break;
        }
      }
      // 全都用过了 → 兜底取第一个
      if (!pick) {
        pick = allVoices[nextIdx % allVoices.length];
        nextIdx++;
      }
      usedVoices.add(pick);
      result[i] = { ...result[i], voiceRef: pick };
    }
  }

  return { characters: result };
}

/** 按当前 TTS provider 选真实音色 ID。provider 未配置或未知时返回 undefined
 *  (让 step-tts 走 provider 的默认音色,不强行覆盖)。 */
function pickRealVoice(
  providerId: TTSProviderId | null,
  gender: CharacterAnchor['gender'],
  ageGroup: CharacterAnchor['ageGroup'],
): string | undefined {
  if (!providerId) return undefined;
  const table = REAL_VOICES[providerId];
  if (!table) return undefined;

  // gender 已知:严格在对应性别里挑
  if (gender === 'male' || gender === 'female') {
    const byAge = table[gender];
    // ageGroup 可能是 'unknown' 或没对应档 → 兜底 young
    const byAgeTyped = byAge as Record<string, string | undefined>;
    return (ageGroup ? byAgeTyped[ageGroup] : undefined) ?? byAge.young;
  }
  // gender 未知 → 返回 undefined,由上层 stepVoice 轮流分配
  return undefined;
}

export function listVoicePresets(): VoicePreset[] {
  return VOICE_PRESETS;
}

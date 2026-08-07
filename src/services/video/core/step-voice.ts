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
const REAL_VOICES: Record<string, {
  female: { child?: string; teen?: string; young: string; middle: string; elder?: string };
  male: { child?: string; teen?: string; young: string; middle: string; elder?: string };
}> = {
  // OpenAI TTS 标准 6 个音色:alloy(中性偏男)、echo(男)、fable(中性偏英)、
  // onyx(深男)、nova(女)、shimmer(女)。男声 = echo/onyx,女声 = nova/shimmer。
  'openai-tts': {
    female: { child: 'nova', young: 'nova', middle: 'shimmer', elder: 'shimmer' },
    male: { child: 'echo', young: 'echo', middle: 'onyx', elder: 'onyx' },
  },
  // 硅基流动 TTS 预设音色(CosyVoice / FishSpeech)
  'siliconflow-tts': {
    female: { child: 'claire', young: 'anna', middle: 'bella', elder: 'diana' },
    male: { child: 'benjamin', young: 'alex', middle: 'david', elder: 'charles' },
  },
  '302ai-tts': {
    female: { child: 'claire', young: 'anna', middle: 'bella', elder: 'diana' },
    male: { child: 'benjamin', young: 'alex', middle: 'david', elder: 'charles' },
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

/** 从角色名字 / 提示词 / 描述中智能识别男女性别 */
function inferGender(c: CharacterAnchor): 'female' | 'male' | 'unknown' {
  if (c.gender === 'female' || c.gender === 'male') return c.gender;
  const raw = c as Record<string, unknown>;
  const text = `${c.name} ${c.appearance || ''} ${raw.prompt || ''} ${raw.description || ''}`;
  if (/女|姐|妹|母|妇|娘|姬|婷|美|莉|雪|雅|静|芳|萍|姿|靓|丫|媳|仙|妃|姑娘|丫鬟|公主|千金|female|girl|woman|lady|mother|sister|queen/i.test(text)) {
    return 'female';
  }
  if (/男|哥|弟|父|爷|叔|伯|汉|郎|帅|伟|强|军|平|峰|刚|建|公|少爷|老头|公子|国王|王爷|male|boy|man|father|brother|king/i.test(text)) {
    return 'male';
  }
  return 'unknown';
}

export async function stepVoice(characters: CharacterAnchor[]): Promise<VoiceAssignResult> {
  const providerId = providerRouter.getActiveTTSProviderId();

  // 第一轮:给 gender 已知或可推断出的角色分配真实音色
  const usedVoices = new Set<string>();
  const result: CharacterAnchor[] = characters.map((c) => {
    if (c.voiceRef) {
      usedVoices.add(c.voiceRef);
      return c;
    }
    const resolvedGender = inferGender(c);
    const realVoice = pickRealVoice(providerId, resolvedGender, c.ageGroup);
    if (realVoice) {
      usedVoices.add(realVoice);
      return { ...c, gender: resolvedGender !== 'unknown' ? resolvedGender : c.gender, voiceRef: realVoice };
    }
    return c;
  });

  // 第二轮: gender 依然 unknown 的角色，轮流分配不同音色
  if (providerId && REAL_VOICES[providerId]) {
    const table = REAL_VOICES[providerId];
    // 拍平所有可选音色,交替分配
    const allVoices: string[] = [
      ...Object.values(table.female),
      ...Object.values(table.male),
    ].filter((v): v is string => typeof v === 'string');
    let nextIdx = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].voiceRef) continue;
      let pick: string | undefined;
      for (let k = 0; k < allVoices.length; k++) {
        const idx = (nextIdx + k) % allVoices.length;
        if (!usedVoices.has(allVoices[idx])) {
          pick = allVoices[idx];
          nextIdx = idx + 1;
          break;
        }
      }
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

/** 按当前 TTS provider 选真实音色 ID。provider 未配置或未知时返回 undefined */
function pickRealVoice(
  providerId: TTSProviderId | null,
  gender: CharacterAnchor['gender'],
  ageGroup: CharacterAnchor['ageGroup'],
): string | undefined {
  if (!providerId) return undefined;
  const table = REAL_VOICES[providerId] ?? REAL_VOICES['openai-tts'];
  if (!table) return undefined;

  // gender 已知:严格在对应性别里挑
  if (gender === 'male' || gender === 'female') {
    const byAge = table[gender];
    const byAgeTyped = byAge as Record<string, string | undefined>;
    return (ageGroup ? byAgeTyped[ageGroup] : undefined) ?? byAge.young;
  }
  return undefined;
}

export function listVoicePresets(): VoicePreset[] {
  return VOICE_PRESETS;
}

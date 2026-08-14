// step-tts.ts — 步 8:TTS 配音
// 对每个 shot 的 narration 调 providerRouter.generateTTS。
// 音色选择:
//   - shot 在场角色的 voiceRef(由 step-voice 分配),取第一个有声的角色
//   - 若角色都没 voiceRef,用全局 defaultVoice
// 失败单个不阻塞,shot.audioTrack 留空,step-audio-merge 自动跳过该镜。

import { providerRouter } from '@/services/providers';
import type { ShotSpec, CharacterAnchor } from '@/types/video';
import { saveAsset } from '../asset-store';

export interface TTSResult {
  shots: ShotSpec[];
  /** 生成失败的 shotId */
  failedShotIds: string[];
}

export async function runTTS(
  shots: ShotSpec[],
  characters: CharacterAnchor[],
  ctx: { ttsTier: string; novelProjectId: string; model?: string },
  onProgress?: (done: number, total: number) => void,
): Promise<TTSResult> {
  const total = shots.length;
  const charById = new Map(characters.map((c) => [c.id, c]));
  const result: ShotSpec[] = shots.map((s) => ({ ...s }));
  const failedShotIds: string[] = [];
  let attempted = 0;
  let okCount = 0;
  let lastErr: unknown = null;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const dialogueStr = shot.dialogue?.map((d) => (d.speaker ? `${d.speaker}：${d.text}` : d.text)).join(' ');
    const text = (
      shot.narration ||
      dialogueStr ||
      shot.sourceText ||
      shot.videoPrompt
    )?.trim();

    if (!text) {
      onProgress?.(i + 1, total);
      continue;
    }
    attempted++;

    // 选音色:
    // 1. 如果 shot 有结构化的 dialogue 字段且标明了 speaker
    let speaker: CharacterAnchor | undefined;
    const directSpeakerName = shot.dialogue?.find((d) => d.speaker)?.speaker;
    if (directSpeakerName) {
      speaker = characters.find(
        (c) => c.name === directSpeakerName || c.aliases?.includes(directSpeakerName),
      );
    }

    // 2. 优先根据台词开头的角色名（如 "女生："、"胖橘猫："、"大师:"）精准比对角色或别名
    if (!speaker) {
      for (const c of characters) {
        const namesToCheck = [c.name, ...(c.aliases || [])].filter(Boolean);
        const matched = namesToCheck.some(
          (name) =>
            text.startsWith(`${name}:`) ||
            text.startsWith(`${name}：`) ||
            text.startsWith(`【${name}】`) ||
            new RegExp(`^${name}(?:（[^）]+）|\\([^)]+\\))?[:：]`).test(text) ||
            text.startsWith(name),
        );
        if (matched) {
          speaker = c;
          break;
        }
      }
    }

    // 3. 若台词没有包含角色名，则在在场角色列表中寻找匹配音色的角色
    if (!speaker) {
      speaker = shot.characterIds
        .map((cid) => charById.get(cid))
        .find((c) => c?.voiceRef);
    }

    const voice = speaker?.voiceRef;

    const cleanText = cleanNarrationForTTS(text);
    if (!cleanText) {
      onProgress?.(i + 1, total);
      continue;
    }

    try {
      const response = await providerRouter.generateTTS({
        text: cleanText,
        voice,
        model: ctx.model,
      });
      result[i].audioTrack = await saveAsset(
        ctx.novelProjectId,
        'audio',
        response.audioData,
        `tts_shot_${i + 1}`,
      );
      okCount++;
    } catch (err) {
      console.warn(`tts: failed for shot ${shot.id}`, err);
      lastErr = err;
      failedShotIds.push(shot.id);
      // audioTrack 留空,step-audio-merge 自动跳过该镜
    }
    onProgress?.(i + 1, total);
  }

  if (attempted > 0 && okCount === 0) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
    throw new Error(`所有 ${attempted} 次配音调用都失败。最近一次错误:${reason}`);
  }

  if (attempted === 0) {
    // 所有镜头都没有 narration 字段 → 一个 TTS 都没尝试。
    // 不抛错(避免阻塞后续阶段),但要让用户知道"没活可干"。
    console.warn('[tts] 所有镜头都没有 narration 字段,跳过 TTS 阶段');
  }

  return { shots: result, failedShotIds };
}

function cleanNarrationForTTS(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\[.*?\]/g, '') // 去除 [动作/神态] 提示
    .replace(/【.*?】/g, '')
    .replace(/（.*?）/g, '') // 去除 (括号) 提示
    .replace(/\(.*?\)/g, '')
    .replace(/^.*?[：:]\s*/g, '')  // 去除 "角色名:" 或 "角色名：" 前缀
    .replace(/[“”"「」]/g, '')     // 去除双引号/单引号等符号，让发音自然连贯
    .trim();
}

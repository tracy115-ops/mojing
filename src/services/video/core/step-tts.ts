// step-tts.ts — 步 8:TTS 配音
// 对每个 shot 的 narration 调 providerRouter.generateTTS。
// 音色选择:
//   - shot 在场角色的 voiceRef(由 step-voice 分配),取第一个有声的角色
//   - 若角色都没 voiceRef,用全局 defaultVoice
// 失败单个不阻塞,shot.audioTrack 留空,step-audio-merge 自动跳过该镜。

import { providerRouter } from '@/services/providers';
import type { ShotSpec, CharacterAnchor } from '@/types/video';

export interface TTSResult {
  shots: ShotSpec[];
  /** 生成失败的 shotId */
  failedShotIds: string[];
}

export async function runTTS(
  shots: ShotSpec[],
  characters: CharacterAnchor[],
  _ctx: { ttsTier: string },
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
    const text = shot.narration?.trim();
    if (!text) {
      // 没旁白的镜头跳过(对白镜头暂不处理)
      onProgress?.(i + 1, total);
      continue;
    }
    attempted++;

    // 选音色:shot 在场角色的 voiceRef,取第一个有 voiceRef 的角色
    const speaker = shot.characterIds
      .map((cid) => charById.get(cid))
      .find((c) => c?.voiceRef);
    const voice = speaker?.voiceRef;

    try {
      const response = await providerRouter.generateTTS({
        text,
        voice,
      });
      result[i].audioTrack = response.audioData;
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

  return { shots: result, failedShotIds };
}

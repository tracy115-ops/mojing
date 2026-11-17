// Adapter for the configured Suno-compatible proxy contract.

import { fetch as httpFetch } from './fetch-proxy.ts';

export interface SunoGenerateRequest {
  prompt: string;
  lyrics?: string;
  title?: string;
  styleOption?: string;
  vocalType?: 'male' | 'female' | 'duet' | 'instrumental';
  bpm?: number;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface SunoGenerateResponse {
  id: string;
  title: string;
  audioUrl: string;
  durationSeconds: number;
  tags: string[];
  lyrics: string;
  stylePrompt: string;
}

/** 核心黑科技 1: Suno 顶级 5 维风格矩阵构造器 */
export function buildSunoStylePrompt(
  styleOption: string = 'Pop',
  vocalType: 'male' | 'female' | 'duet' | 'instrumental' = 'female',
  bpm: number = 120
): string {
  if (vocalType === 'instrumental') {
    return `${styleOption}, Instrumental, Cinematic Production, Rich Layering, Melodic Lead, ${bpm} BPM, Studio Mastering`;
  }

  const vocalMap = {
    male: 'Expressive Male Vocals, Clear Diction, Powerful Pitch',
    female: 'Ethereal Female Vocals, Emotional Vocal, High Range, Polished',
    duet: 'Male and Female Harmony Duet, Alternating Vocals, Rich Choral',
    instrumental: 'Instrumental',
  };

  const vocalTag = vocalMap[vocalType] || vocalMap.female;

  return `${styleOption}, ${vocalTag}, ${bpm} BPM, Anthem, Pristine Mixing, Dynamic Range, Hit Song Production`;
}

/** 核心黑科技 2: 歌词结构化元标记工程器 (Metatag Structurer) */
export function buildStructuredLyrics(rawText: string): string {
  if (!rawText || rawText.trim().length === 0) {
    return '';
  }

  // 如果已经包含元标记,原样精修输出
  if (rawText.includes('[Verse') || rawText.includes('[Chorus')) {
    return rawText;
  }

  // 否则把普通文本自动结构化划分
  const lines = rawText.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= 4) {
    return `[Intro]\n\n[Chorus - Main Melody]\n${rawText}\n\n[Outro - Fade Out]`;
  }

  const half = Math.floor(lines.length / 2);
  const verse1 = lines.slice(0, half).join('\n');
  const chorus = lines.slice(half).join('\n');

  return `[Intro - Piano Melodic]\n\n[Verse 1]\n${verse1}\n\n[Chorus - Peak Energy]\n${chorus}\n\n[Outro - Echo Fade]`;
}

function outputOf(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return outputOf(value[0]);
  if (!value || typeof value !== 'object') return {};
  const data = value as Record<string, unknown>;
  return data.data ? { ...data, ...outputOf(data.data) } : data;
}

function audioUrlOf(data: Record<string, unknown>): string | undefined {
  const value = data.audio_url || data.audioUrl || data.url;
  if (!value) return undefined;
  if (typeof value !== 'string') throw new Error('Music API returned an invalid audio URL');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Music API returned an invalid audio URL');
  return url.href;
}

function assertTaskHealthy(data: Record<string, unknown>): void {
  const status = String(data.status || data.state || '').toLowerCase();
  if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status) || data.error) {
    throw new Error('Music generation task failed');
  }
}

/** Submit once; failures must remain failures rather than creating sample tracks. */
export async function generateSunoMusicSOP(
  req: SunoGenerateRequest,
  endpointOverride?: { baseUrl?: string; apiKey?: string }
): Promise<SunoGenerateResponse> {
  const baseUrl = (endpointOverride?.baseUrl || req.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Configure a music endpoint before generating');
  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid music endpoint URL');
  const apiKey = endpointOverride?.apiKey || req.apiKey || '';

  // 1. 自动重构 5 维风格 Prompt
  const stylePrompt = buildSunoStylePrompt(
    req.styleOption || 'Anime J-Pop, High energy, Electric Guitar',
    req.vocalType || 'female',
    req.bpm || 128
  );

  // 2. 自动格式化元标记歌词
  const structuredLyrics = buildStructuredLyrics(req.lyrics || '');
  if (!req.prompt.trim() && !structuredLyrics) throw new Error('A music prompt or lyrics is required');

  const body = {
    prompt: structuredLyrics || req.prompt,
    tags: stylePrompt,
    title: req.title || 'Untitled',
    make_instrumental: req.vocalType === 'instrumental',
    model: req.model || 'suno-v3.5',
    wait_audio: true,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const generateUrl = /\/v1$/.test(baseUrl)
    ? `${baseUrl}/audio/music`
    : `${baseUrl}/api/generate`;

  const res = await httpFetch(generateUrl, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Music API HTTP ${res.status}`);
  let data = outputOf(await res.json());
  assertTaskHealthy(data);
  const taskId = data.task_id || data.id;
  if (!audioUrlOf(data) && taskId) data = await pollSunoAudioStatus(baseUrl, String(taskId), headers);
  const audioUrl = audioUrlOf(data);
  if (!audioUrl) throw new Error('Music API returned no audio URL or usable task');
  const duration = Number(data.duration || data.durationSeconds);
  return {
    id: String(taskId || data.id || crypto.randomUUID()),
    title: String(data.title || req.title || 'Untitled'),
    audioUrl,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : 0,
    tags: stylePrompt.split(',').map((t) => t.trim()),
    lyrics: typeof data.lyrics === 'string' ? data.lyrics : structuredLyrics,
    stylePrompt,
  };
}

/** 轮询 Suno 音频生成状态 */
async function pollSunoAudioStatus(baseUrl: string, taskId: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const statusUrl = `${baseUrl}/api/generate/status?task_id=${encodeURIComponent(taskId)}`;
  
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const res = await httpFetch(statusUrl, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Music status HTTP ${res.status} (task ${taskId})`);
    const data = outputOf(await res.json());
    assertTaskHealthy(data);
    const status = String(data.status || data.state || '').toLowerCase();
    if (['success', 'completed', 'complete'].includes(status)) {
      if (!audioUrlOf(data)) throw new Error(`Music task ${taskId} completed without audio`);
      return data;
    }
  }
  throw new Error(`Music task ${taskId} is still pending; check the provider before resubmitting`);
}

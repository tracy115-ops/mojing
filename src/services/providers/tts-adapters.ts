// tts-adapters.ts — TTS Provider 适配层
// 当前实现:OpenAI TTS API(简单可靠,首版接入)
// 后续:字节豆包 TTS、Edge TTS(免费)

import type { TTSRequest, TTSResponse, TTSProviderId, ApiEndpoint } from '@/types/providers';
import { BaseTTSProvider } from './base';

// --- OpenAI TTS Adapter ---
// API: POST {baseUrl}/audio/speech
// Body: { model, input, voice, response_format, speed }
// Response: binary audio stream

export class OpenAITTSProvider extends BaseTTSProvider {
  readonly providerId: TTSProviderId = 'openai-tts';

  async generate(request: TTSRequest): Promise<TTSResponse> {
    const startTime = Date.now();
    const model = request.model || 'tts-1';
    const voice = request.voice || 'alloy';
    const format = request.format || 'mp3';
    const speed = request.speed ?? 1.0;

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    // 兼容用户填 https://api.openai.com/v1 或 https://api.openai.com
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/audio/speech` : `${baseUrl}/v1/audio/speech`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        input: request.text,
        voice,
        response_format: format,
        speed,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS API error ${response.status}: ${text}`);
    }

    // Response is binary audio
    const buffer = await response.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    return {
      audioData: `data:audio/${format};base64,${base64}`,
      format,
      // OpenAI TTS 不返回时长,粗略估算:mp3 24kbps ≈ 字符数 / 14
      durationSeconds: estimateDuration(request.text),
      model,
      voice,
      provider: 'openai-tts',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- 字节豆包 TTS Adapter (占位,待实装) ---

export class DoubaoTTSProvider extends BaseTTSProvider {
  readonly providerId: TTSProviderId = 'doubao-tts';

  async generate(_request: TTSRequest): Promise<TTSResponse> {
    throw new Error('DoubaoTTSProvider not implemented yet');
  }
}

// --- Edge TTS Adapter (免费,微软官方,无需 API Key) ---
//
// 协议:WSS → speech.platform.bing.com
// 流程:connect → config message → SSML message → 接收 binary mp3 分片 → close
// 参考:https://github.com/anyantudre/edge-tts-py 的逆向实现
//
// 注意:浏览器/Tauri webview 内 WebSocket 可直连该 endpoint,无需代理

const EDGE_TTS_WSS_URL =
  'wss://speech.platform.bing.com/speech/synthesis/tts/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// 默认音色 - 中文女声/男声 (用户可在请求里指定其他)
const EDGE_DEFAULT_VOICE_ZH_FEMALE = 'zh-CN-XiaoxiaoNeural';
const EDGE_DEFAULT_VOICE_ZH_MALE = 'zh-CN-YunxiNeural';

// 根据请求文本/音色推断 Edge voice
function resolveEdgeVoice(request: TTSRequest): string {
  if (request.voice && /^[a-z]{2}-[A-Z]{2}-/i.test(request.voice)) {
    return request.voice;
  }
  // 用户传语义化名 (如 female / male / xiaoxiao / yunxi) 帮助映射
  const v = (request.voice || '').toLowerCase();
  if (v.includes('male') || v.includes('yunxi') || v.includes('yunyang')) {
    return EDGE_DEFAULT_VOICE_ZH_MALE;
  }
  // 默认女声
  return EDGE_DEFAULT_VOICE_ZH_FEMALE;
}

export class EdgeTTSProvider extends BaseTTSProvider {
  readonly providerId: TTSProviderId = 'edge-tts';

  async generate(request: TTSRequest): Promise<TTSResponse> {
    const startTime = Date.now();
    const voice = resolveEdgeVoice(request);
    // Edge TTS 输出格式:audio-24khz-48kbitrate-mono-mp3
    const format = 'mp3';
    const outputFormat = 'audio-24khz-48kbitrate-mono-mp3';
    const ratePercent = request.speed ? `${((request.speed - 1) * 100).toFixed(0)}%` : '+0%';

    // SSML
    const ssml = [
      '<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'en-US\'>',
      `<voice name='${voice}'>`,
      `<prosody pitch='+0Hz' rate='${ratePercent}' volume='+0%'>`,
      escapeXml(request.text),
      '</prosody>',
      '</voice>',
      '</speak>',
    ].join('');

    // 通过 WebSocket 收发
    const audioChunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(EDGE_TTS_WSS_URL);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('Edge TTS timeout after 60s'));
      }, 60_000);

      ws.onopen = () => {
        // 1) config message
        ws.send(
          `X-Timestamp:${new Date().toISOString()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: { outputFormat, metadataOptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' } },
              },
            },
          }),
        );
        // 2) SSML message
        ws.send(
          `X-RequestId:${uuidV4()}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toISOString()}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml,
        );
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          // 控制消息,检查是否有错误
          if (ev.data.includes('Path:turn.error') || ev.data.includes('Path:error')) {
            clearTimeout(timeout);
            try { ws.close(); } catch { /* ignore */ }
            reject(new Error(`Edge TTS error: ${ev.data.slice(0, 500)}`));
          }
          return;
        }
        // binary frame: 前 2 字节 big-endian 是 header 长度,后面是 mp3 数据
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        const headerLen = (buf[0] << 8) | buf[1];
        const body = buf.slice(2 + headerLen);
        if (body.length > 0) {
          audioChunks.push(body);
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error(`Edge TTS WebSocket error: ${err instanceof Error ? err.message : 'unknown'}`));
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (audioChunks.length === 0) {
          reject(new Error('Edge TTS connection closed before any audio received'));
          return;
        }
        resolve();
      };
    });

    // 合并 chunks → base64 data URI
    const totalLen = audioChunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of audioChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const base64 = arrayBufferToBase64(merged.buffer);

    return {
      audioData: `data:audio/${format};base64,${base64}`,
      format,
      durationSeconds: estimateDuration(request.text),
      model: 'edge-tts',
      voice,
      provider: 'edge-tts',
      latencyMs: Date.now() - startTime,
    };
  }
}

// --- Factory ---

export function createTTSProvider(
  providerId: TTSProviderId,
  endpoint: ApiEndpoint,
): BaseTTSProvider {
  switch (providerId) {
    case 'openai-tts':
      return new OpenAITTSProvider(endpoint);
    case 'doubao-tts':
      return new DoubaoTTSProvider(endpoint);
    case 'edge-tts':
      return new EdgeTTSProvider(endpoint);
    default:
      // 默认走 OpenAI 兼容(很多 TTS 服务都兼容 OpenAI API)
      return new OpenAITTSProvider(endpoint);
  }
}

// --- helpers ---

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uuidV4(): string {
  // RFC 4122 v4 (无依赖实现)
  const bytes = new Uint8Array(16);
  (globalThis.crypto || (window as unknown as { crypto: Crypto }).crypto).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function estimateDuration(text: string): number {
  // 中文 ~ 4 字/秒,英文 ~ 3 词/秒,这里用字符数粗估
  const charCount = text.length;
  return Math.max(1, Math.round(charCount / 5));
}

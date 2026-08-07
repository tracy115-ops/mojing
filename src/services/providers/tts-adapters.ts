// tts-adapters.ts — TTS Provider 适配层
// 当前实现:OpenAI TTS API(简单可靠,首版接入)
// 后续:字节豆包 TTS、Edge TTS(免费)

import type { TTSRequest, TTSResponse, TTSProviderId, ApiEndpoint } from '@/types/providers';
import { BaseTTSProvider } from './base';
import { fetch as httpFetch } from './fetch-proxy';
import { logger } from '@/services/log';

// --- OpenAI TTS Adapter ---
// API: POST {baseUrl}/audio/speech
// Body: { model, input, voice, response_format, speed }
// Response: binary audio stream

export class OpenAITTSProvider extends BaseTTSProvider {
  readonly providerId: TTSProviderId = 'openai-tts';

  async generate(request: TTSRequest): Promise<TTSResponse> {
    const startTime = Date.now();
    const isOfficialOpenAI = this.endpoint.baseUrl.includes('api.openai.com');
    const isSiliconFlow = this.endpoint.baseUrl.includes('siliconflow.cn');
    const format = request.format || 'mp3';
    const speed = request.speed ?? 1.0;
    const rawVoice = request.voice || 'alex';

    const baseUrl = this.endpoint.baseUrl.replace(/\/+$/, '');
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/audio/speech` : `${baseUrl}/v1/audio/speech`;

    // 备选模型重试序列
    const defaultCandidates = isOfficialOpenAI
      ? ['tts-1', 'tts-1-hd']
      : isSiliconFlow
      ? ['FunAudioLLM/CosyVoice2-0.5B', 'FunAudioLLM/CosyVoice-300M-Instruct', 'fishaudio/fish-speech-1.5', 'cosyvoice-v1', 'tts-1']
      : ['FunAudioLLM/CosyVoice2-0.5B', 'FunAudioLLM/CosyVoice-300M-Instruct', 'cosyvoice-v1', 'tts-1', 'doubao-tts-v1'];

    let specifiedModel = request.model || (this.endpoint.models && this.endpoint.models.length > 0 ? this.endpoint.models[0] : undefined);
    
    // 如果保存的是下线旧模型(CosyVoice-300M)或识别模型(SenseVoiceSmall)，自动升级更正为 SiliconFlow 最新的 CosyVoice2-0.5B
    if (specifiedModel === 'FunAudioLLM/SenseVoiceSmall' || specifiedModel === 'FunAudioLLM/CosyVoice-300M') {
      specifiedModel = isSiliconFlow ? 'FunAudioLLM/CosyVoice2-0.5B' : 'FunAudioLLM/CosyVoice-300M-Instruct';
    }

    // 组合重试序列:如果有指定模型优先尝试指定模型;若报错400(模型不存在/不可用),自动倒扣重试后续候选模型
    const candidateModels = specifiedModel
      ? Array.from(new Set([specifiedModel, ...defaultCandidates]))
      : defaultCandidates;

    let lastError: Error | null = null;
    const isFemale = /female|woman|girl|lady|queen|anna|bella|claire|diana|nova|shimmer|xiaoxiao|xiaoyi|xiaomo|xiaomeng|qingxin|wenrou/i.test(rawVoice) || /^女|女/i.test(rawVoice);

    for (const modelCandidate of candidateModels) {
      // 按模型类型智能决定初始音色：
      // - OpenAI 系列模型(tts-1) -> 使用 alloy(男) / nova(女)
      // - CosyVoice / SiliconFlow 系列 -> 使用 alex(男) / anna(女) 或带前缀名
      const isOpenAIModel = /^tts-1/i.test(modelCandidate);
      const primaryVoice = isOpenAIModel
        ? (isFemale ? 'nova' : 'alloy')
        : (isFemale ? 'anna' : 'alex');

      // 多音色变体备选序列(防止中转站要求特定的带前缀名或旧样式名)
      const voiceVariants = Array.from(new Set([
        primaryVoice,
        isOpenAIModel ? 'alloy' : 'alex',
        isOpenAIModel ? 'nova' : 'anna',
        `${modelCandidate}:${primaryVoice}`,
        'alex',
        'alloy',
      ]));

      for (const voiceCandidate of voiceVariants) {
        let response = await httpFetch(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            model: modelCandidate,
            input: request.text,
            voice: voiceCandidate,
            response_format: format,
            speed,
          }),
          signal: this.timeoutSignal(60_000),
        });

        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const base64 = arrayBufferToBase64(buffer);
          return {
            audioData: `data:audio/${format};base64,${base64}`,
            format,
            durationSeconds: estimateDuration(request.text),
            model: modelCandidate,
            voice: voiceCandidate,
            provider: 'openai-tts',
            latencyMs: Date.now() - startTime,
          };
        }

        const text = await response.text().catch(() => '');
        // 如果是因为 Invalid voice 报错，循环进入下一个音色变体重试
        if (response.status === 400 && (text.includes('20047') || text.toLowerCase().includes('invalid voice'))) {
          logger.warn(`OpenAITTSProvider: model '${modelCandidate}' rejected voice '${voiceCandidate}', trying next voice variant...`);
          lastError = new Error(`OpenAI TTS API error 400: ${text}`);
          continue;
        }

        // 如果是因为 Model does not exist 报错，跳出当前模型的音色循环，尝试下一个候选模型
        if (response.status === 400 && (text.includes('20012') || text.toLowerCase().includes('model does not exist'))) {
          lastError = new Error(`OpenAI TTS API error 400 (模型 '${modelCandidate}' 不存在)。请在设置中填入有效 TTS 模型名。`);
          break;
        }

        // 其他错误直接记录并跳出
        lastError = new Error(`OpenAI TTS API error ${response.status}: ${text}`);
        break;
      }
    }

    throw lastError || new Error('OpenAI TTS API: 所有候选模型与音色变体组合均被服务器拒绝。');
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
// 协议(2025+ 更新):WSS → speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
// 流程:connect(带 Sec-MS-GEC token) → config message → SSML message → 接收 binary mp3 分片 → close
// 参考:https://github.com/travisvn/edge-tts-universal 的 TS 实现
//
// 关键:微软现在要求 Sec-MS-GEC token,缺失/过期会 403。token 算法:
//   ticks = ((unixSec + 11644473600) // 300) * 1e7  (Windows file time, 100ns 单位,300s 取整)
//   sha256(ticks + TRUSTED_CLIENT_TOKEN).hex().upper()
// 有效期 ~5 分钟,每次连接重新生成。

const EDGE_TTS_WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_TTS_GEC_VERSION = '1-130.0.2849.68';

/** 生成 Sec-MS-GEC token(Windows file time + SHA256)。每次连接重新算。 */
async function generateSecMsGec(): Promise<string> {
  const WIN_EPOCH = 11644473600; // 1970-01-01 → 1601-01-01 (Windows epoch)
  let ticks = Date.now() / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300; // 取整到 5 分钟边界
  ticks *= 1e7; // sec → 100ns ticks (1e9 / 100)
  const strToHash = `${ticks.toFixed(0)}${EDGE_TTS_TOKEN}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(strToHash);
  // Web Crypto SHA-256
  const cryptoObj = globalThis.crypto || (window as unknown as { crypto: Crypto }).crypto;
  const hashBuffer = await cryptoObj.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

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
    await new Promise<void>(async (resolve, reject) => {
      // 每次连接生成新的 Sec-MS-GEC token(有效期 5 分钟)和 ConnectionId
      const secMsGec = await generateSecMsGec();
      const connectionId = uuidV4();
      const wsUrl =
        `${EDGE_TTS_WSS_BASE}?TrustedClientToken=${EDGE_TTS_TOKEN}` +
        `&ConnectionId=${connectionId}` +
        `&Sec-MS-GEC=${secMsGec}` +
        `&Sec-MS-GEC-Version=${EDGE_TTS_GEC_VERSION}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(new Error(`Edge TTS WebSocket 构造失败: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
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
        // 2) SSML message — X-RequestId 必须和 connectionId 一致(微软要求)
        ws.send(
          `X-RequestId:${connectionId}\r\n` +
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

      ws.onerror = () => {
        // 浏览器/Tauri webview 的 error event 是 Event 不是 Error,
        // 真正的错误细节在随后的 close event 里(code + reason)。
        // 这里不立即 reject,让 onclose 处理,避免双重 reject + 错误消息含糊。
        void logger.warn('[edge-tts] WebSocket onerror triggered, waiting for onclose', 'tts');
      };

      ws.onclose = (ev) => {
        clearTimeout(timeout);
        if (audioChunks.length === 0) {
          const reason = ev.reason || `(code=${ev.code}, no reason)`;
          reject(new Error(
            `Edge TTS 连接关闭,未收到任何音频。close code=${ev.code} reason=${reason}. ` +
            `常见原因:1) Tauri webview CSP 阻塞 wss; 2) 网络代理拦截 wss; 3) voice 名称错误。`,
          ));
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

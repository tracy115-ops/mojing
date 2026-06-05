import type {
  LLMGenerateRequest,
  LLMGenerateResponse,
  LLMStreamChunk,
  ApiEndpoint,
} from '@/types/providers';
import { BaseLLMProvider } from './base';

// --- OpenAI-Compatible Adapter ---
// Works with: OpenAI, DeepSeek, Qwen, GLM, Doubao (via compatible endpoint)

export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly providerId = 'openai-compatible';

  constructor(endpoint: ApiEndpoint, public readonly name: string) {
    super(endpoint);
  }

  private getChatUrl(): string {
    const base = this.endpoint.baseUrl.replace(/\/+$/, '');
    // If the URL already ends with /v1 or similar versioned path, use it directly
    if (/\/v\d+$/.test(base)) {
      return `${base}/chat/completions`;
    }
    // Default: append directly (DeepSeek uses https://api.deepseek.com/chat/completions)
    return `${base}/chat/completions`;
  }

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: request.model || 'gpt-4o',
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    if (request.stopSequences?.length) {
      body.stop = request.stopSequences;
    }

    const response = await fetch(this.getChatUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? '',
      model: data.model ?? request.model ?? 'gpt-4o',
      provider: this.endpoint.provider as LLMGenerateResponse['provider'],
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      latencyMs: Date.now() - startTime,
    };
  }

  async *stream(request: LLMGenerateRequest): AsyncIterable<LLMStreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model || 'gpt-4o',
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    const response = await fetch(this.getChatUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(`LLM stream error ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') {
          yield { delta: '', done: true };
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            yield { delta, done: false };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    yield { delta: '', done: true };
  }
}

// --- Claude (Anthropic) Adapter ---

export class ClaudeProvider extends BaseLLMProvider {
  readonly providerId = 'claude';

  constructor(endpoint: ApiEndpoint) {
    super(endpoint);
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.endpoint.apiKey,
      'anthropic-version': '2023-06-01',
      ...this.endpoint.customHeaders,
    };
  }

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const startTime = Date.now();
    const model = request.model || 'claude-sonnet-4-20250514';

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userPrompt }],
      temperature: request.temperature ?? 0.7,
    };

    if (request.stopSequences?.length) {
      body.stop_sequences = request.stopSequences;
    }

    const base = this.endpoint.baseUrl.replace(/\/+$/, '');
    const messagesUrl = /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;

    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Claude API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');

    return {
      content: textBlock?.text ?? '',
      model: data.model ?? model,
      provider: 'claude',
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      latencyMs: Date.now() - startTime,
    };
  }

  async *stream(request: LLMGenerateRequest): AsyncIterable<LLMStreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model || 'claude-sonnet-4-20250514',
      max_tokens: request.maxTokens ?? 4096,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userPrompt }],
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    const base = this.endpoint.baseUrl.replace(/\/+$/, '');
    const messagesUrl = /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;

    const response = await fetch(messagesUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(`Claude stream error ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('event: ') && !trimmed.startsWith('data: ')) continue;
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);

        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { delta: parsed.delta.text, done: false };
          } else if (parsed.type === 'message_stop') {
            yield { delta: '', done: true };
            return;
          }
        } catch {
          // Skip
        }
      }
    }

    yield { delta: '', done: true };
  }
}

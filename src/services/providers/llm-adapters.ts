import type {
  LLMGenerateRequest,
  LLMGenerateResponse,
  LLMStreamChunk,
  ApiEndpoint,
} from '@/types/providers';
import { BaseLLMProvider } from './base.ts';
import { fetch as httpFetch } from './fetch-proxy.ts';

// --- OpenAI-Compatible Adapter ---
// Works with: OpenAI, DeepSeek, Qwen, GLM, Doubao (via compatible endpoint)

export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly providerId = 'openai-compatible';
  readonly name: string;

  constructor(endpoint: ApiEndpoint, name: string) {
    super(endpoint);
    this.name = name;
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

  private getChatBody(request: LLMGenerateRequest): Record<string, unknown> {
    let systemPrompt = request.systemPrompt;

    const body: Record<string, unknown> = {
      model: request.model || 'gpt-4o',
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
      // DeepSeek/OpenAI 接口规范要求:开启 response_format: { type: 'json_object' } 时,
      // prompt 中必须包含 "json" / "JSON" 单词,否则 DeepSeek 会报 HTTP 400 invalid_request_error。
      if (!/json/i.test(systemPrompt) && !/json/i.test(request.userPrompt)) {
        systemPrompt = (systemPrompt ? `${systemPrompt}\n\n` : '') + 'Please respond in valid json format.';
      }
    }

    // V4 shares max_tokens between reasoning and text. Structured output and
    // explicitly bounded writing tasks reserve their budget for the result.
    if (this.endpoint.provider === 'deepseek' && /^deepseek-v4-/.test(String(request.model))) {
      if (request.thinking !== undefined || request.responseFormat === 'json') {
        body.thinking = { type: request.thinking === true ? 'enabled' : 'disabled' };
      }
    }
    // GLM reasoning models also default to thinking. Honor the explicit task
    // setting even when they are configured through a custom compatible endpoint.
    if (/^glm-(?:4\.[5-9]|5(?:[.-]|$))/i.test(String(request.model)) && request.thinking !== undefined) {
      body.thinking = { type: request.thinking ? 'enabled' : 'disabled' };
    }

    const isKnownTextOnly =
      this.endpoint.baseUrl.includes('deepseek.com') ||
      this.name === 'deepseek' ||
      String(request.model || '').toLowerCase().startsWith('deepseek-');

    const userContent = request.imageInputs?.length && !isKnownTextOnly
      ? [
        { type: 'text', text: request.userPrompt },
        ...request.imageInputs.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
      : request.userPrompt;

    body.messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    if (request.stopSequences?.length) {
      body.stop = request.stopSequences;
    }
    return body;
  }

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const startTime = Date.now();
    const body = this.getChatBody(request);

    let response = await httpFetch(this.getChatUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(request.thinking ? 360_000 : 120_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 如果报错是因为当前服务商不支持 image_url 结构，自动降级为纯文本重试
      if (
        response.status === 400 &&
        request.imageInputs?.length &&
        (text.includes('image_url') || text.includes('expected `text`') || text.includes('unknown variant'))
      ) {
        body.messages = [
          (body.messages as Array<unknown>)[0],
          { role: 'user', content: request.userPrompt },
        ];
        response = await httpFetch(this.getChatUrl(), {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(body),
          signal: this.timeoutSignal(request.thinking ? 360_000 : 120_000),
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`LLM API error ${response.status}: ${errText || text}`);
      }
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error(`LLM output was truncated at max_tokens=${body.max_tokens}; increase the output budget or reduce the planning batch size.`);
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('LLM returned no text output. Check the model and its output token budget.');
    }

    return {
      content,
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
    const body: Record<string, unknown> = { ...this.getChatBody(request), stream: true };

    const response = await httpFetch(this.getChatUrl(), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(request.thinking ? 360_000 : 120_000),
    });

    if (!response.ok) {
      throw new Error(`LLM stream error ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let hasText = false;
    let finished = false;
    const parseLine = (line: string): LLMStreamChunk | undefined => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        if (!hasText) throw new Error('LLM returned no text output. Check the model and its output token budget.');
        finished = true;
        return { delta: '', done: true };
      }
      const parsed = JSON.parse(payload);
      if (parsed.error) throw new Error(`LLM stream error: ${parsed.error.message || 'provider error'}`);
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw new Error(`LLM output was truncated at max_tokens=${body.max_tokens}; increase the output budget or reduce the planning batch size.`);
      }
      if (choice?.finish_reason === 'content_filter') throw new Error('LLM output was stopped by the provider content filter.');
      if (choice?.finish_reason) finished = true;
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        if (delta.trim()) hasText = true;
        return { delta, done: false };
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        if (done && buffer) { lines.push(buffer); buffer = ''; }
        for (const line of lines) {
          const chunk = parseLine(line);
          if (chunk) {
            yield chunk;
            if (chunk.done) return;
          }
        }
        if (done) break;
      }
      if (!finished) throw new Error('LLM stream ended before completion. Retry the request.');
      if (!hasText) throw new Error('LLM returned no text output. Check the model and its output token budget.');
      yield { delta: '', done: true };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
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
      messages: [{ role: 'user', content: toClaudeUserContent(request) }],
      temperature: request.temperature ?? 0.7,
    };

    if (request.stopSequences?.length) {
      body.stop_sequences = request.stopSequences;
    }

    const base = this.endpoint.baseUrl.replace(/\/+$/, '');
    const messagesUrl = /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;

    const response = await httpFetch(messagesUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(120_000),
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

    const response = await httpFetch(messagesUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(120_000),
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

function toClaudeUserContent(request: LLMGenerateRequest): string | Array<Record<string, unknown>> {
  if (!request.imageInputs?.length) return request.userPrompt;
  const images = request.imageInputs.flatMap((input) => {
    const match = input.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    return match ? [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }] : [];
  });
  return [{ type: 'text', text: request.userPrompt }, ...images];
}

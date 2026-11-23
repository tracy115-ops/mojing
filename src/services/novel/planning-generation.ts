import type { LLMStreamChunk } from '@/types/providers';

export async function generatePlanningResponse<T>(generate: (maxTokens: number) => Promise<T>, initialBudget = 8192): Promise<T> {
  try { return await generate(initialBudget); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('LLM output was truncated at max_tokens=') || initialBudget >= 32768) throw error;
    return generate(Math.min(initialBudget * 2, 32768));
  }
}

/** Retry an explicitly truncated plan once; partial JSON is never adopted. */
export async function collectPlanningText(
  stream: (maxTokens: number) => AsyncIterable<LLMStreamChunk>,
  options: { signal?: AbortSignal; onText?: (text: string) => void; onRetry?: () => void } = {},
): Promise<string> {
  for (const maxTokens of [8192, 16384]) {
    options.signal?.throwIfAborted();
    let text = '';
    options.onText?.('');
    try {
      for await (const chunk of stream(maxTokens)) {
        options.signal?.throwIfAborted();
        text += chunk.delta;
        options.onText?.(text);
      }
      options.signal?.throwIfAborted();
      return text;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (maxTokens !== 8192 || !(error instanceof Error) || !error.message.includes('LLM output was truncated at max_tokens=')) throw error;
      options.onRetry?.();
    }
  }
  throw new Error('Planning output is incomplete.');
}

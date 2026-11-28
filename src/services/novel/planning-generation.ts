import type { LLMStreamChunk } from '@/types/providers';

export async function generatePlanningResponse<T>(generate: (maxTokens: number) => Promise<T>, initialBudget = 8192, signal?: AbortSignal): Promise<T> {
  let budget = initialBudget;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await generate(budget);
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 3 || budget >= 32768 || !(error instanceof Error) || !error.message.includes('LLM output was truncated at max_tokens=')) throw error;
      budget = Math.min(budget * 2, 32768);
    }
  }
}

/** Retry an explicitly truncated stream once and discard its incomplete output. */
export async function collectNovelStreamText(
  stream: (maxTokens: number) => AsyncIterable<LLMStreamChunk>,
  options: { initialBudget?: number; signal?: AbortSignal; onText?: (text: string) => void; onRetry?: () => void } = {},
): Promise<string> {
  const initialBudget = options.initialBudget ?? 8192;
  const retryBudget = Math.min(initialBudget * 2, 32768);
  for (const maxTokens of initialBudget < retryBudget ? [initialBudget, retryBudget] : [initialBudget]) {
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
      if (maxTokens >= retryBudget || !(error instanceof Error) || !error.message.includes('LLM output was truncated at max_tokens=')) throw error;
      options.onRetry?.();
    }
  }
  throw new Error('Novel output is incomplete.');
}

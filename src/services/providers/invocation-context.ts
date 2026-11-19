// invocation-context.ts — 当前正在跑的 stage + project 上下文
//
// Pipeline 进入 stage 时注册上下文，结束或中断时释放对应的条目。
// Router 在请求发出时读取上下文，用于将调用记录归档到发起请求的 stage。
//
// 这一层不直接 import videoStore —— 保持 provider 层纯净,订阅者自由注册。

import type { StageInvocation, VideoQueueRetry } from '@/types/video';

export interface InvocationStageContext {
  novelProjectId: string;
  stage: string;
  signal?: AbortSignal;
  onVideoQueueRetry?: (retry: VideoQueueRetry | undefined) => void;
}

type Listener = (
  ctx: InvocationStageContext,
  invocation: StageInvocation,
) => void;

const stack: InvocationStageContext[] = [];
const listeners = new Set<Listener>();

export function pushStageContext(ctx: InvocationStageContext): () => void {
  stack.push(ctx);
  const release = () => {
    const index = stack.lastIndexOf(ctx);
    if (index !== -1) stack.splice(index, 1);
    ctx.signal?.removeEventListener('abort', release);
  };
  ctx.signal?.addEventListener('abort', release, { once: true });
  if (ctx.signal?.aborted) release();
  return release;
}

export function peekStageContext(signal?: AbortSignal): InvocationStageContext | undefined {
  for (let index = stack.length - 1; index >= 0; index--) {
    const context = stack[index];
    if (context.signal === signal) return context;
  }
}

export function subscribeInvocation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 将调用记录交给订阅者，已停止的步骤无需再更新账本。 */
export function emitInvocation(invocation: StageInvocation, ctx: InvocationStageContext | undefined): void {
  if (!ctx || ctx.signal?.aborted) return;
  for (const l of listeners) {
    try {
      l(ctx, invocation);
    } catch {
      // listener 出错不能影响主流程
    }
  }
}

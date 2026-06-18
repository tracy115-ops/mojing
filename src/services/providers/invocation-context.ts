// invocation-context.ts — 当前正在跑的 stage + project 上下文
//
// Pipeline 进入某个 stage 时调用 pushStage() 把上下文压栈;退出时 popStage()。
// Router 在每次 provider 调用前后 wrap 一层,如果发现栈顶有 stage,就把
// invocation 推给订阅者(videoStore 会订阅,把记录追加到对应 stage 的 invocations[])。
//
// 这一层不直接 import videoStore —— 保持 provider 层纯净,订阅者自由注册。

import type { StageInvocation } from '@/types/video';

export interface InvocationStageContext {
  novelProjectId: string;
  stage: string;
}

type Listener = (
  ctx: InvocationStageContext,
  invocation: StageInvocation,
) => void;

const stack: InvocationStageContext[] = [];
const listeners = new Set<Listener>();

export function pushStageContext(ctx: InvocationStageContext): void {
  stack.push(ctx);
}

export function popStageContext(): InvocationStageContext | undefined {
  return stack.pop();
}

export function peekStageContext(): InvocationStageContext | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

export function subscribeInvocation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Router 调用:把构造好的 invocation 广播给所有订阅者(若栈顶有 stage)。 */
export function emitInvocation(invocation: StageInvocation): void {
  const ctx = peekStageContext();
  if (!ctx) return;
  for (const l of listeners) {
    try {
      l(ctx, invocation);
    } catch {
      // listener 出错不能影响主流程
    }
  }
}

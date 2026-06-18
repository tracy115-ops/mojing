// log.ts — 跨进程日志桥 + 全局 console 捕获
//
// 调用 Tauri 命令 log_write,把消息写到 {app_data_dir}/logs/app.log。
// 非 Tauri 环境(纯浏览器开发)静默降级,只在内存里留最近 200 条。
//
// 在 main.tsx 启动时调 installGlobalLogCapture() 一次,
// 之后任何 console.error/warn 都会自动写盘,方便排查用户机器上的问题。

// 用静态 import,避免 dynamic import 在 release 构建下因 chunk 顺序问题失效。
import { invoke } from '@tauri-apps/api/core';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 记录 invoke 失败原因,用于诊断"日志为啥不写"。环形 buffer,最近 50 条。 */
const invokeFailures: { ts: number; err: string }[] = [];
function recordFailure(err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  invokeFailures.push({ ts: Date.now(), err: msg });
  if (invokeFailures.length > 50) invokeFailures.shift();
}

export function getInvokeFailures(): { ts: number; err: string }[] {
  return [...invokeFailures];
}

async function invokeLog(level: LogLevel, message: string, source?: string): Promise<void> {
  if (!isTauri()) {
    // 浏览器开发环境,只留在内存
    inMemoryBuffer.push({ ts: Date.now(), level, message, source });
    if (inMemoryBuffer.length > 200) inMemoryBuffer.shift();
    return;
  }
  try {
    await invoke('log_write', { req: { level, message, source } });
  } catch (err) {
    // 日志失败不应该影响业务;但要记录失败原因,方便排查"为啥日志不写"
    recordFailure(err);
  }
}

export const logger = {
  error: (msg: string, source?: string) => invokeLog('error', msg, source),
  warn: (msg: string, source?: string) => invokeLog('warn', msg, source),
  info: (msg: string, source?: string) => invokeLog('info', msg, source),
  debug: (msg: string, source?: string) => invokeLog('debug', msg, source),
};

/** 返回当前日志文件绝对路径(用于 UI 上"打开日志"按钮)。 */
export async function getLogPath(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>('log_path');
  } catch {
    return null;
  }
}

interface InMemEntry {
  ts: number;
  level: LogLevel;
  message: string;
  source?: string;
}
const inMemoryBuffer: InMemEntry[] = [];

/** 仅用于浏览器开发环境查看。Tauri 环境下磁盘日志是权威来源。 */
export function getInMemoryLog(): InMemEntry[] {
  return [...inMemoryBuffer];
}

let installed = false;

/**
 * 接管 console.error / console.warn,把每条消息也写盘。
 * 必须在 React render 之前调一次(main.tsx 顶部)。
 * 同时捕获未处理 Promise rejection 和全局 error 事件。
 */
export function installGlobalLogCapture(): void {
  if (installed) return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  const format = (args: unknown[]): string =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');

  console.error = (...args: unknown[]) => {
    origError(...args);
    void invokeLog('error', format(args), 'console');
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    void invokeLog('warn', format(args), 'console');
  };

  // 未处理的 Promise rejection
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
        : typeof reason === 'string'
          ? reason
          : JSON.stringify(reason);
    void invokeLog('error', `unhandledrejection: ${msg}`, 'window');
  });

  // 同步异常
  window.addEventListener('error', (e) => {
    const msg = e.error instanceof Error
      ? `${e.error.name}: ${e.error.message}\n${e.error.stack ?? ''}`
      : e.message || '(unknown error)';
    void invokeLog('error', `error@${e.filename}:${e.lineno}:${e.colno} ${msg}`, 'window');
  });

  // 启动一行 banner,方便在日志里快速找到"应用启动"边界
  void invokeLog('info', '═══ MoJing session start ═══', 'boot');

  // 启动后 3 秒、10 秒各打一次心跳日志。这两条不依赖任何用户操作,
  // 用于区分"日志路径坏了"还是"用户没操作"。如果这两条没出现,
  // 说明 Tauri invoke 在 banner 之后失效了(很可疑)。
  setTimeout(() => {
    void invokeLog('info', '[boot] heartbeat @3s', 'boot');
  }, 3000);
  setTimeout(() => {
    void invokeLog('info', '[boot] heartbeat @10s', 'boot');
  }, 10000);
}

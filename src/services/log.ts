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

/** 打开日志目录 */
export async function openLogDir(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('log_open_dir');
    return true;
  } catch {
    return false;
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
    // 已知噪音:tauri-plugin-http 在连接失败/中止时,内部资源句柄释放会
    // 产生 "The resource id XXX is invalid" 类型的 rejection。这些不影响
    // 业务逻辑,但会刷屏,淹没真实错误。这里降级到 debug,默认不写盘。
    if (/resource id \d+ is invalid/i.test(msg)) {
      void invokeLog('debug', `[noise] unhandledrejection: ${msg}`, 'window');
      // 阻止默认处理,避免控制台额外噪音
      e.preventDefault?.();
      return;
    }
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

  // 诊断:dump 实际生效的 CSP meta tag。Tauri 2 编译期会改写 CSP,
  // 这条让我们能看到 webview 真正拿到的内容,排查 connect-src 是不是被拦。
  try {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    void invokeLog('info', `[boot] CSP meta: ${meta?.getAttribute('content') ?? '(none)'}`, 'boot');
  } catch (e) {
    void invokeLog('warn', `[boot] CSP meta read failed: ${String(e)}`, 'boot');
  }
  try {
    void invokeLog('info', `[boot] location: ${location.href}`, 'boot');
  } catch {}

  // 诊断:启动后 5 秒,试一下对 klingai.com 的 HEAD 请求。
  // 这条日志会告诉我们:CSP 是否真在拦这个域,还是别的原因。
  setTimeout(async () => {
    const targets = [
      'https://api-beijing.klingai.com/',
      'https://api.deepseek.com/',
      'https://www.baidu.com/',
    ];
    for (const url of targets) {
      const t0 = Date.now();
      try {
        const r = await fetch(url, { method: 'GET', mode: 'no-cors' });
        void invokeLog('info', `[boot] probe ${url} ok ${r.status} ${r.type} ${Date.now() - t0}ms`, 'boot');
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        void invokeLog('error', `[boot] probe ${url} FAIL ${Date.now() - t0}ms ${msg}`, 'boot');
      }
    }
  }, 5000);

  // 启动后 3 秒、10 秒各打一次心跳日志。这两条不依赖任何用户操作,
  // 用于区分"日志路径坏了"还是"用户没操作"。如果这两条没出现,
  // 说明 Tauri invoke 在 banner 之后失效了(很可疑)。
  setTimeout(() => {
    void invokeLog('info', '[boot] heartbeat @3s', 'boot');
    // 3 秒后 dump 当前 provider config + endpoints,方便排查"用户实际配了什么"。
    // 这是诊断用户"为什么走了 kling 而不是 agnes"类问题的关键信息。
    try {
      const providerState = (window as unknown as { __MOJING_PROVIDER_DUMP__?: () => string }).__MOJING_PROVIDER_DUMP__;
      if (typeof providerState === 'function') {
        const dump = providerState();
        void invokeLog('info', `[boot] provider config: ${dump}`, 'boot');
      }
    } catch (e) {
      void invokeLog('debug', `[boot] provider dump failed: ${String(e)}`, 'boot');
    }
  }, 3000);
  setTimeout(() => {
    void invokeLog('info', '[boot] heartbeat @10s', 'boot');
  }, 10000);
}

// fetch-proxy.ts — 跨域 HTTP 出口
//
// Tauri webview 直接打第三方 API 会因为 CORS preflight 失败而抛
// "Failed to fetch"(典型场景:用 Authorization + JSON POST 调 Kling 等
// 不带 Access-Control-Allow-* 的 API)。LLM(DeepSeek 等 OpenAI 兼容
// 服务)通常配了 CORS,所以走得通;但 image/video/TTS 经常通不过。
//
// 解决:走 tauri-plugin-http 提供的 fetch,它在 Rust 端用 reqwest,
// 完全绕过 webview 的同源/CORS 限制。
//
// 用法和原生 fetch 一样,只是 import 来源不同:
//   import { fetch as httpFetch } from '@/services/providers/fetch-proxy';

let pluginFetch: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null = null;
let pluginLoadFailed = false;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function loadPluginFetch(): Promise<typeof fetch | null> {
  if (pluginLoadFailed) return null;
  if (pluginFetch) return pluginFetch;
  if (!isTauri()) return null;
  try {
    const mod = await import('@tauri-apps/plugin-http');
    pluginFetch = mod.fetch as typeof fetch;
    return pluginFetch;
  } catch {
    pluginLoadFailed = true;
    return null;
  }
}

/**
 * 统一 fetch 入口。Tauri 环境下走 tauri-plugin-http 绕过 CORS;
 * 浏览器开发环境降级到原生 fetch。
 *
 * 注意:tauri-plugin-http 的 fetch 在 Rust 端执行,Response.body 等
 * 字段语义和原生略有差异,但本仓库所有 adapter 都只用 .ok / .status /
 * .text() / .json(),这些 plugin 都支持。
 */
export async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const pluginFetch = await loadPluginFetch();
  if (pluginFetch) {
    return pluginFetch(input as RequestInfo, init);
  }
  return globalThis.fetch(input, init);
}

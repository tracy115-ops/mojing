import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function chromeSession({ url = 'http://127.0.0.1:1420/', port = 9234 } = {}) {
  const profile = join(tmpdir(), `mojing-studio-review-${process.pid}-${Date.now()}`);
  const child = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-sandbox', '--no-first-run', '--disable-extensions', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=1600,1050', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let target;
  for (let i = 0; i < 60; i++) {
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = pages.find((page) => page.type === 'page'); if (target) break; } catch { /* Chrome is starting. */ }
    await delay(200);
  }
  if (!target) { child.kill(); throw new Error('Chrome did not start'); }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(), listeners = new Set(), errors = [];
  let counter = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id); if (!callback) return;
      pending.delete(message.id); clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
    } else {
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
      for (const listener of listeners) listener(message);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const click = async (selector) => { if (!await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`)) throw new Error(`Button unavailable: ${selector}`); };
  const textButton = async (text, parent = 'body') => {
    const found = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(parent + ' button')})].find(el => el.textContent.replace(/\\s/g, '') === ${JSON.stringify(text.replace(/\s/g, ''))}); if (!el || el.disabled) return false; el.click(); return true; })()`);
    if (!found) throw new Error(`Button unavailable: ${text}`);
  };
  const screenshot = async (name) => { const path = join(tmpdir(), name); const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path, Buffer.from(result.data, 'base64')); return path; };
  await call('Runtime.enable'); await call('Page.enable');
  return { url, call, evaluate, waitFor, click, textButton, screenshot, delay, errors, onEvent: (listener) => listeners.add(listener), close: () => { socket.close(); child.kill(); } };
}

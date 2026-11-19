import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs the actual release executable with an isolated WebView2 profile.
// Only input configuration may be seeded by callers; native IPC stays intact.
export async function desktopSession({ executable, profile, allowedOrigins = [], softwareRendering = true }) {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1${softwareRendering ? ' --use-angle=swiftshader --enable-unsafe-swiftshader' : ''}`,
  } });
  let target, startupError, lastTargets = [];
  child.once('error', error => { startupError = error; });
  try {
    const deadline = Date.now() + 60000;
    while (!target && Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Desktop exited with ${child.exitCode}`);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
        lastTargets = targets.map(({ type, url }) => ({ type, url }));
        target = targets.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url));
      } catch { /* Starting WebView2. */ }
      if (!target) await delay(200);
    }
    assert.ok(target, 'release WebView2 exposes an isolated target; observed ' + JSON.stringify(lastTargets));
  } catch (error) {
    if (child.pid && child.exitCode === null) {
      const ended = new Promise(resolve => child.once('close', resolve));
      child.kill(); await ended;
    }
    throw error;
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const origin = new URL(target.url).origin, pending = new Map(), errors = [], blocked = [], consoleMessages = [];
  let counter = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled') consoleMessages.push({ type: message.params.type, text: message.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 1600) });
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params, url = new URL(request.url);
      const local = [origin, ...allowedOrigins, 'http://asset.localhost', 'https://asset.localhost', 'http://ipc.localhost'].includes(url.origin) || ['ipc:', 'asset:', 'data:', 'blob:'].includes(url.protocol);
      if (!local) blocked.push(url.href);
      void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(e => {
        if (!String(e).includes('"code":-32602,"message":"Invalid InterceptionId."')) errors.push(String(e));
      });
    }
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(150); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Button unavailable: '+${JSON.stringify(selector)});e.click();})()`);
  const textButton = (label, parent = 'body') => evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(parent + ' button')})].find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(label.replace(/\s/g, ''))});if(!e||e.disabled)throw new Error('Button unavailable: '+${JSON.stringify(label)});e.click();})()`);
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Input unavailable');e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const clickTarget = async (target, label) => {
    await evaluate(`(()=>{const e=${target};if(!e)throw new Error('Click target unavailable');e.scrollIntoView({block:'nearest',behavior:'instant'});})()`);
    // A preceding dropdown can still cover the next control while its close
    // animation runs. Wait for the real mouse hit target before sending input.
    await waitFor(`(()=>{const e=${target};if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&!!hit&&e.contains(hit);})()`, 'unobstructed click target ' + label);
    const point = await evaluate(`(()=>{const r=(${target}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const nativeClick = selector => clickTarget(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e?.closest('.ant-select-selector')||e;})()`, selector);
  const nativeTextButton = (label, parent = 'body') => clickTarget(
    `[...document.querySelectorAll(${JSON.stringify(parent + ' button')})].find(e=>e.getClientRects().length&&e.textContent.replace(/\\s/g,'')===${JSON.stringify(label.replace(/\s/g, ''))})`,
    label,
  );
  const choose = async (selector, label) => {
    await nativeClick(selector);
    const input = `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e?.matches('input')?e:e?.querySelector('input');})()`;
    const option = `(()=>{const input=${input},popup=document.getElementById(input?.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');if(!popup||popup.classList.contains('ant-select-dropdown-hidden'))return;return[...popup.querySelectorAll('.ant-select-item-option')].find(e=>e.title===${JSON.stringify(label)}||e.textContent===${JSON.stringify(label)});})()`;
    await waitFor(`Boolean(${option})`, 'select option ' + label);
    await evaluate(`(${option}).click()`);
    await waitFor(`(${input})?.getAttribute('aria-expanded')!=='true'`, 'selected dropdown closes');
  };
  const screenshot = async path => { const result = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path, Buffer.from(result.data, 'base64')); };
  await call('Runtime.enable'); await call('Page.enable'); await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await waitFor('!!window.__TAURI__?.core?.invoke', 'real Tauri API');
  return { child, call, evaluate, waitFor, click, textButton, fill, nativeClick, nativeTextButton, choose, screenshot, errors, blocked, consoleMessages,
    close: async () => {
      socket.close();
      if (child.exitCode === null) {
        const ended = new Promise(resolve => child.once('exit', resolve));
        child.kill(); await ended;
      }
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Desktop closed')); }
      pending.clear();
      await delay(600);
    },
  };
}

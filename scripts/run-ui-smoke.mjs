// Browser-level smoke test for the Vite-rendered shell.
// This intentionally stops before provider calls: it verifies navigation and
// catches render-time exceptions without spending generation credits.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 9228;
const appUrl = process.env.MOJING_SMOKE_URL || 'http://localhost:1420/';
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profilePath = join(tmpdir(), `mojing-cdp-smoke-${port}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  `--user-data-dir=${profilePath}`,
  `--remote-debugging-port=${port}`,
  '--remote-debugging-address=127.0.0.1',
  appUrl,
], { stdio: 'ignore' });

async function getPageTarget() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith(appUrl));
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('Chrome page target did not become available');
}

function cdpCall(socket, method, params = {}) {
  let commandId = 0;
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(socket, expression) {
  const result = await cdpCall(socket, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

async function waitFor(socket, expression, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(socket, expression)) return;
    await sleep(100);
  }
  throw new Error(`${description} did not become ready within ${timeoutMs}ms`);
}

try {
  const target = await getPageTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  await cdpCall(socket, 'Runtime.enable');
  await waitFor(
    socket,
    "document.body.innerText.includes('视频工坊')",
    'Home navigation',
  );

  const clicked = await evaluate(
    socket,
    "(() => { const element = [...document.querySelectorAll('button,[role=tab],a')].find((item) => item.textContent.includes('视频工坊')); if (!element) return false; element.click(); return true; })()",
  );
  if (!clicked) throw new Error('视频工坊 navigation control was not found');

  await waitFor(
    socket,
    "document.querySelector('.ws-content') && document.body.innerText.includes('视频工坊')",
    '视频工坊 page',
  );
  const videoText = String(await evaluate(socket, 'document.body.innerText'));
  if (videoText.includes('Cannot read properties of undefined')) {
    throw new Error('Render-time TypeError was exposed in the page');
  }

  console.log('UI smoke passed: home -> 视频工坊');
  socket.close();
} finally {
  chrome.kill();
}

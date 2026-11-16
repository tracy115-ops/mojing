// Browser-level smoke test for the current video production board.
// It creates a generic series/episode and stops before provider calls.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const port = 9229;
const appUrl = process.env.MOJING_SMOKE_URL || 'http://localhost:1420/';
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const windowSize = process.env.MOJING_WINDOW_SIZE || '1440,900';
const profilePath = join(tmpdir(), `mojing-video-e2e-${port}-${process.pid}-${Date.now()}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  `--window-size=${windowSize}`,
  `--user-data-dir=${profilePath}`,
  `--remote-debugging-port=${port}`,
  '--remote-debugging-address=127.0.0.1',
  appUrl,
], { stdio: 'ignore' });

let socket;
let commandId = 0;
const runtimeExceptions = [];
const consoleMessages = [];

async function getPageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

function cdpCall(method, params = {}) {
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

async function evaluate(expression) {
  const result = await cdpCall('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result?.result?.value;
}

async function waitFor(expression, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`${description} did not become ready within ${timeoutMs}ms`);
}

const visibleModalExpression = `(() => {
  const isVisibleWrap = (wrap) => {
    const style = getComputedStyle(wrap);
    const rect = wrap.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  };
  return [...document.querySelectorAll('.ant-modal-wrap')].some(isVisibleWrap);
})()`;

async function waitForModalsClosed(description = 'modal close', timeoutMs = 5000) {
  await waitFor(`!${visibleModalExpression}`, description, timeoutMs);
}

async function clickButtonByText(text, scope = 'document') {
  return evaluate(`(() => {
    const root = ${scope};
    const button = [...root.querySelectorAll('button')]
      .find((item) => item.textContent?.includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function fillModalField(selector, value) {
  return evaluate(`(() => {
    const isVisibleWrap = (wrap) => {
      const style = getComputedStyle(wrap);
      const rect = wrap.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const root = [...document.querySelectorAll('.ant-modal-root')]
      .find((item) => [...item.querySelectorAll('.ant-modal-wrap')].some(isVisibleWrap));
    const field = root?.querySelector(${JSON.stringify(selector)});
    if (!field) return false;
    const prototype = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function clickModalFooter(kind = 'cancel') {
  return evaluate(`(() => {
    const isVisibleWrap = (wrap) => {
      const style = getComputedStyle(wrap);
      const rect = wrap.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const root = [...document.querySelectorAll('.ant-modal-root')]
      .find((item) => [...item.querySelectorAll('.ant-modal-wrap')].some(isVisibleWrap));
    const buttons = root ? [...root.querySelectorAll('.ant-modal-footer button')] : [];
    const button = ${kind === 'ok' ? 'buttons.at(-1)' : 'buttons[0]'};
    if (!button) return false;
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
}

async function clickSidebarVideo() {
  return evaluate(`(() => {
    const button = [...document.querySelectorAll('.ws-titlebar button')]
      .find((item) => item.getAttribute('aria-label') === 'video-camera'
        || item.querySelector('[aria-label="video-camera"]'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function clickTestId(testId) {
  return evaluate(`(() => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0;
    };
    const button = [...document.querySelectorAll('[data-testid=' + ${JSON.stringify(testId)} + ']')]
      .find(isVisible);
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function clickButtonByAriaLabel(label) {
  return evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function clickInspectorTab(tab) {
  return evaluate(`(() => {
    const button = document.querySelector('.shot-production-inspector-tab[data-tab=' + ${JSON.stringify(tab)} + ']');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function captureScreenshot(path) {
  await cdpCall('Page.enable');
  const result = await cdpCall('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

try {
  const target = await getPageTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'Unknown runtime exception');
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const values = message.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      consoleMessages.push(`${message.params.type}: ${values}`);
    }
  });
  await cdpCall('Runtime.enable');

  await waitFor('document.querySelectorAll(".ws-titlebar button").length >= 3', 'application shell');
  if (!await clickSidebarVideo()) throw new Error('Video navigation button was not found');
  await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))', 'video studio workspace');
  if (!await clickTestId('studio-nav-projects')) throw new Error('Project navigation button was not found');
  await waitFor('Boolean(document.querySelector(".video-view-shell"))', 'video workspace');

  if (!await clickTestId('video-new-video')) throw new Error('New video button was not found');
  await waitFor("Boolean(document.querySelector('.ant-modal-root .ant-modal-wrap:not([style*=" + JSON.stringify('display: none') + "])'))", 'standalone video modal');
  const standaloneModal = await evaluate(`document.body.innerText.includes('新建视频') || document.body.innerText.includes('New Video')`);
  if (!standaloneModal) throw new Error('Standalone video modal title was not found');
  if (!await clickModalFooter('cancel')) throw new Error('Standalone video modal could not close');
  await waitForModalsClosed('standalone video modal close');

  if (!await clickTestId('video-new-series')) throw new Error('New series button was not found');
  await waitFor("Boolean(document.querySelector('.ant-modal-root .ant-modal-wrap:not([style*=" + JSON.stringify('display: none') + "])'))", 'new series modal');
  if (!await fillModalField('input', 'Generic Quality Validation Series')) throw new Error('Series title field was not found');
  if (!await fillModalField('textarea', 'A generic visual series used to validate the production board.')) throw new Error('Series description field was not found');
  if (!await clickModalFooter('ok')) throw new Error('New series modal could not save');
  await waitForModalsClosed('series modal close');
  await waitFor("document.body.innerText.includes('Generic Quality Validation Series')", 'series workspace');

  if (!await clickTestId('video-new-episode')) throw new Error('New episode button was not found');
  await waitFor("Boolean(document.querySelector('.ant-modal-root .ant-modal-wrap:not([style*=" + JSON.stringify('display: none') + "])'))", 'new episode modal');
  if (!await fillModalField('input', 'Generic Quality Validation Episode')) throw new Error('Episode title field was not found');
  if (!await fillModalField('textarea', 'A generic visual episode used to validate the production board.')) throw new Error('Episode script field was not found');
  if (!await clickModalFooter('ok')) throw new Error('New episode modal could not save');
  await waitForModalsClosed('episode modal close');
  await waitFor('Boolean(document.querySelector("[data-testid=video-production-overview]"))', 'production overview');
  const overviewContract = await evaluate(`(() => ({
    overview: Boolean(document.querySelector('[data-testid="video-production-overview"]')),
    nextAction: Boolean(document.querySelector('[data-testid="video-overview-next-action"]')),
    traceButton: Boolean(document.querySelector('[data-testid="video-overview-trace"]')),
    storyInputVisible: document.body.innerText.includes('Story input saved') || document.body.innerText.includes('故事输入已保存'),
    configurationGate: document.body.innerText.includes('configuration') || document.body.innerText.includes('配置'),
    projectStatus: Boolean(document.querySelector('[data-testid="video-overview-next-action"] h3')),
    stableNextAction: Boolean(document.querySelector('[data-testid="video-overview-next-action-button"]')),
  }))()`);
  if (!overviewContract?.overview || !overviewContract.nextAction || !overviewContract.traceButton || !overviewContract.projectStatus || !overviewContract.stableNextAction) {
    throw new Error('Production overview contract sections are missing');
  }
  if (process.env.MOJING_UI_OVERVIEW_SCREENSHOT) await captureScreenshot(process.env.MOJING_UI_OVERVIEW_SCREENSHOT);
  if (!await clickTestId('video-overview-trace')) throw new Error('Technical details action was not found');
  await waitFor('Boolean(document.querySelector(".video-flow-trace-drawer-root.ant-drawer-open"))', 'technical trace drawer');
  const traceContract = await evaluate(`(() => ({
    trace: Boolean(document.querySelector('.video-flow-trace-drawer-root.ant-drawer-open')),
    overviewStillVisible: Boolean(document.querySelector('[data-testid="video-production-overview"]')),
  }))()`);
  if (!traceContract?.trace || !traceContract.overviewStillVisible) throw new Error('Technical trace drawer contract is missing');
  if (!await clickTestId('video-flow-trace-close')) throw new Error('Technical trace close action was not found');
  await waitFor('!Boolean(document.querySelector(".video-flow-trace-drawer-root.ant-drawer-open"))', 'technical trace drawer close');
  if (!await clickButtonByText('打开模型设置')) throw new Error('Configuration gate action was not found');
  await waitFor('Boolean(document.querySelector(".ant-modal-wrap"))', 'configuration settings modal');
  await evaluate(`(() => {
    const wrap = [...document.querySelectorAll('.ant-modal-wrap')].find((item) => getComputedStyle(item).display !== 'none');
    wrap?.querySelector('.ant-modal-close')?.click();
    return Boolean(wrap);
  })()`);
  await waitForModalsClosed('configuration settings modal close');
  if (!await clickButtonByText('镜头精修与生成')) throw new Error('Shot refinement phase was not found');
  await waitFor('Boolean(document.querySelector(".shot-production-board"))', 'shot production board');

  const beforeShotCount = await evaluate('document.querySelectorAll(".shot-production-shot-item").length');
  if (!await clickTestId('shot-production-add-shot')) throw new Error('Add-shot action was not found');
  await waitFor(`document.querySelectorAll(".shot-production-shot-item").length > ${beforeShotCount}`, 'new shot in production queue');
  const boardContract = await evaluate(`(() => ({
    board: Boolean(document.querySelector('.shot-production-board')),
    handoff: Boolean(document.querySelector('.shot-production-handoff')),
    inputContract: Boolean(document.querySelector('[data-testid="shot-production-input-contract"]')),
    actualRequest: Boolean(document.querySelector('[data-testid="shot-production-actual-request"]')),
    versionReview: Boolean(document.querySelector('[data-testid="shot-production-version-review"]')),
  }))()`);
  if (!boardContract?.board || !boardContract.handoff || !boardContract.inputContract || !boardContract.actualRequest || !boardContract.versionReview) {
    throw new Error('Production board contract sections are missing');
  }

  if (!await clickButtonByAriaLabel('\u751f\u4ea7\u94fe\u8def')) throw new Error('Production overview navigation was not found');
  await waitFor('Boolean(document.querySelector("[data-testid=video-production-overview]"))', 'production overview after shot creation');
  const overviewShotContract = await evaluate(`(() => ({
    table: Boolean(document.querySelector('[data-testid="video-overview-shot-snapshot"]')),
    rows: document.querySelectorAll('.video-command-center-shot-row').length,
    columns: document.querySelectorAll('.video-command-center-shot-table-head > span').length,
  }))()`);
  if (!overviewShotContract?.table || overviewShotContract.rows < 1 || overviewShotContract.columns !== 6) {
    throw new Error('Production overview shot handoff row is missing');
  }
  if (!await clickButtonByText('\u8fdb\u5165\u955c\u5934\u5de5\u4f5c\u53f0')) throw new Error('Shot production board navigation was not found after overview validation');
  await waitFor('Boolean(document.querySelector(".shot-production-board"))', 'shot production board after overview validation');

  for (const tab of ['contract', 'references', 'request', 'review']) {
    if (!await clickInspectorTab(tab)) throw new Error(`Inspector tab ${tab} was not found`);
    await waitFor(
      `document.querySelector('.shot-production-inspector-tab[data-tab=${JSON.stringify(tab)}]')?.getAttribute('aria-selected') === 'true'`,
      `inspector tab ${tab}`,
    );
  }
  await clickInspectorTab('contract');

  if (process.env.MOJING_UI_SCREENSHOT) await captureScreenshot(process.env.MOJING_UI_SCREENSHOT);
  if (process.env.MOJING_UI_HANDOFF_SCREENSHOT) {
    const handoffLayout = await evaluate(`(() => {
      const handoff = [...document.querySelectorAll('.shot-production-handoff')]
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });
      handoff?.scrollIntoView({ block: 'center', inline: 'nearest' });
      const board = document.querySelector('.shot-production-board');
      const editor = document.querySelector('.shot-production-editor');
      return {
        present: Boolean(handoff),
        text: handoff?.innerText?.slice(0, 120),
        handoffTop: handoff?.getBoundingClientRect().top,
        handoffBottom: handoff?.getBoundingClientRect().bottom,
        boardScrollTop: board?.scrollTop,
        editorScrollTop: editor?.scrollTop,
        boardHeight: board?.clientHeight,
        editorHeight: editor?.clientHeight,
        boardCount: document.querySelectorAll('.shot-production-board').length,
        boardRects: [...document.querySelectorAll('.shot-production-board')].map((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height, display: getComputedStyle(candidate).display, overflow: getComputedStyle(candidate).overflow };
        }),
        handoffRects: [...document.querySelectorAll('.shot-production-handoff')].map((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height, display: getComputedStyle(candidate).display, opacity: getComputedStyle(candidate).opacity };
        }),
      };
    })()`);
    if (process.env.MOJING_UI_HANDOFF_DEBUG) console.log('Handoff layout:', JSON.stringify(handoffLayout));
    await sleep(250);
    await captureScreenshot(process.env.MOJING_UI_HANDOFF_SCREENSHOT);
  }
  if (!await clickTestId('shot-production-open-timeline')) throw new Error('Timeline action was not found');
  await waitFor('Boolean(document.querySelector(".video-timeline-workspace"))', 'timeline workspace');
  const timelineGate = await evaluate(`(() => {
    const compose = document.querySelector('[data-testid="video-timeline-compose"]');
    return { hasTimeline: Boolean(document.querySelector('.video-timeline-workspace')), composeDisabled: compose?.disabled === true };
  })()`);
  if (!timelineGate?.hasTimeline || !timelineGate.composeDisabled) throw new Error('Timeline composition gate did not block an unapproved shot');
  if (process.env.MOJING_UI_TIMELINE_SCREENSHOT) await captureScreenshot(process.env.MOJING_UI_TIMELINE_SCREENSHOT);

  if (runtimeExceptions.length > 0) throw new Error(`Browser runtime exceptions: ${runtimeExceptions.join(' | ')}`);
  console.log('Video UI workflow passed: series -> episode -> shot board -> timeline approval gate');
} catch (error) {
  const body = socket ? await evaluate('document.body?.innerText || ""').catch(() => '') : '';
  const modalDebug = socket ? await evaluate(`(() => ({
    roots: document.querySelectorAll('.ant-modal-root').length,
    wraps: [...document.querySelectorAll('[class*="modal"]')].slice(-12).map((node) => ({
      tag: node.tagName,
      className: node.className,
      text: node.innerText?.slice(0, 80),
      style: node.getAttribute('style'),
    })),
    bodyTail: document.body?.innerHTML?.slice(-3000),
  }))()`).catch((err) => ({ error: String(err) })) : {};
  if (socket && process.env.MOJING_UI_FAILURE_SCREENSHOT) {
    await captureScreenshot(process.env.MOJING_UI_FAILURE_SCREENSHOT).catch(() => undefined);
  }
  console.error('Video UI workflow failed:', error instanceof Error ? error.message : String(error));
  console.error('Modal debug:', JSON.stringify(modalDebug));
  if (runtimeExceptions.length > 0) console.error('Runtime exceptions:', runtimeExceptions.join(' | '));
  if (consoleMessages.length > 0) console.error('Browser console:', consoleMessages.slice(-30).join(' | '));
  console.error('Visible page text:', String(body).slice(-5000));
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill();
}

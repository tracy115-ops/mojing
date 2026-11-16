// Minimal WebView2/CDP probe for the packaged desktop app.
// The app is started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333.

const port = Number(process.env.MOJING_CDP_PORT || 9333);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === 'page');
if (!target) throw new Error('MoJing WebView2 page target not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let commandId = 0;
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
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function clickText(text) {
  const expression = `(() => {
    const wanted = ${JSON.stringify(text)};
    const elements = [...document.querySelectorAll('button,[role="button"],a,.ant-menu-item,.ant-btn,.ant-tabs-tab')];
    const element = elements.find((item) => (item.innerText || item.textContent || '').trim().includes(wanted));
    if (!element) return false;
    element.click();
    return true;
  })()`;
  return evaluate(expression);
}

async function waitForText(text, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await evaluate('document.body?.innerText || ""');
    if (body.includes(text)) return body;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for visible text: ${text}`);
}

async function clickSidebarShot(index) {
  return evaluate(`(() => {
    const sidebar = [...document.querySelectorAll('.ant-col')]
      .find((column) => [...column.querySelectorAll('button')]
        .some((button) => (button.textContent || '').includes('添加分镜')));
    if (!sidebar) return false;
    const cards = [...sidebar.querySelectorAll('.ant-card')]
      .filter((card) => /^\\s*${index + 1}\\./.test(card.innerText || ''));
    const card = cards[0];
    if (!card) return false;
    card.click();
    return true;
  })()`);
}

async function clickSegmentOption(text) {
  return evaluate(`(() => {
    const item = [...document.querySelectorAll('.ant-segmented-item')]
      .find((candidate) => (candidate.innerText || candidate.textContent || '').includes(${JSON.stringify(text)}));
    if (!item) return false;
    item.click();
    return true;
  })()`);
}

async function getPersistedVideoSummary() {
  return evaluate(`(() => {
    const summaries = [];
    for (const key of Object.keys(localStorage)) {
      const raw = localStorage.getItem(key) || '';
      if (!raw.includes('char_girl_jk') && !raw.includes('char_cat_master')) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const values = parsed?.state?.projects || parsed?.projects;
      const projects = Array.isArray(values) ? values : Object.values(values || {});
      for (const project of projects) {
        const shots = project?.sceneSpec?.shots || [];
        if (!shots.length) continue;
        if (!shots.some((shot) => (shot.characterIds || []).includes('char_girl_jk'))) continue;
        summaries.push({
          storageKey: key,
          projectId: project?.id || project?.novelProjectId,
          clips: (project?.clips || []).map((clip) => ({
            shotId: clip.shotId,
            videoUrl: clip.videoUrl,
            keyframeImage: clip.keyframeImage,
            lastFrameImage: clip.lastFrameImage,
          })),
          shots: shots.map((shot) => ({
            index: shot.index,
            id: shot.id,
            keyframeImage: shot.keyframeImage,
            referenceAssets: (shot.referenceAssets || []).map((asset) => ({
              kind: asset.kind,
              characterId: asset.characterId,
              sentToProvider: asset.sentToProvider,
              providerIndex: asset.providerIndex,
              omittedReason: asset.omittedReason,
            })),
            latestVersion: shot.versionHistory?.[0]?.url,
          })),
        });
      }
    }
    return summaries;
  })()`);
}

const requestedProjectId = process.env.MOJING_PROJECT_ID;
if (requestedProjectId) {
  const selected = await evaluate(`(() => {
    const raw = localStorage.getItem('mojing-video');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const state = parsed.state || parsed;
    if (!state.projects?.[${JSON.stringify(requestedProjectId)}]) return false;
    state.activePipelineId = ${JSON.stringify(requestedProjectId)};
    if (parsed.state) parsed.state = state;
    localStorage.setItem('mojing-video', JSON.stringify(parsed));
    location.reload();
    return true;
  })()`);
  if (!selected) throw new Error(`Requested video project was not found: ${requestedProjectId}`);
  await sleep(1000);
}

async function waitForSingleKeyframe(index, timeoutMs = 900000) {
  const buttonText = `生成分镜 ${index + 1} 关键帧`;
  const deadline = Date.now() + timeoutMs;
  let sawLoading = false;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(buttonText)}));
      const loading = buttons.some((candidate) => candidate.classList.contains('ant-btn-loading')
        && /关键帧|渲染生成中/.test(candidate.textContent || ''));
      return {
        exists: !!button,
        loading,
        body: document.body?.innerText || '',
      };
    })()`);
    sawLoading ||= state.loading;
    const failed = /生成失败|生成错误|关键帧.*失败/.test(state.body);
    const finished = sawLoading && !state.loading && state.body.includes('关键帧 ✓');
    if (failed) throw new Error(`Shot ${index + 1} keyframe generation failed`);
    if (finished) return state.body;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for shot ${index + 1} keyframe generation`);
}

console.log('Initial page:', (await evaluate('document.body?.innerText || ""')).slice(0, 1200));
if (process.argv.includes('--probe-asset-stat')) {
  const probe = await evaluate(`(async () => {
    const raw = localStorage.getItem('mojing-video');
    const parsed = raw ? JSON.parse(raw) : undefined;
    const state = parsed?.state || parsed;
    const project = state?.projects?.[${JSON.stringify(requestedProjectId)}];
    const url = project?.clips?.[0]?.videoUrl;
    const match = url?.match(/^(?:https?:\\/\\/asset\\.localhost\\/|asset:\\/\\/(?:localhost\\/)?)(.*)$/i);
    const path = match ? decodeURIComponent(match[1]) : url;
    const internals = window.__TAURI_INTERNALS__;
    let stat;
    let error;
    try {
      stat = path && internals?.invoke ? await internals.invoke('asset_stat_path', { path }) : undefined;
    } catch (cause) {
      error = String(cause);
    }
    return {
      hasInternals: Boolean(internals),
      hasInvoke: typeof internals?.invoke === 'function',
      url,
      path,
      stat,
      error,
    };
  })()`);
  console.log('Asset stat probe:', JSON.stringify(probe, null, 2));
  socket.close();
  process.exit(0);
}
if (process.argv.includes('--dump-video-summary')) {
  console.log('Video summary:', JSON.stringify(await getPersistedVideoSummary(), null, 2));
  socket.close();
  process.exit(0);
}
if (process.argv.includes('--dump-assets')) {
  const persisted = await evaluate(`(() => {
    const result = [];
    for (const key of Object.keys(localStorage)) {
      const raw = localStorage.getItem(key) || '';
      if (!raw.includes('char_girl_jk') && !raw.includes('char_cat_master')) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      const projectValues = parsed?.state?.projects || parsed?.projects;
      const projects = projectValues && typeof projectValues === 'object'
        ? Object.values(projectValues)
        : [];
      result.push({
        key,
        length: raw.length,
        projects: projects.filter((project) => (project?.sceneSpec?.characters || [])
          .some((character) => character.id === 'char_girl_jk' || character.id === 'char_cat_master')).map((project) => ({
          id: project?.id,
          characters: (project?.sceneSpec?.characters || []).map((character) => ({
            id: character.id,
            name: character.name,
            entityType: character.entityType,
            gender: character.gender,
            appearance: character.appearance,
            portraitImage: character.portraitImage,
            turnaroundImage: character.turnaroundImage,
            variants: (character.costumeVariants || []).map((variant) => ({ id: variant.id, portraitImage: variant.portraitImage })),
          })),
          shots: (project?.sceneSpec?.shots || []).map((shot) => ({
            index: shot.index,
            characterIds: shot.characterIds,
            videoPrompt: shot.videoPrompt,
            sourceText: shot.sourceText,
            narration: shot.narration,
            dialogue: shot.dialogue,
            referenceAssets: shot.referenceAssets,
          })),
        })),
      });
    }
    return result;
  })()`);
  console.log('Persisted assets:', JSON.stringify(persisted, null, 2));
}
if (!await clickText('视频工坊')) throw new Error('视频工坊 navigation item not found');
const body = await waitForText('视频工坊', 10000);
console.log('Video page:', body.slice(0, 8000));

if (process.argv.includes('--verify-flow')) {
  const flowDeadline = Date.now() + 10000;
  while (Date.now() < flowDeadline) {
    const ready = await evaluate("Boolean(document.querySelector('.video-flow-trace-workspace .video-flow-canvas'))");
    if (ready) break;
    await sleep(250);
  }
  const flowState = await evaluate(`(() => {
    const workspace = document.querySelector('.video-flow-trace-workspace');
    const canvas = workspace?.querySelector('.video-flow-canvas');
    const nodes = workspace?.querySelectorAll('.video-flow-node') || [];
    const context = document.querySelector('.video-workbench-context');
    const content = document.querySelector('.ws-content');
    const openButton = [...(workspace?.querySelectorAll('button') || [])]
      .find((button) => (button.textContent || '').includes('进入处理工作台'));
    return {
      hasWorkspace: Boolean(workspace),
      hasCanvas: Boolean(canvas),
      nodeCount: nodes.length,
      contextText: (context?.textContent || '').trim(),
      contentChildren: [...(content?.children || [])].map((item) => item.className),
      hasOpenButton: Boolean(openButton),
    };
  })()`);
  if (!flowState.hasWorkspace || !flowState.hasCanvas || flowState.nodeCount < 10) {
    throw new Error(`Packaged app did not open the production flow workspace: ${JSON.stringify(flowState)}`);
  }
  if (!flowState.contextText.includes('生产链路')) {
    throw new Error(`Production flow is not the default phase: ${JSON.stringify(flowState.contextText)}`);
  }
  if (!flowState.hasOpenButton) {
    throw new Error('Selected flow node did not expose the workbench navigation action');
  }
  if (process.argv.includes('--verify-missing-assets')) {
    const missingBody = await waitForText('文件不可用', 10000);
    if (!missingBody.includes('已记录素材文件当前不可用')) {
      throw new Error('Missing assets were not reflected in the selected stage warning');
    }
    if (!/输出\s*0\/6 视频片段/.test(missingBody)) {
      throw new Error('Unavailable video files were still counted as usable outputs');
    }
    console.log('Missing asset state verified: unavailable persisted clips are reported as 0/6');
  }
  const opened = await clickText('进入处理工作台');
  if (!opened) throw new Error('Could not open the selected node workbench');
  await sleep(300);
  const remainedOnFlow = await evaluate("Boolean(document.querySelector('.video-flow-trace-workspace'))");
  if (remainedOnFlow) throw new Error('Flow node workbench navigation did not change the active phase');
  const hasBackToFlow = await evaluate(`[...document.querySelectorAll('button')].some((button) =>
    (button.textContent || '').includes('返回生产链路'))`);
  if (!hasBackToFlow) throw new Error('Workbench did not expose a return-to-flow action');
  console.log('Packaged flow verified:', JSON.stringify(flowState));
}

async function waitForSliceCompletion(timeoutMs = 180000) {
  const deadline = Date.now() + 180000;
  let latest = '';
  while (Date.now() < deadline) {
    latest = await evaluate('document.body?.innerText || ""');
    const failed = /切片失败|Cannot read properties of undefined|章节切片.*失败/.test(latest);
    const running = /执行中|正在执行工序|终止生成|生成中|处理中|切片中/.test(latest);
    const finished = /镜头大纲清单/.test(latest) && !running;
    if (failed || finished) break;
    await sleep(1000);
  }
  if (/Cannot read properties of undefined/.test(latest)) {
    throw new Error('Packaged app exposed undefined.map during chapter slicing');
  }
  if (!/镜头大纲清单/.test(latest) || /执行中|正在执行工序|终止生成|生成中|处理中|切片中/.test(latest)) {
    throw new Error('Packaged app did not finish chapter slicing within the timeout');
  }
  return latest;
}

if (process.argv.includes('--slice') || process.argv.includes('--wait-slice')) {
  if (process.argv.includes('--slice') && !await clickText('AI 重新切片')) {
    throw new Error('AI 重新切片 button not found');
  }
  const latest = await waitForSliceCompletion();
  console.log('Slice result:', latest.slice(0, 8000));
}

if (process.argv.includes('--regen-keyframes')) {
  if (!await clickSegmentOption('分镜精修')) throw new Error('分镜精修 phase was not found');
  await waitForText('参考素材槽位', 10000);
  if (!await clickSegmentOption('分镜图创作')) throw new Error('分镜图创作 mode was not found');
  const before = await getPersistedVideoSummary();
  const shots = before.flatMap((project) => project.shots).filter((shot) => typeof shot.index === 'number');
  const total = shots.length ? Math.max(...shots.map((shot) => shot.index)) + 1 : 0;
  if (total === 0) throw new Error('No persisted shots found for keyframe regeneration');
  const firstIndex = Math.min(total, Math.max(0, Number.parseInt(process.env.MOJING_START_SHOT || '0', 10) || 0));
  console.log(`Regenerating shots ${firstIndex + 1}-${total} through the single-shot studio...`);
  for (let index = firstIndex; index < total; index += 1) {
    if (!await clickSidebarShot(index)) throw new Error(`Shot ${index + 1} sidebar item was not found`);
    await waitForText(`当前编辑：分镜 ${index + 1}`, 10000);
    if (!await clickSegmentOption('分镜图创作')) throw new Error(`Shot ${index + 1} keyframe mode was not found`);
    const buttonText = `生成分镜 ${index + 1} 关键帧`;
    if (!await clickText(buttonText)) throw new Error(`Shot ${index + 1} keyframe button was not found`);
    await waitForSingleKeyframe(index);
    console.log(`Shot ${index + 1} completed`);
  }
  console.log('Keyframe result:', JSON.stringify(await getPersistedVideoSummary(), null, 2));
}

socket.close();

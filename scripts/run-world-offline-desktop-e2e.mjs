import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createWorld, createWorldObject, addWorldPath } from '../src/services/video-studio/document.ts';

// Use the release executable, real WebView2, real Tauri IPC and real FFmpeg.
// A unique WebView2 profile keeps all fixture state separate from user projects.
const executable = resolve(process.argv[2] || 'src-tauri/target/release/mojing.exe');
await access(executable);
const root = await mkdtemp(join(tmpdir(), 'mojing-desktop-export-'));
const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const port = server.address().port; await new Promise(ok => server.close(ok));
const run = promisify(execFile), delay = ms => new Promise(ok => setTimeout(ok, ms));
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-angle=swiftshader --enable-unsafe-swiftshader`,
} });
const pending = new Map(), errors = [], blocked = [];
let socket, nextId = 0, appData, fixtureWorldId, ownedAssets = [];
const call = (method, params = {}) => new Promise((ok, fail) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 30000);
  pending.set(id, { ok, fail, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(100); }
  throw new Error(`Timed out waiting for ${label}`);
};
const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Button unavailable');e.click();})()`);
const helpers = `
window.desktopState = async (value) => {
  const db = await new Promise((ok, fail) => { const r=indexedDB.open('mojing-video-studio',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error); });
  try { return await new Promise((ok,fail)=>{const tx=db.transaction('workspace',value===undefined?'readonly':'readwrite'),s=tx.objectStore('workspace'),r=value===undefined?s.get('video-studio'):s.put(JSON.stringify(value),'video-studio');tx.oncomplete=()=>ok(value===undefined?JSON.parse(r.result||'null'):null);tx.onerror=()=>fail(tx.error);}); }
  finally { db.close(); }
};
`;
try {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    if (child.exitCode !== null) throw new Error(`Desktop exited with ${child.exitCode}`);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && /tauri\.localhost/.test(t.url)); } catch { /* WebView2 is starting. */ }
    if (!target) await delay(200);
  }
  assert.ok(target, 'release WebView2 exposes the isolated CDP target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  const origin = new URL(target.url).origin;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer); if (message.error) item.fail(new Error(JSON.stringify(message.error))); else item.ok(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params, url = new URL(request.url);
      const local = url.origin === origin || ['http://asset.localhost', 'https://asset.localhost', 'http://ipc.localhost'].includes(url.origin) || ['ipc:', 'asset:', 'data:', 'blob:'].includes(url.protocol);
      if (!local) blocked.push(url.href);
      void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(e => errors.push(String(e)));
    }
  });
  await call('Runtime.enable'); await call('Page.enable'); await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await waitFor('!!window.__TAURI__?.core?.invoke', 'real Tauri API');
  assert.equal(await evaluate('window.__TAURI__.app.getVersion()'), '0.3.0');
  appData = await evaluate('window.__TAURI__.path.appDataDir()');
  assert.equal((await evaluate('window.__TAURI__.core.invoke("ffmpeg_probe")')).available, true);
  await evaluate(helpers);
  const previous = await evaluate('desktopState()');
  assert.ok(!previous?.state?.worlds?.length && !previous?.state?.assets?.length, 'test profile contains no user media');
  const world = createWorld('Desktop release fixture'); fixtureWorldId = world.id; world.duration = 1;
  world.objects = [addWorldPath(createWorldObject('actor', 'Lead'), [-1, 0, 0], [1, 0, 0], 1, 'walk')];
  world.camera = { position: [0, 2, 6], target: [0, 1, 0], focalLength: 35, keyframes: [] };
  world.cameraSequence = { enabled: true, shots: [
    { id: 'front', name: 'Front', duration: .5, camera: world.camera },
    { id: 'side', name: 'Side', duration: .5, camera: { position: [-6, 2, 0], target: [0, 1, 0], focalLength: 70, keyframes: [] } },
  ] };
  await evaluate(`desktopState(${JSON.stringify({ state: { page: 'world', assets: [], assetFolders: [], trashedAssets: [], jobs: [], uploadTasks: [], canvases: [], worlds: [world], recipes: [], commerceProjects: [], activeWorldId: world.id }, version: 0 })})`);
  await call('Page.addScriptToEvaluateOnNewDocument', { source: helpers }); await call('Page.reload');
  await waitFor('!!window.__TAURI__?.core?.invoke', 'Tauri after reload');
  await waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'packaged studio navigation'); await click('button[aria-label="视频工坊"]');
  await waitFor('!!document.querySelector("[data-testid=studio-world]")', 'packaged world');
  await click('[data-testid=world-offline-open]'); await waitFor('!!document.querySelector("[data-testid=world-offline-start]")', 'desktop export settings');
  assert.equal(await evaluate('document.querySelector("[data-testid=world-offline-start]").disabled'), false);
  await click('[data-testid=world-offline-start]');
  await waitFor('document.querySelector("[data-testid=world-offline-status]")?.textContent.includes("导出完成")', 'real desktop MP4 export', 60000);
  await waitFor('(async()=>{const s=await desktopState();return s?.state.assets.length===1;})()', 'durable asset save');
  const state = await evaluate('desktopState()'); ownedAssets = state.state.assets.filter(a => a.worldId === fixtureWorldId); assert.equal(ownedAssets.length, 1);
  const output = ownedAssets[0].url, jobId = ownedAssets[0].id.replace(/^offline-/, '');
  assert.equal(resolve(dirname(output)), resolve(join(appData, 'video-assets', 'studio-library', 'clip')));
  assert.match(jobId, /^[a-f\d-]{36}$/); assert.equal(basename(output), `${jobId}-offline.mp4`);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,pix_fmt,nb_read_frames,avg_frame_rate:format=duration', '-of', 'json', output], { windowsHide: true });
  const info = JSON.parse(stdout), stream = info.streams[0];
  assert.equal(stream.codec_name, 'h264'); assert.equal(stream.width, 1280); assert.equal(stream.height, 720); assert.equal(stream.pix_fmt, 'yuv420p'); assert.equal(stream.nb_read_frames, '24'); assert.equal(stream.avg_frame_rate, '24/1'); assert.equal(Number(info.format.duration), 1);
  assert.equal(state.state.assets[0].url, output); assert.deepEqual(state.state.worlds[0], world);
  const shot = await call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(tmpdir(), 'mojing-030-desktop-export.png'), Buffer.from(shot.data, 'base64'));
  await evaluate('[...document.querySelectorAll(".world-offline-modal button")].find(b=>b.textContent.replace(/\\s/g,"")==="关闭").click()');
  await waitFor('!document.querySelector(".world-offline-modal")', 'export dialog close');
  await click('[data-testid=studio-nav-assets]'); await waitFor('document.querySelector("[data-testid=studio-assets] video")?.readyState>=1', 'real asset-protocol MP4 playback');
  assert.deepEqual(await evaluate('(()=>{const v=document.querySelector("[data-testid=studio-assets] video");return[v.videoWidth,v.videoHeight,v.duration];})()'), [1280, 720, 1]);
  await evaluate('(async()=>{const v=document.querySelector("[data-testid=studio-assets] video");v.muted=true;await v.play();})()');
  await waitFor('document.querySelector("[data-testid=studio-assets] video").currentTime>0', 'decoded MP4 playback advances');
  await call('Page.reload'); await waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'packaged reload'); await click('button[aria-label="视频工坊"]');
  await waitFor('document.querySelector("[data-testid=studio-assets] video")?.readyState>=1', 'persisted disk video after reload');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', desktopVersion: '0.3.0', frames: 24, nativeIPC: true, playback: true, reload: true, blockedExternal: blocked.length, screenshot: join(tmpdir(), 'mojing-030-desktop-export.png') }));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    console.error('Desktop diagnostic:', await evaluate('document.body.innerText.slice(-2600)').catch(() => 'unavailable'));
    const shot = await call('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot) await writeFile(join(tmpdir(), 'mojing-030-desktop-failure.png'), Buffer.from(shot.data, 'base64'));
  }
  console.error('Runtime errors:', errors); throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate('document.querySelector("[data-testid=world-offline-cancel]")?.click()').catch(() => undefined);
    await waitFor('!document.querySelector("[data-testid=world-offline-cancel]")', 'pending render cleanup', 10000).catch(() => undefined);
    const finalState = await evaluate('desktopState()').catch(() => null);
    ownedAssets = finalState?.state?.assets.filter(a => a.worldId === fixtureWorldId) ?? ownedAssets;
    socket.close();
  }
  child.kill();
  for (const asset of ownedAssets) {
    const output = asset.url;
    assert.equal(resolve(dirname(output)), resolve(join(appData, 'video-assets', 'studio-library', 'clip')));
    assert.equal(basename(output), `${asset.id.replace(/^offline-/, '')}-offline.mp4`);
    for (let i = 0; i < 20; i++) { try { await rm(output, { force: true }); break; } catch (e) { if (i === 19) throw e; await delay(200); } }
  }
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') && basename(root).startsWith('mojing-desktop-export-'));
  for (let i = 0; i < 20; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch (e) { if (i === 19) throw e; await delay(200); } }
}

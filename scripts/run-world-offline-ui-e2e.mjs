import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { chromeSession } from './lib/chrome-session.mjs';

const run = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'mojing-offline-ui-'));
const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/', origin = new URL(appUrl).origin;
const browser = await chromeSession({ url: appUrl, port: 9243 });
const { call, evaluate, waitFor, click, textButton, delay, screenshot } = browser;
const jobs = [], external = [], commands = [];
let failEncode = true, holdAt = 5, held;
browser.onEvent(event => {
  if (event.method === 'Runtime.bindingCalled' && event.params.name === 'offlineIPC') {
    void (async () => {
      const { id, command, args } = JSON.parse(event.params.payload); commands.push(command);
      try {
        let result;
        if (command === 'ffmpeg_probe') result = { available: true };
        else if (command === 'world_render_begin') {
          const job = { id: `job-${jobs.length + 1}`, config: args.config, frames: [], cancelled: false }; job.directory = join(root, job.id); await mkdir(job.directory); jobs.push(job); result = job.id;
        } else {
          const job = jobs.find(j => j.id === args.jobId); assert.ok(job, command);
          if (command === 'world_render_frame') {
            assert.equal(args.index, job.frames.length); assert.equal(job.cancelled, false);
            if (args.index === holdAt) { holdAt = -1; await new Promise((ok, fail) => { held = { ok, fail }; }); }
            assert.equal(job.cancelled, false);
            const bytes = Buffer.from(args.dataUri.split(',')[1], 'base64'), metadata = await sharp(bytes).metadata(); assert.equal(metadata.format, 'png'); assert.equal(metadata.width, job.config.width); assert.equal(metadata.height, job.config.height);
            await writeFile(join(job.directory, `frame-${String(args.index).padStart(6, '0')}.png`), bytes); job.frames.push(bytes);
          } else if (command === 'world_render_finish') {
            assert.equal(job.frames.length, job.config.frameCount);
            if (failEncode) { failEncode = false; throw new Error('Injected encoding failure'); }
            job.output = join(root, `${job.id}.mp4`);
            await run('ffmpeg', ['-v', 'error', '-y', '-framerate', String(job.config.fps), '-i', join(job.directory, 'frame-%06d.png'), '-frames:v', String(job.config.frameCount), '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', job.output], { windowsHide: true });
            result = { outputPath: `${origin}/__offline_output/${job.id}.mp4`, width: job.config.width, height: job.config.height, fps: job.config.fps, frameCount: job.config.frameCount, durationSeconds: job.config.frameCount / job.config.fps, sizeBytes: (await readFile(job.output)).length }; job.completed = true;
          } else if (command === 'world_render_cancel') {
            job.cancelled = true; if (held) { held.fail(new Error('cancelled')); held = undefined; }
            await rm(job.directory, { recursive: true, force: true });
          } else throw new Error('Unexpected native command ' + command);
        }
        await evaluate(`offlineReplies.get(${id}).resolve(${JSON.stringify(result) ?? 'undefined'});offlineReplies.delete(${id});`);
      } catch (error) {
        await evaluate(`offlineReplies.get(${id}).reject(${JSON.stringify(String(error))});offlineReplies.delete(${id});`);
      }
    })().catch(error => browser.errors.push(String(error)));
  }
  if (event.method === 'Fetch.requestPaused') {
    void (async () => {
      const { request, requestId } = event.params, url = new URL(request.url);
      if (url.origin === origin && url.pathname.startsWith('/__offline_output/')) {
        const job = jobs.find(j => url.pathname.endsWith(`/${j.id}.mp4`)); assert.ok(job?.output);
        await call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }], body: (await readFile(job.output)).toString('base64') });
      } else if (url.origin === origin) await call('Fetch.continueRequest', { requestId });
      else { external.push(url.href); await call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
    })().catch(error => browser.errors.push(String(error)));
  }
});
const choose = async (label, option) => {
  const selector = `input[aria-label=${JSON.stringify(label)}]`;
  const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select');const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  const item = `(()=>{const input=document.querySelector(${JSON.stringify(selector)}),popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return[...(popup?.querySelectorAll('.ant-select-item-option')??[])].find(el=>el.title===${JSON.stringify(option)});})()`;
  await waitFor(`Boolean(${item})`, option); await evaluate(`(${item}).click()`); await waitFor('!document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")', 'export settings closed');
};
const open = async () => { await click('[data-testid=world-offline-open]'); await waitFor('!!document.querySelector(".world-offline-modal")', 'offline export dialog'); await delay(250); };
const close = async () => { await textButton('关闭', '.world-offline-modal'); await waitFor('!document.querySelector(".world-offline-modal")', 'export dialog closed'); };
try {
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await call('Runtime.addBinding', { name: 'offlineIPC' }); await call('Page.navigate', { url: appUrl });
  await waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'studio navigation'); await click('button[aria-label="视频工坊"]'); await waitFor('!!document.querySelector("[data-testid=studio-nav-world]")', 'studio'); await click('[data-testid=studio-nav-world]'); await waitFor('!!document.querySelector("[data-testid=studio-world]")', 'world');
  await evaluate(`(async()=>{const source=await(await fetch('/src/components/VideoStudio/WorldEngine.tsx')).text(),spec=symbol=>{const l=source.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes(symbol));return l.slice(l.indexOf('"')+1,l.lastIndexOf('"'));};window.offlineStore=(await import(spec('useVideoStudioStore'))).useVideoStudioStore;const {WorldViewport}=await import(spec('WorldViewport')),animate=WorldViewport.prototype.animate;window.offlineSamples=[];WorldViewport.prototype.animate=function(time){animate.call(this,time);window.offlineViewport=this;if(this.recording)offlineSamples.push({time,focal:this.shotCamera.getFocalLength(),actor:[...this.objects.values()][0]?.root.position.x});};const {createWorld,createWorldObject,addWorldPath}=await import('/src/services/video-studio/document.ts');const w=createWorld('Offline production');w.duration=1;w.fps=24;w.objects=[addWorldPath(createWorldObject('actor','Lead'),[-1,0,0],[1,0,0],1,'walk')];const a={position:[0,2,6],target:[0,1,0],focalLength:35,keyframes:[]},b={position:[-6,2,0],target:[0,1,0],focalLength:70,keyframes:[]};w.camera=a;w.cameraBookmarks=[{id:'side',name:'Side',camera:b}];w.cameraSequence={enabled:true,shots:[{id:'a',name:'Front',duration:.5,camera:a},{id:'b',name:'Side',duration:.5,camera:b}]};offlineStore.getState().saveWorld(w);})()`);
  await waitFor('!!window.offlineViewport', 'real WebGL');
  await evaluate('[...document.querySelectorAll(".world-engine-view-toolbar .ant-segmented-item-label")].find(el=>el.textContent==="多机位监看").click()'); await open(); assert.equal(await evaluate('document.querySelector("[data-testid=world-offline-start]").disabled'), true); assert.match(await evaluate('document.querySelector(".world-offline-modal").textContent'), /桌面应用/);
  for (const theme of ['dark', 'light']) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    for (const width of [1600, 650]) { await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(150); assert.ok(await evaluate('(()=>{const e=document.querySelector(".world-offline-form");return e.scrollWidth<=e.clientWidth+1;})()')); await screenshot(`mojing-world-offline-${theme}-${width}.png`); }
  }
  await call('Emulation.clearDeviceMetricsOverride'); await close();
  await evaluate('window.offlineReplies=new Map();window.offlineCounter=0;window.__TAURI_INTERNALS__={invoke:(command,args)=>new Promise((resolve,reject)=>{const id=++offlineCounter;offlineReplies.set(id,{resolve,reject});offlineIPC(JSON.stringify({id,command,args}));})};');
  const sourceWorld = await evaluate('JSON.stringify(offlineStore.getState().worlds[0])'); await open(); await click('[data-testid=world-offline-start]');
  await waitFor('document.querySelector("[data-testid=world-offline-status]")?.textContent.includes("5 / 24")', 'real frame write progress'); for (let i = 0; i < 100 && !held; i++) await delay(30); assert.ok(held); assert.equal(jobs[0].frames.length, 5); await screenshot('mojing-world-offline-rendering.png'); held.ok(); held = undefined;
  await waitFor('document.querySelector("[data-testid=world-offline-status]")?.textContent.includes("视频编码失败")', 'injected encode failure'); assert.equal(jobs[0].frames.length, 24); assert.equal(await evaluate('offlineStore.getState().assets.length'), 0);
  const samples = await evaluate('offlineSamples'); assert.equal(samples.length, 24); for (let i = 0; i < 24; i++) { assert.equal(samples[i].time, i / 24); assert.equal(Math.round(samples[i].focal), i < 12 ? 35 : 70); assert.ok(Math.abs(samples[i].actor - (-1 + 2 * i / 24)) < .00001); }
  assert.equal(await evaluate('offlineViewport.view'), 'monitor'); assert.equal(await evaluate('offlineViewport.recording'), false); const frameWrites = commands.filter(c => c === 'world_render_frame').length;
  await click('[data-testid=world-offline-retry]'); await waitFor('document.querySelector("[data-testid=world-offline-status]")?.textContent.includes("导出完成")', 'encoded MP4 saved', 30000);
  assert.equal(commands.filter(c => c === 'world_render_frame').length, frameWrites); assert.equal(jobs.length, 1); const asset = await evaluate('offlineStore.getState().assets[0]'); assert.equal(asset.mimeType, 'video/mp4'); assert.equal(asset.width, 1280); assert.equal(asset.height, 720); assert.equal(asset.durationSeconds, 1);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,pix_fmt,nb_read_frames,avg_frame_rate', '-of', 'json', jobs[0].output], { windowsHide: true }); const stream = JSON.parse(stdout).streams[0]; assert.equal(stream.codec_name, 'h264'); assert.equal(stream.nb_read_frames, '24'); assert.equal(stream.avg_frame_rate, '24/1'); assert.equal(stream.pix_fmt, 'yuv420p');
  for (const index of [0, 12, 23]) {
    const { stdout: bytes } = await run('ffmpeg', ['-v', 'error', '-i', jobs[0].output, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const a = await sharp(bytes).resize(64, 36).removeAlpha().raw().toBuffer(), b = await sharp(jobs[0].frames[index]).resize(64, 36).removeAlpha().raw().toBuffer(); assert.ok(a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / a.length < 6, `encoded frame ${index} matches the rendered timestamp`);
  }
  await close(); assert.equal(await evaluate('JSON.stringify(offlineStore.getState().worlds[0])'), sourceWorld);
  console.log('Exact timestamps and camera cuts, real PNG writes, encode-only retry, H.264 frame count/rate and decoded frame comparisons passed.');

  holdAt = 0; await open(); await choose('导出尺寸', '长边 1920'); await click('[data-testid=world-offline-start]'); await waitFor('offlineViewport.recording', 'second frame render started');
  for (let i = 0; i < 100 && !held; i++) await delay(30); assert.ok(held); await click('[data-testid=world-offline-cancel]'); await waitFor('document.querySelector("[data-testid=world-offline-status]")?.textContent.includes("已取消")', 'frame render cancelled'); assert.equal(jobs[1].cancelled, true); assert.equal((await readdir(root)).includes(jobs[1].id), false); assert.equal(await evaluate('offlineStore.getState().assets.length'), 1); assert.equal(await evaluate('offlineViewport.recording'), false); assert.equal(await evaluate('offlineViewport.view'), 'monitor'); await close();
  holdAt = 0; await open(); await click('[data-testid=world-offline-start]'); for (let i = 0; i < 100 && !held; i++) await delay(30); assert.ok(held); await evaluate('offlineStore.getState().setPage("home")'); await waitFor('!document.querySelector("[data-testid=studio-world]")', 'world unmounted'); for (let i = 0; i < 100 && !jobs[2].cancelled; i++) await delay(30); assert.equal(jobs[2].cancelled, true);
  assert.deepEqual(browser.errors, []); assert.ok(external.every(url => !/generations|\/tasks/.test(url)), 'no real model requests');
  console.log('Browser desktop gate, 1080P cancellation, owned-cache cleanup, monitor restoration, unmount cancellation and responsive dark/light UI passed. Native IPC was simulated; WebGL and FFmpeg were real.');
} catch (error) {
  console.error('Offline diagnostic:', await evaluate('({text:document.body.innerText.slice(-3500),samples:window.offlineSamples?.length,recording:window.offlineViewport?.recording})').catch(() => null)); console.error('Runtime errors:', browser.errors); console.error('Screenshot:', await screenshot('mojing-world-offline-failure.png').catch(() => null)); throw error;
} finally {
  browser.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') && root.includes('mojing-offline-ui-')); await rm(root, { recursive: true, force: true });
}

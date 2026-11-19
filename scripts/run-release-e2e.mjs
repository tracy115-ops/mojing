import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { desktopSession, delay } from './lib/desktop-session.mjs';

// Real packaged UI, provider adapters, Tauri HTTP/IPC, disk assets and FFmpeg.
// The only simulated boundary is the remote model service (including its visual judgement).
const executable = resolve(process.argv[2] || 'src-tauri/target/release/mojing.exe');
await access(executable);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const root = await mkdtemp(join(tmpdir(), 'mojing-release-e2e-'));
const output = process.env.MOJING_E2E_ARTIFACT_DIR || resolve('artifacts', `release-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const run = promisify(execFile), requests = [], serverErrors = [], steps = [], layoutChecks = [];
const paragraphs = [
  'In the Studio, Ada, an adult woman in a blue coat, raises her right hand. Ada says: "Hello."',
  'In the Studio, Ada lowers her right hand and smiles. Ada says: "Goodbye."',
];
let desktop, appData, projectId, report, studioAssets = [], currentStep = 'prepare fixtures';
const mark = name => { currentStep = name; steps.push({ name, at: new Date().toISOString() }); console.log(`E2E: ${name}`); };
const sha = data => createHash('sha256').update(data).digest('hex');
const diskPath = url => /^https?:\/\/asset\.localhost\//.test(url) ? decodeURIComponent(new URL(url).pathname.slice(1)) : url;
const probe = async path => JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration,size', '-of', 'json', path], { windowsHide: true })).stdout);
const averageFrame = async (path, seconds) => [...(await run('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, encoding: 'buffer' })).stdout];
const subtitlePixels = async (path, seconds) => {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1', '-vf', 'crop=iw:80:0:ih-80', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, encoding: 'buffer' });
  let count = 0;
  for (let i = 0; i < stdout.length; i += 3) if (stdout[i] > 200 && stdout[i + 1] > 200 && stdout[i + 2] > 200) count++;
  return count;
};
const audible = async (path, seconds) => {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', path, '-t', '0.4', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true, encoding: 'buffer' });
  let sum = 0; for (let i = 0; i < stdout.length; i += 2) sum += (stdout.readInt16LE(i) / 32768) ** 2;
  const rms = Math.sqrt(sum / (stdout.length / 2)); assert.ok(rms > .01, `audible output at ${seconds}s: ${rms}`); return rms;
};
const videoFixtures = [];
for (let i = 0; i < 2; i++) {
  const path = join(root, `shot-${i}.mp4`);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x704:r=24', '-t', '5', '-vf', i === 0 ? 'lutrgb=r=val*.25+180:g=val*.2:b=val*.2' : 'lutrgb=r=val*.2:g=val*.2:b=val*.25+180', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads', '2', path], { windowsHide: true });
  const color = await averageFrame(path, 1);
  assert.ok(i === 0 ? color[0] > color[2] + 30 : color[2] > color[0] + 30, `fixture ${i} has a distinct color`);
  // A valid MP4 free box keeps the fixture above WebView2's fetch URL limit.
  const padding = Buffer.alloc(2 * 1024 * 1024); padding.writeUInt32BE(padding.length); padding.write('free', 4);
  videoFixtures.push(Buffer.concat([await readFile(path), padding]));
}
const audioPath = join(root, 'voice.mp3');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=1', '-c:a', 'libmp3lame', audioPath], { windowsHide: true });
const audio = await readFile(audioPath);
const png = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: '#467aa8' } }).composite([{ input: Buffer.from('<svg width="2048" height="1152"><circle cx="1024" cy="420" r="150" fill="#f0d0b0"/><rect x="820" y="570" width="408" height="480" rx="80" fill="#123c78"/><path d="M0 1100H2048M100 0V1152M1948 0V1152" stroke="#ddd" stroke-width="30"/></svg>') }]).png().toBuffer();
let videoCounter = 0, failSceneOnce = true, firstImage = true;
let videoQueueFull = false;
let planRequests = 0, sceneRequests = 0;
const releasePlanResponses = [];
const releaseSceneResponses = [];
const tasks = new Map();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: url.pathname, query: url.search, method: request.method, body });
    let data;
    if (/\/media\/shot-\d+\.mp4$/.test(url.pathname)) {
      const index = Number(url.pathname.match(/shot-(\d+)/)[1]);
      const bytes = videoFixtures[index];
      response.setHeader('Content-Type', 'video/mp4'); response.setHeader('Accept-Ranges', 'bytes');
      const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const start = Number(range[1]), end = range[2] ? Number(range[2]) : bytes.length - 1;
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }).end(bytes.subarray(start, end + 1));
      } else response.writeHead(200, { 'Content-Length': bytes.length }).end(bytes);
      return;
    } else if (url.pathname.endsWith('/audio/speech')) {
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(audio); return;
    } else if (url.pathname.endsWith('/images/generations')) {
      assert.ok(body.seed === undefined || Number.isInteger(body.seed) && body.seed >= -1 && body.seed <= 999, 'Agnes Image accepts only seeds from -1 to 999');
      if (firstImage) { firstImage = false; await delay(1600); }
      if (/scene_background/.test(body.prompt)) {
        const attempt = ++sceneRequests;
        if (attempt <= 2) await new Promise(resolve => { releaseSceneResponses[attempt - 1] = resolve; });
        if (attempt > 1 && failSceneOnce) {
          failSceneOnce = false;
          response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'E2E scene generation failed once' } }));
          return;
        }
      }
      data = { data: [{ b64_json: png.toString('base64') }] };
    }
    else if (request.method === 'POST' && url.pathname.endsWith('/v1/videos')) {
      const secondShot = /Goodbye|lowers/i.test(body.prompt);
      if (videoQueueFull === 'all' || (videoQueueFull === 'second' && secondShot)) {
        response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'video_queue_full', message: 'Fixture queue is full' }));
        return;
      }
      const id = `video_release_${++videoCounter}`;
      tasks.set(id, { index: secondShot ? 1 : 0, seconds: body.seconds, inconsistentMetadata: videoCounter === 5 });
      data = { video_id: id };
    } else if (url.pathname === '/agnesapi') {
      const task = tasks.get(url.searchParams.get('video_id')); assert.ok(task, 'known video task');
      data = { status: 'completed', progress: 100, seconds: task.inconsistentMetadata ? 2 : task.seconds, width: task.inconsistentMetadata ? 640 : 1280, height: task.inconsistentMetadata ? 360 : 704, url: `http://${request.headers.host}/media/shot-${task.index}.mp4` };
    } else if (url.pathname.endsWith('/chat/completions')) {
      const system = body.messages.find(m => m.role === 'system')?.content || '';
      const user = body.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')).join('\n');
      let content;
      if (system.includes('source-preserving shot segmentation')) {
        const attempt = ++planRequests;
        if (attempt <= 2) await new Promise(resolve => { releasePlanResponses[attempt - 1] = resolve; });
        const input = JSON.parse(user), chapter = input.chapters[0];
        content = paragraphs.map((sourceText, index) => ({ index, sourceChapterId: chapter.id, sourceChapterNumber: chapter.number, sourceText, visibleCharacters: ['Ada'], offscreenCharacters: [], location: 'Studio', mood: 'calm', hasDialogue: true, hasAction: true }));
      } else if (system.includes('Return only a JSON array with exactly one object per input segment')) {
        const indices = [...user.matchAll(/source=(.*)/g)].map(match => /Goodbye/.test(match[1]) ? 1 : 0);
        content = indices.map(index => ({ videoPrompt: paragraphs[index], imagePrompt: `Medium shot in the Studio. ${index ? 'Ada smiles with her right hand lowered. Goodbye.' : 'Ada holds her right hand up. Hello.'} Soft light, static camera.`, narration: '', dialogue: [{ speaker: 'Ada', text: index ? 'Goodbye.' : 'Hello.' }], visibleCharacters: ['Ada'], offscreenCharacters: [], characters: ['Ada'], location: 'Studio', mood: 'calm', cameraMovement: 'static', transition: 'cut', durationSeconds: 5, startState: index ? 'Hand raised.' : 'Hand lowered.', endState: index ? 'Hand lowered.' : 'Hand raised.' }));
      } else if (system.includes('schema-constrained entity extraction')) content = { characters: [{ name: 'Ada', aliases: [], appearance: 'adult woman in a blue coat', entityType: 'human', gender: 'female', ageGroup: 'adult', firstAppearShotIndex: 0, seed: 12345 }], scenes: [{ name: 'Studio', description: 'Studio', firstAppearShotIndex: 0 }], props: [], characterIdMap: {}, sceneIdMap: {} };
      else if (system.includes('provider-aware image prompt planner') || system.includes('provider-aware video prompt planner')) {
        // Keep the application-built source/reference contract intact.
        const input = JSON.parse(user);
        content = { prompt: input.prompt || input.basePrompt || input.shot?.videoPrompt || input.shot?.imagePrompt || user, parameters: {} };
      } else if (system.includes('strict visual quality reviewer')) content = { overallScore: 95, summary: 'Simulated visual judgement for transport and gate testing only.', checks: ['subject_count', 'subject_identity', 'scene_match', 'composition', 'temporal_consistency'].map(id => ({ id, status: 'pass', score: 95, message: 'Fixture response', evidence: 'Simulated response' })) };
      else throw new Error(`Unexpected LLM task: ${system.slice(0, 160)}`);
      data = { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } };
    } else throw new Error(`Unexpected model route ${request.method} ${url.pathname}`);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  } catch (error) { serverErrors.push(String(error)); response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelOrigin = `http://127.0.0.1:${server.address().port}`;
const config = {
  llm: { primary: 'openai', endpointId: 'fixture-llm', defaultModel: 'gpt-4o-mini', models: { planning: '', generation: '', review: '', extraction: '', translation: '', embedding: '' } },
  image: { primary: 'agnes-image', endpointId: 'fixture-image', defaultModel: 'agnes-image-2.1-flash', models: { character: '', scene: '', panel: '', 'style-transfer': '', storyboard: '' }, defaultWidth: 2048, defaultHeight: 1152 },
  video: { primary: 'agnes-video', endpointId: 'fixture-video', defaultModel: 'agnes-video-2.5-flash', models: { clip: '', transition: '', 'full-scene': '', 'lip-sync': '', effects: '' }, defaultResolution: '1280x704', defaultFps: 24, queueRetryCount: 1, queueRetryBackoffMs: 20000 },
  tts: { primary: 'openai-tts', endpointId: 'fixture-tts', defaultModel: 'tts-1', defaultVoice: 'alloy', defaultFormat: 'mp3', defaultSpeed: 1 },
};
const endpoints = [['llm', 'openai', 'gpt-4o-mini'], ['image', 'agnes-image', 'agnes-image-2.1-flash'], ['video', 'agnes-video', 'agnes-video-2.5-flash'], ['tts', 'openai-tts', 'tts-1']].map(([category, provider, model]) => ({ id: `fixture-${category}`, name: `E2E ${category}`, category, provider, baseUrl: modelOrigin, apiKey: 'local-fixture-only', models: [model], enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
const projectExpression = () => `JSON.parse(localStorage.getItem('mojing-video')).state.projects[${JSON.stringify(projectId)}]`;
const project = () => desktop.evaluate(projectExpression());
const start = () => desktopSession({ executable, profile: join(root, 'webview'), allowedOrigins: [modelOrigin], softwareRendering: process.env.MOJING_E2E_HARDWARE_RENDERING !== '1' });
const stopGeneration = async () => {
  await desktop.nativeTextButton('停止生成', '.video-production-console-tools');
  const confirmStop = '.ant-modal-confirm-btns .ant-btn-dangerous';
  await desktop.waitFor(`(()=>{
    const modal = document.querySelector(${JSON.stringify(confirmStop)})?.closest('.ant-modal');
    return modal?.getClientRects().length && !modal.getAnimations({subtree:true}).some(animation => animation.playState === 'running');
  })()`, 'stop confirmation ready for mouse input');
  await desktop.nativeClick(confirmStop);
  await desktop.waitFor(`!document.querySelector(${JSON.stringify(confirmStop)})?.getClientRects().length`, 'stop confirmation closes');
};
const studioReader = `window.e2eReadStudio=async()=>{const db=await new Promise((ok,fail)=>{const r=indexedDB.open('mojing-video-studio',1);r.onsuccess=()=>ok(r.result);r.onerror=()=>fail(r.error);});try{return await new Promise((ok,fail)=>{const tx=db.transaction('workspace','readonly'),r=tx.objectStore('workspace').get('video-studio');tx.oncomplete=()=>ok(JSON.parse(r.result||'null'));tx.onerror=()=>fail(tx.error);});}finally{db.close();}}`;
try {
  mark('launch isolated release desktop');
  desktop = await start();
  assert.equal(await desktop.evaluate('window.__TAURI__.app.getVersion()'), version);
  appData = await desktop.evaluate('window.__TAURI__.path.appDataDir()');
  assert.equal((await desktop.evaluate('window.__TAURI__.core.invoke("ffmpeg_probe")')).available, true);
  assert.equal(await desktop.evaluate("JSON.parse(localStorage.getItem('mojing-projects')||'null')?.state?.projects?.length||0"), 0);
  await desktop.evaluate(`localStorage.setItem('mojing-providers',${JSON.stringify(JSON.stringify({ state: { config, endpoints }, version: 0 }))})`);
  await desktop.call('Page.reload');
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'video navigation');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'studio navigation');
  await desktop.nativeClick('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-new-video]")', 'projects page');
  await desktop.nativeClick('[data-testid=video-new-video]');
  await desktop.waitFor('!!document.querySelector(".video-create-episode-modal #title")', 'new project form');
  await desktop.fill('.video-create-episode-modal #title', 'Release E2E - Ada');
  await desktop.fill('.video-create-episode-modal #scriptText', paragraphs.join('\n\n'));
  await desktop.nativeClick('.video-create-episode-modal .ant-modal-footer .ant-btn-primary');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-overview-next-action-button]")', 'draft overview');
  projectId = await desktop.evaluate("JSON.parse(localStorage.getItem('mojing-video')).state.activePipelineId");
  assert.match(projectId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(requests.length, 0, 'new project is local and makes no model call');

  mark('stop and resume script planning after leaving and reopening the workbench');
  await desktop.nativeClick('[data-testid=video-overview-next-action-button]');
  await desktop.waitFor(`${projectExpression()}.stages.script_slicing?.status==='running'`, 'script planning started');
  await desktop.waitFor(
    'document.querySelector(".video-view-projects [data-testid=video-project-progress]")?.innerText.includes("执行中")',
    'standalone project shows running status in the list',
  );
  for (let tries = 0; !releasePlanResponses[0] && tries < 120; tries++) await delay(100);
  assert.equal(planRequests, 1);
  await desktop.nativeClick('button[aria-label="小说引擎"]');
  await desktop.waitFor('!document.querySelector(".video-production-console")', 'project panel closes when leaving the workbench');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'return to video workspace');
  await desktop.nativeClick('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector(".video-production-console.is-running")', 'the reopened project is still generating');
  await stopGeneration();
  await desktop.waitFor('document.querySelector("[data-testid=video-overview-next-action-button]")?.textContent.includes("继续生成")', 'resume script planning');
  await desktop.nativeClick('[data-testid=video-overview-next-action-button]');
  for (let tries = 0; !releasePlanResponses[1] && tries < 120; tries++) await delay(100);
  assert.equal(planRequests, 2);
  releasePlanResponses[0]();
  await delay(600);
  assert.equal((await project()).stages.script_slicing.status, 'running', 'the stopped plan cannot advance the resumed stage');
  assert.deepEqual((await project()).shots, [], 'the stopped plan cannot overwrite the resumed draft');
  releasePlanResponses[1]();

  mark('complete script planning and wait for approval');
  await desktop.waitFor(`${projectExpression()}.stages.extraction?.status==='awaiting_review'`, 'planning review checkpoint', 45000);
  assert.equal((await project()).sceneSpec.shots.length, 2);
  assert.equal(requests.filter(r => r.path.endsWith('/images/generations')).length, 0, 'planning approval blocks paid image calls');
  await desktop.screenshot(join(output, '01-planning.png'));

  mark('confirm storyboard, reopen the project directly on Assets, then start and retry reference generation');
  await desktop.nativeClick('[data-phase=assets]');
  await desktop.waitFor('document.querySelector("[data-testid=video-phase-next-action-button]")?.textContent.includes("审核分镜")', 'asset page explains pending storyboard review');
  await desktop.nativeClick('[data-testid=video-phase-next-action-button]');
  await desktop.nativeClick('[data-testid=video-approve-planning]');
  await desktop.waitFor('document.querySelector("[data-phase=assets]").getAttribute("aria-current")==="step"', 'asset page after approval');
  assert.equal(requests.filter(r => r.path.endsWith('/images/generations')).length, 0, 'confirming the plan does not start a model call');
  const planned = (await project()).sceneSpec;
  await desktop.call('Page.reload');
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'video navigation after reopening');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'short drama navigation after reopening');
  await desktop.nativeClick('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector("[data-phase=assets]")', 'saved project steps');
  await desktop.nativeClick('[data-phase=assets]');
  const assetAction = '[data-testid=video-phase-next-action-button]';
  await desktop.waitFor(`document.querySelector(${JSON.stringify(assetAction)})?.textContent.includes("生成缺少的角色和场景图")`, 'visible asset generation action');
  await desktop.nativeClick('.ws-titlebar-window-controls .ant-btn');
  await desktop.waitFor('document.documentElement.dataset.theme==="light"', 'asset view in light theme');
  await desktop.evaluate('window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(900,600))');
  await desktop.waitFor('innerWidth===900&&innerHeight===600', 'minimum desktop window for assets');
  assert.equal(await desktop.evaluate('document.querySelector(".video-production-console-steps").scrollWidth<=document.querySelector(".video-production-console-steps").clientWidth'), true, 'all four project steps remain visible');
  await desktop.screenshot(join(output, '01-assets-ready-to-start.png'));
  await desktop.nativeClick(assetAction);
  await desktop.waitFor('document.querySelector(".video-production-console.is-running") && document.querySelector("[data-testid=video-phase-action]").getAttribute("aria-busy")==="true"', 'asset generation visible in place');
  await desktop.screenshot(join(output, '01-assets-running.png'));
  mark('stop a pending scene request and resume immediately from the overview');
  await desktop.waitFor(`${projectExpression()}.stages.scene_image?.status==='running'`, 'scene generation started');
  const requestDeadline = Date.now() + 10000;
  while (sceneRequests < 1 && Date.now() < requestDeadline) await delay(100);
  assert.equal(sceneRequests, 1, 'the first scene request is still held by the provider');
  const refsBeforeStop = (await project()).sceneSpec.characters;
  await desktop.nativeClick('button[aria-label="生产链路"]');
  await stopGeneration();
  await desktop.waitFor('document.querySelector("[data-testid=video-overview-next-action-button]")?.textContent.includes("继续生成")', 'resume action while the old response is still pending', 5000);
  assert.match(await desktop.evaluate('document.querySelector(".video-production-console-status").innerText'), /已停止/);
  const stopped = await project();
  assert.equal(stopped.stages.scene_image.status, 'error');
  assert.deepEqual(stopped.sceneSpec.characters, refsBeforeStop);
  await desktop.evaluate('window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(1280,800))');
  await desktop.waitFor('innerWidth===1280&&innerHeight===800', 'overview at the regular desktop size');
  await desktop.screenshot(join(output, '01-assets-stopped.png'));
  await desktop.nativeClick('[data-phase=assets]');
  await desktop.waitFor('document.querySelector("[data-testid=video-phase-next-action-button]")?.textContent.includes("继续生成")', 'resume action also appears in Assets');
  await desktop.nativeClick('button[aria-label="生产链路"]');
  await desktop.nativeClick('[data-testid=video-overview-next-action-button]');
  const resumeDeadline = Date.now() + 10000;
  while (sceneRequests < 2 && Date.now() < resumeDeadline) await delay(100);
  assert.equal(sceneRequests, 2, 'the new request starts before the stopped request returns');
  releaseSceneResponses[0]();
  await delay(750);
  const resumed = await project();
  assert.equal(resumed.stages.scene_image.status, 'running', 'late response cannot change the resumed stage');
  assert.ok(!resumed.sceneSpec.scenes[0].backgroundImage, 'late response cannot populate a resumed stage');
  assert.equal(await desktop.evaluate('document.querySelector("[data-testid=video-phase-action]")?.getAttribute("aria-busy")'), 'true');
  releaseSceneResponses[1]();
  await desktop.waitFor(`${projectExpression()}.stages.scene_image?.status==='error'`, 'failed scene graph state', 90000);
  const partial = (await project()).sceneSpec;
  assert.ok(partial.characters[0].portraitImage && partial.characters[0].turnaroundImage);
  assert.deepEqual(partial.shots, planned.shots);
  await desktop.waitFor(`document.querySelector(${JSON.stringify(assetAction)})?.textContent.includes("重试")`, 'retry action after provider failure');
  await desktop.nativeClick(assetAction);
  await desktop.waitFor(`${projectExpression()}.stages.scene_image?.status==='completed'`, 'asset retry success', 30000);
  const prepared = (await project()).sceneSpec;
  assert.deepEqual(prepared.characters, partial.characters, 'retry retains the completed references');
  assert.deepEqual(prepared.shots, planned.shots, 'asset work retains the original storyboard and bindings');
  assert.ok(prepared.scenes[0].backgroundImage && prepared.scenes[0].backgroundReferenceRole === 'environment_only');
  assert.equal(requests.filter(r => r.path.endsWith('/images/generations')).length, 5, 'portrait and turnaround are reused across the three scene attempts');
  await desktop.waitFor('document.querySelector("[data-testid=video-phase-action]")?.textContent.includes("角色参考图 1/1 · 场景图 1/1")', 'asset view shows saved reference counts');
  await desktop.screenshot(join(output, '01-assets-finished.png'));
  await desktop.waitFor('innerWidth===1280&&innerHeight===800', 'desktop restored after asset checks');
  for (let i = 0; i < 3; i++) await desktop.nativeClick('.ws-titlebar-window-controls .ant-btn');
  await desktop.waitFor('document.documentElement.dataset.theme==="dark"', 'dark theme restored');
  await desktop.nativeClick(assetAction);
  await desktop.waitFor(`${projectExpression()}.stages.video_generation?.status==='awaiting_review'`, 'keyframe checkpoint', 90000);
  let state = await project();
  assert.equal(state.stages.keyframe_image.status, 'completed');
  assert.ok(state.sceneSpec.characters[0].portraitImage && state.sceneSpec.scenes[0].backgroundImage);
  assert.ok(state.sceneSpec.shots.every(s => s.keyframeImage && s.versionHistory.filter(v => v.type === 'image').length === 2));
  assert.equal(videoCounter, 0, 'unreviewed keyframes block video calls');
  await desktop.nativeClick('[data-testid=video-phase-next-action-button]');
  await desktop.waitFor('document.querySelectorAll(".shot-production-shot-item").length===2', 'shot queue');
  for (let index = 0; index < 2; index++) {
    await desktop.evaluate(`document.querySelectorAll('.shot-production-shot-item')[${index}].click()`);
    await desktop.waitFor(`document.querySelectorAll('.shot-production-shot-item')[${index}].classList.contains('is-active')`, 'selected shot');
    await desktop.click('[data-tab=review]');
    await desktop.waitFor('!!document.querySelector(".shot-production-version.is-selected")', 'selected keyframe');
    if (index === 0) {
      await desktop.click('.shot-production-version.is-selected .shot-production-version-actions button:has([aria-label=warning])');
      await desktop.waitFor('document.querySelector(".shot-production-generate-actions .ant-btn-primary").disabled', 'rejected keyframe blocks generation');
    }
    await desktop.click('.shot-production-version.is-selected .shot-production-version-actions button:has([aria-label=check])');
  }
  assert.ok((await project()).sceneSpec.shots.every(s => s.versionHistory.some(v => v.type === 'image' && v.reviewStatus === 'approved')));
  await desktop.screenshot(join(output, '02-keyframes.png'));

  mark('edit and regenerate an approved keyframe, then reload and resume from idle');
  await desktop.evaluate(`document.querySelectorAll('.shot-production-shot-item')[0].click()`);
  const imageCountBeforeEdit = (await project()).sceneSpec.shots[0].versionHistory.filter(v => v.type === 'image').length;
  await desktop.fill('.shot-production-prompt-grid label:first-child textarea', 'Ada stands beside the same blue wall, with her right hand lowered.');
  await desktop.evaluate('document.activeElement.blur()');
  await desktop.textButton('生成关键帧', '.shot-production-generate-actions');
  await desktop.waitFor(`${projectExpression()}.sceneSpec.shots[0].versionHistory.filter(v=>v.type==='image').length>${imageCountBeforeEdit}`, 'regenerated keyframe', 30000);
  await desktop.click('[data-tab=review]');
  await desktop.click('.shot-production-version.is-selected .shot-production-version-actions button:has([aria-label=check])');
  assert.equal(videoCounter, 0, 'manual editing still requires an explicit video production action');

  // Rehydration clears a suspended pipeline checkpoint after an app reload.
  // This is the real trigger observed during the live quality run.
  await desktop.call('Page.reload');
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'reload navigation');
  await desktop.click('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'reload studio');
  await desktop.click('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-overview-next-action-button]")', 'reloaded project');
  // Hydration updates the runtime store before the next persistence write.
  // Observe the console used by the user, rather than its old disk snapshot.
  assert.equal(await desktop.evaluate('document.querySelector(".video-production-console")?.classList.contains("is-idle")'), true, 'reloaded project is idle before the user resumes production');

  mark('resume voice assignment, TTS and video candidates through UI');
  await desktop.nativeClick('[data-phase=studio]');
  await desktop.nativeClick('[data-testid=video-phase-next-action-button]');
  await desktop.waitFor(`${projectExpression()}.stages.video_review?.status==='awaiting_review'`, 'video candidate review checkpoint', 150000);
  state = await project();
  assert.equal(state.stages.tts.status, 'completed');
  assert.equal(requests.filter(r => r.path.endsWith('/audio/speech')).length, 2);
  assert.equal(videoCounter, 4);
  assert.ok(state.sceneSpec.shots.every(s => s.audioTrack));
  assert.ok(!state.finalVideoUrl, 'unlocked video candidates block composition');
  const submitted = requests.filter(r => r.method === 'POST' && r.path.endsWith('/v1/videos'));
  assert.ok(submitted.every(r => r.body.mode === 'keyframe' && r.body.first_frame.startsWith('data:image/') && r.body.seconds === '5' && r.body.size === '720P'));
  await desktop.click('[data-phase=studio]');
  assert.equal(await desktop.evaluate('document.querySelector(".shot-production-toolbar-actions .ant-btn-primary").disabled'), true, 'unreviewed videos cannot be assembled');
  for (let index = 0; index < 2; index++) {
    await desktop.evaluate(`document.querySelectorAll('.shot-production-shot-item')[${index}].click()`);
    await desktop.waitFor(`document.querySelectorAll('.shot-production-shot-item')[${index}].classList.contains('is-active')`, 'selected video shot');
    await desktop.click('[data-tab=review]');
    await desktop.waitFor('!!document.querySelector(".shot-production-version.is-selected video")', 'selected video candidate');
    await desktop.click('.shot-production-version.is-selected .shot-production-version-actions button:has([aria-label=check])');
    await desktop.waitFor('!!document.querySelector(".shot-production-version.is-selected .shot-production-version-actions button:has([aria-label=lock])")', 'lock approved candidate');
    await desktop.click('.shot-production-version.is-selected .shot-production-version-actions button:has([aria-label=lock])');
  }
  state = await project();
  assert.ok(state.sceneSpec.shots.every(s => s.lockedVersionId));
  await desktop.screenshot(join(output, '03-approved-videos.png'));

  mark('compose actual MP4 with audio');
  await desktop.textButton('合成成片', '.shot-production-board');
  await desktop.waitFor(`${projectExpression()}.stages.composing?.status==='completed'&&!!${projectExpression()}.finalVideoUrl`, 'native final composition', 90000);
  state = await project();
  const finalPath = diskPath(state.finalVideoUrl);
  const cacheDirectory = resolve(appData, 'video-cache', projectId);
  assert.equal(resolve(dirname(dirname(finalPath))), cacheDirectory);
  assert.match(basename(dirname(finalPath)), /^compose-[a-f0-9-]{36}$/);
  await copyFile(finalPath, join(output, 'final-original.mp4'));
  const originalInfo = await probe(finalPath);
  const originalVideo = originalInfo.streams.find(s => s.codec_type === 'video');
  assert.deepEqual([originalVideo.codec_name, originalVideo.width, originalVideo.height, originalVideo.nb_read_frames], ['h264', 1280, 704, '240']);
  assert.ok(originalInfo.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'), 'final MP4 contains actual audio');
  assert.ok(Math.abs(Number(originalInfo.format.duration) - 10) < .2);
  const originalColors = await Promise.all([averageFrame(finalPath, 1), averageFrame(finalPath, 6)]);
  assert.ok(originalColors[0][0] > originalColors[0][2] + 30, 'first shot is red');
  assert.ok(originalColors[1][2] > originalColors[1][0] + 30, 'second shot is blue');
  assert.ok(state.sceneSpec.shots.every(shot => !shot.narration && shot.dialogue?.length), 'subtitle regression uses dialogue-only plans');
  const whiteSubtitlePixels = await Promise.all([subtitlePixels(finalPath, 1), subtitlePixels(finalPath, 6)]);
  assert.ok(whiteSubtitlePixels.every(count => count > 50), `structured dialogue appears in the rendered subtitles: ${whiteSubtitlePixels}`);
  const incompleteOutput = join(output, 'must-not-compose-partial.mp4');
  const incompleteRequest = { clipPaths: [diskPath(state.clips[0].videoUrl), join(output, 'missing-shot.mp4')], subtitles: [null, null], outputPath: incompleteOutput, hardcodeSubtitles: false };
  const incompleteError = await desktop.evaluate(`(async()=>{try{await window.__TAURI__.core.invoke('ffmpeg_compose_clips',{req:${JSON.stringify(incompleteRequest)}});return '';}catch(error){return String(error);}})()`);
  assert.match(incompleteError, /无效镜头|没有可用|不存在|missing/i, 'missing shots cannot silently disappear from the final movie');
  await assert.rejects(access(incompleteOutput), 'a failed partial composition must not publish a movie');
  const chineseSubtitleOutput = join(output, 'chinese-multiline-subtitles.mp4');
  const chineseSubtitleRequest = { clipPaths: [diskPath(state.clips[0].videoUrl)], subtitles: ['你好，世界。\n同一个角色。'], outputPath: chineseSubtitleOutput, hardcodeSubtitles: true };
  await desktop.evaluate(`window.__TAURI__.core.invoke('ffmpeg_compose_clips',{req:${JSON.stringify(chineseSubtitleRequest)}})`);
  const { stdout: captionRGB } = await run('ffmpeg', ['-v', 'error', '-ss', '1', '-i', chineseSubtitleOutput, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  let captionTop = originalVideo.height, captionBottom = 0, captionWhite = 0;
  for (let i = 0; i < captionRGB.length; i += 3) if (captionRGB[i] > 200 && captionRGB[i + 1] > 200 && captionRGB[i + 2] > 200) {
    const y = Math.floor(i / 3 / originalVideo.width); captionTop = Math.min(captionTop, y); captionBottom = Math.max(captionBottom, y); captionWhite++;
  }
  assert.ok(captionWhite > 100 && captionTop > originalVideo.height - 200 && captionBottom < originalVideo.height - 10, 'Chinese multiline subtitles remain visible inside the picture');
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', chineseSubtitleOutput, '-frames:v', '1', '-update', '1', join(output, 'chinese-multiline-subtitles.png')], { windowsHide: true });
  const audioRms = await Promise.all([audible(finalPath, .1), audible(finalPath, 5.1)]);
  await desktop.waitFor('document.querySelector(".video-timeline-workspace video")?.readyState>=1', 'final asset-protocol playback');
  await desktop.evaluate('(async()=>{const v=document.querySelector(".video-timeline-workspace video");v.muted=true;await v.play();})()');
  await desktop.waitFor('document.querySelector(".video-timeline-workspace video").currentTime>.2', 'playback advances');
  await desktop.screenshot(join(output, '04-composed.png'));

  mark('reorder shots and trim one second using timeline controls');
  const shotIds = state.sceneSpec.shots.map(s => s.id);
  await desktop.click('.video-timeline-workspace [role=button][aria-label="第 1 镜"] button:has([aria-label=arrow-down])');
  await desktop.waitFor(`${projectExpression()}.timelineState.shotOrder[0]===${JSON.stringify(shotIds[1])}`, 'persisted reordered shots');
  assert.equal((await project()).finalVideoUrl, undefined, 'timeline edit invalidates the previous master');
  // The range end handle supports keyboard input, exactly as in the desktop UI.
  await desktop.click('.video-timeline-workspace [role=button][aria-label="第 1 镜"]');
  await desktop.evaluate('document.querySelector(".video-timeline-workspace .ant-slider-handle-2").focus()');
  for (let i = 0; i < 10; i++) {
    await desktop.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await desktop.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  }
  await desktop.waitFor(`${projectExpression()}.timelineState.trims[${JSON.stringify(shotIds[1])}]?.endSeconds>=.99`, 'persisted one-second trim');
  await desktop.click('[data-testid=video-timeline-compose]');
  await desktop.waitFor(`${projectExpression()}.finalDurationSeconds>8.8&&${projectExpression()}.finalDurationSeconds<9.2`, 'recomposed duration', 90000);
  const edited = await project();
  assert.equal(edited.stages.composing.status, 'completed');
  const editedPath = diskPath(edited.finalVideoUrl);
  assert.equal(resolve(dirname(dirname(editedPath))), cacheDirectory);
  assert.notEqual(editedPath, finalPath, 'each composition writes to its own path');
  assert.deepEqual(await probe(finalPath), originalInfo, 'the new render leaves the original movie intact');
  const editedInfo = await probe(editedPath);
  assert.ok(Math.abs(Number(editedInfo.format.duration) - 9) < .2);
  const editedColors = await Promise.all([averageFrame(editedPath, 1), averageFrame(editedPath, 5)]);
  assert.ok(editedColors[0][2] > editedColors[0][0] + 30, 'edited first shot is blue');
  assert.ok(editedColors[1][0] > editedColors[1][2] + 30, 'edited second shot is red');
  await copyFile(editedPath, join(output, 'final-edited.mp4'));
  await desktop.waitFor('(()=>{const v=document.querySelector(".video-timeline-workspace video");return v?.readyState>=2&&v.duration>8.8&&v.duration<9.2;})()', 'edited preview reloads the actual new duration', 15000);
  await desktop.evaluate('(()=>{const v=document.querySelector(".video-timeline-workspace video");v.pause();v.currentTime=1;})()');
  await desktop.waitFor('(()=>{const v=document.querySelector(".video-timeline-workspace video");return v.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-1)<.1;})()', 'seek in recomposed preview');
  const previewBox = await desktop.evaluate('(()=>{const r=document.querySelector(".video-timeline-workspace video").getBoundingClientRect();return{x:r.x+r.width*.25,y:r.y+r.height*.25,width:r.width*.5,height:r.height*.4,scale:1};})()');
  const previewPixels = await desktop.call('Page.captureScreenshot', { format: 'png', clip: previewBox });
  const previewImage = Buffer.from(previewPixels.data, 'base64');
  await writeFile(join(output, 'preview-edited.png'), previewImage);
  const previewStats = await sharp(previewImage).stats();
  const previewColor = previewStats.channels.slice(0, 3).map(c => c.mean);
  assert.ok(previewColor[2] > previewColor[0] + 30, 'desktop preview shows the new blue first shot');
  const checkTimelineLayout = async () => {
    const layout = await desktop.evaluate(`(()=>{const grid=document.querySelector('.video-timeline-preview-grid'),player=grid.querySelector('video'),body=player.closest('.ant-card-body');const rect=e=>{const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height};};return{theme:document.documentElement.dataset.theme,width:innerWidth,preview:rect(grid),player:rect(player),body:rect(body),tracks:rect(grid.nextElementSibling)};})()`);
    assert.ok(layout.player.bottom <= layout.body.bottom + 1, 'video stays inside its preview card');
    assert.ok(layout.player.bottom <= layout.tracks.top, 'preview does not overlap timeline controls');
    assert.ok(layout.tracks.height >= 179, 'timeline retains usable height');
    layoutChecks.push(layout);
  };
  await checkTimelineLayout();
  await desktop.evaluate('document.activeElement?.blur()');
  // Capture the actual layout, including any success notice whose dismissal
  // is paused by the native pointer. Its timer is not an export prerequisite.
  await desktop.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 100 });
  await desktop.screenshot(join(output, '05-timeline-edited.png'));
  await desktop.click('.ws-titlebar-window-controls .ant-btn');
  await desktop.waitFor('document.documentElement.dataset.theme==="light"', 'light theme');
  await delay(350); // Let Ant Design's theme color transitions settle for the screenshot.
  await checkTimelineLayout();
  await desktop.screenshot(join(output, '05-timeline-light.png'));
  for (let i = 0; i < 3; i++) await desktop.click('.ws-titlebar-window-controls .ant-btn');
  await desktop.waitFor('document.documentElement.dataset.theme==="dark"', 'restored dark theme');
  await delay(350);
  await desktop.evaluate('window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(900,600))');
  await desktop.waitFor('innerWidth===900&&innerHeight===600', 'minimum desktop window size');
  await checkTimelineLayout();
  await desktop.screenshot(join(output, '05-timeline-small-window.png'));
  await desktop.evaluate('document.querySelector(".video-timeline-preview-grid").nextElementSibling.scrollIntoView({block:"end"})');
  await desktop.waitFor(`(()=>{const e=document.querySelector('.video-timeline-workspace [role=button][aria-label="第 1 镜"] button:has([aria-label=arrow-down])'),r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`, 'timeline controls reachable by scrolling in the minimum window');
  await checkTimelineLayout();
  await desktop.screenshot(join(output, '05-timeline-small-window-tracks.png'));
  await desktop.evaluate('window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(1280,800))');
  await desktop.waitFor('innerWidth===1280&&innerHeight===800', 'restored desktop window size');
  await desktop.evaluate('document.querySelector(".video-timeline-workspace").scrollTop=0');

  mark('export through actual native Save dialog');
  await desktop.textButton('导出 MP4', '.video-timeline-workspace');
  await desktop.waitFor('!!document.querySelector(".ant-modal .ant-radio-group")', 'export settings');
  await desktop.click('.ant-modal .ant-modal-footer .ant-btn-primary');
  const exportedPath = join(output, 'exported.mp4');
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/lib/save-desktop-dialog.ps1'), '-AppProcessId', String(desktop.child.pid), '-OutputPath', exportedPath], { windowsHide: true, timeout: 60000 });
  await desktop.waitFor('!document.querySelector(".ant-modal .ant-radio-group")', 'export completed', 45000);
  assert.ok((await stat(exportedPath)).size > 1024);
  const exportedInfo = await probe(exportedPath);
  assert.ok(Math.abs(Number(exportedInfo.format.duration) - 9) < .2);
  assert.ok(exportedInfo.streams.some(s => s.codec_type === 'audio'));

  mark('import a canvas input and generate an image-to-video dependency');
  const canvasPath = join(root, 'fixture.canvas.json');
  await writeFile(canvasPath, JSON.stringify({ name: 'Release E2E canvas', nodes: [
    { id: 'fixture-image', name: 'Fixture image', kind: 'image', prompt: 'Ada raises her hand in the Studio.', x: 0, y: 0 },
    { id: 'fixture-video', name: 'Fixture video', kind: 'video', prompt: 'Ada says Hello and raises her hand.', x: 340, y: 0, generation: { durationSeconds: 5, controlMode: 'keyframe' } },
  ], edges: [{ id: 'fixture-edge', from: 'fixture-image', to: 'fixture-video' }], viewport: { x: 40, y: 40, zoom: .8 } }));
  await desktop.click('[data-testid=studio-nav-canvas]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-canvas]")', 'canvas page');
  await desktop.evaluate(studioReader);
  assert.equal((await desktop.evaluate('e2eReadStudio()')).state.assets.length, 0, 'isolated profile has no library assets');
  const doc = await desktop.call('DOM.getDocument');
  const input = await desktop.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.studio-canvas-toolbar input[type=file][accept=".json"]' });
  assert.ok(input.nodeId);
  await desktop.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [canvasPath] });
  await desktop.waitFor('document.querySelectorAll(".studio-canvas-node").length===2', 'UI canvas import');
  await desktop.textButton('全选节点', '.studio-canvas-toolbar');
  await desktop.textButton('生成选中 2 项', '.studio-canvas-toolbar');
  await desktop.waitFor('(async()=>{const s=(await e2eReadStudio()).state;return s.jobs.length===2&&s.jobs.every(j=>j.status==="completed");})()', 'dependent canvas jobs', 45000);
  const canvasState = (await desktop.evaluate('e2eReadStudio()')).state;
  studioAssets = canvasState.assets;
  assert.equal(studioAssets.length, 2);
  assert.ok(canvasState.canvases[0].nodes.every(n => n.assetId));
  assert.equal(videoCounter, 5);
  const graphRequest = requests.filter(r => r.method === 'POST' && r.path.endsWith('/v1/videos')).at(-1).body;
  assert.equal(graphRequest.mode, 'keyframe');
  assert.ok(graphRequest.first_frame.startsWith('data:image/'), 'upstream generated image reaches actual video HTTP payload');
  assert.ok(studioAssets.every(a => a.storage === 'disk'), 'canvas outputs saved through native IPC');
  const canvasVideo = studioAssets.find(a => a.kind === 'video');
  assert.deepEqual([canvasVideo.width, canvasVideo.height, canvasVideo.durationSeconds], [1280, 704, 5], 'library metadata comes from the actual saved file');
  assert.equal(canvasVideo.responseSnapshot.width, 640, 'keep the original provider metadata for comparison');
  await desktop.screenshot(join(output, '06-canvas.png'));

  mark('send generated canvas video back to a project shot');
  await desktop.nativeClick('[data-node-id=fixture-video] header');
  await desktop.waitFor('!!document.querySelector(".studio-canvas-inspector")', 'canvas output inspector');
  await desktop.textButton('发送到分镜', '.studio-canvas-inspector');
  await desktop.waitFor('!!document.querySelector(".studio-project-transfer")', 'shot transfer form');
  await desktop.choose('.studio-project-transfer [aria-label="选择项目"]', 'Release E2E - Ada');
  await desktop.choose('.studio-project-transfer [aria-label="选择镜头"]', `#1 ${paragraphs[0].slice(0, 50)}`);
  const oldVersionCount = (await project()).sceneSpec.shots[0].versionHistory.length;
  await desktop.click('.studio-project-transfer .ant-modal-footer .ant-btn-primary');
  await desktop.waitFor('!document.querySelector(".studio-project-transfer")', 'asset transfer completed');
  state = await project();
  assert.equal(state.sceneSpec.shots[0].versionHistory.length, oldVersionCount + 1);
  assert.equal(state.sceneSpec.shots[0].versionHistory[0].reviewStatus, 'unreviewed');
  assert.equal(resolve(diskPath(state.finalVideoUrl)), resolve(editedPath), 'comparison candidate retains the current final output');
  await desktop.click('[data-testid=studio-nav-assets]');
  const libraryVideo = `[data-testid=studio-assets] [data-asset-id="${studioAssets.find(a => a.kind === 'video').id}"] video`;
  await desktop.waitFor(`document.querySelector(${JSON.stringify(libraryVideo)})?.readyState>=1`, 'library disk video playback');
  assert.equal(await desktop.evaluate(`document.querySelector(${JSON.stringify(libraryVideo)}).duration`), 5);
  await desktop.screenshot(join(output, '07-library.png'));

  mark('restart real process and recover persisted production state');
  const snapshot = await project();
  assert.deepEqual(desktop.errors, []);
  await desktop.close(); desktop = await start();
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'restart navigation');
  await desktop.click('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'restart studio');
  await desktop.click('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector("[data-phase=timeline]")', 'persisted project');
  assert.deepEqual(await project(), snapshot, 'actual process restart preserves project, audits and paths');
  await desktop.click('[data-phase=timeline]');
  await desktop.waitFor('document.querySelector(".video-timeline-workspace video")?.readyState>=1', 'persisted final playback');
  assert.ok(Math.abs(await desktop.evaluate('document.querySelector(".video-timeline-workspace video").duration') - 9) < .2);
  await desktop.evaluate(studioReader);
  assert.deepEqual((await desktop.evaluate('e2eReadStudio()')).state.canvases, canvasState.canvases, 'canvas dependency outputs survive actual restart');
  await desktop.screenshot(join(output, '08-restarted.png'));

  mark('inspect and adopt a saved video larger than 2 MB through native IPC');
  await desktop.click('[data-testid=studio-nav-assets]');
  await desktop.textButton('发送到分镜', `[data-asset-id="${canvasVideo.id}"]`);
  await desktop.choose('.studio-project-transfer [aria-label="选择项目"]', 'Release E2E - Ada');
  await desktop.choose('.studio-project-transfer [aria-label="选择镜头"]', `#1 ${paragraphs[0].slice(0, 50)}`);
  await desktop.choose('.studio-project-transfer [aria-label="使用方式"]', '检查后进入正式审片');
  await desktop.click('.studio-project-transfer .ant-modal-footer .ant-btn-primary');
  await desktop.waitFor('!document.querySelector(".studio-project-transfer")', 'large real video inspection', 45000);
  const imported = (await project()).clips.find(c => c.shotId === state.sceneSpec.shots[0].id).importedVideo;
  assert.ok((await stat(diskPath(canvasVideo.url))).size > 2 * 1024 * 1024);
  assert.deepEqual([imported.width, imported.height, imported.durationSeconds], [1280, 704, 5]);
  assert.equal(imported.sha256, sha(await readFile(diskPath(canvasVideo.url))), 'import fingerprints the complete large file');
  assert.equal((await project()).finalVideoUrl, undefined, 'adoption invalidates the old final');
  await desktop.screenshot(join(output, '09-large-video-import.png'));
  assert.deepEqual(desktop.errors, []);

  mark('reopen and resume a project saved with the 0.3.5 stop state');
  stopped.currentStage = 'idle';
  stopped.stages.scene_image.progress = 0;
  await desktop.evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('mojing-video'));saved.state.projects[${JSON.stringify(projectId)}]=${JSON.stringify(stopped)};localStorage.setItem('mojing-video',JSON.stringify(saved));})()`);
  await desktop.close(); desktop = await start();
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'legacy restart navigation');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'legacy restart studio');
  await desktop.nativeClick('[data-testid=studio-nav-projects]');
  await desktop.waitFor('document.querySelector("[data-testid=video-overview-next-action-button]")?.textContent.includes("继续生成")', 'resume action on the legacy stop state');
  await desktop.nativeClick('[data-testid=video-overview-next-action-button]');
  await desktop.waitFor(`${projectExpression()}.stages.scene_image?.status==='completed'`, 'scene completed from the legacy stop state', 30000);
  assert.deepEqual((await project()).sceneSpec.characters, refsBeforeStop, 'upgrading the stopped project preserves character references');
  assert.deepEqual(desktop.errors, []);

  mark('produce a legacy multi-subject episode in one action');
  const technicalOnly = process.env.MOJING_E2E_AUTOMATIC_WITHOUT_VISION === '1';
  const legacy = await project();
  const [ada] = legacy.sceneSpec.characters;
  const secondSubject = {
    ...ada,
    id: 'second-subject',
    name: 'Bo',
    portraitImage: ada.turnaroundImage,
    turnaroundImage: ada.portraitImage,
    turnaroundSourcePortrait: ada.turnaroundImage,
  };
  const courtyard = legacy.sceneSpec.scenes[0];
  const uploadedFrame = courtyard.backgroundImage;
  legacy.sceneSpec = {
    ...legacy.sceneSpec,
    characters: [ada, secondSubject],
    shots: legacy.sceneSpec.shots.map((shot, index) => ({
      ...shot,
      transition: 'cut',
      characterIds: index === 0 ? [ada.id, secondSubject.id] : [ada.id],
      sourceText: undefined,
      imagePrompt: undefined,
      characterBinding: undefined,
      visibleCharacterIds: undefined,
      ...(index === 1 ? { manualReferenceImage: uploadedFrame } : {}),
    })),
  };
  if (technicalOnly) {
    const textOnlyConfig = { ...config, llm: { ...config.llm, defaultModel: 'text-fixture' } };
    const textOnlyEndpoints = endpoints.map(endpoint => endpoint.category === 'llm'
      ? { ...endpoint, models: ['text-fixture'] } : endpoint);
    legacy.options = { ...legacy.options, qualityProfile: 'draft', enableVisualQualityGate: false, blockOnVisualReviewUnavailable: false };
    await desktop.evaluate(`localStorage.setItem('mojing-providers',${JSON.stringify(JSON.stringify({
      state: { config: textOnlyConfig, endpoints: textOnlyEndpoints }, version: 0,
    }))})`);
  }
  await desktop.evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('mojing-video'));saved.state.projects[${JSON.stringify(projectId)}]=${JSON.stringify(legacy)};localStorage.setItem('mojing-video',JSON.stringify(saved));})()`);
  const seriesId = `${projectId}_series`;
  const otherId = `${projectId}_other`;
  await desktop.evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem('mojing-projects'));
    const episode = saved.state.projects.find(project => project.id === ${JSON.stringify(projectId)});
    episode.metadata = { ...episode.metadata, seriesRole: 'episode', seriesId: ${JSON.stringify(seriesId)} };
    saved.state.projects.push(
      { ...episode, id: ${JSON.stringify(seriesId)}, title: 'Release E2E Series', description: '', status: 'planning', metadata: { seriesRole: 'series' } },
      { ...episode, id: ${JSON.stringify(otherId)}, title: 'Another project', description: '', status: 'planning', metadata: {} },
    );
    localStorage.setItem('mojing-projects', JSON.stringify(saved));
  })()`);
  await desktop.close(); desktop = await start();
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'automatic production launch');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'automatic production studio');
  await desktop.nativeClick('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-automatic-production]")', 'one-click production action');
  await desktop.screenshot(join(output, '10-automatic-start.png'));
  const beforeAutomatic = requests.length;
  mark('show video queue retry in the series and project lists');
  videoQueueFull = 'all';
  await desktop.nativeClick('[data-testid=video-automatic-production]');
  const seriesCard = `.video-view-projects [data-project-id="${seriesId}"]`;
  const projectProgress = `${seriesCard} [data-testid=video-project-progress]`;
  const episodeProgress = '.video-view-content [data-testid=video-project-progress]';
  const readProgress = selector => `document.querySelector(${JSON.stringify(selector)})?.innerText`;
  const waitingOnProvider = (selector, completed = 0) => `(() => {
    const text = ${readProgress(selector)};
    return text?.includes('执行中') && text.includes('生成视频') && text.includes('视频 ${completed}/2 镜')
      && /服务队列已满 · \\d{2}:\\d{2}:\\d{2} 重试（1\\/1）/.test(text);
  })()`;
  await desktop.waitFor(waitingOnProvider(projectProgress), 'series card shows queue wait and video count', 90000);
  assert.match(await desktop.evaluate(readProgress(projectProgress)), /第\s*1\s*集/);
  await desktop.nativeClick(`.video-view-projects [data-project-id="${otherId}"]`);
  await desktop.waitFor('document.querySelector(".video-production-console-header")?.innerText.includes("Another project")', 'open a different short drama');
  assert.equal(await desktop.evaluate(waitingOnProvider(projectProgress)), true, 'the series status stays visible beside another project');
  await desktop.nativeClick(seriesCard);
  await desktop.waitFor(waitingOnProvider(episodeProgress), 'episode list shows progress without opening the episode');
  assert.equal(await desktop.evaluate('!!document.querySelector(".video-production-console")'), false);
  await desktop.screenshot(join(output, '10-series-queue-dark.png'));
  await desktop.nativeClick('.ws-titlebar-window-controls .ant-btn');
  await desktop.waitFor('document.documentElement.dataset.theme==="light"', 'series queue in light theme');
  await desktop.screenshot(join(output, '10-series-queue-light.png'));
  await desktop.waitFor(`${readProgress(episodeProgress)}?.includes("出错")`, 'terminal queue failure shown in series list', 40000);
  assert.match(await desktop.evaluate(readProgress(projectProgress)), /服务队列已满/);
  assert.doesNotMatch(await desktop.evaluate(readProgress(projectProgress)), /重试（/);
  assert.equal((await project()).stages.video_generation.queueRetry, undefined);
  const refused = requests.slice(beforeAutomatic).filter(item => item.method === 'POST' && item.path.endsWith('/v1/videos'));
  assert.equal(refused.length, 2, 'first submission and one automatic retry reached the model service');
  await desktop.screenshot(join(output, '10-series-queue-failed.png'));

  mark('open the failed episode from the live task list and restart during the second shot');
  const taskNavigation = '[data-testid=studio-nav-tasks]';
  const dramaTask = `[data-testid=studio-short-drama-tasks] [data-project-id="${projectId}"]`;
  const openDrama = `${dramaTask} [data-testid=studio-short-drama-open]`;
  const continueVideo = '[data-testid=video-automatic-production]';
  const taskStatus = readProgress(dramaTask);
  await desktop.nativeClick(taskNavigation);
  await desktop.waitFor(`${taskStatus}?.includes("服务队列已满")`, 'task list shows the episode and the queue failure');
  await desktop.nativeClick(openDrama);
  await desktop.waitFor(`${readProgress(continueVideo)}?.includes("继续生成成片")`, 'resume action on the failed episode');
  assert.match(await desktop.evaluate(readProgress('.video-command-center-hero-action')), /视频服务队列已满/);
  videoQueueFull = 'second';
  await desktop.nativeClick(continueVideo);
  await desktop.waitFor(waitingOnProvider(projectProgress, 1), 'first shot is saved while the second waits for the model', 90000);
  assert.equal(await desktop.evaluate(readProgress(`${taskNavigation} small`)), '1', 'the task navigation includes the live episode');
  await desktop.nativeClick(taskNavigation);
  await desktop.waitFor(waitingOnProvider(dramaTask, 1), 'task list updates with one saved shot');
  await desktop.screenshot(join(output, '11-task-second-shot-queued.png'));
  const checkpoint = await project();
  assert.equal(checkpoint.clips.length, 1);
  assert.equal(checkpoint.clips[0].shotVersionId, checkpoint.sceneSpec.shots[0].lockedVersionId);
  assert.equal(checkpoint.stages.tts.status, 'completed');
  assert.equal(checkpoint.stages.keyframe_image.status, 'completed');
  await desktop.evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem('mojing-providers'));
    saved.state.endpoints = saved.state.endpoints.map(endpoint => ['image', 'tts'].includes(endpoint.category)
      ? { ...endpoint, enabled: false } : endpoint);
    localStorage.setItem('mojing-providers', JSON.stringify(saved));
  })()`);
  await desktop.close();
  desktop = await start();
  await desktop.waitFor(`!!document.querySelector('button[aria-label="视频工坊"]')`, 'restart into the main window');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor(`!!document.querySelector(${JSON.stringify(taskNavigation)})`, 'task navigation after restart');
  await desktop.nativeClick(taskNavigation);
  await desktop.waitFor(`${taskStatus}?.includes("上次中断") && ${taskStatus}?.includes("视频 1/2 镜")`, 'interrupted stage and its saved progress survive restart');
  assert.doesNotMatch(await desktop.evaluate(taskStatus), /执行中|重试（/);
  assert.equal(await desktop.evaluate(`!!document.querySelector(${JSON.stringify(`${taskNavigation} small`)})`), false);
  await desktop.screenshot(join(output, '11-task-after-restart.png'));

  mark('resume into the missing shot with image and voice services unavailable');
  videoQueueFull = false;
  await desktop.nativeClick(openDrama);
  await desktop.waitFor(`${readProgress(continueVideo)}?.includes("继续生成成片")`, 'resume action on the interrupted episode');
  const beforeResume = requests.length;
  await desktop.nativeClick(continueVideo);
  await desktop.waitFor(`${projectExpression()}.currentStage==='complete'`, 'automatic production completes without an approval click', 150000);
  const automatic = await project();
  const resumedRequests = requests.slice(beforeResume);
  const newVideos = resumedRequests.filter(item => item.method === 'POST' && item.path.endsWith('/v1/videos'));
  assert.equal(newVideos.length, 1, 'only the missing shot is requested after restart');
  assert.match(newVideos[0].body.prompt, /Goodbye|lowers/i, 'the resumed request belongs to the second shot');
  assert.ok(resumedRequests.every(item => !item.path.endsWith('/images/generations') && !item.path.endsWith('/audio/speech')));
  const mediaInputs = state => state.sceneSpec.shots.map(shot => [shot.keyframeImage, shot.audioTrack]);
  assert.deepEqual(mediaInputs(automatic), mediaInputs(checkpoint), 'all first frames and voice tracks are unchanged');
  assert.equal(automatic.sceneSpec.shots[0].lockedVersionId, checkpoint.sceneSpec.shots[0].lockedVersionId);
  for (const shot of automatic.sceneSpec.shots) {
    const clip = automatic.clips.find(item => item.shotId === shot.id);
    assert.equal(clip.audioTrack, shot.audioTrack, 'merged output references the saved dialogue source');
    const voice = await probe(diskPath(shot.audioTrack));
    assert.deepEqual(voice.streams.map(stream => stream.codec_type), ['audio'], 'saved dialogue is independently playable');
  }
  assert.ok(automatic.sceneSpec.shots.every(shot => (
    shot.sourceText && shot.imagePrompt && shot.characterBinding === 'explicit' && shot.lockedVersionId
  )), 'legacy inputs are restored and every clip has a locked version');
  assert.equal(automatic.sceneSpec.shots[1].keyframeImage, uploadedFrame, 'the existing uploaded image is the actual second-shot keyframe');
  const automaticImages = requests.slice(beforeAutomatic).filter(item => item.path.endsWith('/images/generations'));
  assert.equal(automaticImages.length, 1, 'generate only the missing shot composition');
  assert.match(automaticImages[0].body.prompt, /input 2: character/);
  assert.equal(automatic.stages.video_review.inputSummary.automaticReviewMode, technicalOnly ? 'technical' : 'visual');
  if (technicalOnly) {
    assert.ok(automatic.clips.every(clip => !clip.visualReview && clip.qualityReview?.status !== 'failed'));
    assert.ok((await desktop.evaluate('document.querySelector(".video-command-center-hero-action").innerText')).includes('草稿成片已就绪'));
  } else {
    assert.ok(automatic.clips.every(clip => clip.visualReview?.status === 'passed'), 'every clip passed visual review');
  }
  const automaticOutput = diskPath(automatic.finalVideoUrl);
  await copyFile(automaticOutput, join(output, 'automatic-final.mp4'));
  assert.ok((await probe(automaticOutput)).streams.some(stream => stream.codec_type === 'audio'));
  const resumedDialogueRms = [await audible(automaticOutput, 0.1), await audible(automaticOutput, 5.2)];
  await desktop.screenshot(join(output, '12-automatic-complete.png'));
  assert.deepEqual(desktop.errors, []);
  assert.deepEqual(serverErrors, []);
  report = { result: 'passed', version, executable, executableSHA256: sha(await readFile(executable)), boundary: 'Remote model and visual-review responses are simulated by a local HTTP service. UI, provider adapters, Tauri HTTP/IPC, disk, FFmpeg, playback, native Save dialog and process restart are real.', projectId, steps, originalInfo, editedInfo, exportedInfo, originalColors, editedColors, previewColor, audioRms, layoutChecks, canvas: { jobs: canvasState.jobs.length, diskAssets: studioAssets.length, referenceTransport: graphRequest.mode, shotTransfer: true }, requestCounts: Object.fromEntries([...new Set(requests.map(r => r.path))].map(path => [path, requests.filter(r => r.path === path).length])), videoPayloads: submitted.map(({ body }) => ({ ...body, first_frame: `sha256:${sha(body.first_frame)}` })), output };
  report.resume = {
    clipsBeforeRestart: checkpoint.clips.length,
    videoRequestsAfterRestart: newVideos.length,
    imageRequestsAfterRestart: 0,
    ttsRequestsAfterRestart: 0,
    savedFirstFramesAndVoiceTracks: mediaInputs(checkpoint).length,
    retainedFirstShotVersion: checkpoint.sceneSpec.shots[0].lockedVersionId,
    dialogueRmsInFinalVideo: resumedDialogueRms,
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report = { result: 'failed', version, step: currentStep, error: String(error), serverErrors, steps, output };
  if (desktop) {
    await desktop.screenshot(join(output, 'failure.png')).catch(() => {});
    await writeFile(join(output, 'diagnostic.json'), JSON.stringify({ text: await desktop.evaluate('document.body.innerText').catch(() => ''), project: projectId ? await project().catch(() => null) : null, console: desktop.consoleMessages, errors: desktop.errors, serverErrors, requestTasks: requests.map(r => ({ path: r.path, system: r.body?.messages?.find(m => m.role === 'system')?.content, prompt: r.body?.prompt?.slice(0, 1000) })) }, null, 2));
  }
  throw error;
} finally {
  for (const release of [...releasePlanResponses, ...releaseSceneResponses]) release?.();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (desktop) {
    studioAssets = (await desktop.evaluate('window.e2eReadStudio?.()').catch(() => null))?.state?.assets ?? studioAssets;
    await desktop.close();
  }
  await new Promise(resolve => server.close(resolve));
  // Delete only the two native directories belonging to this UI-created fixture project.
  if (appData && projectId) for (const kind of ['video-assets', 'video-cache']) {
    const owned = resolve(appData, kind, projectId);
    assert.equal(dirname(owned), resolve(appData, kind)); assert.equal(basename(owned), projectId);
    await rm(owned, { recursive: true, force: true });
  }
  for (const asset of studioAssets.filter(a => a.jobId && a.storage === 'disk' && a.url)) {
    const path = resolve(diskPath(asset.url)), kind = asset.kind === 'video' ? 'clip' : 'keyframe';
    assert.equal(dirname(path), resolve(appData, 'video-assets', 'studio-library', kind));
    assert.match(basename(path), /^(clip|keyframe)_[a-z0-9]+_[a-z0-9]+\.(mp4|png)$/);
    await rm(path, { force: true });
  }
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('mojing-release-e2e-'));
  for (let i = 0; i < 20; i++) { try { await rm(root, { recursive: true, force: true }); break; } catch (error) { if (i === 19) throw error; await delay(300); } }
}

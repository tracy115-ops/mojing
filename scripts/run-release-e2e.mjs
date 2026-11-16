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
const output = resolve('artifacts', `release-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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
  videoFixtures.push(await readFile(path));
}
const audioPath = join(root, 'voice.mp3');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=1', '-c:a', 'libmp3lame', audioPath], { windowsHide: true });
const audio = await readFile(audioPath);
const png = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: '#467aa8' } }).composite([{ input: Buffer.from('<svg width="2048" height="1152"><circle cx="1024" cy="420" r="150" fill="#f0d0b0"/><rect x="820" y="570" width="408" height="480" rx="80" fill="#123c78"/><path d="M0 1100H2048M100 0V1152M1948 0V1152" stroke="#ddd" stroke-width="30"/></svg>') }]).png().toBuffer();
let videoCounter = 0;
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
    } else if (url.pathname.endsWith('/images/generations')) data = { data: [{ b64_json: png.toString('base64') }] };
    else if (request.method === 'POST' && url.pathname.endsWith('/v1/videos')) {
      const id = `video_release_${++videoCounter}`;
      tasks.set(id, { index: /Goodbye|lowers/i.test(body.prompt) ? 1 : 0, seconds: body.seconds });
      data = { video_id: id };
    } else if (url.pathname === '/agnesapi') {
      const task = tasks.get(url.searchParams.get('video_id')); assert.ok(task, 'known video task');
      data = { status: 'completed', progress: 100, seconds: task.seconds, width: 1280, height: 704, url: `http://${request.headers.host}/media/shot-${task.index}.mp4` };
    } else if (url.pathname.endsWith('/chat/completions')) {
      const system = body.messages.find(m => m.role === 'system')?.content || '';
      const user = body.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')).join('\n');
      let content;
      if (system.includes('source-preserving shot segmentation')) {
        const input = JSON.parse(user), chapter = input.chapters[0];
        content = paragraphs.map((sourceText, index) => ({ index, sourceChapterId: chapter.id, sourceChapterNumber: chapter.number, sourceText, visibleCharacters: ['Ada'], offscreenCharacters: [], location: 'Studio', mood: 'calm', hasDialogue: true, hasAction: true }));
      } else if (system.includes('Return only a JSON array with exactly one object per input segment')) {
        const indices = [...user.matchAll(/source=(.*)/g)].map(match => /Goodbye/.test(match[1]) ? 1 : 0);
        content = indices.map(index => ({ videoPrompt: paragraphs[index], imagePrompt: `Medium shot in the Studio. ${index ? 'Ada smiles with her right hand lowered. Goodbye.' : 'Ada holds her right hand up. Hello.'} Soft light, static camera.`, narration: index ? 'Goodbye.' : 'Hello.', dialogue: [{ speaker: 'Ada', text: index ? 'Goodbye.' : 'Hello.' }], visibleCharacters: ['Ada'], offscreenCharacters: [], characters: ['Ada'], location: 'Studio', mood: 'calm', cameraMovement: 'static', transition: 'cut', durationSeconds: 5, startState: index ? 'Hand raised.' : 'Hand lowered.', endState: index ? 'Hand lowered.' : 'Hand raised.' }));
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
  video: { primary: 'agnes-video', endpointId: 'fixture-video', defaultModel: 'agnes-video-2.5-flash', models: { clip: '', transition: '', 'full-scene': '', 'lip-sync': '', effects: '' }, defaultResolution: '1280x704', defaultFps: 24 },
  tts: { primary: 'openai-tts', endpointId: 'fixture-tts', defaultModel: 'tts-1', defaultVoice: 'alloy', defaultFormat: 'mp3', defaultSpeed: 1 },
};
const endpoints = [['llm', 'openai', 'gpt-4o-mini'], ['image', 'agnes-image', 'agnes-image-2.1-flash'], ['video', 'agnes-video', 'agnes-video-2.5-flash'], ['tts', 'openai-tts', 'tts-1']].map(([category, provider, model]) => ({ id: `fixture-${category}`, name: `E2E ${category}`, category, provider, baseUrl: modelOrigin, apiKey: 'local-fixture-only', models: [model], enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
const projectExpression = () => `JSON.parse(localStorage.getItem('mojing-video')).state.projects[${JSON.stringify(projectId)}]`;
const project = () => desktop.evaluate(projectExpression());
const start = () => desktopSession({ executable, profile: join(root, 'webview'), allowedOrigins: [modelOrigin] });
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
  await desktop.click('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'studio navigation');
  await desktop.click('[data-testid=studio-nav-projects]');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-new-video]")', 'projects page');
  await desktop.click('[data-testid=video-new-video]');
  await desktop.waitFor('!!document.querySelector(".video-create-episode-modal #title")', 'new project form');
  await desktop.fill('.video-create-episode-modal #title', 'Release E2E - Ada');
  await desktop.fill('.video-create-episode-modal #scriptText', paragraphs.join('\n\n'));
  await desktop.click('.video-create-episode-modal .ant-modal-footer .ant-btn-primary');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-overview-next-action-button]")', 'draft overview');
  projectId = await desktop.evaluate("JSON.parse(localStorage.getItem('mojing-video')).state.activePipelineId");
  assert.match(projectId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(requests.length, 0, 'new project is local and makes no model call');

  mark('plan script and stop for human approval');
  await desktop.click('[data-testid=video-overview-next-action-button]');
  await desktop.waitFor(`${projectExpression()}.stages.extraction?.status==='awaiting_review'`, 'planning review checkpoint', 45000);
  assert.equal((await project()).sceneSpec.shots.length, 2);
  assert.equal(requests.filter(r => r.path.endsWith('/images/generations')).length, 0, 'planning approval blocks paid image calls');
  await desktop.screenshot(join(output, '01-planning.png'));

  mark('approve planning and generate character, scene and keyframes');
  await desktop.click('[data-testid=video-approve-planning]');
  await desktop.waitFor(`${projectExpression()}.stages.video_generation?.status==='awaiting_review'`, 'keyframe checkpoint', 90000);
  let state = await project();
  assert.equal(state.stages.keyframe_image.status, 'completed');
  assert.ok(state.sceneSpec.characters[0].portraitImage && state.sceneSpec.scenes[0].backgroundImage);
  assert.ok(state.sceneSpec.shots.every(s => s.keyframeImage && s.versionHistory.filter(v => v.type === 'image').length === 2));
  assert.equal(videoCounter, 0, 'unreviewed keyframes block video calls');
  await desktop.click('[data-phase=studio]');
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

  mark('resume voice assignment, TTS and video candidates through UI');
  await desktop.click('button[aria-label="生产链路"]');
  await desktop.click('[data-testid=video-overview-next-action-button]');
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
  assert.equal(resolve(dirname(finalPath)), resolve(join(appData, 'video-cache', projectId)));
  await copyFile(finalPath, join(output, 'final-original.mp4'));
  const originalInfo = await probe(finalPath);
  const originalVideo = originalInfo.streams.find(s => s.codec_type === 'video');
  assert.deepEqual([originalVideo.codec_name, originalVideo.width, originalVideo.height, originalVideo.nb_read_frames], ['h264', 1280, 704, '240']);
  assert.ok(originalInfo.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'), 'final MP4 contains actual audio');
  assert.ok(Math.abs(Number(originalInfo.format.duration) - 10) < .2);
  const originalColors = await Promise.all([averageFrame(finalPath, 1), averageFrame(finalPath, 6)]);
  assert.ok(originalColors[0][0] > originalColors[0][2] + 30, 'first shot is red');
  assert.ok(originalColors[1][2] > originalColors[1][0] + 30, 'second shot is blue');
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
  assert.equal((await project()).stages.composing.status, 'completed');
  const editedInfo = await probe(finalPath);
  assert.ok(Math.abs(Number(editedInfo.format.duration) - 9) < .2);
  const editedColors = await Promise.all([averageFrame(finalPath, 1), averageFrame(finalPath, 5)]);
  assert.ok(editedColors[0][2] > editedColors[0][0] + 30, 'edited first shot is blue');
  assert.ok(editedColors[1][0] > editedColors[1][2] + 30, 'edited second shot is red');
  await copyFile(finalPath, join(output, 'final-edited.mp4'));
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
  await desktop.waitFor('!document.querySelector(".ant-message-notice")', 'transient composition messages clear', 10000);
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
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/lib/save-desktop-dialog.ps1'), '-AppProcessId', String(desktop.child.pid), '-OutputPath', exportedPath], { windowsHide: true, timeout: 30000 });
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
  assert.equal(state.finalVideoUrl, finalPath, 'comparison candidate retains the current final output');
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
  assert.deepEqual(desktop.errors, []);
  assert.deepEqual(serverErrors, []);
  report = { result: 'passed', version, executable, executableSHA256: sha(await readFile(executable)), boundary: 'Remote model and visual-review responses are simulated by a local HTTP service. UI, provider adapters, Tauri HTTP/IPC, disk, FFmpeg, playback, native Save dialog and process restart are real.', projectId, steps, originalInfo, editedInfo, exportedInfo, originalColors, editedColors, previewColor, audioRms, layoutChecks, canvas: { jobs: canvasState.jobs.length, diskAssets: studioAssets.length, referenceTransport: graphRequest.mode, shotTransfer: true }, requestCounts: Object.fromEntries([...new Set(requests.map(r => r.path))].map(path => [path, requests.filter(r => r.path === path).length])), videoPayloads: submitted.map(({ body }) => ({ ...body, first_frame: `sha256:${sha(body.first_frame)}` })), output };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report = { result: 'failed', version, step: currentStep, error: String(error), serverErrors, steps, output };
  if (desktop) {
    await desktop.screenshot(join(output, 'failure.png')).catch(() => {});
    await writeFile(join(output, 'diagnostic.json'), JSON.stringify({ text: await desktop.evaluate('document.body.innerText').catch(() => ''), project: projectId ? await project().catch(() => null) : null, console: desktop.consoleMessages, errors: desktop.errors, serverErrors, requestTasks: requests.map(r => ({ path: r.path, system: r.body?.messages?.find(m => m.role === 'system')?.content, prompt: r.body?.prompt?.slice(0, 1000) })) }, null, 2));
  }
  throw error;
} finally {
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

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopSession, delay } from './lib/desktop-session.mjs';

const executable = resolve(process.argv[2] || 'src-tauri/target/release/mojing.exe');
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = process.env.MOJING_E2E_ARTIFACT_DIR || resolve('artifacts', 'application-desktop-e2e-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'mojing-app-acceptance-'));
const audio = Buffer.alloc(44 + 32000);
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(32000, 40);
for (let i = 0; i < 16000; i++) audio.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 9000), 44 + 2 * i);
const requests = [], serverErrors = [], steps = [], runtimeErrors = [], pages = [];
let failMusic = true, desktop, baseUrl;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/track.wav') { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length }).end(audio); return; }
    assert.equal(request.url, '/v1/audio/music'); assert.equal(request.method, 'POST');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(failMusic ? 503 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(failMusic ? { error: 'fixture failure' } : { id: 'desktop-music-fixture', title: 'Desktop fixture music', audio_url: baseUrl + '/track.wav', duration: 2 }));
  } catch (error) { serverErrors.push(String(error)); response.writeHead(500).end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
baseUrl = 'http://127.0.0.1:' + server.address().port;
const start = () => desktopSession({ executable, profile, allowedOrigins: [baseUrl], softwareRendering: false });
const mark = message => { steps.push(message); console.log(message); };
const state = key => desktop.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))?.state`);
const type = async (selector, chunks) => {
  await desktop.nativeClick(selector);
  for (const text of chunks) await desktop.call('Input.insertText', { text });
};
const newProject = async (label, formSelector) => {
  await desktop.nativeClick('.ws-titlebar-project-actions button[aria-label="新建"]');
  const menuItem = `[...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) [role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.getBoundingClientRect().width>0)`;
  await desktop.waitFor(`!!(${menuItem})`, 'new project menu');
  await delay(300);
  const index = await desktop.evaluate(`Array.from((${menuItem}).parentElement.children).indexOf(${menuItem})`);
  await desktop.nativeClick(`.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu > [role=menuitem]:nth-child(${index + 1})`);
  await desktop.waitFor(`!!document.querySelector(${JSON.stringify(formSelector)})`, 'requested form after changing workshop: ' + label);
};
try {
  desktop = await start();
  assert.equal(await desktop.evaluate('window.__TAURI__.app.getVersion()'), version);
  await desktop.waitFor('[...document.querySelectorAll("button")].some(el=>el.textContent.replace(/\\s/g,"")==="新建小说")', 'novel view');
  await desktop.nativeClick('button[aria-label="音乐工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=music-workspace]")', 'music home');
  await newProject('小说引擎', '.ant-modal #title');
  await desktop.fill('.ant-modal #title', 'Desktop acceptance novel');
  for (let index = 1; index < 5; index++) {
    await delay(200);
    await desktop.nativeTextButton('下一步', '.ant-modal');
    await desktop.waitFor(`[...document.querySelectorAll('.ant-steps-item')].findIndex(el=>el.classList.contains('ant-steps-item-process'))===${index}`, 'wizard step');
  }
  await desktop.nativeTextButton('完成创建', '.ant-modal'); await desktop.waitFor('!document.querySelector(".ant-modal")', 'novel created');
  await desktop.nativeTextButton('添加章节'); await desktop.waitFor(`!!document.querySelector('textarea[placeholder="章节大纲..."]')`, 'chapter');
  await type('textarea[placeholder="章节大纲..."]', ['真实桌面', '连续输入']);
  assert.equal(await desktop.evaluate(`document.querySelector('textarea[placeholder="章节大纲..."]').value`), '真实桌面连续输入');
  await desktop.nativeTextButton('添加章节');
  await desktop.waitFor(`JSON.parse(localStorage.getItem('mojing-projects')).state.projects[0].metadata.chapters.length===2`, 'second chapter');
  assert.equal((await state('mojing-projects')).projects[0].metadata.chapters[0].outline, '真实桌面连续输入');
  await desktop.nativeClick('[role=tab][id$="-tab-content"]'); await desktop.waitFor(`!!document.querySelector('textarea[placeholder="章节正文..."]')`, 'content');
  await type('textarea[placeholder="章节正文..."]', ['雨停了。', '她推开窗。']);
  await newProject('漫画工坊', '.ant-modal #theme');
  assert.equal((await state('mojing-projects')).projects[0].metadata.chapters[1].content, '雨停了。她推开窗。');
  mark('Packaged novel: immediate typing, draft flush on chapter/view change and saved chapter isolation passed.');

  await desktop.fill('.ant-modal #title', 'Desktop acceptance comic'); await desktop.fill('.ant-modal #theme', 'An adult waits at a station.'); await desktop.nativeClick('.ant-modal-footer .ant-btn-primary');
  await desktop.waitFor('!document.querySelector(".ant-modal")', 'comic created');
  assert.equal(Object.values((await state('mojing-comic-store')).projects)[0].sourceText, 'An adult waits at a station.');
  mark('Packaged comic: normal project creation and persisted source passed.');

  await desktop.nativeClick('button[aria-label="设置"]');
  for (const tab of ['general', 'appearance', 'network', 'creative', 'providers', 'storage']) {
    const selector = `.ant-modal [role=tab][id$="-tab-${tab}"]`;
    await desktop.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 'settings tab ' + tab);
    await desktop.nativeClick(selector);
    const panel = `.ant-modal [role=tabpanel][id$="-panel-${tab}"]`;
    await desktop.waitFor(`document.querySelector(${JSON.stringify(panel)})?.innerText.trim().length>0`, 'settings content ' + tab);
    if (tab === 'network') assert.equal(await desktop.evaluate(`document.querySelector(${JSON.stringify(panel + ' [role=switch]')})?.getAttribute('aria-checked')`), 'false', 'proxy is disabled in the fresh profile');
    await desktop.screenshot(join(output, 'settings-' + tab + '.png'));
    pages.push({ view: 'settings', page: tab });
  }
  await desktop.nativeClick('.ant-modal .ant-modal-close');
  await desktop.waitFor('!document.querySelector(".ant-modal")', 'settings closed');

  await desktop.evaluate('window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(900,600))');
  await desktop.waitFor('innerWidth===900&&innerHeight===600', 'small desktop layout');
  await desktop.nativeClick('button[aria-label="视频工坊"]');
  await desktop.waitFor('!!document.querySelector("[data-testid=video-studio-workspace]")', 'video studio home');
  const studioPages = {
    home: '[data-testid=studio-creator]', projects: '.video-view-shell', canvas: '[data-testid=studio-canvas]',
    world: '[data-testid=studio-world]', image: '[data-testid=studio-creator]', video: '[data-testid=studio-creator]',
    commerce: '[data-testid=studio-commerce]', assets: '[data-testid=studio-assets]', tasks: '[data-testid=studio-tasks]',
    skills: '[data-testid=studio-skills]', plugins: '[data-testid=studio-plugins]',
  };
  for (const [page, selector] of Object.entries(studioPages)) {
    const nav = `[data-testid=studio-nav-${page}]`;
    assert.ok(await desktop.evaluate(`document.querySelector(${JSON.stringify(nav + ' > span:not(.anticon)')})?.getBoundingClientRect().width>0`), page + ' has a readable sidebar label');
    await desktop.nativeClick(nav);
    await desktop.waitFor(`!!document.querySelector(${JSON.stringify('.video-studio-main.is-' + page + ' ' + selector)})`, 'video studio page ' + page);
    assert.equal(await desktop.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'shell stays within window');
    pages.push({ view: 'video', page });
    await desktop.screenshot(join(output, 'studio-' + page + '.png'));
  }
  mark('Opened six settings tabs and all eleven Studio pages with unobstructed pointer input, checking rendered content and readable sidebar labels at 900 × 600.');
  await desktop.evaluate('window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(1280,800))');
  await desktop.waitFor('innerWidth===1280&&innerHeight===800', 'normal desktop layout');
  await desktop.nativeClick('button[aria-label="音乐工坊"]'); await desktop.waitFor('!!document.querySelector("[data-testid=music-workspace]")', 'music view');
  await desktop.fill('[data-testid=music-prompt]', 'A quiet piano theme'); await desktop.click('[data-testid=music-endpoint-open]'); await desktop.waitFor('!!document.querySelector(".music-endpoint-modal #baseUrl")', 'music settings');
  await desktop.fill('.music-endpoint-modal #baseUrl', baseUrl + '/v1'); await desktop.click('.music-endpoint-modal .ant-modal-footer .ant-btn-primary'); await desktop.waitFor('!document.querySelector(".music-endpoint-modal")', 'endpoint saved');
  await desktop.click('[data-testid=music-generate]'); await desktop.waitFor('document.querySelector(".ant-message")?.textContent.includes("未添加作品")', 'native HTTP failure');
  assert.equal((await state('mojing-music-store'))?.tracks.length || 0, 0);
  failMusic = false; await desktop.click('[data-testid=music-generate]'); await desktop.waitFor('document.querySelectorAll("[data-testid=music-track]").length===1', 'native HTTP success');
  assert.equal(requests.length, 2); assert.equal(requests[1].prompt, 'A quiet piano theme');
  await desktop.waitFor('document.querySelector("audio")?.readyState>=2', 'real audio decoded'); assert.equal(await desktop.evaluate('document.querySelector("audio").duration'), 2);
  await desktop.call('Runtime.evaluate', { expression: 'document.querySelector("audio").play()', awaitPromise: true, userGesture: true });
  await desktop.waitFor('document.querySelector("audio").currentTime>.1', 'audio playback'); await desktop.evaluate('document.querySelector("audio").pause()');
  await desktop.screenshot(join(output, 'packaged-music.png'));
  mark('Packaged music: real Tauri HTTP error/success, no fake track, actual WAV decoding and playback passed. Remote service simulated.');

  runtimeErrors.push(...desktop.errors); await desktop.close(); desktop = await start();
  await desktop.waitFor('!!document.querySelector(\'button[aria-label="音乐工坊"]\')', 'restarted shell');
  const novel = (await state('mojing-projects')).projects[0], comic = Object.values((await state('mojing-comic-store')).projects)[0];
  assert.equal(novel.metadata.chapters[0].outline, '真实桌面连续输入'); assert.equal(novel.metadata.chapters[1].content, '雨停了。她推开窗。'); assert.equal(comic.title, 'Desktop acceptance comic');
  await desktop.click('button[aria-label="音乐工坊"]'); await desktop.waitFor('document.querySelectorAll("[data-testid=music-track]").length===1', 'track survived process restart');
  await desktop.waitFor('document.querySelector("audio")?.readyState>=2', 'restored audio decoded'); assert.equal((await state('mojing-music-store')).isPlaying, undefined, 'transient play state must not be persisted');
  await desktop.screenshot(join(output, 'packaged-restarted.png'));
  await desktop.click('[data-testid=music-track] button.ant-btn-dangerous'); await desktop.waitFor('!document.querySelector("[data-testid=music-track]")', 'track deletion');
  assert.equal((await state('mojing-music-store')).tracks.length, 0);
  runtimeErrors.push(...desktop.errors); assert.deepEqual(runtimeErrors, []); assert.deepEqual(serverErrors, []);
  mark('Full process restart: novel/comic/music persist, audio reopens and deletion updates saved data. No source imports or IPC stubs.');
  const report = { result: 'passed', desktopVersion: version, executableSHA256: createHash('sha256').update(await readFile(executable)).digest('hex'), steps, pages, musicRequests: requests.length, nativeIPC: true, playback: true, processRestart: true, boundary: 'Only the remote music HTTP service is simulated. Music remains a provider URL; offline retention is outside this test.', output };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await desktop?.screenshot(join(output, 'failure.png')).catch(() => undefined);
  await writeFile(join(output, 'report.json'), JSON.stringify({ result: 'failed', error: String(error), steps, pages, runtimeErrors: desktop?.errors, serverErrors }, null, 2)); throw error;
} finally { await desktop?.close(); await new Promise(resolveClose => server.close(resolveClose)); }

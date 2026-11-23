import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopSession } from './lib/desktop-session.mjs';

// Usage: node scripts/run-novel-workbench-desktop-e2e.mjs <release.exe> <reading-project.json>
// Input contains the documented project and narrative data only, never providers.

const run = promisify(execFile);
const executable = resolve(process.argv[2]);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const input = JSON.parse(await readFile(process.argv[3], 'utf8'));
const output = resolve('artifacts', 'novel-workbench-native-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'mojing-workbench-native-'));
const chapters = input.project.metadata.storyNodes.filter(n => n.nodeType === 'chapter').sort((a, b) => a.order - b.order);
const manuscript = chapters.filter(c => c.content.trim());
const narrative = input.narrative;
const steps = [], exported = [], pages = [];
let app, report = { result: 'running', version, executable, profile, mode: 'native-restoration', boundary: 'Exact release executable and real IPC. Restore documented live-service prose as input; no model providers, generated-output replacement, application-module imports or IPC stubs. Native export uses the OS save dialog.' };
const start = () => desktopSession({ executable, profile, softwareRendering: false });
const keypress = async key => { await app.call('Input.dispatchKeyEvent', { type: 'keyDown', key }); await app.call('Input.dispatchKeyEvent', { type: 'keyUp', key }); };
const snapshot = () => app.evaluate(`(()=>{const project=JSON.parse(localStorage.getItem('mojing-projects')).state.projects.find(p=>p.id===${JSON.stringify(input.project.id)});const narrative=Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('mojing-narrative:'+project.id+':')).sort().map(k=>[k,localStorage.getItem(k)]));return{project,narrative,providerConfigurationPresent:!!localStorage.getItem('mojing-providers')}})()`);
try {
  app = await start();
  await app.waitFor('!!document.querySelector(".ws-titlebar")', 'app');
  await app.evaluate(`localStorage.setItem('mojing-projects',${JSON.stringify(JSON.stringify({ state: { projects: [input.project], activeProjectId: input.project.id }, version: 0 }))}); for(const [k,v]of Object.entries(${JSON.stringify(narrative)}))localStorage.setItem(k,typeof v==='string'?v:JSON.stringify(v));`);
  const oldLoader = (await app.call('Page.getFrameTree')).frameTree.frame.loaderId;
  await app.call('Page.reload');
  const reloadDeadline = Date.now() + 30000;
  while ((await app.call('Page.getFrameTree')).frameTree.frame.loaderId === oldLoader) {
    if (Date.now() > reloadDeadline) throw new Error('Reload did not navigate');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await app.waitFor(`!!document.querySelector('button[aria-label="小说引擎"]')`, 'restored app');
  await app.nativeClick('button[aria-label="小说引擎"]');
  await app.waitFor('!!document.querySelector("[data-testid=novel-workbench-toggle]")', 'workbench entry');
  if (await app.evaluate('document.querySelector("[data-testid=novel-workbench-toggle]").getAttribute("aria-expanded")==="false"')) {
    await app.nativeClick('[data-testid=novel-workbench-toggle]');
  }
  await app.waitFor('!!document.querySelector("[data-testid=narrative-dashboard]")', 'workbench');
  assert.equal(await app.evaluate('window.__TAURI__.app.getVersion()'), version);
  const pane = '.narrative-workbench-tabs > .ant-tabs-content-holder > .ant-tabs-content > .ant-tabs-tabpane-active';
  for (const category of ['overview', 'characters', 'plot', 'quality', 'tools']) {
    await app.nativeClick(`[data-workbench-category="${category}"]`);
    const tabs = await app.evaluate(`[...document.querySelectorAll('.narrative-workbench-tabs > .ant-tabs-nav [role=tab]')].map(e=>({id:e.id,label:e.innerText}))`);
    for (const tab of tabs) {
      await app.nativeClick('[id=' + JSON.stringify(tab.id) + ']');
      await app.waitFor(`document.querySelector(${JSON.stringify(pane)})?.id===${JSON.stringify(tab.id.replace('-tab-', '-panel-'))}`, 'selected workbench data panel');
      const text = await app.evaluate(`document.querySelector(${JSON.stringify(pane)}).innerText`);
      assert.ok(text.trim(), 'selected workbench panel has content or its own empty-state message');
      if (category === 'plot' && tab.id.endsWith('-tab-storyline') && narrative['mojing-narrative:' + input.project.id + ':plot-outline']) {
        const saved = narrative['mojing-narrative:' + input.project.id + ':plot-outline'];
        const plan = typeof saved === 'string' ? JSON.parse(saved) : saved;
        await app.waitFor(`!!document.querySelector('[data-testid="story-plan-overview"]')`, 'saved plot overview');
        await app.evaluate(`[...document.querySelectorAll('[data-testid="story-plan-overview"] .ant-collapse-header')].find(e=>e.textContent.includes('阶段与关键事件')).click()`);
        await app.evaluate(`[...document.querySelectorAll('[data-testid="story-plan-overview"] .ant-collapse-header')].find(e=>e.textContent.includes('结局')).click()`);
        await app.waitFor(`document.querySelector('[data-testid="story-plan-overview"]').innerText.includes(${JSON.stringify(plan.ending)})`, 'complete ending in saved plan');
        const visible = await app.evaluate(`document.querySelector('[data-testid="story-plan-overview"]').innerText`);
        for (const value of [plan.mainPlot, plan.ending, ...plan.stages.flatMap(s => [s.description, s.coreEvent])]) assert.ok(visible.includes(value), 'every saved stage and ending is readable in the real panel');
      }
      const name = category + '-' + tab.id.split('-tab-').at(-1);
      await writeFile(join(output, name + '.txt'), text);
      await app.screenshot(join(output, name + '.png'));
      pages.push({ category, label: tab.label });
    }
  }
  assert.equal(pages.length, 14); steps.push('All 14 retained workbench pages render in the actual executable with real saved novel data.');
  await app.nativeTextButton('阅读模式');
  await app.waitFor('!!document.querySelector("h2")', 'reader');
  for (let i = 0; i < manuscript.length; i++) await keypress('ArrowLeft');
  for (let i = 0; i < manuscript.length; i++) {
    await app.waitFor(`document.querySelector('h2')?.textContent===${JSON.stringify(manuscript[i].title)}`, 'chapter in reader');
    const paragraphs = await app.evaluate(`[...document.querySelector('h2').parentElement.querySelectorAll(':scope > p')].map(e=>e.textContent.trim())`);
    assert.deepEqual(paragraphs, manuscript[i].content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean));
    await app.screenshot(join(output, 'reader-chapter-' + (i + 1) + '.png'));
    if (i + 1 < manuscript.length) await keypress('ArrowRight');
  }
  steps.push('Every reader paragraph and chapter transition matches the saved manuscript, including the final chapter.');
  await keypress('Escape');
  for (const [format, extension] of [['markdown', 'md'], ['html', 'html'], ['txt', 'txt']]) {
    await app.nativeTextButton('导出');
    await app.waitFor(`!!document.querySelector('input[type=radio][value="${format}"]')`, 'export form');
    await app.nativeClick(`label:has(input[type=radio][value="${format}"])`);
    await app.nativeClick('button.ant-btn-primary:has(.anticon-download)');
    const path = join(output, 'reading-sample.' + extension);
    const dialog = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('scripts/lib/save-desktop-dialog.ps1'), '-AppProcessId', String(app.child.pid), '-OutputPath', path], { windowsHide: true, timeout: 60000 });
    await app.waitFor('!document.querySelector("input[type=radio][value=markdown]")', 'export complete');
    const text = await readFile(path, 'utf8');
    if (format === 'html') {
      const exportedChapters = await app.evaluate(`(()=>{const dom=new DOMParser().parseFromString(${JSON.stringify(text)},'text/html');return [...dom.querySelectorAll('h2[id^="ch"]')].map(h=>{const paragraphs=[];for(let p=h.nextElementSibling;p&&p.tagName!=='H2';p=p.nextElementSibling)if(p.tagName==='P')paragraphs.push(p.textContent.trim());return{id:h.id,title:h.textContent,paragraphs}})})()`);
      assert.equal(exportedChapters.length, manuscript.length);
      for (let i = 0; i < manuscript.length; i++) {
        assert.equal(exportedChapters[i].id, 'ch' + manuscript[i].order);
        assert.deepEqual(exportedChapters[i].paragraphs, manuscript[i].content.split(/\n+/).map(p => p.trim()).filter(Boolean));
      }
    } else {
      let cursor = 0;
      for (const chapter of manuscript) { const index = text.indexOf(chapter.content, cursor); assert.ok(index >= cursor, 'export retains complete chapter in order'); cursor = index + chapter.content.length; }
    }
    exported.push({ format, path, bytes: Buffer.byteLength(text), nativeDialog: dialog.stdout.trim() });
  }
  steps.push('Markdown, HTML and TXT export through actual native dialogs and Rust file writing, with complete manuscript text.');
  const before = await snapshot(), firstPid = app.child.pid;
  await app.close(); app = undefined;
  app = await start();
  await app.waitFor(`!!document.querySelector('button[aria-label="小说引擎"]')`, 'restart ready');
  await app.nativeClick('button[aria-label="小说引擎"]');
  await app.waitFor(`!!document.querySelector('textarea[placeholder="章节正文..."]')`, 'restored prose editor');
  const after = await snapshot();
  assert.deepEqual(after, before); assert.equal(after.providerConfigurationPresent, false); assert.notEqual(app.child.pid, firstPid);
  const body = await app.evaluate(`document.querySelector('textarea[placeholder="章节正文..."]').value`);
  assert.ok(manuscript.some(chapter => chapter.content === body));
  await app.screenshot(join(output, 'restarted-workbench.png'));
  assert.deepEqual(app.errors, []);
  await writeFile(join(output, 'restored-input.json'), JSON.stringify(input, null, 2));
  await writeFile(join(output, 'restart-assertions.json'), JSON.stringify({ firstPid, secondPid: app.child.pid, projectExact: true, narrativeExact: true, providerConfigurationPresent: false, proseVisible: true }, null, 2));
  steps.push('Full process restart preserves prose, reviews and all author references without restoring provider credentials.');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error); console.error(error); process.exitCode = 1;
  await app?.screenshot(join(output, 'failure.png')).catch(() => {});
} finally {
  report = { ...report, executableSHA256: createHash('sha256').update(await readFile(executable)).digest('hex'), completedAt: new Date().toISOString(), chapterCount: manuscript.length, pages, steps, exported, runtimeErrors: app?.errors, output };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (app) await app.close(); console.log(JSON.stringify(report));
}

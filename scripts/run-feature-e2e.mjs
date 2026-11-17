import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Runs the existing local video checks with isolated browser profiles. Passing
// these cases does not claim live-model quality or complete application coverage.
const output = resolve('artifacts', 'feature-e2e-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const run = (command, args, options = {}) => new Promise(resolveRun => {
  const child = spawn(command, args, { windowsHide: true, ...options });
  // Decode across pipe chunks; split UTF-8 characters otherwise produce
  // different source-diff hashes even when no file changed during the run.
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  let stdout = '', stderr = '', timedOut = false;
  child.stdout?.on('data', data => { stdout += data; });
  child.stderr?.on('data', data => { stderr += data; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout || 240000);
  child.once('error', error => { stderr += String(error); });
  child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr, timedOut }); });
});
const contracts = (await readdir('scripts')).filter(name => /^test-.*\.mjs$/.test(name) && !['test-tts.mjs', 'test-llm-json-parser.mjs'].includes(name));
const suites = [
  ...contracts.map(name => ({ id: name.slice(0, -4), script: name, kind: 'contract' })),
  ...['application', 'novel-comic', 'novel-workbench', 'video', 'studio', 'image-mask', 'studio-library', 'studio-upload', 'world-sequence', 'world-model-animation', 'world-monitor', 'world-offline', 'world-sets'].map(name => ({ id: name + '-ui-e2e', script: 'run-' + name + '-ui-e2e.mjs', kind: 'browser' })),
  { id: 'native', kind: 'rust' },
  { id: 'release-e2e', script: 'run-release-e2e.mjs', kind: 'desktop' },
  { id: 'world-offline-desktop-e2e', script: 'run-world-offline-desktop-e2e.mjs', kind: 'desktop' },
  { id: 'application-desktop-e2e', script: 'run-application-desktop-e2e.mjs', kind: 'desktop' },
];
const selected = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',');
if (selected?.some(id => !suites.some(suite => suite.id === id))) throw new Error('Unknown suite in --only');
const cases = selected ? suites.filter(suite => selected.includes(suite.id)) : suites;
const source = await run('git', ['rev-parse', 'HEAD']);
const sourceChanges = () => run('git', ['diff', 'HEAD', '--', 'src', 'src-tauri', 'public', 'vite.config.ts', 'package.json', 'package-lock.json']);
const changes = await sourceChanges();
const report = { result: 'running', coverage: selected ? 'partial' : 'full', totalSuites: suites.length, startedAt: new Date().toISOString(), sourceCommit: source.stdout.trim(), sourceDiffSHA256: createHash('sha256').update(changes.stdout).digest('hex'), boundary: 'Models, S3, Eagle and WebUI use fixtures. Browser suites may simulate IPC; desktop suites exercise real IPC. Rust tests use real FFmpeg. Live services and installation are outside this run.', output, suites: [] };
let vite;
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
try {
  if (cases.some(suite => suite.kind === 'browser')) {
    const reservation = createServer();
    await new Promise(resolvePort => reservation.listen(0, '127.0.0.1', resolvePort));
    const port = reservation.address().port;
    await new Promise(resolvePort => reservation.close(resolvePort));
    report.appUrl = 'http://127.0.0.1:' + port + '/';
    vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true });
    let viteLog = '';
    vite.stdout.on('data', data => { viteLog += data; });
    vite.stderr.on('data', data => { viteLog += data; });
    vite.on('error', error => { viteLog += String(error); });
    const deadline = Date.now() + 60000;
    while (true) {
      try { if ((await fetch(report.appUrl, { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* Server is starting. */ }
      if (vite.exitCode !== null || Date.now() > deadline) throw new Error('Vite failed to start: ' + viteLog);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
    }
    vite.once('close', () => { void writeFile(join(output, 'vite.log'), viteLog); });
  }
  await save();
  for (const suite of cases) {
    console.log('RUN ' + suite.id);
    const suiteOutput = join(output, suite.id);
    await mkdir(suiteOutput, { recursive: true });
    const start = Date.now();
    const command = suite.kind === 'rust' ? 'cargo' : process.execPath;
    const args = suite.kind === 'rust' ? ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib'] : ['--experimental-strip-types', join('scripts', suite.script)];
    const result = await run(command, args, { timeout: suite.kind === 'rust' ? 600000 : 240000, env: { ...process.env, MOJING_SMOKE_URL: report.appUrl, MOJING_E2E_ARTIFACT_DIR: suiteOutput, MOJING_UI_OVERVIEW_SCREENSHOT: join(suiteOutput, 'overview.png'), MOJING_UI_SCREENSHOT: join(suiteOutput, 'shots.png'), MOJING_UI_HANDOFF_SCREENSHOT: join(suiteOutput, 'handoff.png'), MOJING_UI_TIMELINE_SCREENSHOT: join(suiteOutput, 'timeline.png'), MOJING_UI_FAILURE_SCREENSHOT: join(suiteOutput, 'failure.png') } });
    await writeFile(join(suiteOutput, 'stdout.log'), result.stdout);
    await writeFile(join(suiteOutput, 'stderr.log'), result.stderr);
    const entry = { id: suite.id, kind: suite.kind, result: result.code === 0 && !result.timedOut ? 'passed' : 'failed', seconds: Number(((Date.now() - start) / 1000).toFixed(2)), exitCode: result.code, timedOut: result.timedOut, output: suiteOutput };
    report.suites.push(entry);
    await save();
    console.log(entry.result.toUpperCase() + ' ' + entry.id + ' (' + entry.seconds + 's)');
    if (entry.result === 'failed') console.log((result.stderr || result.stdout).slice(-1800));
  }
  report.result = report.suites.every(suite => suite.result === 'passed') ? 'passed' : 'failed';
} catch (error) { report.result = 'failed'; report.error = String(error); console.error(error); }
finally {
  if (vite && vite.exitCode === null) {
    const closed = new Promise(resolveClose => vite.once('close', resolveClose));
    vite.kill(); await closed;
  }
  report.completedAt = new Date().toISOString();
  report.sourceUnchanged = (await sourceChanges()).stdout === changes.stdout;
  if (!report.sourceUnchanged) { report.result = 'failed'; report.error = 'Application source changed during verification. Rerun against a stable tree.'; }
  await save();
}
console.log(JSON.stringify({ result: report.result, passed: report.suites.filter(suite => suite.result === 'passed').length, failed: report.suites.filter(suite => suite.result === 'failed').length, output }));
if (report.result !== 'passed') process.exitCode = 1;

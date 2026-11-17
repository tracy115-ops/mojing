import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/';
const browser = await chromeSession({ url: appUrl, port: 9249 });
const { call, evaluate, waitFor, click, textButton, screenshot } = browser;
const external = [];
browser.onEvent(event => {
  if (event.method !== 'Fetch.requestPaused') return;
  const { request, requestId } = event.params, url = new URL(request.url);
  const local = url.origin === new URL(appUrl).origin || ['blob:', 'data:'].includes(url.protocol);
  if (!local) external.push(request.url);
  void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => browser.errors.push(String(error)));
});
const choose = async (label, option) => {
  const selector = `[aria-label=${JSON.stringify(label)}]`;
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  if (label === '添加内置布景') await call('Input.insertText', { text: option });
  const item = `(()=>{const input=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('input[role=combobox]'),popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return[...(popup?.querySelectorAll('.ant-select-item-option')??[])].find(e=>e.title===${JSON.stringify(option)});})()`;
  await waitFor(`!!${item}`, 'set option'); await evaluate(`(${item}).click()`);
};
const boot = async () => {
  await waitFor('!!document.querySelector(\'button[aria-label="视频工坊"]\')', 'video navigation'); await click('button[aria-label="视频工坊"]');
  await waitFor('!!document.querySelector("[data-testid=studio-nav-world]")', 'studio navigation'); await click('[data-testid=studio-nav-world]');
  await waitFor('!!document.querySelector("[data-testid=studio-world]")', 'world page');
  await evaluate(`(async()=>{const source=await(await fetch('/src/components/VideoStudio/WorldEngine.tsx')).text(),path=symbol=>{const line=source.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};window.setStore=(await import(path('useVideoStudioStore'))).useVideoStudioStore;const {WorldViewport}=await import(path('WorldViewport')),sync=WorldViewport.prototype.sync;WorldViewport.prototype.sync=function(...args){sync.apply(this,args);window.setViewport=this;};})()`);
};
const ready = () => waitFor('!!window.setViewport && [...setViewport.objects.values()].every(e=>!e.loading&&!e.loadError&&(e.modelLoaded||!e.root.children.some(c=>c.isMesh))) && setViewport.objects.size===setStore.getState().worlds.find(w=>w.id===setStore.getState().activeWorldId)?.objects.length', 'all bundled GLB geometry and textures', 60000);
try {
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await call('Page.navigate', { url: appUrl }); await boot();
  await click('.world-engine-empty .ant-btn-primary'); await ready();
  const town = await evaluate('setStore.getState().worlds[0]');
  assert.ok(town.objects.filter(o => o.builtinModel).length > 40);
  assert.equal(town.objects.filter(o => o.kind === 'actor').length, 2);
  const models = await evaluate('(()=>{const meshes=[];for(const entry of setViewport.objects.values())entry.root.traverse(o=>{if(o.isMesh)meshes.push({vertices:o.geometry.attributes.position.count,texture:!!o.material.map?.image});});return meshes;})()');
  assert.ok(models.some(m => m.vertices > 3000 && m.texture), 'real detailed meshes and embedded textures loaded');
  await evaluate(`(async()=>{const {parseWorldDocument}=await import('/src/services/video-studio/document.ts');const w=setStore.getState().worlds[0];const parsed=parseWorldDocument(w);if(JSON.stringify(parsed.objects)!==JSON.stringify(w.objects))throw new Error('Props lost on parse');for(const patch of [{builtinModel:'../../unavailable'},{assetId:'ambiguous-model'},{kind:'box'}]){let failed=false;const next=structuredClone(w);Object.assign(next.objects[0],patch);try{parseWorldDocument(next);}catch{failed=true;}if(!failed)throw new Error('Invalid built-in model accepted');}})()`);
  const townImage = await evaluate('setViewport.capture(0)');
  if (process.env.MOJING_E2E_ARTIFACT_DIR) await writeFile(join(process.env.MOJING_E2E_ARTIFACT_DIR, 'town-camera.png'), Buffer.from(townImage.split(',')[1], 'base64'));
  await textButton('查看全景', '.world-engine-view-toolbar'); await screenshot('town-editor.png');
  await choose('添加内置布景', '木推车'); await ready();
  assert.equal(await evaluate('setStore.getState().worlds[0].objects.at(-1).builtinModel'), 'cart');
  await click('.world-engine-toolbar [aria-label="撤销"]'); await ready();
  assert.equal(await evaluate('setStore.getState().worlds[0].objects.length'), town.objects.length);
  await choose('场景模板', '喷泉庭院 · 完整布景'); await textButton('新世界', '.world-engine-toolbar'); await ready();
  assert.equal(await evaluate('setStore.getState().worlds.length'), 2);
  const courtyard = await evaluate('setStore.getState().worlds[1]');
  const courtyardImage = await evaluate('setViewport.capture(0)');
  if (process.env.MOJING_E2E_ARTIFACT_DIR) await writeFile(join(process.env.MOJING_E2E_ARTIFACT_DIR, 'courtyard-camera.png'), Buffer.from(courtyardImage.split(',')[1], 'base64'));
  await evaluate('(()=>{const w=setStore.getState().worlds[1];setStore.getState().saveWorld({...w,duration:1,fps:15,camera:{...w.camera,keyframes:[{time:0,position:w.camera.position,target:w.camera.target},{time:1,position:[11,7,14],target:w.camera.target}]}});})()');
  await textButton('导出预演视频', '.world-engine-output-actions');
  await waitFor('setStore.getState().assets.some(a=>a.kind==="video")', 'real encoded town video', 60000);
  const clip = await evaluate(`(async()=>{const a=setStore.getState().assets.find(a=>a.kind==='video'),v=document.createElement('video');v.muted=true;v.src=a.url;await new Promise((ok,fail)=>{v.onloadedmetadata=ok;v.onerror=fail;});const c=document.createElement('canvas');c.width=160;c.height=90;const ctx=c.getContext('2d');const sample=async t=>{await new Promise(ok=>{v.onseeked=ok;v.currentTime=t;});ctx.drawImage(v,0,0,160,90);return [...ctx.getImageData(0,0,160,90).data];};const x=await sample(.1),y=await sample(.8);return{url:a.url,duration:v.duration,width:v.videoWidth,height:v.videoHeight,difference:x.reduce((n,v,i)=>n+Math.abs(v-y[i]),0)/x.length};})()`);
  assert.equal(clip.width, 1280); assert.equal(clip.height, 720); assert.ok(Math.abs(clip.duration - 1) < .005); assert.ok(clip.difference > 2);
  if (process.env.MOJING_E2E_ARTIFACT_DIR) await writeFile(join(process.env.MOJING_E2E_ARTIFACT_DIR, 'courtyard.webm'), Buffer.from(clip.url.split(',')[1], 'base64'));
  for (const theme of ['dark', 'light']) for (const width of [1600, 900, 650]) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    await call('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: false });
    await textButton('查看全景', '.world-engine-view-toolbar');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'));
    await screenshot(`courtyard-${theme}-${width}.png`);
  }
  await call('Emulation.clearDeviceMetricsOverride');
  await evaluate(`(async()=>{const {exportWorldBundle}=await import('/src/services/video-studio/bundle.ts'),{parseStudioBundle}=await import('/src/services/video-studio/document.ts'),w=setStore.getState().worlds[1];const b=await exportWorldBundle(w,[]),p=parseStudioBundle(b,'world');if(JSON.stringify(p.world.objects)!==JSON.stringify(w.objects))throw new Error('Portable built-in props lost');})()`);
  await call('Page.reload'); await boot(); await evaluate('(()=>{const w=setStore.getState().worlds[1];setStore.getState().saveWorld({...w});})()'); await ready();
  assert.deepEqual(await evaluate('setStore.getState().worlds[1].objects'), courtyard.objects);
  assert.ok(external.every(url => ['https://api-beijing.klingai.com/', 'https://api.deepseek.com/', 'https://www.baidu.com/'].includes(url)), 'only unrelated application connectivity probes were attempted'); assert.deepEqual(browser.errors, []);
  console.log('Bundled textured town and courtyard, prop insertion/undo, strict import, portable export, persisted reload, six layouts, and actual fixed-duration WebM passed. Scene assets are local; unrelated application connectivity probes were blocked.');
} catch (error) {
  console.error('World set diagnostic:', await evaluate('({text:document.body.innerText.slice(-2500),entries:window.setViewport&&[...setViewport.objects.values()].map(e=>({key:e.key,loading:e.loading,error:e.loadError}))})').catch(() => null));
  console.error('Screenshot:', await screenshot('world-sets-failure.png').catch(() => null)); throw error;
} finally { browser.close(); }

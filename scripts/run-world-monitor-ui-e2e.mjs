import assert from 'node:assert/strict';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/', origin = new URL(appUrl).origin;
const browser = await chromeSession({ url: appUrl, port: 9242 });
const { call, evaluate, waitFor, click, textButton, delay, screenshot } = browser;
const external = [];
browser.onEvent(event => {
  if (event.method !== 'Fetch.requestPaused') return;
  const { request, requestId } = event.params, local = new URL(request.url).origin === origin;
  if (!local) external.push(request.url);
  void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => browser.errors.push(String(error)));
});
const segment = async text => {
  await evaluate(`[...document.querySelectorAll('.world-engine-view-toolbar .ant-segmented-item-label')].find(el=>el.textContent===${JSON.stringify(text)}).click()`);
  await delay(100);
};
const choose = async (label, option) => {
  const selector = `[aria-label=${JSON.stringify(label)}]`;
  const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  const item = `(()=>{const input=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('input[role=combobox]'),popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return[...(popup?.querySelectorAll('.ant-select-item-option')??[])].find(el=>el.title===${JSON.stringify(option)}&&!el.classList.contains('ant-select-item-option-disabled'));})()`;
  await waitFor(`Boolean(${item})`, 'monitor option ' + option); await evaluate(`(${item}).click()`);
  await waitFor('!document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")', 'monitor select closed');
};
const inspect = () => evaluate('({view:monitorViewport.view,time:monitorViewport.time,scissor:monitorViewport.renderer.getScissorTest(),focal:monitorViewport.shotCamera.getFocalLength(),position:monitorViewport.shotCamera.position.toArray(),controls:monitorViewport.controls.enabled,roots:monitorViewport.objects.size})');
const renderFrames = time => evaluate(`(()=>{monitorFrames=[];monitorViewport.animate(${time});return monitorFrames;})()`);
const tilePixels = () => evaluate(`(async()=>{const {worldMonitorLayout}=await import('/src/services/video-studio/world-monitor.ts'),canvas=monitorViewport.renderer.domElement,c=document.createElement('canvas');c.width=80;c.height=45;const ctx=c.getContext('2d'),rects=worldMonitorLayout(canvas.width,canvas.height,monitorViewport.monitorSources.length);return rects.map(r=>{ctx.clearRect(0,0,80,45);ctx.drawImage(canvas,r.x,r.y,r.width,r.height,0,0,80,45);const p=[...ctx.getImageData(0,0,80,45).data];return{signature:p.reduce((sum,n,i)=>(sum+n*(i%131+1))%1000000007,0),rgb:p.reduce((sum,n,i)=>sum+(i%4===3?0:n),0)};});})()`);
try {
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await call('Page.navigate', { url: appUrl });
  await waitFor('Boolean(document.querySelector(\'button[aria-label="视频工坊"]\'))', 'studio navigation'); await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-nav-world]"))', 'studio'); await click('[data-testid=studio-nav-world]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-world]"))', 'world page');
  await evaluate(`(async()=>{
    window.monitorImport=async(file,symbol)=>{const source=await(await fetch(file)).text(),line=source.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};
    window.monitorStore=(await import(await monitorImport('/src/components/VideoStudio/WorldEngine.tsx','useVideoStudioStore'))).useVideoStudioStore;
    const {WorldViewport}=await import(await monitorImport('/src/components/VideoStudio/WorldEngine.tsx','WorldViewport')),sync=WorldViewport.prototype.sync;
    const record=WorldViewport.prototype.record;window.monitorRecordResults=[];window.monitorNotices=[];
    new MutationObserver(()=>{const text=document.querySelector('.ant-message')?.textContent;if(text&&!monitorNotices.includes(text))monitorNotices.push(text);}).observe(document.body,{subtree:true,childList:true,characterData:true});
    WorldViewport.prototype.record=async function(onTime){try{const blob=await record.call(this,onTime);monitorRecordResults.push({size:blob.size,type:blob.type});return blob;}catch(error){monitorRecordResults.push({error:String(error)});throw error;}};
    window.monitorFrames=[];WorldViewport.prototype.sync=function(...args){sync.apply(this,args);window.monitorViewport=this;if(!this.renderer.monitorWrapped){const render=this.renderer.render.bind(this.renderer),engine=this;this.renderer.monitorWrapped=true;this.renderer.render=(scene,camera)=>{const actor=[...engine.objects.values()][0]?.root;monitorFrames.push({time:engine.time,recording:engine.recording,focal:camera.getFocalLength(),position:camera.position.toArray(),aspect:camera.aspect,actor:actor?.position.toArray()});if(monitorFrames.length>1000)monitorFrames.shift();render(scene,camera);};}};
    const {createWorld,createWorldObject,addWorldPath}=await import('/src/services/video-studio/document.ts');
    const w=createWorld('Camera monitor fixture');w.duration=4;w.fps=24;w.objects=[addWorldPath(createWorldObject('actor','Moving cast'),[-2,0,0],[2,0,0],4,'walk')];
    const prop=createWorldObject('box','Red block');prop.color='#c24c4c';prop.transform.position=[-2,0,-2];prop.transform.scale=[2,2,2];w.objects.push(prop);
    const tree=createWorldObject('tree','Green tree');tree.transform.position=[2,0,-1];w.objects.push(tree);
    const front={position:[0,2.2,8],target:[0,1,0],focalLength:35,keyframes:[{time:0,position:[0,2.2,8],target:[0,1,0]},{time:4,position:[0,2.2,6],target:[0,1,0]}]},side={position:[8,3,0],target:[0,1,0],focalLength:70,keyframes:[]},top={position:[0,10,2],target:[0,0,0],focalLength:50,keyframes:[]};
    w.camera=structuredClone(front);w.cameraBookmarks=[{id:'front',name:'Front setup',camera:structuredClone(front)},{id:'side',name:'Side setup',camera:side},{id:'top',name:'Top setup',camera:top}];
    w.cameraSequence={enabled:true,shots:[{id:'opening',name:'Opening',duration:2,camera:{...structuredClone(front),keyframes:[{...front.keyframes[0],time:0},{...front.keyframes[1],time:2}]}},{id:'reverse',name:'Reverse',duration:2,camera:{position:[-7,2,0],target:[0,1,0],focalLength:85,keyframes:[]}}]};monitorStore.getState().saveWorld(w);
  })()`);
  await waitFor('!!window.monitorViewport && monitorViewport.objects.size===3', 'shared real WebGL scene');
  await segment('多机位监看'); await waitFor('document.querySelectorAll("[data-monitor-slot]").length===4', 'four monitor views');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=world-viewport] canvas").length'), 1);
  const beforeViews = await evaluate('JSON.stringify(monitorStore.getState().worlds[0])');
  let frames = await renderFrames(2.5); assert.equal(frames.length, 4); assert.deepEqual(frames.map(f => Math.round(f.focal)), [85, 35, 70, 50]); assert.ok(frames.every(f => Math.abs(f.actor[0] - .5) < .0001)); assert.equal((await inspect()).roots, 3); assert.equal((await inspect()).scissor, false);
  let pixels = await tilePixels(); assert.equal(new Set(pixels.map(p => p.signature)).size, 4, 'four real camera compositions are rendered');
  await screenshot('mojing-world-monitor-four-dark-1600.png');
  await click('[aria-label="预览镜头 2"]'); await segment('多机位监看');
  await choose('监看机位 4', '#1 · Opening'); frames = await renderFrames(2); assert.deepEqual(frames.map(f => Math.round(f.focal)), [85, 35, 70, 35]); assert.deepEqual(frames[3].position, [0, 2.2, 6]); assert.ok(frames.every(f => f.actor[0] === 0), 'camera-local time never rewinds the cast');
  assert.match(await evaluate('document.querySelectorAll("[data-monitor-slot]")[3].querySelector("[data-testid=world-monitor-info]").textContent'), /已结束 2.00s/);
  await choose('监看机位 4', '主摄影机');
  await evaluate('document.querySelectorAll("[data-monitor-slot]")[3].querySelector(".ant-select-clear").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}))'); await waitFor('monitorViewport.monitorSources[3]===""', 'cleared camera selection'); frames = await renderFrames(2); assert.equal(frames.length, 3); pixels = await tilePixels(); assert.equal(pixels[3].rgb, 0, 'cleared cells do not retain another camera frame');
  await choose('监看机位 4', '机位方案 · Top setup');
  assert.equal(await evaluate('JSON.stringify(monitorStore.getState().worlds[0])'), beforeViews, 'monitor choices never edit the world');
  await textButton('播放', '.world-engine-timeline-toolbar'); await waitFor('parseFloat(document.querySelector("[data-testid=world-playhead]").textContent)>2.4', 'monitors follow live playback'); await textButton('暂停', '.world-engine-timeline-toolbar');
  assert.ok(await evaluate('monitorFrames.some(f=>f.time>2.2&&f.time<3.5&&Math.abs(f.actor[0]-(-2+f.time))<.0001)'), 'live playback advances the shared cast');
  await click('[aria-label="预览镜头 2"]'); await segment('多机位监看');
  console.log('Four real camera compositions share one WebGL scene, world time and actor; source selection, cut boundaries and cleared cells passed.');

  const beforeCapture = await inspect(); const expectedFrame = await evaluate('monitorViewport.capture(2,"solid","bookmark:front")');
  await textButton('保存画面', '[data-monitor-slot="2"]'); await waitFor('monitorStore.getState().assets.some(a=>a.kind==="image")', 'per-camera frame saved');
  const asset = await evaluate('monitorStore.getState().assets.find(a=>a.kind==="image")'); assert.equal(asset.url, expectedFrame); assert.match(asset.name, /Front setup/); assert.deepEqual(await inspect(), beforeCapture);
  const size = await evaluate('(async()=>{const i=new Image();i.src=monitorStore.getState().assets.find(a=>a.kind==="image").url;await i.decode();return[i.width,i.height];})()'); assert.deepEqual(size, [1280, 720]);
  await textButton('采用机位', '[data-monitor-slot="2"]');
  await waitFor('monitorStore.getState().worlds[0].cameraSequence.shots[1].camera.focalLength===35', 'camera adopted into active shot');
  assert.deepEqual(await evaluate('monitorStore.getState().worlds[0].cameraSequence.shots[1].camera.keyframes.map(f=>f.time)'), [0, 2]);
  assert.equal(await evaluate('monitorStore.getState().worlds[0].cameraBookmarks[0].camera.keyframes.at(-1).time'), 4);
  await click('.world-engine-toolbar [aria-label="撤销"]'); await waitFor('monitorStore.getState().worlds[0].cameraSequence.shots[1].camera.focalLength===85', 'undo camera adoption');
  assert.equal(await evaluate('JSON.stringify(monitorStore.getState().worlds[0])'), beforeViews);
  console.log('Per-camera 1280×720 capture restores the view; adoption copies/retimes the full camera curve into the active shot and supports undo.');

  await evaluate('window.monitorEncoder=VideoEncoder;window.VideoEncoder=class extends window.monitorEncoder{configure(){throw new Error("Injected monitor encoder failure")}};');
  await textButton('导出预演视频', '.world-engine-output-actions'); await waitFor('!document.querySelector(".world-engine-output-actions .ant-btn-loading") && !!document.querySelector("[data-testid=world-camera-monitor]")', 'failed recorder restores monitoring');
  assert.equal((await inspect()).view, 'monitor'); assert.equal((await inspect()).controls, false);
  await evaluate('window.VideoEncoder=class extends window.monitorEncoder{static async isConfigSupported(config){await new Promise(ok=>setTimeout(ok,1200));return super.isConfigSupported(config)}};monitorFrames=[];');
  await textButton('导出预演视频', '.world-engine-output-actions');
  await delay(350);
  assert.equal(await evaluate('monitorViewport.time'), 0, 'the scene clock must wait until the recorder actually starts');
  await waitFor('monitorStore.getState().assets.some(a=>a.kind==="video")', 'program recording from monitor', 90000);
  await evaluate('window.VideoEncoder=window.monitorEncoder');
  console.log('Recorder diagnostic:', await evaluate('({results:monitorRecordResults,notices:monitorNotices})'));
  const recording = await evaluate('monitorFrames.filter(f=>f.recording)'); assert.ok(recording.some(f => f.time < 1 && Math.round(f.focal) === 35)); assert.ok(recording.some(f => f.time > 2 && Math.round(f.focal) === 85)); assert.ok(recording.every(f => Math.abs(f.aspect - 16 / 9) < .0001));
  assert.equal((await inspect()).view, 'monitor'); assert.equal((await inspect()).scissor, false); assert.equal((await renderFrames(3)).length, 4);
  const decoded = await evaluate(`(async()=>{const v=document.createElement('video');v.muted=true;v.src=monitorStore.getState().assets.find(a=>a.kind==='video').url;await new Promise((ok,fail)=>{v.onloadedmetadata=ok;v.onerror=fail;});const c=document.createElement('canvas');c.width=80;c.height=45;const ctx=c.getContext('2d'),sample=async t=>{await new Promise(ok=>{v.onseeked=ok;v.currentTime=t;});ctx.drawImage(v,0,0,80,45);return[...ctx.getImageData(0,0,80,45).data];},a=await sample(.3),b=await sample(3.2);return{size:[v.videoWidth,v.videoHeight],duration:v.duration,difference:a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0)/a.length};})()`); assert.deepEqual(decoded.size, [1280, 720]); assert.ok(Math.abs(decoded.duration - 4) < .1, `actual video duration: ${decoded.duration}`); assert.ok(decoded.difference > 2);
  await segment('白模'); assert.equal((await renderFrames(2)).length, 4); await segment('深度'); assert.equal((await renderFrames(2)).length, 4); await segment('材质');
  console.log('Recorder failure cleanup and decoded program-only video passed; monitor layout and render modes restore afterward.');

  await segment('双画面'); await waitFor('document.querySelectorAll("[data-monitor-slot]").length===2', 'dual layout');
  for (const theme of ['dark', 'light']) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    for (const width of [1600, 900, 650]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: false }); await delay(200);
      await evaluate('document.querySelector("[data-testid=world-viewport]").scrollIntoView({block:"center"})');
      const layout = await evaluate(`(async()=>{const {worldMonitorLayout}=await import('/src/services/video-studio/world-monitor.ts'),host=document.querySelector('[data-testid=world-viewport]'),r=host.getBoundingClientRect(),cells=worldMonitorLayout(host.clientWidth,host.clientHeight,2);return [...document.querySelectorAll('[data-monitor-slot]')].map((el,i)=>{const b=el.getBoundingClientRect(),c=cells[i];return Math.abs(b.x-r.x-c.x)<1.1&&Math.abs(b.y-r.y-c.y)<1.1&&Math.abs(b.width-c.width)<1.1&&Math.abs(b.height-c.height)<1.1;});})()`); assert.ok(layout.every(Boolean), `${theme} ${width} overlay/scissor alignment`);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'), 'no horizontal layout overflow');
      assert.ok(await evaluate('(()=>{const body=document.querySelector(".world-engine-body").getBoundingClientRect(),toolbar=document.querySelector(".world-engine-view-toolbar").getBoundingClientRect(),output=document.querySelector(".world-engine-output-actions").getBoundingClientRect();return toolbar.top>=body.top-1&&output.bottom<=body.bottom+1;})()'), 'monitor controls fit within the stage');
      await screenshot(`mojing-world-monitor-${theme}-${width}.png`);
    }
  }
  await segment('四画面'); await call('Emulation.clearDeviceMetricsOverride'); await delay(180);
  await evaluate('(()=>{const w=monitorStore.getState().worlds[0];monitorStore.getState().saveWorld({...w,aspectRatio:"9:16"});})()'); frames = await renderFrames(2); assert.ok(frames.every(f => f.aspect === 9 / 16));
  const portrait = await evaluate('(async()=>{const i=new Image();i.src=monitorViewport.capture(2,"solid","bookmark:side");await i.decode();return[i.width,i.height,monitorViewport.renderer.getScissorTest()];})()'); assert.deepEqual(portrait, [720, 1280, false]);
  await evaluate('(()=>{const w=monitorStore.getState().worlds[0];monitorStore.getState().saveWorld({...w,aspectRatio:"16:9",cameraBookmarks:w.cameraBookmarks.filter(b=>b.id!=="front")});})()');
  await waitFor('!!document.querySelectorAll("[data-monitor-slot]")[1].querySelector(".world-camera-monitor-empty")', 'deleted camera leaves an empty slot'); assert.equal((await renderFrames(2)).length, 3);
  await segment('自由视角'); assert.equal((await inspect()).controls, true); assert.equal((await inspect()).scissor, false); assert.equal((await renderFrames(2)).length, 1);
  await segment('摄影机画面'); assert.equal((await renderFrames(2)).length, 1);
  assert.deepEqual(browser.errors, []); assert.ok(external.every(url => !/generations|\/tasks/.test(url)), 'no real model requests');
  console.log('Dark/light 1600/900/650px layouts, responsive scissor alignment, portrait capture, camera deletion and orbit/shot restoration passed. No real models were called.');
} catch (error) {
  console.error('Recorder diagnostic:', JSON.stringify(await evaluate('({results:window.monitorRecordResults,events:window.monitorRecorderEvents,notices:window.monitorNotices})').catch(()=>null)));
  console.error('Monitor diagnostic:', await evaluate('({text:document.body.innerText.slice(-3500),world:window.monitorStore?.getState().worlds[0],view:window.monitorViewport?.view,sources:window.monitorViewport?.monitorSources})').catch(() => null));
  console.error('Runtime errors:', browser.errors); console.error('Screenshot:', await screenshot('mojing-world-monitor-failure.png').catch(() => null)); throw error;
} finally { browser.close(); }

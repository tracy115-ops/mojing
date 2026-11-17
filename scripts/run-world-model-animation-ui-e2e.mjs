import assert from 'node:assert/strict';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/', origin = new URL(appUrl).origin;
const browser = await chromeSession({ url: appUrl, port: 9241 });
const { call, evaluate, waitFor, click, textButton, delay, screenshot } = browser;
const external = [];
let pageLoads = 0;
browser.onEvent(event => {
  if (event.method === 'Page.loadEventFired') pageLoads++;
  if (event.method !== 'Fetch.requestPaused') return;
  const { request, requestId } = event.params, local = new URL(request.url).origin === origin;
  if (!local) external.push({ url: request.url, method: request.method });
  void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => browser.errors.push(String(error)));
});
const boot = async () => {
  await waitFor('Boolean(document.querySelector(\'button[aria-label="视频工坊"]\'))', 'studio navigation'); await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-nav-world]"))', 'studio'); await click('[data-testid=studio-nav-world]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-world]"))', 'world');
  await evaluate(`(async()=>{window.animationImport=async(file,symbol)=>{const source=await(await fetch(file)).text(),line=source.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};window.animationStore=(await import(await animationImport('/src/components/VideoStudio/WorldEngine.tsx','useVideoStudioStore'))).useVideoStudioStore;const {WorldViewport}=await import(await animationImport('/src/components/VideoStudio/WorldEngine.tsx','WorldViewport'));const animate=WorldViewport.prototype.animate;window.animationFrames=[];WorldViewport.prototype.animate=function(time){animate.call(this,time);window.animationViewport=this;const w=animationStore.getState().worlds.find(w=>w.id===animationStore.getState().activeWorldId),o=w?.objects.find(o=>o.kind==='model'),mesh=o&&this.objects.get(o.id)?.root.getObjectByName('AnimatedTriangle');if(this.recording&&mesh)animationFrames.push({time,x:mesh.position.x,y:mesh.position.y});};})()`);
};
const fill = async (label, value) => {
  await evaluate(`(()=>{const el=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const choose = async (label, option) => {
  const selector = `[aria-label=${JSON.stringify(label)}]`;
  const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  const item = `(()=>{const input=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('input[role=combobox]'),popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return[...(popup?.querySelectorAll('.ant-select-item-option')??[])].find(el=>el.title===${JSON.stringify(option)});})()`;
  await waitFor(`Boolean(${item})`, 'animation option ' + option); await evaluate(`(${item}).click()`);
  await waitFor('!document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")', 'animation select closed');
};
const sample = time => evaluate(`(()=>{animationViewport.animate(${time});const o=animationStore.getState().worlds[0].objects.find(o=>o.kind==='model');return animationViewport.objects.get(o.id).root.getObjectByName('AnimatedTriangle').position.toArray();})()`);
const assertPose = async (time, expected) => {
  const position = await sample(time); assert.ok(position.every((v, i) => Math.abs(v - expected[i]) < 0.0001), `pose at ${time}: ${position} expected ${expected}`);
};
try {
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await call('Page.navigate', { url: appUrl }); await boot();
  await evaluate(`(async()=>{const {createWorld}=await import('/src/services/video-studio/document.ts');const w=createWorld('Animation production fixture');w.duration=4;w.fps=12;w.camera.position=[2,2,8];w.camera.target=[2,1,0];animationStore.getState().saveWorld(w);})()`);
  await evaluate(`(async()=>{const {WorldViewport}=await import(await animationImport('/src/components/VideoStudio/WorldEngine.tsx','WorldViewport'));const record=WorldViewport.prototype.record;WorldViewport.prototype.record=async function(onTime){try{const blob=await record.call(this,onTime);window.animationRecordResult={size:blob.size,type:blob.type};return blob;}catch(error){window.animationRecordResult={error:String(error)};throw error;}};})()`);
  await waitFor('Boolean(document.querySelector("[data-testid=world-viewport] canvas")) && !!window.animationViewport', 'WebGL viewport');
  await evaluate(`(()=>{
    const binary=new Float32Array([-.5,0,0,.5,0,0,0,1,0,0,4,0,0,0,4,0,0,0,0,0,0,3,0]);
    const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'AnimatedTriangle'}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[.2,.5,.8,1],metallicFactor:0,roughnessFactor:1},doubleSided:true}],buffers:[{byteLength:binary.byteLength}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:8},{buffer:0,byteOffset:44,byteLength:24},{buffer:0,byteOffset:68,byteLength:24}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-.5,0,0],max:[.5,1,0]},{bufferView:1,componentType:5126,count:2,type:'SCALAR',min:[0],max:[4]},{bufferView:2,componentType:5126,count:2,type:'VEC3'},{bufferView:3,componentType:5126,count:2,type:'VEC3'}],animations:[{name:'Slide',samplers:[{input:1,output:2,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]},{name:'Lift',samplers:[{input:1,output:3,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}]};
    const raw=new TextEncoder().encode(JSON.stringify(json)),padded=Math.ceil(raw.length/4)*4,buffer=new ArrayBuffer(28+padded+binary.byteLength),v=new DataView(buffer);v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,buffer.byteLength,true);v.setUint32(12,padded,true);v.setUint32(16,0x4e4f534a,true);new Uint8Array(buffer,20,padded).fill(32);new Uint8Array(buffer,20,raw.length).set(raw);v.setUint32(20+padded,binary.byteLength,true);v.setUint32(24+padded,0x004e4942,true);new Uint8Array(buffer,28+padded).set(new Uint8Array(binary.buffer));
    const transfer=new DataTransfer();transfer.items.add(new File([buffer],'Animation production.glb',{type:'model/gltf-binary'}));const input=document.querySelector('input[accept=".glb"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('Boolean(document.querySelector("[data-testid=world-model-animation]"))', 'real embedded clip metadata');
  await choose('模型动画', 'Slide · 4.0s'); await assertPose(0.5, [0.5, 0, 0]); await assertPose(4.5, [0.5, 0, 0]);
  await fill('源片段起点（秒）', 1); await fill('源片段终点（秒）', 3); await fill('时间线起点（秒）', 1); await fill('播放倍速', 2);
  await waitFor('animationStore.getState().worlds[0].objects[0].animationPlayback.speed===2', 'animation settings');
  assert.equal(await evaluate('document.querySelector("[data-testid=world-animation-duration]").textContent'), '单次播放时长: 1.00s');
  await assertPose(0, [1, 0, 0]); await assertPose(1.25, [1.5, 0, 0]); await assertPose(2, [1, 0, 0]); await assertPose(2.25, [1.5, 0, 0]);
  await choose('动作播放方式', '播放一次并保持末帧');
  for (const [time, x] of [[4, 3], [1.25, 1.5], [2, 3], [0, 1], [1.5, 2]]) await assertPose(time, [x, 0, 0]);
  const track = await evaluate('(()=>{const el=document.querySelector(".world-model-animation-span");return{left:el.style.left,width:el.style.width};})()'); assert.deepEqual(track, { left: '25%', width: '25%' });
  await click('.world-model-animation-span'); await waitFor('document.querySelector("[data-testid=world-playhead]").textContent.startsWith("1.00")', 'timeline segment seeks to action start'); await assertPose(1, [1, 0, 0]);
  await click('.world-engine-toolbar [aria-label="撤销"]'); await waitFor('animationStore.getState().worlds[0].objects[0].animationPlayback.loop==="repeat"', 'undo playback mode');
  await click('.world-engine-toolbar [aria-label="重做"]'); await waitFor('animationStore.getState().worlds[0].objects[0].animationPlayback.loop==="once"', 'redo playback mode');
  const captures = await evaluate(`(()=>{animationViewport.animate(1.25);const a=animationViewport.capture(1),b=animationViewport.capture(2);const o=animationStore.getState().worlds[0].objects[0];return{different:a!==b,restored:animationViewport.objects.get(o.id).root.getObjectByName('AnimatedTriangle').position.x};})()`); assert.deepEqual(captures, { different: true, restored: 1.5 });
  await textButton('保存参考画面', '.world-engine-output-actions'); await waitFor('animationStore.getState().assets.some(a=>a.kind==="image"&&a.worldId)', 'timeline screenshot saved');
  console.log('Real GLB ranges, delayed start, repeat/hold, backward seek, timeline segment, undo/redo and capture restoration passed.');

  await textButton('导出预演视频', '.world-engine-output-actions'); await waitFor('animationStore.getState().assets.some(a=>a.kind==="video"&&a.worldId)', 'animation recording', 25000);
  const frames = await evaluate('animationFrames'); assert.ok(frames.some(f => f.time === 0 && f.x === 1)); assert.ok(frames.some(f => f.time > 1 && f.time < 2 && f.x > 1 && f.x < 3)); assert.ok(frames.some(f => f.time > 3 && f.x === 3));
  const decoded = await evaluate(`(async()=>{const v=document.createElement('video');v.muted=true;v.src=animationStore.getState().assets.find(a=>a.kind==='video').url;await new Promise((ok,fail)=>{v.onloadedmetadata=ok;v.onerror=fail;});const c=document.createElement('canvas');c.width=160;c.height=90;const ctx=c.getContext('2d'),sample=async time=>{await new Promise(ok=>{v.onseeked=ok;v.currentTime=time;});ctx.drawImage(v,0,0,160,90);return[...ctx.getImageData(0,0,160,90).data];},a=await sample(.2),b=await sample(3.2);return{size:[v.videoWidth,v.videoHeight],difference:a.reduce((sum,n,i)=>sum+Math.abs(n-b[i]),0)/a.length};})()`); assert.deepEqual(decoded.size, [1280, 720]); assert.ok(decoded.difference > 0.1, 'recorded poses visibly change');
  await choose('模型动画', '静止姿态'); await assertPose(3, [0, 0, 0]); assert.equal(await evaluate('animationStore.getState().worlds[0].objects[0].animationPlayback'), undefined);
  await choose('模型动画', 'Lift · 4.0s'); await assertPose(2, [0, 1.5, 0]);
  await fill('播放倍速', 2); await textButton('恢复完整动作', '[data-testid=world-model-animation]'); assert.equal(await evaluate('animationStore.getState().worlds[0].objects[0].animationPlayback'), undefined);
  await choose('模型动画', 'Slide · 4.0s'); await fill('源片段起点（秒）', 1); await fill('源片段终点（秒）', 3); await fill('时间线起点（秒）', 1); await fill('播放倍速', 2); await choose('动作播放方式', '播放一次并保持末帧');
  console.log('A decoded 1280×720 recording, exact held endpoint, rest-pose restoration, clip switching and reset passed.');

  await evaluate('(()=>{const w=animationStore.getState().worlds[0];animationStore.getState().saveWorld({...w,cameraSequence:{enabled:true,shots:[{id:"front",name:"Front",duration:2,camera:structuredClone(w.camera)},{id:"reverse",name:"Reverse",duration:2,camera:{...structuredClone(w.camera),focalLength:70}}]}});})()');
  await waitFor('animationStore.getState().worlds[0].cameraSequence?.enabled', 'camera cuts with GLB animation');
  await assertPose(1.75, [2.5, 0, 0]); await assertPose(2, [3, 0, 0]); assert.equal(Math.round(await evaluate('animationViewport.shotCamera.getFocalLength()')), 70);
  await assertPose(2.5, [3, 0, 0]);
  await evaluate('(()=>{const w=animationStore.getState().worlds[0];animationStore.getState().saveWorld({...w,cameraSequence:undefined});})()');

  const portable = await evaluate(`(async()=>{const {exportWorldBundle}=await import('/src/services/video-studio/bundle.ts'),{parseStudioBundle}=await import('/src/services/video-studio/document.ts');const s=animationStore.getState(),b=await exportWorldBundle(s.worlds[0],s.assets),p=parseStudioBundle(b,'world');return{original:s.worlds[0].objects[0].animationPlayback,copy:p.world.objects[0].animationPlayback,remapped:p.world.objects[0].assetId!==s.worlds[0].objects[0].assetId,embedded:p.assets[0].url.startsWith('data:')};})()`); assert.deepEqual(portable.copy, portable.original); assert.equal(portable.remapped, true); assert.equal(portable.embedded, true);
  for (const theme of ['dark', 'light']) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    for (const width of [1600, 900, 650]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 1050, deviceScaleFactor: 1, mobile: false }); await delay(180);
      await evaluate('document.querySelector("[data-testid=world-model-animation]").scrollIntoView({block:"center"})');
      assert.equal(await evaluate('(()=>{const el=document.querySelector("[data-testid=world-model-animation]");return el.scrollWidth>el.clientWidth+1||document.documentElement.scrollWidth>innerWidth+2;})()'), false, `${theme} ${width}px layout`);
      await screenshot(`mojing-world-animation-${theme}-${width}.png`);
    }
  }
  await call('Emulation.clearDeviceMetricsOverride');
  const persisted = await evaluate('JSON.stringify(animationStore.getState().worlds[0])'); await delay(350); const previousLoads = pageLoads; await call('Page.reload');
  for (let i = 0; i < 200 && pageLoads === previousLoads; i++) await delay(100); assert.ok(pageLoads > previousLoads); await boot();
  await evaluate('(()=>{const w=animationStore.getState().worlds[0];animationStore.getState().saveWorld({...w});})()');
  await waitFor('!!window.animationViewport', 'restored WebGL');
  assert.equal(await evaluate('JSON.stringify(animationStore.getState().worlds[0])'), persisted);
  await click('[data-testid=world-object-item]'); await waitFor('Boolean(document.querySelector("[data-testid=world-model-animation]"))', 'restored animation inspector'); await assertPose(4, [3, 0, 0]); await assertPose(1.25, [1.5, 0, 0]);
  assert.deepEqual(browser.errors, []); assert.ok(external.every(r => !/generations|\/tasks/.test(r.url)), 'no real generation requests');
  console.log('Portable animation settings, persisted media reload, dark/light themes and 1600/900/650px layouts passed. No real models were called.');
} catch (error) {
  console.error('Animation diagnostic:', await evaluate('({text:document.body.innerText.slice(-3500),world:window.animationStore?.getState().worlds[0],frames:window.animationFrames?.length,recording:window.animationViewport?.recording,result:window.animationRecordResult})').catch(() => null));
  console.error('Runtime errors:', browser.errors); console.error('Screenshot:', await screenshot('mojing-world-animation-failure.png').catch(() => null)); throw error;
} finally { browser.close(); }

import assert from 'node:assert/strict';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/';
const browser = await chromeSession({ url: appUrl, port: 9237 });
const { call, evaluate, waitFor, click, textButton, screenshot, delay } = browser;
const origin = new URL(appUrl).origin, external = [];
browser.onEvent((event) => {
  if (event.method !== 'Fetch.requestPaused') return;
  const { request, requestId } = event.params, local = new URL(request.url).origin === origin;
  if (!local) external.push(request.url);
  void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch((error) => browser.errors.push(String(error)));
});
const fill = async (selector, value) => {
  await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await call('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
  await call('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
};
const choose = async (label, option) => {
  const selector = `[aria-label=${JSON.stringify(label)}]`;
  const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify('.world-sequence-transfer '+selector)})||document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:1 });
  await call('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:1 });
  const input = `document.querySelector(${JSON.stringify(selector)})?.closest('.ant-select')?.querySelector('input[role=combobox]')`;
  await waitFor(`(${input})?.getAttribute('aria-expanded')==='true'`, 'open select '+label);
  const selectedOption = `(()=>{const input=${input},popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return [...(popup?.querySelectorAll('.ant-select-item-option')??[])].find(el=>el.title===${JSON.stringify(option)}&&!el.classList.contains('ant-select-item-option-disabled'));})()`;
  await waitFor(`Boolean(${selectedOption})`, 'option '+option);
  await evaluate(`(${selectedOption}).click()`);
  await waitFor(`(${input})?.getAttribute('aria-expanded')==='false'`, 'close select '+label);
};
const waitModal = async () => { await waitFor('document.querySelectorAll(".world-sequence-transfer-row img").length===2', 'two midpoint previews'); await delay(350); };
const openTransfer = async () => { await textButton('批量回流分镜', '.world-camera-sequence'); await waitModal(); await choose('选择项目', 'Sequence project'); };
const closeTransfer = async () => { await click('.world-sequence-transfer .ant-modal-close'); await waitFor('!document.querySelector(".world-sequence-transfer")', 'transfer closed'); };

try {
  await call('Fetch.enable', { patterns:[{ urlPattern:'*' }] });
  await call('Page.setDownloadBehavior', { behavior:'allow', downloadPath:process.env.TEMP || 'C:/Windows/Temp' });
  await call('Page.navigate', { url:appUrl });
  await waitFor('Boolean(document.querySelector(".ws-titlebar"))', 'shell');
  await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-nav-world]"))', 'studio');
  await click('[data-testid=studio-nav-world]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-world]"))', 'world page');
  await evaluate(`(async()=>{
    window.sequenceModuleURL=async(file,symbol)=>{const source=await(await fetch(file)).text();const line=source.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};
    window.sequenceStore=(await import(await sequenceModuleURL('/src/components/VideoStudio/WorldEngine.tsx','useVideoStudioStore'))).useVideoStudioStore;
    window.sequenceProjects=(await import(await sequenceModuleURL('/src/components/VideoStudio/WorldEngine.tsx','useVideoStore'))).useVideoStore;
    const {WorldViewport}=await import(await sequenceModuleURL('/src/components/VideoStudio/WorldEngine.tsx','WorldViewport'));
    const animate=WorldViewport.prototype.animate;
    window.sequenceRecording=[];
    WorldViewport.prototype.animate=function(time){animate.call(this,time);window.sequenceViewport=this;if(this.recording)sequenceRecording.push({time,position:this.shotCamera.position.toArray(),focal:this.shotCamera.getFocalLength()});};
    const {worldFromTemplate,addWorldPath}=await import('/src/services/video-studio/document.ts');
    const world=worldFromTemplate('Coverage fixture','studio','Actor');world.duration=6;
    world.objects[0]=addWorldPath(world.objects[0],[-3,0,0],[3,0,0],6,'walk');
    world.cameraBookmarks=[{id:'front',name:'Front setup',camera:{position:[0,2.2,7],target:[0,1.1,0],focalLength:35,keyframes:[]}},{id:'reverse',name:'Reverse setup',camera:{position:[-7,2.2,0],target:[0,1.1,0],focalLength:85,keyframes:[]}}];
    sequenceStore.getState().saveWorld(world);
    const p=sequenceProjects.getState();p.initProject('sequence-project',[],{style:'cinematic',aspectRatio:'16:9',shotDurationSeconds:5},'Sequence project');
    window.sequenceImage=document.createElement('canvas').toDataURL();
    p.setSceneSpec('sequence-project',{characters:[],scenes:[],props:[],meta:{title:'Sequence project',style:'cinematic',aspectRatio:'16:9',defaultShotDuration:5,sourceMode:'multishot',channel:'direct'},shots:[0,1,2].map(index=>({id:'shot-'+index,index,sourceText:'Existing shot '+(index+1),videoPrompt:'Existing prompt '+index,durationSeconds:5,characterIds:[],manualReferenceImage:sequenceImage,keyframeImage:sequenceImage,transition:'continue',selectedVersionId:'old-'+index,lockedVersionId:'old-'+index,versionHistory:[{id:'old-'+index,type:'video',url:'old-'+index+'.mp4',createdAt:new Date().toISOString(),reviewStatus:'approved'}]}))});
    for(let index=0;index<3;index++)p.addClip('sequence-project',{shotId:'shot-'+index,shotVersionId:'old-'+index,videoUrl:'old-'+index+'.mp4',provider:'custom',model:'fixture',durationSeconds:5,hasAudio:false,generatedAt:new Date().toISOString()});
    p.setFinalVideo('sequence-project','old-final.mp4',{durationSeconds:15,sizeBytes:123});
  })()`);
  await waitFor('Boolean(document.querySelector("[data-testid=world-viewport] canvas")) && !!window.sequenceViewport', 'real WebGL');
  await choose('机位来源', 'Front setup'); await textButton('加入序列', '.world-camera-sequence');
  await waitFor('sequenceStore.getState().worlds[0].cameraSequence?.shots.length===1', 'first shot');
  await fill('input[aria-label="镜头时长（秒） 1"]', 2);
  await choose('运镜预设 1', '缓慢推进');
  await choose('机位来源', 'Reverse setup'); await textButton('加入序列', '.world-camera-sequence');
  await waitFor('document.querySelectorAll("[data-world-sequence-shot]").length===2', 'second shot');
  await click('[aria-label="预览镜头 2"]');
  await waitFor('document.querySelector("[data-testid=world-playhead]").textContent.startsWith("2.00 / 5s")', 'cut seek');
  assert.equal(await evaluate('Math.round(sequenceViewport.shotCamera.getFocalLength())'), 85);
  assert.equal(await evaluate('sequenceViewport.objects.get(sequenceStore.getState().worlds[0].objects[0].id).root.position.x'), -1, 'actor time does not restart at the cut');
  await fill('input[aria-label="焦距（mm）"]', 70);
  const cameras = await evaluate('(()=>{const w=sequenceStore.getState().worlds[0];return {main:w.camera.focalLength,bookmark:w.cameraBookmarks[1].camera.focalLength,shot:w.cameraSequence.shots[1].camera.focalLength};})()');
  assert.deepEqual(cameras, { main:35, bookmark:85, shot:70 });
  await click('[aria-label="复制 2"]');
  await waitFor('sequenceStore.getState().worlds[0].cameraSequence.shots.length===3', 'duplicate');
  await click('[aria-label="删除 3"]'); await waitFor('sequenceStore.getState().worlds[0].cameraSequence.shots.length===2', 'delete');
  await click('[aria-label="前移镜头 2"]');
  assert.equal(await evaluate('sequenceStore.getState().worlds[0].cameraSequence.shots[0].name'), 'Reverse setup');
  await click('.world-engine-toolbar [aria-label="撤销"]');
  await waitFor('sequenceStore.getState().worlds[0].cameraSequence.shots[0].name==="Front setup"', 'undo sequence order');
  await click('[aria-label="使用多机位"]');
  assert.equal(await evaluate('sequenceStore.getState().worlds[0].cameraSequence.enabled'), false);
  assert.equal(await evaluate('Math.round(sequenceViewport.shotCamera.getFocalLength())'), 35);
  await click('[aria-label="使用多机位"]');
  await textButton('导出预演视频', '.world-engine-output-actions');
  await waitFor('sequenceStore.getState().assets.some(a=>a.kind==="video"&&a.worldId)', 'recorded sequence', 35000);
  const recording = await evaluate('({frames:sequenceRecording,asset:sequenceStore.getState().assets.find(a=>a.kind==="video")})');
  assert.equal(recording.asset.durationSeconds, 5);
  assert.ok(recording.frames.some(frame => frame.time < 1 && Math.round(frame.focal) === 35));
  assert.ok(recording.frames.some(frame => frame.time >= 2 && Math.round(frame.focal) === 70), 'the real recorder uses the incoming shot camera');
  const decoded = await evaluate(`(async()=>{const v=document.createElement('video');v.muted=true;v.src=sequenceStore.getState().assets.find(a=>a.kind==='video').url;await new Promise((ok,fail)=>{v.onloadedmetadata=ok;v.onerror=fail;});const size=[v.videoWidth,v.videoHeight];const c=document.createElement('canvas');c.width=64;c.height=36;const ctx=c.getContext('2d');const sample=async time=>{await new Promise(ok=>{v.onseeked=ok;v.currentTime=time;});ctx.drawImage(v,0,0,64,36);return [...ctx.getImageData(0,0,64,36).data];};const a=await sample(.3),b=await sample(4.5);return {size,difference:a.reduce((sum,value,i)=>sum+Math.abs(value-b[i]),0)/a.length};})()`);
  assert.deepEqual(decoded.size, [1280,720]); assert.ok(decoded.difference > 2, 'recorded frames contain distinct camera compositions');
  console.log('Sequence editing, independent camera snapshots, continuous actor time and a decoded 1280×720 recording passed.');

  await openTransfer();
  const previewState = await evaluate('({sources:[...document.querySelectorAll(".world-sequence-transfer-row img")].map(img=>img.src),camera:sequenceViewport.shotCamera.position.toArray()})');
  assert.notEqual(previewState.sources[0], previewState.sources[1]);
  await evaluate('sequenceProjects.getState().updateSceneSpecShot("sequence-project","shot-2",{videoPrompt:"Changed while reviewing"})');
  await click('.world-sequence-transfer .ant-modal-footer .ant-btn-primary');
  await waitFor('document.querySelector(".ant-message")?.textContent.includes("分镜已变化")', 'stale project rejection');
  assert.equal(await evaluate('sequenceProjects.getState().projects["sequence-project"].sceneSpec.shots.some(s=>s.previsReferenceImage)'), false);
  await closeTransfer();
  await openTransfer();
  await evaluate('(()=>{const w=sequenceStore.getState().worlds[0];sequenceStore.getState().saveWorld({...w,name:"Changed world"});})()');
  await click('.world-sequence-transfer .ant-modal-footer .ant-btn-primary');
  await delay(200);
  assert.equal(await evaluate('sequenceProjects.getState().projects["sequence-project"].sceneSpec.shots.some(s=>s.previsReferenceImage)'), false, 'world edits cannot attach old previews');
  await closeTransfer();
  const guards = await evaluate(`(()=>{const s=sequenceProjects.getState(),spec=s.projects['sequence-project'].sceneSpec,frames=[{shotId:'shot-0',url:sequenceImage}];const before=JSON.stringify(s.projects['sequence-project']);const duplicate=s.applyWorldSequenceReferences('sequence-project',spec,'world',[...frames,...frames]),missing=s.applyWorldSequenceReferences('sequence-project',spec,'world',[{shotId:'missing',url:sequenceImage}]);const intact=before===JSON.stringify(sequenceProjects.getState().projects['sequence-project']);s.setStageStatus('sequence-project','video_generation','running');const running=s.applyWorldSequenceReferences('sequence-project',spec,'world',frames);s.setStageStatus('sequence-project','video_generation','pending');return {duplicate,missing,running,intact};})()`);
  assert.deepEqual(guards, { duplicate:false, missing:false, running:false, intact:true });
  // Put the untouched third shot's artifacts back after the deliberate stale-edit check.
  await evaluate(`(()=>{const s=sequenceProjects.getState();s.addClip('sequence-project',{shotId:'shot-2',shotVersionId:'old-2',videoUrl:'old-2.mp4',provider:'custom',model:'fixture',durationSeconds:5,hasAudio:false,generatedAt:new Date().toISOString()});s.setFinalVideo('sequence-project','before-batch.mp4',{durationSeconds:15,sizeBytes:123});window.sequenceAtomicWrites=0;window.sequenceUnsubscribe=sequenceProjects.subscribe((next,previous)=>{if(next.projects['sequence-project'].sceneSpec!==previous.projects['sequence-project'].sceneSpec)sequenceAtomicWrites++;});})()`);
  await openTransfer();
  await choose('目标分镜 1', '#3 Existing shot 3');
  await choose('目标分镜 2', '#1 Existing shot 1');
  await choose('目标分镜 1', '#2 Existing shot 2');
  await waitFor('document.querySelectorAll(".world-sequence-transfer-row .ant-select-selection-item")[0]?.textContent==="#2 Existing shot 2" && document.querySelectorAll(".world-sequence-transfer-row .ant-select-selection-item")[1]?.textContent==="#1 Existing shot 1"', 'explicit swapped targets');
  await click('.world-sequence-transfer .ant-modal-footer .ant-btn-primary');
  await waitFor('!document.querySelector(".world-sequence-transfer")', 'atomic batch applied');
  const applied = await evaluate('({project:sequenceProjects.getState().projects["sequence-project"],writes:sequenceAtomicWrites,assets:sequenceStore.getState().assets.filter(a=>a.kind==="image")})');
  assert.equal(applied.writes, 1);
  assert.equal(applied.assets.length, 2);
  assert.deepEqual(applied.project.sceneSpec.shots.slice(0,2).map(shot => applied.assets.find(asset => asset.url === shot.previsReferenceImage)?.name.split(' · ')[1]), ['Reverse setup','Front setup'], 'mapping applies each selected camera to its explicit target');
  for (const shot of applied.project.sceneSpec.shots.slice(0,2)) {
    assert.ok(shot.previsReferenceImage.startsWith('data:image/png'));
    assert.equal(shot.previsWorldId, await evaluate('sequenceStore.getState().worlds[0].id'));
    assert.equal(shot.manualReferenceImage, undefined); assert.equal(shot.keyframeImage, undefined);
    assert.equal(shot.lockedVersionId, undefined); assert.equal(shot.selectedVersionId, undefined);
    assert.equal(shot.transition, 'cut'); assert.equal(shot.durationSeconds, 5);
    assert.match(shot.videoPrompt, /^Existing prompt/);
  }
  assert.equal(applied.project.clips.length, 1); assert.equal(applied.project.clips[0].shotId, 'shot-2');
  assert.equal(applied.project.finalVideoUrl, undefined); assert.equal(applied.project.finalDurationSeconds, undefined);
  assert.equal(applied.project.stages.keyframe_image.status, 'pending');
  console.log('Midpoint previews, stale world/project and running-stage guards, atomic mapping and derived artifact invalidation passed.');

  for (const theme of ['dark','light']) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    for (const width of [1600,900,650]) {
      await call('Emulation.setDeviceMetricsOverride', { width,height:1000,deviceScaleFactor:1,mobile:false }); await delay(250);
      await evaluate('document.querySelector(".world-camera-sequence").scrollIntoView({block:"center"})');
      assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+2'), `${theme} ${width}px layout overflow`);
      await screenshot(`mojing-world-sequence-${theme}-${width}-20261116.png`);
    }
  }
  const persisted = await evaluate(`(async()=>{const source=await sequenceModuleURL('/src/stores/videoStudioStore.ts','videoStudioStorage');const {videoStudioStorage}=await import(source);await videoStudioStorage.getItem('video-studio');const w=sequenceStore.getState().worlds[0];return {world:w,assets:sequenceStore.getState().assets.length};})()`);
  await call('Emulation.clearDeviceMetricsOverride'); await call('Page.reload');
  await waitFor('!window.sequenceStore && !!document.querySelector(".ws-titlebar")', 'fresh shell');
  await click('button[aria-label="视频工坊"]'); await waitFor('Boolean(document.querySelector("[data-testid=studio-nav-world]"))', 'restored studio');
  await click('[data-testid=studio-nav-world]'); await waitFor('document.querySelectorAll("[data-world-sequence-shot]").length===2', 'restored sequence UI');
  const restored = await evaluate(`(async()=>{const source=await(await fetch('/src/components/VideoStudio/WorldEngine.tsx')).text();const line=source.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes('useVideoStudioStore'));const {useVideoStudioStore}=await import(line.slice(line.indexOf('"')+1,line.lastIndexOf('"')));const s=useVideoStudioStore.getState();return {world:s.worlds[0],assets:s.assets.length};})()`);
  assert.deepEqual(restored, persisted);
  assert.deepEqual(browser.errors, []);
  assert.ok(external.every(url => !url.includes('/images/generations') && !url.includes('/contents/generations')), 'no generation requests or real credits');
  console.log('Camera sequence persistence, dark/light themes and 1600/900/650px layouts passed. Runtime errors: []');
} catch (error) {
  await screenshot('mojing-world-sequence-failure.png').catch(()=>undefined);
  throw error;
} finally { browser.close(); }

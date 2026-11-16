import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl=process.env.MOJING_SMOKE_URL||'http://127.0.0.1:1420/', origin=new URL(appUrl).origin, storageOrigin='https://upload.fixture.test';
const browser=await chromeSession({url:appUrl,port:9239});
const {call,evaluate,waitFor,click,textButton,delay,screenshot}=browser;
const objects=new Map(), transfers=[], modelRequests=[], blocked=[];
let failHead=true, holdPut=false, heldPut, pageLoads=0;
const video='data:video/mp4;base64,'+(await readFile(new URL('./fixtures/studio-reference.mp4',import.meta.url))).toString('base64');
const output=(await readFile(new URL('./fixtures/studio-output.webm',import.meta.url))).toString('base64');
const fulfill=(requestId,responseCode,headers={},body)=>call('Fetch.fulfillRequest',{requestId,responseCode,responseHeaders:Object.entries(headers).map(([name,value])=>({name,value:String(value)})),...(body?{body}:{} )});
browser.onEvent(event=>{
  if(event.method==='Page.loadEventFired')pageLoads++;
  if(event.method!=='Fetch.requestPaused')return;
  void(async()=>{
    const {request,requestId}=event.params,url=new URL(request.url);
    if(url.origin===storageOrigin){
      const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'PUT, GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'content-type,x-amz-meta-sha256','Access-Control-Expose-Headers':'content-length,x-amz-meta-sha256'};
      if(request.method==='OPTIONS'){await fulfill(requestId,204,cors);return;}
      transfers.push({method:request.method,path:url.pathname,signedHeaders:url.searchParams.get('X-Amz-SignedHeaders')});
      assert.equal(url.searchParams.get('X-Amz-Algorithm'),'AWS4-HMAC-SHA256');assert.match(url.searchParams.get('X-Amz-Signature'),/^[a-f\d]{64}$/);
      if(request.method==='PUT'){
        const wire=await evaluate('window.uploadBodies.at(-1)');
        assert.equal(wire.raw,true);assert.ok(wire.size>0);const headers=Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]));
        assert.equal(headers['x-amz-meta-sha256'],wire.hash);assert.equal(headers['content-type'],wire.type);
        objects.set(url.pathname,{...wire});
        if(holdPut){holdPut=false;heldPut=requestId;return;}
        await fulfill(requestId,200,cors);return;
      }
      if(request.method==='HEAD'){
        if(failHead){failHead=false;await fulfill(requestId,503,cors);return;}
        const object=objects.get(url.pathname);await fulfill(requestId,object?200:404,{...cors,...(object?{'Content-Length':object.size,'x-amz-meta-sha256':object.hash,'Content-Type':object.type}:{})});return;
      }
      throw new Error('Unexpected object request '+request.method);
    }
    if(url.origin===origin&&url.pathname.startsWith('/__upload_mock')){
      if(url.pathname.endsWith('/output.webm')){await fulfill(requestId,200,{'Content-Type':'video/webm'},output);return;}
      const body=request.postData?JSON.parse(request.postData):undefined;modelRequests.push({path:url.pathname,method:request.method,body});
      const result=request.method==='POST'?{id:'upload-reference-model-task'}:{status:'succeeded',content:{video_url:origin+'/__upload_mock/output.webm'}};
      await fulfill(requestId,200,{'Content-Type':'application/json'},Buffer.from(JSON.stringify(result)).toString('base64'));return;
    }
    if(url.origin===origin)await call('Fetch.continueRequest',{requestId});
    else{blocked.push({url:url.href,method:request.method,auth:Object.keys(request.headers).some(key=>/authorization|api-key/i.test(key))});await call('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
  })().catch(error=>browser.errors.push(String(error)));
});
const boot=async()=>{
  await waitFor('Boolean(document.querySelector(\'button[aria-label="视频工坊"]\'))','studio navigation');await click('button[aria-label="视频工坊"]');await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))','studio');
  await evaluate(`(async()=>{const spec=async(file,symbol)=>{const source=await(await fetch(file)).text(),line=source.split(String.fromCharCode(10)).find(line=>line.startsWith('import')&&line.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};window.uploadStudio=(await import(await spec('/src/components/VideoStudio/StudioWorkspace.tsx','useVideoStudioStore'))).useVideoStudioStore;window.uploadSettings=(await import(await spec('/src/components/VideoStudio/StudioUploadSettings.tsx','useStudioUploadStore'))).useStudioUploadStore;window.uploadAPI=await import(await spec('/src/components/VideoStudio/StudioUploadModal.tsx','startStudioMediaUpload'));window.uploadProvider=(await import(await spec('/src/components/VideoStudio/StudioCreator.tsx','useProviderStore'))).useProviderStore;
    const original=fetch.bind(window);window.uploadBodies=[];window.fetch=async(input,options)=>{if(String(input).startsWith(${JSON.stringify(storageOrigin)})&&options?.method==='PUT'){const bytes=new Uint8Array(options.body);const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');uploadBodies.push({size:bytes.length,hash,raw:options.body instanceof ArrayBuffer,type:options.headers['content-type']});}return original(input,options);};})()`);
};
const fill=(label,value,parent='body')=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(parent)}).querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const openSettings=async()=>{await click('[data-testid=studio-nav-plugins]');await waitFor('Boolean(document.querySelector("[data-testid=studio-plugins]"))','plugins');await evaluate(`[...document.querySelectorAll('[role=tab]')].find(el=>el.textContent==='媒体上传设置').click()`);await waitFor('Boolean(document.querySelector("[data-testid=studio-upload-settings]"))','upload settings');};
const credentials=async()=>{await fill('Access Key ID','UPLOAD_TEST_ACCESS');await fill('Secret Access Key','upload-fixture-secret');await click('[data-testid=studio-save-upload-settings]');};
const reload=async()=>{
  const previous=pageLoads;await call('Page.reload');
  for(let i=0;i<200&&pageLoads===previous;i++)await delay(100);
  assert.ok(pageLoads>previous,'reload finishes before inspecting the new document');await boot();
};
try{
  await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});await call('Page.navigate',{url:appUrl});await boot();
  const endpointId=await evaluate(`(()=>{const p=uploadProvider.getState();const id=p.addEndpoint({name:'Upload model fixture',provider:'doubao-video',category:'video',models:['doubao-seedance-2-5-260628'],baseUrl:location.origin+'/__upload_mock',apiKey:'model-fixture-key',enabled:true});p.setVideoProvider('doubao-video','doubao-seedance-2-5-260628',id);for(const [assetId,name] of [['upload-motion','Local MP4 reference'],['upload-cancel','Cancelled upload']])uploadStudio.getState().addAsset({id:assetId,name,kind:'video',category:'reference',createdAt:new Date().toISOString(),url:${JSON.stringify(video)},mimeType:'video/mp4'});return id;})()`);
  await openSettings();await fill('S3 接口地址',storageOrigin);await fill('存储桶','test-bucket');await credentials();
  for(const theme of ['dark','light']){
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    for(const width of [1600,900,650]){await call('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:1,mobile:false});await delay(150);assert.equal(await evaluate('(()=>{const el=document.querySelector(".studio-upload-config-grid");return el.scrollWidth>el.clientWidth+1;})()'),false);await screenshot('mojing-upload-settings-'+theme+'-'+width+'.png');}
  }
  await call('Emulation.clearDeviceMetricsOverride');
  await click('[data-testid=studio-nav-assets]');await waitFor('Boolean(document.querySelector("[data-asset-id=upload-motion]"))','media card');
  await textButton('上传为模型参考','[data-asset-id=upload-motion]');await waitFor('Boolean(document.querySelector(".studio-upload-modal"))','upload dialog');await delay(350);await click('[data-testid=studio-start-upload]');
  await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.status==="failed"','injected post-upload verification failure');
  const first=await evaluate('uploadStudio.getState().uploadTasks.at(-1)');assert.equal(first.putConfirmed,true);assert.equal(first.error,'verify');assert.equal(await evaluate('!!uploadStudio.getState().assets.find(a=>a.id==="upload-motion").cloudUpload'),false);
  const firstPutCount=transfers.filter(t=>t.method==='PUT').length;assert.equal(firstPutCount,1);assert.equal(modelRequests.length,0);
  await delay(350);await reload();
  assert.equal(await evaluate('uploadSettings.getState().credentials.secretAccessKey'),'','storage secrets are not persisted');
  assert.equal(await evaluate('uploadSettings.getState().config.bucket'),'test-bucket');
  assert.equal(await evaluate(`uploadStudio.getState().uploadTasks.find(t=>t.id===${JSON.stringify(first.id)}).status`),'failed');
  await openSettings();await credentials();await click('[data-testid=studio-nav-tasks]');await waitFor('Boolean(document.querySelector("[data-testid=studio-retry-upload]"))','upload task retry');await click('[data-testid=studio-retry-upload]');
  await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.status==="completed"','retained-object verification');
  assert.equal(transfers.filter(t=>t.method==='PUT').length,firstPutCount,'retry checks an existing object without retransmission');
  const uploaded=await evaluate('uploadStudio.getState().assets.find(a=>a.id==="upload-motion")');assert.equal(uploaded.url,video);assert.ok(uploaded.cloudUpload.sha256);assert.equal(uploaded.width,160);assert.equal(uploaded.height,90);assert.ok(Math.abs(uploaded.durationSeconds-3)<0.1);assert.ok(Date.parse(uploaded.cloudUpload.expiresAt)>Date.now()+23*3600_000);
  assert.equal(await evaluate('localStorage.getItem("studio-media-upload-settings").includes("upload-fixture-secret")'),false);
  console.log('Raw MP4 upload, signed metadata, post-PUT failure, session-only credentials, persistence and verification without repeated PUT passed.');

  await click('[data-testid=studio-nav-video]');await evaluate(`uploadStudio.getState().setDraft({kind:'video',prompt:'UPLOADED_REFERENCE',endpointId:${JSON.stringify(endpointId)},model:'doubao-seedance-2-5-260628',controlMode:'reference',referenceAssetIds:[],videoReferenceAssetIds:[],audioReferenceAssetIds:[],durationSeconds:5})`);
  await waitFor('document.querySelector("#studio-creative-prompt")?.value==="UPLOADED_REFERENCE"','video draft');
  await textButton('上传本地参考','[data-testid=studio-video-references]');await waitFor('Boolean(document.querySelector(".studio-upload-modal"))','reference upload dialog');await delay(350);
  const document=await call('DOM.getDocument'),fileInput=await call('DOM.querySelector',{nodeId:document.root.nodeId,selector:'.studio-upload-modal input[type=file]'});
  await call('DOM.setFileInputFiles',{nodeId:fileInput.nodeId,files:[fileURLToPath(new URL('./fixtures/studio-reference.mp4',import.meta.url))]});
  await waitFor('uploadStudio.getState().assets.at(-1)?.name==="studio-reference.mp4"','native file import');
  const referenceId=await evaluate('uploadStudio.getState().assets.at(-1).id');await click('[data-testid=studio-start-upload]');await waitFor('!document.querySelector(".studio-upload-modal")','uploaded reference selected');
  await waitFor('[...document.querySelectorAll(".ant-select-selection-item")].some(el=>el.title?.startsWith("studio-reference.mp4"))','reference selection');
  await click('[data-testid=studio-generate]');await waitFor('uploadStudio.getState().jobs.at(-1)?.status==="completed"','video generation from uploaded file');
  const body=modelRequests.find(r=>r.method==='POST').body, videoInput=body.content.find(item=>item.type==='video_url');
  assert.match(videoInput.video_url.url,/^https:\/\/upload\.fixture\.test\/test-bucket\//);assert.equal(videoInput.role,'reference_video');assert.ok(!JSON.stringify(body).includes('upload-fixture-secret'));assert.ok(!JSON.stringify(body).includes(video));
  const modelCount=modelRequests.length,putCount=transfers.filter(t=>t.method==='PUT').length;
  await evaluate(`(()=>{const a=uploadStudio.getState().assets.find(a=>a.id===${JSON.stringify(referenceId)});uploadStudio.getState().updateAsset(a.id,{cloudUpload:{...a.cloudUpload,expiresAt:'2020-01-01T00:00:00Z'}});uploadStudio.getState().setDraft({kind:'video',prompt:'EXPIRED_UPLOAD',videoReferenceAssetIds:[a.id]});})()`);
  await waitFor('document.querySelector("#studio-creative-prompt")?.value==="EXPIRED_UPLOAD"','expired reference draft');await click('[data-testid=studio-generate]');await waitFor('uploadStudio.getState().jobs.at(-1)?.status==="failed"','expired reference rejected');assert.equal(modelRequests.length,modelCount);
  await click('[data-testid=studio-nav-tasks]');await click('[data-testid=studio-retry-upload]');await waitFor(`Date.parse(uploadStudio.getState().assets.find(a=>a.id===${JSON.stringify(referenceId)}).cloudUpload.expiresAt)>Date.now()+3600_000`,'renewed link');assert.equal(transfers.filter(t=>t.method==='PUT').length,putCount);
  console.log('Local reference upload selects the actual media, reaches the Seedance wire payload, blocks expired links and renews with no extra PUT or model request.');

  holdPut=true;
  const cancelled=await evaluate(`uploadAPI.startStudioMediaUpload('upload-cancel')`);await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.stage==="put"','in-flight transfer');
  for(let i=0;i<100&&!heldPut;i++)await delay(50);assert.ok(heldPut);
  assert.deepEqual(await evaluate(`uploadStudio.getState().trashAssets(['upload-cancel'])`),{changed:[],blocked:['upload-cancel']});
  await evaluate(`uploadAPI.cancelStudioMediaUpload(${JSON.stringify(cancelled)})`);await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.status==="cancelled"','cancelled transfer');
  await call('Fetch.failRequest',{requestId:heldPut,errorReason:'Aborted'}).catch(()=>{});heldPut=undefined;
  const cancelledPuts=transfers.filter(t=>t.method==='PUT').length;
  await evaluate(`uploadAPI.retryStudioMediaUpload(${JSON.stringify(cancelled)})`);await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.status==="completed"','ambiguous PUT recovered');assert.equal(transfers.filter(t=>t.method==='PUT').length,cancelledPuts);
  await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=80;c.height=80;c.getContext('2d').fillRect(0,0,80,80);uploadStudio.getState().addAsset({id:'upload-image',kind:'image',name:'PNG upload',category:'reference',createdAt:new Date().toISOString(),url:c.toDataURL()});uploadAPI.startStudioMediaUpload('upload-image');})()`);
  await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.status==="completed"','PNG upload');
  const wav=Buffer.alloc(44+48000);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(48000,40);
  await evaluate(`(()=>{uploadStudio.getState().addAsset({id:'upload-audio',kind:'audio',name:'WAV upload',category:'reference',createdAt:new Date().toISOString(),url:${JSON.stringify('data:audio/wav;base64,'+wav.toString('base64'))}});uploadAPI.startStudioMediaUpload('upload-audio');})()`);
  await waitFor('uploadStudio.getState().uploadTasks.at(-1)?.status==="completed"','WAV upload');assert.equal(await evaluate('uploadStudio.getState().assets.find(a=>a.id==="upload-audio").durationSeconds'),3);
  const packageCheck=await evaluate(`(async()=>{const {embedAssets}=await import('/src/services/video-studio/bundle.ts');const assets=await embedAssets(new Set(['upload-motion']),uploadStudio.getState().assets);return{media:assets[0].url.startsWith('data:'),cloud:'cloudUpload'in assets[0],signed:JSON.stringify(assets).includes('X-Amz-')};})()`);assert.deepEqual(packageCheck,{media:true,cloud:false,signed:false});
  const targetError=await evaluate(`(()=>{const s=uploadSettings.getState();s.configure({...s.config,bucket:'other-bucket'},s.credentials);try{uploadAPI.retryStudioMediaUpload(${JSON.stringify(cancelled)});return'';}catch(e){return e.message;}})()`);assert.equal(targetError,'target');
  await evaluate(`(()=>{const s=uploadSettings.getState();s.configure({...s.config,bucket:'test-bucket'},s.credentials);const t=uploadStudio.getState().uploadTasks.at(-1);uploadStudio.getState().saveUploadTask({...t,id:'interrupted-upload',status:'uploading'});})()`);await delay(350);const requestsBeforeReload=transfers.length;await reload();
  assert.equal(await evaluate('uploadStudio.getState().uploadTasks.find(t=>t.id==="interrupted-upload").status'),'interrupted');assert.equal(transfers.length,requestsBeforeReload,'reload must never restart uploads');
  const diagnostics=new Set(['https://api-beijing.klingai.com/','https://api.deepseek.com/','https://www.baidu.com/']);assert.deepEqual(blocked.filter(r=>!diagnostics.has(r.url)||!['HEAD','GET'].includes(r.method)||r.auth),[]);assert.deepEqual(browser.errors,[]);
  console.log('Cancellation with a lost PUT response, recycle protection, signed-link stripping, fixed targets and interrupted-task hydration passed. All storage and model services were mocked.');
}catch(error){console.error('Diagnostic:',await evaluate('({text:document.body.innerText.slice(-4000),tasks:window.uploadStudio?.getState().uploadTasks.map(t=>({id:t.id,name:t.name,status:t.status,stage:t.stage,error:t.error})),jobs:window.uploadStudio?.getState().jobs.map(j=>({name:j.name,status:j.status,error:j.error}))})').catch(()=>null));console.error('Runtime errors:',browser.errors);console.error('Screenshot:',await screenshot('mojing-upload-failure.png').catch(()=>null));throw error;}
finally{browser.close();}

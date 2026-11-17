import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/';
const browser = await chromeSession({ url: appUrl });
const { call, evaluate, waitFor, click, textButton, screenshot, delay } = browser;
const origin = new URL(appUrl).origin, requests = [], blocked = [];
let imageURI, videoURI, llmProposal, heldLLM, failMedia = false;
const eagleCalls = [], downloads = [];
const nativeClick = async (selector) => {
  const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing click target'); el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:1 });
  await call('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:1 });
};
const fill = async (selector, value) => { await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, 'input mount'); return evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing input '+${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`); };
const choose = async (label, option) => {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(label)}]`)}))`, 'select mount '+label);
  await nativeClick(`[aria-label=${JSON.stringify(label)}]`);
  await delay(200);
  if (!await evaluate('Boolean(document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)"))')) await nativeClick(`[aria-label=${JSON.stringify(label)}]`);
  await waitFor(`Boolean([...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(el=>el.title===${JSON.stringify(option)}||el.textContent===${JSON.stringify(option)}))`, 'select '+option);
  await evaluate(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(el=>el.title===${JSON.stringify(option)}||el.textContent===${JSON.stringify(option)}).click()`);
  await delay(100);
};
browser.onEvent((event) => {
  if (event.method === 'Runtime.consoleAPICalled') {
    const text = event.params.args.map((arg)=>arg.value||arg.description||'').join(' ');
    if (/WebGLProgram: Shader Error|VALIDATE_STATUS.*false|Failed to compile.*shader/i.test(text)) browser.errors.push(text);
  }
  if (event.method === 'Page.downloadWillBegin') downloads.push(event.params.suggestedFilename);
  if (event.method !== 'Fetch.requestPaused') return;
  void (async () => {
    const { request, requestId } = event.params, url = new URL(request.url);
    let result;
    if (url.origin === 'https://media.studio-fixture.test') {
      const wav = Buffer.alloc(44 + 32000); wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(32000,40);
      await call('Fetch.fulfillRequest', {requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'audio/wav'},{name:'Access-Control-Allow-Origin',value:origin}],body:wav.toString('base64')}); return;
    } else if (url.origin === 'http://127.0.0.1:41595') {
      if (request.method === 'OPTIONS') { await call('Fetch.fulfillRequest', {requestId,responseCode:204,responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Access-Control-Allow-Methods',value:'GET, POST, OPTIONS'},{name:'Access-Control-Allow-Headers',value:'content-type'}]}); return; }
      const body = request.postData ? JSON.parse(request.postData) : undefined;
      eagleCalls.push({path:url.pathname,query:url.search,method:request.method,body});
      if (url.pathname === '/api/library/info') result = { library:{path:'C:/Eagle/Fixture.library',name:'Fixture library'},folders:[{id:'f-one',name:'Product references'}] };
      else if (url.pathname === '/api/item/list') result = [{id:'item-one',name:'Fixture product',ext:'png',width:160,height:90}];
      else if (url.pathname === '/api/folder/create') result = {id:'f-created',name:body.folderName};
      else if (url.pathname === '/api/item/addFromURL') result = 'saved-item';
      else throw new Error('Unexpected Eagle mock '+url.pathname);
      await call('Fetch.fulfillRequest', {requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:origin}],body:Buffer.from(JSON.stringify({status:'success',data:result})).toString('base64')});
    } else if (url.origin === origin && url.pathname === '/__studio_mockrecipe.md') {
      await call('Fetch.fulfillRequest', {requestId,responseCode:200,body:Buffer.from('# Imported motion\nOne restrained action; preserve character identity.').toString('base64')});
    } else if (url.origin === origin && url.pathname.startsWith('/__studio_mockapi')) {
      const body = request.postData ? JSON.parse(request.postData) : undefined;
      requests.push({ path: url.pathname, method: request.method, body });
      if (url.pathname.endsWith('/output.webm')) {
        await call('Fetch.fulfillRequest', { requestId, responseCode: failMedia ? 503 : 200, responseHeaders: [{ name: 'Content-Type', value: 'video/webm' }], body: failMedia ? '' : videoURI.split(',')[1] });
        return;
      }
      if (url.pathname.endsWith('/images/generations')) result = { data: [{ b64_json: imageURI.split(',')[1] }] };
      else if (url.pathname.endsWith('/v1/videos')) result = { video_id: 'video_studio_fixture' };
      else if (url.pathname.endsWith('/api/v3/contents/generations/tasks')) result = { id: 'seedance-studio-fixture' };
      else if (url.pathname.endsWith('/api/v3/contents/generations/tasks/seedance-studio-fixture')) result = { status: 'succeeded', content: { video_url: origin + '/__studio_mockapi/output.webm' } };
      else if (url.pathname.endsWith('/agnesapi')) result = { status: 'completed', progress: 100, url: origin + '/__studio_mockapi/output.webm', seconds: 5 };
      else if (url.pathname.endsWith('/chat/completions')) {
        if (JSON.stringify(body).includes('QUEUE_GATE')) { heldLLM = requestId; return; }
        result = { choices: [{ message: { content: llmProposal || 'A concise creative result.' } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
      }
      else throw new Error(`Unhandled mock request ${url.pathname}`);
      await call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(result)).toString('base64') });
    } else if (url.origin === origin) await call('Fetch.continueRequest', { requestId });
    else { blocked.push({ url: url.href, method: request.method, hasAuthorization: Object.keys(request.headers).some((key) => /authorization|api-key/i.test(key)) }); await call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
  })().catch((error) => browser.errors.push(String(error)));
});

try {
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await call('Page.setDownloadBehavior', {behavior:'allow',downloadPath:process.env.TEMP || 'C:/Windows/Temp'});
  await call('Page.navigate', { url: appUrl });
  await waitFor('Boolean(document.querySelector(".ws-titlebar"))', 'application shell');
  await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))', 'studio hydration');
  const fixtureVideo='data:video/webm;base64,'+(await readFile(new URL('./fixtures/studio-output.webm',import.meta.url))).toString('base64');
  const fixtures = await evaluate(`(async () => {
    // Vite app imports may carry HMR timestamps. Use that URL to avoid creating a second store instance.
    const moduleURL = async (file, symbol) => { const source = await (await fetch(file)).text(); const line=source.split(String.fromCharCode(10)).find(line=>line.startsWith('import') && line.includes(symbol)); return line.slice(line.indexOf('"')+1,line.lastIndexOf('"')); };
    window.studioTest = (await import(await moduleURL('/src/components/VideoStudio/StudioWorkspace.tsx','useVideoStudioStore'))).useVideoStudioStore;
    window.providerTest = (await import(await moduleURL('/src/components/VideoStudio/StudioCreator.tsx','useProviderStore'))).useProviderStore;
    window.studioDownloadedBlobs=[];const createBlobURL=URL.createObjectURL.bind(URL);URL.createObjectURL=(blob)=>{studioDownloadedBlobs.push(blob);return createBlobURL(blob);};
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#546b9f'; ctx.fillRect(0,0,160,90); ctx.fillStyle='#f3d0a6'; ctx.fillRect(55,15,40,65);
    const image = canvas.toDataURL('image/png'); ctx.fillStyle = '#709c72'; ctx.fillRect(0,0,160,90); const composition = canvas.toDataURL('image/png');
    const video = ${JSON.stringify(fixtureVideo)};
    const p = providerTest.getState(); const add = (provider, category, models, suffix='') => p.addEndpoint({name:'Studio UI fixture '+provider,provider,category,models,baseUrl:location.origin+'/__studio_mockapi'+suffix,apiKey:'test-fixture',enabled:true});
    const imageId = add('agnes-image','image',['agnes-image-2.1-flash']); const videoId = add('agnes-video','video',['agnes-video-2.5-flash','agnes-video-2.5']); const llmId = add('openai','llm',['gpt-4o-mini']);
    p.setImageProvider('agnes-image','agnes-image-2.1-flash',imageId); p.setVideoProvider('agnes-video','agnes-video-2.5-flash',videoId); p.setLLMProvider('openai','gpt-4o-mini',llmId);
    studioTest.getState().addAsset({id:'fixture-cast',name:'Cast reference',kind:'image',category:'character',createdAt:new Date().toISOString(),url:image});
    studioTest.getState().addAsset({id:'fixture-composition',name:'Composition reference',kind:'image',category:'reference',createdAt:new Date().toISOString(),url:composition});
    const seedanceId=add('doubao-video','video',['doubao-seedance-2-0-260128','doubao-seedance-2-5-260628','doubao-seedance-2-5-flash-261115']);
    return {image,video,imageId,videoId,llmId,seedanceId};
  })()`);
  imageURI = fixtures.image; videoURI = fixtures.video;
  console.log('Studio fixtures configured; all external requests are blocked.');

  for (const name of ['home','image','video','assets','tasks','skills','plugins','canvas','projects','commerce','world']) {
    await click(`[data-testid=studio-nav-${name}]`);
    const selector = name === 'projects' ? '.video-view-shell' : ['home','image','video'].includes(name) ? '[data-testid=studio-creator]' : `[data-testid=studio-${name}]`;
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, name);
  }
  console.log('All 11 creative pages render.');

  await click('[data-testid=studio-nav-image]');
  await waitFor('Boolean(document.querySelector(".is-image [data-testid=studio-creator]"))', 'image editor mount');
  await evaluate(`studioTest.getState().setDraft({kind:'image',prompt:'A single consistent character in a bookstore.',imageSize:'4K',aspectRatio:'16:9',referenceAssetIds:['fixture-cast']})`);
  await waitFor('document.querySelector("#studio-creative-prompt")?.value.includes("bookstore")', 'image draft'); await click('[data-testid=studio-generate]');
  await waitFor('studioTest.getState().jobs.some(j=>j.status==="completed")', 'image output');
  const imageJob = await evaluate('studioTest.getState().jobs.at(-1)');
  const imageBody = requests.find((request) => request.path.endsWith('/images/generations')).body;
  assert.equal(imageBody.size, '4K');
  assert.ok(JSON.stringify(imageBody).includes(fixtures.image.split(',')[1]), 'actual request includes the cast reference');
  assert.equal(imageJob.input.model, 'agnes-image-2.1-flash');

  await click('[data-testid=studio-nav-video]');
  await waitFor('Boolean(document.querySelector(".is-video [data-testid=studio-creator]"))', 'video editor mount');
  await evaluate(`studioTest.getState().setDraft({kind:'video',prompt:'The actor turns once toward the window. Slow push in.',controlMode:'reference',referenceAssetIds:['fixture-cast'],durationSeconds:5})`);
  await waitFor('document.querySelector("#studio-creative-prompt")?.value.includes("window")', 'video draft'); await click('[data-testid=studio-generate]');
  await waitFor('studioTest.getState().jobs.filter(j=>j.status==="completed").length===2', 'video output');
  const videoBody = requests.find((request) => request.path.endsWith('/v1/videos')).body;
  assert.equal(videoBody.model, 'agnes-video-2.5-flash'); assert.equal(videoBody.size, '720P');
  assert.match(JSON.stringify(videoBody), /Picture 1/);
  console.log('Image 4K and video subject references reach the mocked native API.');

  await click('[data-testid=studio-nav-assets]');
  const openOriginalEditor = async () => {
    await waitFor('Boolean(document.querySelector("[data-testid=studio-assets]"))','asset library');
    await evaluate(`(()=>{const card=[...document.querySelectorAll('[data-testid=studio-assets] article')].find(el=>el.querySelector('strong')?.textContent==='Cast reference');[...card.querySelectorAll('button')].find(el=>el.textContent==='编辑图片').click();})()`);
    await waitFor('document.querySelector(".studio-image-editor canvas")?.width===160','image editor loaded');
    await delay(350); // Ant's modal zoom must settle before measuring pointer coordinates.
  };
  const dragImageRegion = async () => {
    const box=await evaluate(`(()=>{const r=document.querySelector('[data-testid=studio-image-edit-surface]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
    const from={x:box.x+box.w*.25,y:box.y+box.h*.25},to={x:box.x+box.w*.75,y:box.y+box.h*.75};
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:1});
    await waitFor('Boolean(document.querySelector(".studio-image-editor-region"))','image selection');
  };
  await openOriginalEditor(); await textButton('旋转90°','.studio-image-editor');
  await waitFor('document.querySelector(".studio-image-editor canvas")?.width===90','rotated image');
  await evaluate(`[...document.querySelectorAll('.studio-image-editor .ant-segmented-item')].find(el=>el.textContent==='裁剪').click()`); await dragImageRegion();
  await click('[data-testid=studio-image-save-copy]'); await waitFor('!document.querySelector(".studio-image-editor")','saved crop');
  const crop=await evaluate('studioTest.getState().assets.at(-1)'); assert.ok(Math.abs(crop.width-45)<=1 && Math.abs(crop.height-80)<=1, 'central half crop is accurate within one source pixel after browser pointer rounding');
  assert.equal(await evaluate('studioTest.getState().assets.find(a=>a.id==="fixture-cast").url'),fixtures.image,'editing preserves the original');
  await openOriginalEditor(); await dragImageRegion();
  await fill('.studio-image-editor textarea[aria-label="修改要求"]','REGION_EDIT_UI: change only the selected background to dusk.');
  await screenshot('mojing-studio-image-editor-dark-20261116.png');
  await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme('light');})()`); await delay(250);
  await screenshot('mojing-studio-image-editor-light-20261116.png');
  await call('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false}); await delay(250);
  const imageGeometry=await evaluate(`(()=>{const root=document.querySelector('.studio-image-editor-layout'),a=root.querySelector('section').getBoundingClientRect(),b=root.querySelector('aside').getBoundingClientRect();return {overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,overflow:root.scrollWidth>root.clientWidth+1};})()`);
  assert.deepEqual(imageGeometry,{overlap:false,overflow:false}); await screenshot('mojing-studio-image-editor-900-20261116.png');
  await call('Emulation.clearDeviceMetricsOverride');
  await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme('dark');})()`);
  await click('[data-testid=studio-image-ai-edit]'); await waitFor('studioTest.getState().jobs.some(j=>j.input.prompt.includes("REGION_EDIT_UI")&&j.status==="completed")','region image edit');
  const regionRequest=requests.filter(r=>r.path.endsWith('/images/generations')).at(-1).body;
  assert.equal(regionRequest.extra_body.image.length,2); assert.ok(regionRequest.extra_body.image[0].includes(fixtures.image.split(',')[1])); assert.notEqual(regionRequest.extra_body.image[0],regionRequest.extra_body.image[1]); assert.match(regionRequest.prompt,/only a location guide/);

  await click('[data-testid=studio-nav-video]');
  await evaluate(`studioTest.getState().setDraft({kind:'video',prompt:'AUDIO_ONLY_UI: move with the reference rhythm',controlMode:'text',referenceAssetIds:[],firstFrameAssetId:undefined,lastFrameAssetId:undefined,audioReferenceAssetIds:[],videoReferenceAssetIds:[],endpointId:${JSON.stringify(fixtures.videoId)},model:'agnes-video-2.5-flash'})`);
  await waitFor('document.querySelector("#studio-creative-prompt")?.value.startsWith("AUDIO_ONLY_UI")','audio reference draft');
  assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=视频参考]"))'),false,'Flash does not offer video references');
  await textButton('导入素材链接','[data-testid=studio-video-references]');
  await fill('.studio-link-import input[aria-label="公网素材链接"]','https://media.studio-fixture.test/voice.wav'); await fill('.studio-link-import input[aria-label="名称"]','Voice rhythm fixture');
  await click('.studio-link-import .ant-modal-footer .ant-btn-primary'); await waitFor('!document.querySelector(".studio-link-import")','audio URL import');
  const voiceAsset=await evaluate('studioTest.getState().assets.at(-1)'); assert.equal(voiceAsset.kind,'audio'); assert.equal(voiceAsset.durationSeconds,2);
  await click('[data-testid=studio-generate]'); await waitFor('studioTest.getState().jobs.some(j=>j.input.prompt.startsWith("AUDIO_ONLY_UI")&&j.status==="completed")','audio-only Flash request');
  const audioRequest=requests.filter(r=>r.path.endsWith('/v1/videos')).at(-1).body; assert.equal(audioRequest.mode,'reference'); assert.deepEqual(audioRequest.audios,[voiceAsset.sourceUrl]); assert.equal(audioRequest.images,undefined);
  await evaluate(`(()=>{studioTest.getState().addAsset({id:'fixture-motion',name:'Motion reference',kind:'video',category:'reference',createdAt:new Date().toISOString(),url:'https://media.studio-fixture.test/motion.mp4',mimeType:'video/mp4',durationSeconds:5});studioTest.getState().setDraft({kind:'video',prompt:'SEEDANCE_MEDIA_UI',endpointId:${JSON.stringify(fixtures.seedanceId)},model:'doubao-seedance-2-5-260628',controlMode:'reference',referenceAssetIds:['fixture-cast'],audioReferenceAssetIds:[${JSON.stringify(voiceAsset.id)}],videoReferenceAssetIds:['fixture-motion'],generateAudio:true});})()`);
  await waitFor('document.querySelector("#studio-creative-prompt")?.value==="SEEDANCE_MEDIA_UI" && Boolean(document.querySelector("[aria-label=视频参考]"))','Seedance media inputs');
  await click('[data-testid=studio-generate]'); await waitFor('studioTest.getState().jobs.some(j=>j.input.prompt==="SEEDANCE_MEDIA_UI"&&j.status==="completed")','Seedance multimedia request');
  const seedanceRequest=requests.find(r=>r.path.endsWith('/api/v3/contents/generations/tasks')).body;
  assert.equal(seedanceRequest.generate_audio,true); assert.ok(seedanceRequest.content.some(c=>c.role==='reference_audio'&&c.audio_url.url===voiceAsset.sourceUrl)); assert.ok(seedanceRequest.content.some(c=>c.role==='reference_video'));
  const mediaSnapshot=await evaluate('(()=>{const s=studioTest.getState();return s.assets.find(a=>a.jobId===s.jobs.find(j=>j.input.prompt==="SEEDANCE_MEDIA_UI").id).requestSnapshot;})()');
  assert.deepEqual(mediaSnapshot.referenceSlots.filter(s=>s.mediaKind).map(s=>s.mediaKind),['audio','video']);
  const beforeBadMedia=requests.length;
  const mediaRejections=await evaluate(`(async()=>{const {submitStudioJob}=await import('/src/services/video-studio/generation.ts');const {initialStudioInput}=await import('/src/services/video-studio/input.ts');const base={...initialStudioInput(),prompt:'INVALID_MEDIA_UI',endpointId:${JSON.stringify(fixtures.videoId)},model:'agnes-video-2.5-flash'};return [{...base,controlMode:'reference',videoReferenceAssetIds:['fixture-motion']},{...base,controlMode:'keyframe',firstFrameAssetId:'fixture-cast',referenceAssetIds:['fixture-cast']},{...base,controlMode:'reference',firstFrameAssetId:'fixture-cast',referenceAssetIds:['fixture-cast']}].map(input=>{try{submitStudioJob(input);return 'sent';}catch(error){return error.message;}});})()`);
  assert.ok(mediaRejections.every(message=>message!=='sent')); assert.equal(requests.length,beforeBadMedia,'incompatible inputs do not call a provider');
  await evaluate(`providerTest.getState().setVideoProvider('agnes-video','agnes-video-2.5-flash',${JSON.stringify(fixtures.videoId)})`);
  console.log('Image crop/rotate/region requests and Flash audio/Seedance multimedia UI reach the native adapters.');

  const previs = await evaluate(`(async()=>{
    const {generateSingleKeyframe} = await import('/src/services/video/core/step-keyframe.ts');
    const refs = studioTest.getState().assets;
    const shot={id:'previs-shot',index:0,sourceText:'Ada waves beside the table.',videoPrompt:'Ada waves once.',imagePrompt:'Ada by the table.',durationSeconds:5,characterIds:['ada'],visibleCharacterIds:['ada'],characterBinding:'explicit',previsReferenceImage:refs.find(a=>a.id==='fixture-composition').url,transition:'cut'};
    const result=await generateSingleKeyframe(shot,0,[shot],{characters:[{id:'ada',name:'Ada',appearance:'adult woman with short hair and a blue coat',portraitImage:refs.find(a=>a.id==='fixture-cast').url}],scenes:[],aspectRatio:'16:9',imageTier:'fast',imageEndpointId:${JSON.stringify(fixtures.imageId)},imageModel:'agnes-image-2.1-flash',novelProjectId:'studio-ui-previs',requireCharacterReferences:true});
    return {references:result.referenceAssets.map(r=>({label:r.label,status:r.status,kind:r.kind})),request:result.generationPlan.keyframe?.requestSnapshot};
  })()`);
  const previsBody = requests.filter((request) => request.path.endsWith('/images/generations')).at(-1).body;
  assert.ok(JSON.stringify(previsBody).includes(fixtures.image.split(',')[1]));
  assert.ok(JSON.stringify(previsBody).includes(await evaluate('studioTest.getState().assets.find(a=>a.id==="fixture-composition").url.split(",")[1]')));
  assert.match(JSON.stringify(previsBody), /composition and camera only/);
  console.log('Project keyframe generation sends both cast identity and the explicit 3D composition reference.');

  const canvasId = await evaluate(`(async()=>{const {createStudioCanvas}=await import('/src/services/video-studio/document.ts'); const c=createStudioCanvas('Fixture dependency canvas'); c.nodes=[{id:'n-image',kind:'image',name:'Keyframe',prompt:'Ada in the bookstore',x:0,y:0},{id:'n-video',kind:'video',name:'Motion',prompt:'Ada waves once',x:340,y:0,generation:{resolution:'1080p'}}];c.edges=[{id:'edge',from:'n-image',to:'n-video'}];studioTest.getState().saveCanvas(c);return c.id;})()`);
  await click('[data-testid=studio-nav-canvas]'); await waitFor('document.querySelectorAll(".studio-canvas-node").length===2', 'canvas nodes');
  await textButton('全选节点', '.studio-canvas-toolbar'); await delay(100); await textButton('生成选中2项', '.studio-canvas-toolbar');
  await waitFor('studioTest.getState().jobs.filter(j=>j.canvasId).length===2 && studioTest.getState().jobs.filter(j=>j.canvasId).every(j=>j.status==="completed")', 'dependent graph generation', 25000);
  const graph = await evaluate(`studioTest.getState().canvases.find(c=>c.id===${JSON.stringify(canvasId)})`);
  assert.ok(graph.nodes.every((node) => node.assetId));
  assert.equal(await evaluate('studioTest.getState().jobs.find(j=>j.nodeId==="n-video").input.resolution'),'720p','the queued graph snapshot records the model-supported resolution');
  const resizePoint=await evaluate('(()=>{const el=document.querySelector("[data-node-id=n-image] .studio-canvas-resize"),r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:el.parentElement.offsetWidth};})()');
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:resizePoint.x,y:resizePoint.y,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:resizePoint.x+80,y:resizePoint.y+45,buttons:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:resizePoint.x+80,y:resizePoint.y+45,button:'left',clickCount:1});
  await waitFor('studioTest.getState().canvases[0].nodes[0].width===340','resize commits geometry');
  await waitFor('document.querySelector(".studio-canvas-edges path")?.getAttribute("d").startsWith("M340 ")','measured edge follows resized output port');
  const wireStart=await evaluate('document.querySelector(".studio-canvas-edges path").getAttribute("d")');assert.ok(wireStart.startsWith('M340 '),'edge follows resized output port');
  await textButton('全选节点','.studio-canvas-toolbar');
  await textButton('编组', '.studio-canvas-toolbar');
  await waitFor('document.querySelectorAll(".studio-canvas-group").length===1', 'group selected graph');
  await textButton('复制', '.studio-canvas-toolbar'); await waitFor('document.querySelectorAll(".studio-canvas-node").length===4', 'duplicate selected graph');
  assert.equal(await evaluate('document.querySelectorAll(".studio-canvas-group").length'), 2);
  await textButton('全选节点', '.studio-canvas-toolbar');
  await textButton('锁定布局','.studio-canvas-toolbar');
  await waitFor('studioTest.getState().canvases[0].nodes.every(n=>n.layoutLocked)','layout locks persist');
  assert.equal(await evaluate('document.querySelectorAll(".studio-canvas-resize").length'),0);
  await textButton('解锁布局','.studio-canvas-toolbar');
  const beforeDrag = await evaluate('studioTest.getState().canvases[0].nodes.map(({id,x,y})=>({id,x,y}))');
  const dragPoint = await evaluate(`(()=>{const r=document.querySelector('[data-node-id=n-image] header').getBoundingClientRect();return {x:r.left+35,y:r.top+10};})()`);
  await call('Input.dispatchMouseEvent', {type:'mousePressed',...dragPoint,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseMoved',x:dragPoint.x+60,y:dragPoint.y+30,button:'left',buttons:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased',x:dragPoint.x+60,y:dragPoint.y+30,button:'left',clickCount:1});
  await waitFor(`studioTest.getState().canvases[0].nodes[0].x!==${beforeDrag[0].x}`, 'move complete selection');
  const afterDrag = await evaluate('studioTest.getState().canvases[0].nodes.map(({id,x,y})=>({id,x,y}))');
  for (let i=0;i<beforeDrag.length;i++) { assert.equal(afterDrag[i].x-beforeDrag[i].x,60);assert.equal(afterDrag[i].y-beforeDrag[i].y,30); }
  await evaluate(`(async()=>{const {exportCanvasBundle}=await import('/src/services/video-studio/bundle.ts');const {parseStudioBundle}=await import('/src/services/video-studio/document.ts'); const s=studioTest.getState(); const c=s.canvases.find(c=>c.id===${JSON.stringify(canvasId)}); const raw=await exportCanvasBundle(c,s.assets,s.worlds);const imported=parseStudioBundle(raw,'canvas');if(imported.assets.some(a=>s.assets.some(old=>old.id===a.id)))throw new Error('Import overwrote asset IDs');window.canvasBundleTest=raw;})()`);
  console.log('Canvas dependency execution, grouping, whole-selection drag, duplication and portable media bundle passed.');

  await evaluate(`(()=>{const s=studioTest.getState(),doc=s.canvases[0];s.updateAsset('fixture-motion',{url:${JSON.stringify(fixtures.video)},sourceUrl:'https://media.studio-fixture.test/motion.mp4'});s.saveCanvas({...doc,nodes:[...doc.nodes.map(n=>n.id==='n-video'?{...n,prompt:'GRAPH_MEDIA_UI',generation:{endpointId:${JSON.stringify(fixtures.seedanceId)},model:'doubao-seedance-2-5-260628',generateAudio:true}}:n),{id:'n-audio-source',kind:'audio',name:'Voice rhythm',assetId:${JSON.stringify(voiceAsset.id)},prompt:'',x:0,y:700},{id:'n-video-source',kind:'video',name:'Motion source',assetId:'fixture-motion',prompt:'',x:340,y:700}],edges:[...doc.edges,{id:'audio-edge',from:'n-audio-source',to:'n-video'},{id:'video-edge',from:'n-video-source',to:'n-video'}]});})()`);
  await click('[data-node-id=n-video] footer button');
  await waitFor('studioTest.getState().jobs.some(j=>j.input.prompt==="GRAPH_MEDIA_UI"&&j.status==="completed")','audio/video graph connections');
  const graphMedia=requests.filter(r=>r.path.endsWith('/api/v3/contents/generations/tasks')).at(-1).body;
  assert.ok(graphMedia.content.some(c=>c.role==='reference_audio')); assert.ok(graphMedia.content.some(c=>c.role==='reference_video'));
  await evaluate(`(async()=>{const {exportCanvasBundle}=await import('/src/services/video-studio/bundle.ts');const {parseStudioBundle}=await import('/src/services/video-studio/document.ts');const s=studioTest.getState(),doc=s.canvases[0];const raw=await exportCanvasBundle(doc,s.assets,s.worlds);const imported=parseStudioBundle(raw,'canvas');if(!imported.assets.some(a=>a.kind==='audio')||!imported.assets.some(a=>a.kind==='video'&&a.sourceUrl))throw new Error('Portable media references are missing');})()`);
  await evaluate(`(async()=>{const source=await(await fetch('/src/components/VideoStudio/StudioProjectTransfer.tsx')).text();const line=source.split(String.fromCharCode(10)).find(line=>line.startsWith('import')&&line.includes('useVideoStore'));window.shotProjectTest=(await import(line.slice(line.indexOf('"')+1,line.lastIndexOf('"')))).useVideoStore;const v=shotProjectTest.getState();v.initProject('studio-transfer-fixture',[],{style:'cinematic',aspectRatio:'16:9',shotDurationSeconds:5},'Studio transfer fixture');v.setSceneSpec('studio-transfer-fixture',{characters:[],scenes:[],props:[],meta:{title:'Studio transfer fixture',style:'cinematic',aspectRatio:'16:9',defaultShotDuration:5,sourceMode:'multishot',channel:'direct'},shots:[{id:'transfer-shot',index:0,sourceText:'An existing approved shot',videoPrompt:'An existing approved shot',durationSeconds:5,characterIds:[],keyframeImage:${JSON.stringify(fixtures.image)},selectedVersionId:'existing-video',lockedVersionId:'existing-video',versionHistory:[{id:'existing-video',type:'video',url:${JSON.stringify(fixtures.video)},createdAt:new Date().toISOString(),reviewStatus:'approved'}]}]});v.addClip('studio-transfer-fixture',{shotId:'transfer-shot',shotVersionId:'existing-video',videoUrl:${JSON.stringify(fixtures.video)},provider:'agnes-video',model:'agnes-video-2.5-flash',durationSeconds:5,hasAudio:false,generatedAt:new Date().toISOString()});v.setFinalVideo('studio-transfer-fixture','existing-final.mp4');})()`);
  await nativeClick('[data-node-id=n-video] header'); await textButton('发送到分镜','.studio-canvas-inspector');
  await choose('选择项目','Studio transfer fixture'); await choose('选择镜头','#1 An existing approved shot');
  await click('.studio-project-transfer .ant-modal-footer .ant-btn-primary'); await waitFor('!document.querySelector(".studio-project-transfer")','candidate transfer');
  const candidate=await evaluate('(()=>{const p=shotProjectTest.getState().projects["studio-transfer-fixture"];return {shot:p.sceneSpec.shots[0],clip:p.clips[0],final:p.finalVideoUrl};})()');
  assert.equal(candidate.shot.selectedVersionId,'existing-video'); assert.equal(candidate.shot.lockedVersionId,'existing-video'); assert.equal(candidate.final,'existing-final.mp4'); assert.equal(candidate.clip.shotVersionId,'existing-video');
  assert.equal(candidate.shot.versionHistory[0].reviewStatus,'unreviewed'); assert.ok(candidate.shot.versionHistory[0].sourceStudioAssetId); assert.equal(candidate.shot.versionHistory[0].inputFingerprint,undefined,'import cannot fabricate a shot generation receipt');
  await click('[data-testid=studio-nav-assets]');
  await evaluate(`(()=>{const card=[...document.querySelectorAll('[data-testid=studio-assets] article')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(crop.name)});[...card.querySelectorAll('button')].find(el=>el.textContent==='发送到分镜').click();})()`);
  await choose('选择项目','Studio transfer fixture'); await choose('选择镜头','#1 An existing approved shot');
  await click('.studio-project-transfer .ant-modal-footer .ant-btn-primary'); await waitFor('!document.querySelector(".studio-project-transfer")','shot reference transfer');
  const replaced=await evaluate('(()=>{const p=shotProjectTest.getState().projects["studio-transfer-fixture"];return {shot:p.sceneSpec.shots[0],clips:p.clips.length,final:p.finalVideoUrl};})()');
  assert.ok(replaced.shot.manualReferenceImage); assert.equal(replaced.shot.keyframeImage,undefined); assert.equal(replaced.shot.lockedVersionId,undefined); assert.equal(replaced.clips,0); assert.equal(replaced.final,undefined);
  llmProposal=JSON.stringify({overallScore:94,summary:'Decoded output matches the shot',checks:['subject_count','subject_identity','scene_match','composition','temporal_consistency'].map(id=>({id,status:'pass',score:94,message:'Fixture review passed'}))});
  await evaluate('shotProjectTest.setState(s=>({projects:{...s.projects,["studio-transfer-fixture"]:{...s.projects["studio-transfer-fixture"],options:{...s.projects["studio-transfer-fixture"].options,enableVisualQualityGate:true,blockOnVisualReviewUnavailable:true}}}}))');
  await click('[data-testid=studio-nav-canvas]');
  await nativeClick('[data-node-id=n-video] header');await textButton('发送到分镜','.studio-canvas-inspector');
  await choose('选择项目','Studio transfer fixture');await choose('选择镜头','#1 An existing approved shot');await choose('使用方式','检查后进入正式审片');
  await click('.studio-project-transfer .ant-modal-footer .ant-btn-primary');await waitFor('!document.querySelector(".studio-project-transfer")','inspected video adoption',25000);
  const adopted=await evaluate('(()=>{const p=shotProjectTest.getState().projects["studio-transfer-fixture"];return {shot:p.sceneSpec.shots[0],clip:p.clips[0],final:p.finalVideoUrl};})()');
  assert.equal(adopted.clip.visualReview.status,'passed');assert.ok(requests.some(r=>r.path.endsWith('/chat/completions')&&JSON.stringify(r.body).includes('sampled output frame')));
  assert.ok(adopted.clip.importedVideo);assert.match(adopted.clip.importedVideo.sha256,/^[a-f0-9]{64}$/);assert.equal(adopted.clip.importedVideo.width,160);assert.equal(adopted.clip.importedVideo.height,90);assert.ok(adopted.clip.durationSeconds>0);assert.ok(adopted.clip.lastFrameImage.startsWith('data:image/'));assert.equal(adopted.clip.hasAudio,true);assert.equal(adopted.shot.versionHistory[0].reviewStatus,'unreviewed');assert.equal(adopted.shot.lockedVersionId,undefined);assert.equal(adopted.final,undefined);
  const gate=await evaluate('(async()=>{const {isShotAssemblyReady}=await import("/src/services/video/core/shot-production-contract.ts");const v=shotProjectTest.getState(),p=v.projects["studio-transfer-fixture"],shot=p.sceneSpec.shots[0],version=shot.versionHistory[0];const early=v.lockShotVersion("studio-transfer-fixture",shot.id,version.id);v.reviewShotVersion("studio-transfer-fixture",shot.id,version.id,"approved");const locked=v.lockShotVersion("studio-transfer-fixture",shot.id,version.id);const after=shotProjectTest.getState().projects["studio-transfer-fixture"];const ready=isShotAssemblyReady(after.sceneSpec.shots[0],after.clips[0]);v.updateSceneSpecShot("studio-transfer-fixture",shot.id,{videoPrompt:"Changed after approval"});const changed=shotProjectTest.getState().projects["studio-transfer-fixture"];return {early,locked,ready,invalidated:!isShotAssemblyReady(changed.sceneSpec.shots[0],changed.clips[0])};})()');
  assert.deepEqual(gate,{early:false,locked:true,ready:true,invalidated:true});
  await evaluate('(async()=>{const {inspectStudioVideo}=await import("/src/services/video-studio/inspect-video.ts");try{await inspectStudioVideo("data:video/mp4;base64,YnJva2Vu");throw Error("corrupt video accepted");}catch(error){if(error.message==="corrupt video accepted")throw error;}})()');
  llmProposal=undefined;
  console.log('Inspected imported video decodes real frames, creates a missing clip, requires human approval and invalidates on shot changes.');
  console.log('Canvas audio/video edges, portable sources, candidate transfer preservation and reference invalidation passed.');

  await click('[data-testid=studio-nav-world]'); await choose('场景模板', '双人对话'); await textButton('新世界', '.world-engine-toolbar');
  await waitFor('Boolean(document.querySelector("[data-testid=world-viewport] canvas"))', 'WebGL viewport');
  assert.equal(await evaluate('Boolean(document.querySelector(".world-engine-stage .ant-alert-error"))'), false);
  await evaluate(`document.querySelectorAll('[data-testid=world-object-item]')[0].click()`);
  await textButton('A → B 行走', '.world-engine-inspector');
  await waitFor('studioTest.getState().worlds[0].objects[0].keyframes.length===2', 'A/B actor animation');
  await textButton('绘制轨迹','.world-engine-output-actions');
  const pathArea=await evaluate(`(()=>{const r=document.querySelector('[data-testid=world-viewport] canvas').getBoundingClientRect();return {x:r.x+r.width*.4,y:r.y+r.height*.75,step:r.width*.045};})()`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:pathArea.x,y:pathArea.y,button:'left',clickCount:1});
  for(let i=1;i<=5;i++)await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:pathArea.x+pathArea.step*i,y:pathArea.y-8*i,button:'left',buttons:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:pathArea.x+pathArea.step*5,y:pathArea.y-40,button:'left',clickCount:1});
  await waitFor('studioTest.getState().worlds[0].objects[0].keyframes.length>2','ground path drawing');
  await choose('姿态预设', '坐姿');
  assert.ok(await evaluate('studioTest.getState().worlds[0].objects[0].keyframes[0].pose.joints.leftHip[0]<-1'));
  await fill('input[aria-label="关节旋转 X"]', '35'); await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await nativeClick('.world-engine-object-tree > button');
  await choose('运镜预设', '缓慢推进');
  await waitFor('studioTest.getState().worlds[0].camera.keyframes.length===2', 'camera movement');
  await textButton('保存机位方案', '.world-engine-inspector');
  assert.equal(await evaluate('studioTest.getState().worlds[0].cameraBookmarks.length'),1);
  await textButton('AI 导演', '.world-engine-toolbar');
  llmProposal = await evaluate('JSON.stringify({...studioTest.getState().worlds[0],name:"Director staged scene",environment:"sunset"})');
  await fill('textarea[aria-label="描述制作意图"]','Stage a quiet sunset encounter with a slow camera push.');
  await textButton('生成制作方案', '.ant-modal');
  await waitFor('Boolean(document.querySelector(".ant-modal pre"))', 'director proposal');
  assert.notEqual(await evaluate('studioTest.getState().worlds[0].name'),'Director staged scene','a proposal does not apply itself');
  await textButton('应用此方案', '.ant-modal');
  await waitFor('studioTest.getState().worlds[0].name==="Director staged scene"', 'apply director proposal'); llmProposal = undefined;
  await waitFor('![...document.querySelectorAll(".ant-modal-wrap")].some(el=>getComputedStyle(el).display!=="none")','director modal closed');
  await evaluate(`(()=>{
    const binary=new Float32Array([-.5,0,0,.5,0,0,0,1,0,0,1,0,0,0,1,0,0]);
    const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'AnimatedTriangle'}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[.2,.5,.8,1],metallicFactor:0,roughnessFactor:1},doubleSided:true}],buffers:[{byteLength:binary.byteLength}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:8},{buffer:0,byteOffset:44,byteLength:24}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-.5,0,0],max:[.5,1,0]},{bufferView:1,componentType:5126,count:2,type:'SCALAR',min:[0],max:[1]},{bufferView:2,componentType:5126,count:2,type:'VEC3'}],animations:[{name:'Slide',samplers:[{input:1,output:2,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:0,path:'translation'}}]}]};
    const raw=new TextEncoder().encode(JSON.stringify(json)),padded=Math.ceil(raw.length/4)*4,buffer=new ArrayBuffer(28+padded+binary.byteLength),view=new DataView(buffer);
    view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,buffer.byteLength,true);view.setUint32(12,padded,true);view.setUint32(16,0x4e4f534a,true);new Uint8Array(buffer,20,padded).fill(32);new Uint8Array(buffer,20,raw.length).set(raw);view.setUint32(20+padded,binary.byteLength,true);view.setUint32(24+padded,0x004e4942,true);new Uint8Array(buffer,28+padded).set(new Uint8Array(binary.buffer));
    const transfer=new DataTransfer();transfer.items.add(new File([buffer],'Animated fixture.glb',{type:'model/gltf-binary'}));const input=document.querySelector('input[accept=".glb"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('Boolean(document.querySelector("[aria-label=模型动画]"))','embedded GLB animation metadata');
  await choose('模型动画','Slide · 1.0s');
  assert.equal(await evaluate('studioTest.getState().worlds[0].objects.find(o=>o.kind==="model").animationClip'),0);
  await evaluate(`[...document.querySelectorAll('.world-engine-view-toolbar .ant-segmented-item-label')].find(el=>el.textContent==='深度').click()`);
  await delay(300);
  await textButton('保存参考画面','.world-engine-output-actions');
  await waitFor('studioTest.getState().assets.some(a=>a.worldId&&a.kind==="image")','depth render with GLB');
  await evaluate(`[...document.querySelectorAll('.world-engine-view-toolbar .ant-segmented-item-label')].find(el=>el.textContent==='材质').click()`);
  await textButton('保存参考画面', '.world-engine-output-actions');
  await waitFor('studioTest.getState().assets.some(a=>a.worldId && a.kind==="image")', 'previs frame');
  const frameSize = await evaluate(`(async()=>{const a=studioTest.getState().assets.find(a=>a.worldId && a.kind==='image');const img=new Image();img.src=a.url;await img.decode();return [img.width,img.height];})()`);
  assert.deepEqual(frameSize, [1280,720]);
  await screenshot('mojing-studio-world-dark-20261116.png');
  await evaluate(`window.studioEncoder=VideoEncoder;window.VideoEncoder=class extends window.studioEncoder{configure(){throw new Error('Fixture encoder setup failure')}};`);
  await textButton('导出预演视频', '.world-engine-output-actions');
  await waitFor('!document.querySelector(".world-engine-output-actions .ant-btn-loading")', 'recording failure cleanup');
  assert.equal(await evaluate('studioTest.getState().assets.filter(a=>a.worldId&&a.kind==="video").length'), 0, 'failed encoding produces no video asset');
  await evaluate('window.VideoEncoder=window.studioEncoder');
  const previsStartedAt = Date.now();
  await textButton('导出预演视频', '.world-engine-output-actions');
  await waitFor('studioTest.getState().assets.some(a=>a.worldId && a.kind==="video")', 'previs video export', 90000);
  console.log('World previs encoding completed in ' + ((Date.now() - previsStartedAt) / 1000).toFixed(2) + 's.');
  const clipSize = await evaluate(`(async()=>{const a=studioTest.getState().assets.find(a=>a.worldId&&a.kind==='video');const v=document.createElement('video');v.src=a.url;await new Promise((ok,fail)=>{v.onloadedmetadata=ok;v.onerror=fail;});return [v.videoWidth,v.videoHeight];})()`);
  assert.deepEqual(clipSize, [1280,720]);
  await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme('light');})()`); await delay(200);
  await screenshot('mojing-studio-world-light-20261116.png');
  await call('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false }); await delay(300);
  assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+2'), '900px layout has no page overflow');
  assert.ok(await evaluate(`document.querySelector('.world-engine-inspector').getBoundingClientRect().top >= document.querySelector('.world-engine-stage').getBoundingClientRect().bottom - 1`), '900px inspector follows the entire preview stage');
  await screenshot('mojing-studio-world-900-20261116.png');
  await call('Emulation.clearDeviceMetricsOverride');
  console.log('World WebGL, actor pose, A/B keyframes, camera moves, reviewed AI direction, animated GLB import, depth render, recorder cleanup, 1280×720 exports and two themes passed.');

  await click('[data-testid=studio-nav-commerce]'); await textButton('商品项目', '.video-studio-toolbar');
  await textButton('使用三图方案', '.studio-commerce-production');
  assert.equal(await evaluate('studioTest.getState().commerceProjects[0].plan.length'), 3);
  await fill('.studio-commerce-brief label:nth-of-type(1) textarea','A blue ceramic cup');
  llmProposal=JSON.stringify({materials:[{name:'Product hero',prompt:'Keep the exact blue ceramic cup on a neutral counter.'},{name:'Handle detail',prompt:'A close view of the same ceramic handle, side lighting.'},{name:'At home',prompt:'The same cup beside a book in a quiet kitchen.'}]});
  await textButton('AI 策划画面', '.studio-commerce-production');
  await waitFor('studioTest.getState().commerceProjects[0].plan[0]?.name==="Product hero"','commerce AI plan'); llmProposal=undefined;
  await textButton('生成选中3张', '.studio-commerce-production');
  await waitFor('studioTest.getState().commerceProjects[0].jobIds.length===3 && studioTest.getState().commerceProjects[0].jobIds.every(id=>studioTest.getState().jobs.find(j=>j.id===id)?.status==="completed")','commerce batch');
  await textButton('导出作品联系表', '.studio-commerce-production');
  await waitFor('studioDownloadedBlobs.at(-1)?.type==="image/png"','contact-sheet PNG');
  assert.deepEqual(await evaluate('(async()=>{const bitmap=await createImageBitmap(studioDownloadedBlobs.at(-1));const size=[bitmap.width,bitmap.height];bitmap.close();return size;})()'),[1200,400]);
  await waitFor('document.querySelectorAll(".studio-commerce-production .video-studio-card").length===6','commerce results');
  await screenshot('mojing-studio-commerce-light-20261116.png');
  console.log('Commerce reviewed AI plans, batch image requests, history and contact-sheet export passed.');

  await click('[data-testid=studio-nav-skills]'); await textButton('新建技能','.video-studio-toolbar');
  await fill('.ant-modal #name','Fixture creative method'); await fill('.ant-modal #prompt','Freeze wardrobe and one clear camera action.');
  await textButton('保存','.ant-modal'); await waitFor('studioTest.getState().recipes.length===1','save creative method');
  await textButton('新建技能','.video-studio-toolbar');
  assert.equal(await evaluate('document.querySelector(".ant-modal #name").value'),'','a new recipe cannot inherit the previous editor');
  await textButton('取消','.ant-modal');
  await textButton('从链接导入','.video-studio-toolbar');
  await fill('input[aria-label="Markdown 或 JSON 文件链接"]',origin+'/__studio_mockrecipe.md');
  await evaluate(`[...document.querySelectorAll('.studio-recipe-import .ant-modal-footer button')].find(el=>el.classList.contains('ant-btn-primary')).click()`);
  await waitFor('document.querySelector(".ant-modal #name")?.value==="Imported motion"','Markdown recipe review');
  await textButton('保存','.ant-modal'); await waitFor('studioTest.getState().recipes.length===2','import creative method');

  await click('[data-testid=studio-nav-plugins]'); await choose('模型渠道','Studio UI fixture agnes-image');
  await evaluate(`providerTest.getState().updateEndpoint(${JSON.stringify(fixtures.imageId)},{headers:{'X-Fixture-Secret':'never-share-this-header'}})`);
  await textButton('导出接口配置','.video-studio-toolbar');
  const sharedProfile = await evaluate('(async()=>JSON.parse(await studioDownloadedBlobs.at(-1).text()))()');
  assert.equal(sharedProfile.format,'mojing.provider-profile/1'); assert.equal(sharedProfile.apiKey,undefined); assert.equal(sharedProfile.headers,undefined);
  assert.ok(!JSON.stringify(sharedProfile).includes('never-share-this-header'));
  await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify({...sharedProfile,name:'Imported fixture provider',apiKey:'should-be-ignored',headers:{Authorization:'should-be-ignored'}}))}],'provider.json',{type:'application/json'}));const input=document.querySelector('[data-testid=studio-plugins] input[accept=".json"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor('providerTest.getState().endpoints.some(e=>e.name==="Imported fixture provider")','import provider profile');
  const importedEndpoint = await evaluate('providerTest.getState().endpoints.find(e=>e.name==="Imported fixture provider")');
  assert.equal(importedEndpoint.enabled,false); assert.equal(importedEndpoint.apiKey,''); assert.equal(importedEndpoint.headers,undefined);
  await evaluate(`[...document.querySelectorAll('[role=tab]')].find(el=>el.textContent==='Eagle 素材库').click()`);
  await waitFor('Boolean(document.querySelector("[data-testid=studio-eagle]"))','Eagle panel');
  await textButton('读取资料库','[data-testid=studio-eagle]');
  await waitFor('document.querySelector("[data-testid=studio-eagle]").textContent.includes("Fixture product")','mock Eagle library');
  await fill('input[aria-label="新文件夹名称"]','Studio fixture folder'); await textButton('创建文件夹','[data-testid=studio-eagle]');
  await waitFor('document.querySelector("input[aria-label=新文件夹名称]").value===""','create Eagle folder');
  await choose('选择创作素材','Cast reference'); await textButton('写入当前 Eagle 文件夹','[data-testid=studio-eagle]');
  await waitFor('!document.querySelector("[data-testid=studio-eagle] .ant-btn-loading")','upload Eagle asset');
  assert.equal(eagleCalls.find(c=>c.path==='/api/folder/create')?.body.folderName,'Studio fixture folder');
  assert.ok(eagleCalls.find(c=>c.path==='/api/item/addFromURL')?.body.url.startsWith('data:image/'));
  console.log('Creative-method editing and Markdown import, key-free provider profiles, and mocked Eagle browse/create/write passed.');

  const queueIds=await evaluate(`(async()=>{const {submitStudioJob}=await import('/src/services/video-studio/generation.ts');const {initialStudioInput}=await import('/src/services/video-studio/input.ts');const s=studioTest.getState();s.saveRecipe({id:'queue-recipe',name:'Queue freeze',description:'',kind:'text',prompt:'RECIPE_VERSION_ONE',tags:[]});const gate=submitStudioJob({...initialStudioInput(),kind:'text',prompt:'QUEUE_GATE'});const frozen=submitStudioJob({...initialStudioInput(),kind:'text',prompt:'Frozen creative method',recipeId:'queue-recipe'});const cancelled=submitStudioJob({...initialStudioInput(),kind:'text',prompt:'Cancelled queue fixture'});s.saveRecipe({...s.recipes[0],id:'queue-recipe',kind:'text',prompt:'RECIPE_VERSION_TWO'});const p=providerTest.getState();const alternative=p.addEndpoint({name:'Alternative LLM',provider:'openai',category:'llm',baseUrl:location.origin+'/__studio_mockapi/changed',apiKey:'test-fixture',models:['gpt-4o-mini'],enabled:true});p.setLLMProvider('openai','gpt-4o-mini',alternative);return {gate,frozen,cancelled};})()`);
  for (let attempt=0;!heldLLM && attempt<40;attempt++) await delay(50);
  assert.ok(heldLLM,'mock language request is held to exercise the queue');
  await click('[data-testid=studio-nav-tasks]'); await textButton('取消',`tr[data-row-key="${queueIds.cancelled}"]`);
  await call('Fetch.fulfillRequest',{requestId:heldLLM,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({choices:[{message:{content:'Released fixture'}}]})).toString('base64')}); heldLLM=undefined;
  await waitFor(`studioTest.getState().jobs.find(j=>j.id===${JSON.stringify(queueIds.frozen)}).status==="completed"`,'queued method and model');
  const frozenRequest=requests.find(r=>JSON.stringify(r.body || {}).includes('Frozen creative method'));
  assert.match(JSON.stringify(frozenRequest.body),/RECIPE_VERSION_ONE/); assert.ok(!JSON.stringify(frozenRequest.body).includes('RECIPE_VERSION_TWO')); assert.ok(!frozenRequest.path.includes('/changed/'));
  assert.ok(!requests.some(r=>JSON.stringify(r.body || {}).includes('Cancelled queue fixture')),'cancelled queued jobs never reach a provider');
  await textButton('重新提交',`tr[data-row-key="${queueIds.cancelled}"]`);
  await waitFor('studioTest.getState().jobs.at(-1).status==="completed"','explicit retry');
  assert.equal(requests.filter(r=>JSON.stringify(r.body || {}).includes('Cancelled queue fixture')).length,1);
  await evaluate(`providerTest.getState().setLLMProvider('openai','gpt-4o-mini',${JSON.stringify(fixtures.llmId)})`);
  failMedia=true;
  const remoteJob=await evaluate(`(async()=>{const {submitStudioJob}=await import('/src/services/video-studio/generation.ts');return submitStudioJob({...studioTest.getState().jobs.find(j=>j.input.kind==='video').input,prompt:'Remote output download failure fixture'});})()`);
  await waitFor(`studioTest.getState().jobs.find(j=>j.id===${JSON.stringify(remoteJob)}).status==="completed"`,'retain successful provider output after download failure');
  const remoteAsset=await evaluate(`(()=>{const s=studioTest.getState();return s.assets.find(a=>a.jobId===${JSON.stringify(remoteJob)});})()`);
  assert.equal(remoteAsset.storage,'remote'); assert.ok(remoteAsset.storageError); failMedia=false;
  console.log('Queue cancellation/retry, frozen prompt/provider selection and successful remote-output retention passed.');

  await click('.ws-titlebar-project-actions button');
  await waitFor('Boolean(document.querySelector(".ant-dropdown:not(.ant-dropdown-hidden)"))','new project menu');
  await evaluate(`[...document.querySelectorAll('.ant-dropdown-menu-item')].find(el=>el.textContent==='视频工坊').click()`);
  await waitFor('Boolean(document.querySelector(".video-create-episode-modal")) && studioTest.getState().page==="projects"','titlebar create-video bridge');
  await textButton('取消','.video-create-episode-modal');

  const beforeReload = await evaluate(`(async()=>{const s=studioTest.getState();s.addJob({id:'interrupted-fixture',name:'Restart fixture',status:'running',createdAt:new Date().toISOString(),input:{...s.jobs[0].input}}); const {videoStudioStorage}=await import('/src/services/video-studio/storage.ts');await videoStudioStorage.getItem('video-studio');return {assets:s.assets.length,canvases:s.canvases.length,worlds:s.worlds.length};})()`);
  const requestsBefore = requests.length;
  await call('Page.reload'); await waitFor('typeof window.studioTest==="undefined"', 'reload navigation'); await waitFor('Boolean(document.querySelector(".ws-titlebar button[aria-label=视频工坊]"))', 'reload shell'); await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))', 'restored studio');
  const restored = await evaluate(`(async()=>{const source=await(await fetch('/src/components/VideoStudio/StudioWorkspace.tsx')).text();const line=source.split(String.fromCharCode(10)).find(line=>line.startsWith('import')&&line.includes('useVideoStudioStore'));const {useVideoStudioStore}=await import(line.slice(line.indexOf('"')+1,line.lastIndexOf('"')));const s=useVideoStudioStore.getState();return {assets:s.assets.length,canvases:s.canvases.length,worlds:s.worlds.length,status:s.jobs.find(j=>j.id==='interrupted-fixture').status};})()`);
  assert.deepEqual({assets:restored.assets,canvases:restored.canvases,worlds:restored.worlds}, beforeReload);
  assert.equal(restored.status, 'interrupted'); assert.equal(requests.length, requestsBefore, 'reload never resubmits provider jobs');
  const diagnostics = new Set(['https://api-beijing.klingai.com/', 'https://api.deepseek.com/', 'https://www.baidu.com/']);
  assert.deepEqual(blocked.filter((request) => !diagnostics.has(request.url) || !['GET', 'HEAD'].includes(request.method) || request.hasAuthorization), [], 'only existing unauthenticated network diagnostics may be attempted; external requests stay blocked');
  assert.deepEqual(browser.errors, []);
  console.log(JSON.stringify({ result:'passed', requests:requests.length, restored, screenshots:'%TEMP%/mojing-studio-*-20261116.png', previsReferences:previs.references }));
} catch (error) {
  await screenshot('mojing-studio-failure-20261116.png').catch(()=>{});
  console.error(error);
  console.error('Runtime errors:', browser.errors);
  console.error('Jobs:', await evaluate('window.studioTest?.getState().jobs.map(j=>({name:j.name,status:j.status,error:j.error}))').catch(()=>[]));
  process.exitCode = 1;
} finally { browser.close(); }

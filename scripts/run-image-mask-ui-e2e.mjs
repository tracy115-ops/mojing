import assert from 'node:assert/strict';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/';
const browser = await chromeSession({url:appUrl,port:9238});
const {call,evaluate,waitFor,click,textButton,delay,screenshot} = browser;
const origin = new URL(appUrl).origin, requests=[], blocked=[];
let candidate;
browser.onEvent(event=>{
  if(event.method!=='Fetch.requestPaused') return;
  void (async()=>{
    const {request,requestId}=event.params, url=new URL(request.url);
    if(url.origin===origin && url.pathname.startsWith('/__mask_mock/')) {
      const body=JSON.parse(request.postData || '{}'); requests.push({path:url.pathname,body});
      const response=url.pathname.endsWith('/sdapi/v1/img2img')?{images:[candidate.split(',')[1]]}:{data:[{b64_json:candidate.split(',')[1]}]};
      await call('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(response)).toString('base64')});
    } else if(url.origin===origin) await call('Fetch.continueRequest',{requestId});
    else {blocked.push({url:url.href,method:request.method,authenticated:Object.keys(request.headers).some(key=>/authorization|api-key/i.test(key))});await call('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
  })().catch(error=>browser.errors.push(String(error)));
});
const bind = () => evaluate(`(async()=>{
  const spec=async(file,symbol)=>{const text=await(await fetch(file)).text();const line=text.split(String.fromCharCode(10)).find(line=>line.startsWith('import')&&line.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};
  window.maskStore=(await import(await spec('/src/components/VideoStudio/StudioWorkspace.tsx','useVideoStudioStore'))).useVideoStudioStore;
  window.maskProviders=(await import(await spec('/src/components/VideoStudio/StudioImageEditor.tsx','useProviderStore'))).useProviderStore;
  window.maskGeneration=await import(await spec('/src/components/VideoStudio/StudioTasks.tsx','submitStudioJob'));
  window.maskTools=await import('/src/services/video-studio/image-mask.ts');
})()`);
const openEditor=async()=>{
  await click('[data-testid=studio-nav-assets]');
  await waitFor('Boolean(document.querySelector("[data-asset-id=mask-source]"))','original asset');
  await evaluate(`(()=>{const card=document.querySelector('[data-asset-id=mask-source]');[...card.querySelectorAll('button')].find(el=>el.textContent==='编辑图片').click();})()`);
  await waitFor('document.querySelector(".studio-image-editor canvas")?.width===640','source image decode'); await delay(350);
};
const segmented=text=>evaluate(`[...document.querySelectorAll('.studio-image-editor .ant-segmented-item')].find(el=>el.textContent===${JSON.stringify(text)}).click()`);
const fill=async value=>evaluate(`(()=>{const el=document.querySelector('.studio-image-editor textarea[aria-label="修改要求"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const draw=async(points)=>{
  const rect=await evaluate(`(()=>{const r=document.querySelector('[data-testid=studio-image-edit-surface]').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()`);
  const position=p=>({x:rect.x+rect.w*p[0],y:rect.y+rect.h*p[1]});
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...position(points[0]),button:'left',clickCount:1});
  for(const point of points.slice(1)) await call('Input.dispatchMouseEvent',{type:'mouseMoved',...position(point),button:'left',buttons:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...position(points.at(-1)),button:'left',clickCount:1}); await delay(100);
};
const preview=()=>evaluate(`(()=>{const c=document.querySelector('[data-testid=image-edit-mask]'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let selected=0,sum=0;for(let i=0;i<d.length;i+=4){if(d[i]>0)selected++;sum+=d[i];}return{selected,sum};})()`);
const slider=async(label,steps=0)=>{
  await evaluate(`(()=>{const label=[...document.querySelectorAll('.studio-image-editor label')].find(el=>el.textContent.startsWith(${JSON.stringify(label)}));label.querySelector('[role=slider]').focus();})()`);
  for(const [key,code] of [['Home',36],...Array.from({length:steps},()=>['ArrowRight',39])]) {
    await call('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code}); await call('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});
  }
  await delay(100);
};
const verifyJob=id=>evaluate(`(async()=>{
  const state=maskStore.getState(),job=state.jobs.find(j=>j.id===${JSON.stringify(id)}),asset=id=>state.assets.find(a=>a.id===id);
  const read=async uri=>{const image=await maskTools.loadMaskImage(uri),c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return{w:c.width,h:c.height,data:ctx.getImageData(0,0,c.width,c.height).data};};
  const [src,mask,raw,out]=await Promise.all([asset(job.input.imageEdit.sourceAssetId),asset(job.input.imageEdit.maskAssetId),asset(job.rawOutputAssetId),asset(job.outputAssetId)].map(a=>read(a.url)));
  let outside=0,inside=0,outsideErrors=0,insideErrors=0;
  for(let i=0;i<mask.data.length;i+=4){if(mask.data[i]===0){outside++;for(let k=0;k<4;k++)if(src.data[i+k]!==out.data[i+k])outsideErrors++;}else if(mask.data[i]===255){inside++;for(let k=0;k<4;k++)if(raw.data[i+k]!==out.data[i+k])insideErrors++;}}
  return{outside,inside,outsideErrors,insideErrors,w:out.w,h:out.h,rawReceipt:!!asset(job.rawOutputAssetId).responseSnapshot,resultReceipt:!!asset(job.outputAssetId).responseSnapshot,lineage:asset(job.outputAssetId).editResult};
})()`);

try {
  await call('Fetch.enable',{patterns:[{urlPattern:'*'}]}); await call('Page.navigate',{url:appUrl});
  await waitFor('Boolean(document.querySelector(".ws-titlebar"))','application shell'); await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))','studio'); await bind();
  const fixtures=await evaluate(`(()=>{
    const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d');
    ctx.fillStyle='#234567';ctx.fillRect(0,0,640,360);ctx.fillStyle='#47a18b';ctx.fillRect(320,0,320,360);const source=c.toDataURL('image/png');
    ctx.fillStyle='#f08c14';ctx.fillRect(0,0,640,360);const candidate=c.toDataURL('image/png');
    const p=maskProviders.getState(),add=(provider,name,model)=>p.addEndpoint({provider,name,category:'image',models:[model],baseUrl:location.origin+'/__mask_mock/'+provider,apiKey:'fixture',enabled:true});
    const agnes=add('agnes-image','Mask Agnes fixture','agnes-image-2.1-flash'),sd=add('stable-diffusion','Mask SD fixture','sd-inpainting');p.setImageProvider('agnes-image','agnes-image-2.1-flash',agnes);
    maskStore.getState().addAsset({id:'mask-source',name:'Mask source',kind:'image',url:source,width:640,height:360,category:'reference',createdAt:new Date().toISOString()});
    return{source,candidate,agnes,sd};
  })()`); candidate=fixtures.candidate;

  // Check real canvas geometry and bounded feathering at the source resolution.
  const geometry=await evaluate(`(()=>{const strokes=[{tool:'rectangle',size:0,points:[{x:.25,y:.25},{x:.75,y:.75}]}],a=maskTools.renderImageMask(640,360,strokes),b=maskTools.renderImageMask(640,360,strokes,.08);const x=a.getContext('2d').getImageData(0,0,640,360).data,y=b.getContext('2d').getImageData(0,0,640,360).data;let expanded=0,softened=0;for(let i=0;i<x.length;i+=4){if(!x[i]&&y[i])expanded++;if(y[i]>0&&y[i]<x[i])softened++;}return{expanded,softened};})()`);
  assert.equal(geometry.expanded,0);assert.ok(geometry.softened>1000);
  await openEditor(); await segmented('画笔蒙版'); await segmented('黑白蒙版'); await slider('选区内边缘柔化');
  await draw([[.25,.5],[.4,.5],[.6,.5],[.75,.5]]); const painted=await preview();assert.ok(painted.selected>500);
  assert.equal(await evaluate('document.querySelectorAll(".studio-image-editor [data-testid=canvas-node-settings] .ant-select")[2].classList.contains("ant-select-disabled")'),true,'masked edits keep source aspect ratio');
  await segmented('擦除'); await draw([[.5,.35],[.5,.65]]);const erased=await preview();assert.ok(erased.selected<painted.selected);
  await click('button[aria-label="撤销笔画"]');assert.deepEqual(await preview(),painted);
  await click('button[aria-label="重做笔画"]');assert.deepEqual(await preview(),erased);
  await textButton('保存蒙版','.studio-image-editor');await waitFor('maskStore.getState().assets.length===2','saved mask');
  const savedMask=await evaluate('maskStore.getState().assets.at(-1)');assert.equal(savedMask.width,640);assert.equal(savedMask.height,360);
  await fill('MASK_AGNES: replace painted background');
  await click('[data-testid=studio-image-ai-edit]');await waitFor('maskStore.getState().jobs.at(-1)?.status==="completed"','Agnes composition');
  const agnesJob=await evaluate('maskStore.getState().jobs.at(-1)');
  assert.equal(agnesJob.name,'MASK_AGNES: replace painted background');
  assert.equal(agnesJob.input.imageEdit.mode,'local_composite');assert.equal(requests.length,1);
  assert.equal(requests[0].body.extra_body.image.length,2);assert.ok(!('mask' in requests[0].body));assert.ok(!('denoising_strength' in requests[0].body));
  const agnesPixels=await verifyJob(agnesJob.id);assert.equal(agnesPixels.outsideErrors,0);assert.equal(agnesPixels.insideErrors,0);assert.ok(agnesPixels.outside>200000);assert.ok(agnesPixels.inside>1000);
  assert.equal(agnesPixels.rawReceipt,true);assert.equal(agnesPixels.resultReceipt,false);assert.equal(agnesPixels.lineage.preserveOutside,true);
  console.log('Brush, eraser, undo/redo, mask export, bounded feathering and exact Agnes local composition passed.');

  await evaluate(`maskProviders.getState().setImageProvider('stable-diffusion','sd-inpainting',${JSON.stringify(fixtures.sd)})`);
  await openEditor();await draw([[.2,.2],[.8,.8]]);await slider('选区内边缘柔化');await slider('重绘强度',7);await fill('MASK_SD: native repaint');
  assert.ok(await evaluate('document.querySelector(".studio-image-editor").textContent.includes("原生蒙版重绘")'));
  // Switching to crop and rotating must clear a previous mask.
  await segmented('裁剪');await segmented('画笔蒙版');await segmented('黑白蒙版');assert.equal((await preview()).selected,0);
  await draw([[.4,.4],[.6,.6]]);await textButton('旋转90°','.studio-image-editor');assert.equal((await preview()).selected,0);
  await textButton('重置','.studio-image-editor');await waitFor('document.querySelector(".studio-image-editor canvas")?.width===640','rotation reset');
  await draw([[.3,.5],[.7,.5]]);
  for(const theme of ['dark','light']) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    for(const width of [1600,900,650]) {
      await call('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:1,mobile:false});await delay(180);
      const layout=await evaluate(`(()=>{const root=document.querySelector('.studio-image-editor-layout'),a=root.querySelector('section').getBoundingClientRect(),b=root.querySelector('aside').getBoundingClientRect();return{overflow:root.scrollWidth>root.clientWidth+1,overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top};})()`);
      assert.deepEqual(layout,{overflow:false,overlap:false});await screenshot('mojing-mask-'+theme+'-'+width+'.png');
    }
  }
  await call('Emulation.clearDeviceMetricsOverride');
  await click('[data-testid=studio-image-ai-edit]');await waitFor('maskStore.getState().jobs.at(-1)?.status==="completed"','native mask result');
  const sdJob=await evaluate('maskStore.getState().jobs.at(-1)'),sdRequest=requests.at(-1);
  assert.equal(sdJob.input.imageEdit.mode,'native_mask');assert.match(sdRequest.path,/sdapi\/v1\/img2img$/);assert.equal(sdRequest.body.init_images.length,1);
  assert.equal(sdRequest.body.denoising_strength,0.4);assert.equal(sdRequest.body.mask_blur,0);assert.equal(sdRequest.body.inpainting_mask_invert,0);
  assert.match(sdRequest.body.mask,/^data:image\/png;base64,/);assert.equal(sdRequest.body.width,640);assert.equal(sdRequest.body.height,360);
  const sdPixels=await verifyJob(sdJob.id);assert.equal(sdPixels.outsideErrors,0);assert.equal(sdPixels.insideErrors,0);assert.ok(sdPixels.inside>1000);assert.equal(sdPixels.w,640);assert.equal(sdPixels.h,360);
  console.log('Native SD WebUI mask and strength, source dimensions, rotation clearing, two themes and three screen sizes passed.');

  // Fail only after the successful provider artifact has been retained.
  await evaluate(`(()=>{let unsubscribe=maskStore.subscribe(state=>{const job=state.jobs.at(-1);if(!job?.input.prompt.includes('MASK_LOCAL_FAILURE')||!job.rawOutputAssetId)return;unsubscribe();const ids=[...job.input.referenceAssetIds,job.input.imageEdit.maskAssetId,job.rawOutputAssetId];window.maskProtected=maskStore.getState().trashAssets(ids);const original=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){HTMLCanvasElement.prototype.toDataURL=original;throw new Error('Injected local composition failure');};});const base=maskStore.getState().jobs[0].input;maskGeneration.submitStudioJob({...base,prompt:'MASK_LOCAL_FAILURE',imageEdit:{...base.imageEdit,instruction:'MASK_LOCAL_FAILURE'}});})()`);
  await waitFor('maskStore.getState().jobs.at(-1)?.status==="failed"','local failure');
  const failed=await evaluate('maskStore.getState().jobs.at(-1)');assert.ok(failed.rawOutputAssetId);assert.match(failed.error,/Injected local composition/);
  assert.deepEqual(await evaluate('maskProtected.changed'),[]);assert.equal((await evaluate('maskProtected.blocked')).length,4);
  const requestCount=requests.length;await delay(500);await call('Page.reload');
  await waitFor('Boolean(document.querySelector(".ws-titlebar"))','reloaded shell');await click('button[aria-label="视频工坊"]');await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))','reloaded studio');await bind();
  assert.equal(await evaluate(`maskStore.getState().jobs.find(j=>j.id===${JSON.stringify(failed.id)}).rawOutputAssetId`),failed.rawOutputAssetId);
  await evaluate(`maskProviders.getState().endpoints.forEach(ep=>maskProviders.getState().updateEndpoint(ep.id,{enabled:false}))`);
  await click('[data-testid=studio-nav-tasks]');await waitFor('Boolean(document.querySelector("[data-testid=studio-retry-composition]"))','local retry action');await click('[data-testid=studio-retry-composition]');
  await waitFor(`maskStore.getState().jobs.find(j=>j.id===${JSON.stringify(failed.id)}).status==='completed'`,'local retry completed');assert.equal(requests.length,requestCount,'local retry must never request a new provider generation');
  await evaluate(`maskProviders.getState().endpoints.forEach(ep=>maskProviders.getState().updateEndpoint(ep.id,{enabled:true}))`);
  assert.equal((await verifyJob(failed.id)).outsideErrors,0);
  await evaluate(`(()=>{const row=[...document.querySelectorAll('tr')].find(el=>el.textContent.includes('MASK_LOCAL_FAILURE'));row.querySelector('button').click();})()`);
  await waitFor('Boolean(document.querySelector(".ant-modal-content"))','task details');
  assert.ok(await evaluate('document.querySelector(".ant-modal-content").textContent.includes("模型原始候选") && document.querySelector(".ant-modal-content").textContent.includes("蒙版合成结果")'));
  await textButton('从原图重新编辑','.ant-modal-content');await waitFor('Boolean(document.querySelector(".studio-image-editor"))','reopen source editor');
  await click('.studio-image-editor .ant-modal-close');await waitFor('!document.querySelector(".studio-image-editor")','editor close');
  console.log('Retained candidate, recycle protection, persistence, task details and local retry without extra model requests passed.');

  const bundle=await evaluate(`(async()=>{const {createStudioCanvas,parseStudioBundle}=await import('/src/services/video-studio/document.ts'),{exportCanvasBundle}=await import('/src/services/video-studio/bundle.ts');const job=maskStore.getState().jobs[0],canvas={...createStudioCanvas('Mask export'),nodes:[{id:'mask-node',kind:'image',name:'Edit',prompt:'Replace',x:0,y:0,generation:job.input,assetId:job.outputAssetId}]};const pack=await exportCanvasBundle(canvas,maskStore.getState().assets,[]),imported=parseStudioBundle(pack,'canvas');return{count:pack.assets.length,hasMask:pack.assets.some(a=>a.id===job.input.imageEdit.maskAssetId),newMaskId:imported.canvas.nodes[0].generation.imageEdit.maskAssetId!==job.input.imageEdit.maskAssetId};})()`);
  assert.deepEqual(bundle,{count:4,hasMask:true,newMaskId:true});
  // Corrupt or unsupported masks must fail before the provider is called.
  await evaluate(`(()=>{const base=maskStore.getState().jobs[0].input,c=document.createElement('canvas');c.width=640;c.height=360;c.getContext('2d').fillRect(0,0,640,360);maskStore.getState().addAsset({id:'empty-mask',kind:'image',name:'Empty',url:c.toDataURL(),category:'reference',createdAt:new Date().toISOString()});maskGeneration.submitStudioJob({...base,prompt:'EMPTY_MASK',imageEdit:{...base.imageEdit,maskAssetId:'empty-mask'}});})()`);
  await waitFor('maskStore.getState().jobs.at(-1)?.status==="failed"','empty mask rejected');assert.equal(requests.length,requestCount);
  assert.match(await evaluate('maskStore.getState().jobs.at(-1).error'),/empty/);
  assert.equal(await evaluate(`(()=>{const base=maskStore.getState().jobs[0].input;try{maskGeneration.submitStudioJob({...base,imageEdit:{...base.imageEdit,mode:'native_mask'},referenceAssetIds:[base.imageEdit.sourceAssetId]});return false;}catch{return true;}})()`),true);
  assert.equal(requests.length,requestCount);assert.equal(await evaluate('maskStore.getState().assets.find(a=>a.id==="mask-source").url'),fixtures.source);
  assert.deepEqual(browser.errors,[]);
  const diagnostics=new Set(['https://api-beijing.klingai.com/','https://api.deepseek.com/','https://www.baidu.com/']);
  assert.deepEqual(blocked.filter(request=>!diagnostics.has(request.url)||!['GET','HEAD'].includes(request.method)||request.authenticated),[],'all external requests are blocked; only existing unauthenticated connectivity checks are expected');
  console.log('Image mask browser regression passed; only mocked providers were called.');
} catch(error) {
  console.error('Diagnostic:',await evaluate('({text:document.body.innerText.slice(-5000),jobs:window.maskStore?.getState().jobs,errors:[]})').catch(()=>null));
  console.error('Screenshot:',await screenshot('mojing-mask-failure.png').catch(()=>null));throw error;
} finally {browser.close();}

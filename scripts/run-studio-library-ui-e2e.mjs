import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/';
const browser = await chromeSession({ url:appUrl, port:9236 });
const { call, evaluate, waitFor, click, textButton, screenshot, delay } = browser;
const origin = new URL(appUrl).origin, blocked = [];
browser.onEvent((event) => {
  if (event.method !== 'Fetch.requestPaused') return;
  const {request,requestId}=event.params;
  void call(new URL(request.url).origin===origin ? 'Fetch.continueRequest' : 'Fetch.failRequest', new URL(request.url).origin===origin ? {requestId} : {requestId,errorReason:'BlockedByClient'}).catch(error=>browser.errors.push(String(error)));
  if (new URL(request.url).origin!==origin) blocked.push(request.url);
});
const fill = async (selector,value) => {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`,'input');
  await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
};
const choose = async (label,option) => {
  const selector=`[aria-label=${JSON.stringify(label)}]`;
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`,'select mount '+label);
  const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify('.ant-modal ' + selector)})||document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  await waitFor(`Boolean([...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(el=>el.title===${JSON.stringify(option)}||el.textContent===${JSON.stringify(option)}))`,'option '+option);
  await evaluate(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find(el=>el.title===${JSON.stringify(option)}||el.textContent===${JSON.stringify(option)}).click()`);
};
const confirm = async () => { await waitFor('Boolean(document.querySelector(".ant-popconfirm .ant-btn-primary"))','confirmation'); await click('.ant-popconfirm .ant-btn-primary'); await delay(150); };
const search = async (value) => { await fill('input[aria-label="搜索名称或内容"]',value);await delay(150); };
const select = async (id) => click(`[data-asset-id=${JSON.stringify(id)}] input[type=checkbox]`);
const importPack = async (data) => evaluate(`(()=>{const d=new DataTransfer();d.items.add(new File([${JSON.stringify(JSON.stringify(data))}],'fixture.assets.json',{type:'application/json'}));const el=document.querySelector('input[accept=".assets.json,.json"]');el.files=d.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);

try {
  await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
  await call('Page.setDownloadBehavior',{behavior:'allow',downloadPath:process.env.TEMP||'C:/Windows/Temp'});
  await call('Page.navigate',{url:appUrl});
  await waitFor('Boolean(document.querySelector(".ws-titlebar"))','shell');
  await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=video-studio-workspace]"))','studio');
  const video='data:video/webm;base64,'+(await readFile(new URL('./fixtures/studio-output.webm',import.meta.url))).toString('base64');
  await evaluate(`(async()=>{
    const moduleURL=async(file,symbol)=>{const s=await(await fetch(file)).text();const line=s.split(String.fromCharCode(10)).find(l=>l.startsWith('import')&&l.includes(symbol));return line.slice(line.indexOf('"')+1,line.lastIndexOf('"'));};
    window.libraryTest=(await import(await moduleURL('/src/components/VideoStudio/StudioLibrary.tsx','useVideoStudioStore'))).useVideoStudioStore;
    window.libraryProjectTest=(await import(await moduleURL('/src/components/VideoStudio/StudioLibrary.tsx','useVideoStore'))).useVideoStore;
    window.libraryBlobs=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{libraryBlobs.push(blob);return create(blob);};
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;canvas.getContext('2d').fillRect(0,0,160,90);const image=canvas.toDataURL();
    const s=libraryTest.getState(),add=(id,name,kind,body)=>s.addAsset({id,name,kind,category:'reference',createdAt:new Date().toISOString(),...body});
    add('lib-free','Library fixture portrait','image',{url:image});add('lib-used','Library fixture in use','image',{url:image,tags:['review']});add('lib-text','Library fixture brief','text',{text:'Preserve costume and identity.'});add('lib-video','Library fixture motion','video',{url:${JSON.stringify(video)}});add('lib-purge','Disposable note','text',{text:'Temporary note'});
    const p=libraryProjectTest.getState();p.initProject('library-project',[],{aspectRatio:'16:9',style:'cinematic',shotDurationSeconds:5},'Library project');p.setSceneSpec('library-project',{characters:[],scenes:[],props:[{id:'prop-one',name:'Project prop',description:'A project-owned prop.'}],shots:[],meta:{aspectRatio:'16:9',defaultShotDuration:5,sourceMode:'multishot',channel:'direct'}});
  })()`);
  await click('[data-testid=studio-nav-assets]');
  await waitFor('Boolean(document.querySelector(".studio-library-folders"))','library mount');
  await evaluate('libraryTest.getState().setDraft({kind:"video",referenceAssetIds:["lib-used"]})');
  await textButton('新建文件夹','.studio-library-folders');await fill('[aria-label="文件夹名称"]','Cast');await click('.studio-library-folder-modal .ant-modal-footer .ant-btn-primary');
  await waitFor('libraryTest.getState().assetFolders.length===1','root folder');
  const root=await evaluate('libraryTest.getState().assetFolders[0].id');
  await textButton('新建文件夹','.studio-library-folders');await fill('[aria-label="文件夹名称"]','Wardrobe');await click('.studio-library-folder-modal .ant-modal-footer .ant-btn-primary');
  await waitFor('libraryTest.getState().assetFolders.length===2','nested folder');
  const child=await evaluate('libraryTest.getState().assetFolders.find(f=>f.name==="Wardrobe").id');
  assert.equal(await evaluate('libraryTest.getState().assetFolders[1].parentId'),root);
  await click('[data-library-scope=all]');await search('Library fixture');await select('lib-free');await select('lib-text');
  await textButton('整理素材','.studio-library-batch');await delay(350);
  await choose('移至文件夹','Cast / Wardrobe');await choose('业务分类','角色');await choose('素材标签','review');
  await fill('input[aria-label="素材标签"]','approved-take');await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await click('.studio-library-organize-modal .ant-modal-footer .ant-btn-primary');
  await waitFor('!document.querySelector(".studio-library-organize-modal")','organize dialog closed');
  await waitFor(`libraryTest.getState().assets.find(a=>a.id==='lib-free').folderId===${JSON.stringify(child)}`,'bulk organization');
  const organized=await evaluate('libraryTest.getState().assets.filter(a=>["lib-free","lib-text"].includes(a.id))');
  assert.ok(organized.every(a=>a.category==='character'&&a.tags.includes('review')&&a.tags.includes('approved-take')));
  await choose('按标签筛选','approved-take');
  await waitFor('document.querySelectorAll("[data-testid=studio-assets] article").length===2','tag filter');
  await click('.studio-library-batch input[type=checkbox]');await textButton('导出素材包','.studio-library-batch');
  await waitFor('libraryBlobs.length>0','package export');
  const pack=await evaluate('(async()=>{for(const blob of libraryBlobs){try{const value=JSON.parse(await blob.text());if(value.format==="mojing.assets/1")return value;}catch{}}return null;})()');
  assert.equal(pack.assets.length,2);assert.equal(pack.folders.length,2);assert.ok(pack.assets.find(a=>a.kind==='image').url.startsWith('data:image/'));
  await importPack(pack);
  await waitFor('libraryTest.getState().assets.length===7','asset package import');
  const imported=await evaluate('libraryTest.getState().assets.filter(a=>!["lib-free","lib-used","lib-text","lib-video","lib-purge"].includes(a.id))');
  assert.equal(imported.length,2);assert.ok(imported.every(a=>a.folderId!==child));
  const beforeInvalid=await evaluate('({assets:libraryTest.getState().assets.length,folders:libraryTest.getState().assetFolders.length})');
  await importPack({...pack,assets:[{...pack.assets[0],folderId:'missing'}]});await delay(350);
  assert.deepEqual(await evaluate('({assets:libraryTest.getState().assets.length,folders:libraryTest.getState().assetFolders.length})'),beforeInvalid,'invalid package import must be atomic');
  await click('[data-library-scope=all]');
  // Clear the tag and search filters through their own controls.
  await evaluate(`document.querySelector('[aria-label="按标签筛选"]').closest('.ant-select').querySelector('.ant-select-clear').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
  await search('Library fixture');await select('lib-free');await select('lib-text');await select('lib-used');
  await textButton('移入回收站','.studio-library-batch');await confirm();
  await waitFor('libraryTest.getState().trashedAssets.length===2','partial recycle');
  assert.ok(await evaluate('libraryTest.getState().assets.some(a=>a.id==="lib-used")'),'referenced draft must be protected by the store');
  const rejected=await evaluate('(async()=>{const {submitStudioJob}=await import("/src/services/video-studio/generation.ts");try{submitStudioJob({kind:"video",prompt:"Must not submit",referenceAssetIds:["lib-free"]});return false;}catch(error){return error.message.includes("recycle bin");}})()');assert.equal(rejected,true);
  await click('[data-library-scope=trash]');
  assert.equal(await evaluate('document.querySelectorAll(".studio-library [data-asset-id] .studio-project-transfer").length'),0);
  await select('lib-free');await textButton('恢复素材','.studio-library-batch');await waitFor('libraryTest.getState().assets.some(a=>a.id==="lib-free")','restore');
  assert.equal(await evaluate('libraryTest.getState().assets.find(a=>a.id==="lib-free").folderId'),child);
  await search('');
  await evaluate('libraryTest.getState().trashAssets(["lib-purge"])');await select('lib-purge');await textButton('清除记录','.studio-library-batch');await confirm();
  assert.equal(await evaluate('libraryTest.getState().trashedAssets.some(a=>a.id==="lib-purge")'),false);
  await click(`[data-folder-id=${JSON.stringify(child)}]`);await textButton('移除文件夹','.studio-library-heading');await confirm();
  assert.equal(await evaluate('libraryTest.getState().assets.find(a=>a.id==="lib-free").folderId'),root);
  assert.equal(await evaluate('libraryTest.getState().trashedAssets.find(a=>a.id==="lib-text").folderId'),root);
  await click('[data-library-scope=projects]');
  assert.equal(await evaluate('document.querySelector("[data-testid=studio-assets] article input[type=checkbox]").disabled'),true);
  await textButton('复制到素材库','[data-testid=studio-assets] article');
  assert.equal(await evaluate('libraryProjectTest.getState().projects["library-project"].sceneSpec.props[0].description'),'A project-owned prop.');
  await click('[data-library-scope=all]');
  await textButton('另存 MP4 副本','[data-asset-id=lib-video]');await waitFor('Boolean(document.querySelector(".studio-transcode-modal"))','transcode dialog');
  assert.equal(await evaluate('document.querySelector(".studio-transcode-modal .ant-modal-footer .ant-btn-primary").disabled'),true,'browser cannot pretend to run desktop FFmpeg');
  await click('.studio-transcode-modal .ant-modal-close');
  for (const [theme,width] of [['dark',1600],['light',1600],['light',900],['dark',650]]) {
    await evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme(${JSON.stringify(theme)});})()`);
    await call('Emulation.setDeviceMetricsOverride',{width,height:1050,deviceScaleFactor:1,mobile:false});await delay(200);
    const geometry=await evaluate('(()=>{const side=document.querySelector(".studio-library-folders").getBoundingClientRect(),main=document.querySelector(".studio-library-main").getBoundingClientRect(),root=document.querySelector(".studio-library");return {noOverlap:side.right<=main.left+1||side.bottom<=main.top+1,fits:root.scrollWidth<=root.clientWidth+1};})()');
    assert.deepEqual(geometry,{noOverlap:true,fits:true});await screenshot(`mojing-library-${theme}-${width}-20261116.png`);
  }
  const saved=await evaluate('({folders:libraryTest.getState().assetFolders,trash:libraryTest.getState().trashedAssets.map(a=>a.id),assets:libraryTest.getState().assets.map(a=>({id:a.id,tags:a.tags,folderId:a.folderId}))})');
  await delay(250);await call('Page.reload');await waitFor('!window.libraryTest','old document unloaded');
  await waitFor('Boolean(document.querySelector("button[aria-label=视频工坊]"))','reloaded shell');await click('button[aria-label="视频工坊"]');
  await waitFor('Boolean(document.querySelector("[data-testid=studio-assets]"))','restored library');
  const restored=await evaluate('(async()=>{const source=await(await fetch("/src/components/VideoStudio/StudioLibrary.tsx")).text();const line=source.split(String.fromCharCode(10)).find(l=>l.startsWith("import")&&l.includes("useVideoStudioStore"));const s=(await import(line.split(String.fromCharCode(34))[1])).useVideoStudioStore.getState();return {folders:s.assetFolders,trash:s.trashedAssets.map(a=>a.id),assets:s.assets.map(a=>({id:a.id,tags:a.tags,folderId:a.folderId}))};})()');
  assert.deepEqual(restored,saved);
  assert.deepEqual(browser.errors,[]);
  assert.ok(blocked.every(url=>['https://api-beijing.klingai.com/','https://api.deepseek.com/','https://www.baidu.com/'].includes(url)));
  console.log('Studio library UI passed: nested folders, bulk tags/category/move, portable package isolation, guarded partial recycling, restoration, folder removal, project copy, desktop gating, persistence and four theme/viewport combinations.');
} catch(error) {
  console.error(error);console.error('Runtime errors:',browser.errors);
  await screenshot('mojing-library-failure-20261116.png').catch(()=>{});process.exitCode=1;
} finally { browser.close(); }

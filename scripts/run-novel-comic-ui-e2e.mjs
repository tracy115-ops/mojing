import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { chromeSession } from './lib/chrome-session.mjs';

const output = resolve(process.env.MOJING_E2E_ARTIFACT_DIR || 'artifacts/novel-comic-ui-e2e');
await mkdir(output, { recursive: true });
const url = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/';
const origin = new URL(url).origin;
const app = await chromeSession({ url, port: 9256 });
const requests = [], external = [], blockedProbes = [];
const novelProse = '雨水敲着车窗。' + '林岚核对登记簿，保安等她签字。'.repeat(350) + '林岚从黄色帆布包中取出旧票，走向车载摄像头。';
const colors = ['#d93434', '#32b34d', '#3355d4', '#d4a834'];
const tiles = await Promise.all(colors.map(background => sharp({ create: { width: 360, height: 640, channels: 3, background } }).png().toBuffer()));
const panels = colors.map((_, i) => ({ description: `Panel marker ${i}: Lin Lan inspects the yellow bag on the bus.`, dialogue: i === 3 ? '车票上的日期，是明天。' : '', characterIds: ['char_0'], shotType: i === 0 ? 'wide' : 'medium' }));
app.onEvent(event => {
  if (event.method !== 'Fetch.requestPaused') return;
  void (async () => {
    const { requestId, request } = event.params;
    const target = new URL(request.url);
    if (target.origin !== origin) {
      if (['data:', 'blob:'].includes(target.protocol)) { await app.call('Fetch.continueRequest', { requestId }); return; }
      const connectivityProbe = target.pathname === '/' && ['api-beijing.klingai.com', 'api.deepseek.com', 'www.baidu.com'].includes(target.hostname);
      (connectivityProbe ? blockedProbes : external).push(request.url);
      await app.call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); return;
    }
    if (!['/chat/completions', '/v1/images/generations'].includes(target.pathname)) { await app.call('Fetch.continueRequest', { requestId }); return; }
    const body = JSON.parse(request.postData);
    requests.push({ path: target.pathname, body });
    let result, type = 'application/json';
    const system = body.messages?.[0]?.content || '';
    let content;
    if (system.includes('小说世界观设计师')) content = { 'style公约': '克制的现实悬疑。', '核心法则': [{ key: '现实约束', value: '线索必须可以验证' }], '地理生态': [{ key: '总站', value: '雨夜的公交总站' }], '社会结构': [], '历史文化': [], '日常细节': [] };
    else if (system.includes('小说角色设计师')) content = { characters: [{ name: '林岚', importance: 'protagonist', description: '30岁女公交司机', appearance: '齐肩短发、深蓝制服', relationships: [] }] };
    else if (system.includes('小说场景设计师')) content = { locations: [{ name: '总站', description: '雨夜公交总站' }] };
    else if (system.includes('小说剧情规划师')) content = { mainPlot: '林岚发现黄色帆布包，调查日期为明天的车票。', stages: [], ending: '发现一条可验证的线索。' };
    if (target.pathname.includes('images')) {
      const index = Number(body.prompt.match(/Panel marker (\d)/)?.[1] ?? 0);
      result = JSON.stringify({ data: [{ b64_json: tiles[index].toString('base64') }] });
    } else if (body.messages[0].content.includes('漫画分镜师')) {
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ characters: [{ id: 'char_0', name: '林岚', appearance: '30-year-old woman, black bob, dark blue bus uniform.' }], panels }) }, finish_reason: 'stop' }] });
    } else if (system.includes('你是小说策划编辑')) {
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ready:true,outline:'经审读：林岚收车发现黄色帆布包，核对旧票并登记失物；调查来自可验证的来源。',changes:['Remove unsupported planning details.'],unresolvedIssues:[]}) },finish_reason:'stop' }] });
    } else if (system.includes('认真通读作品的小说编辑')) {
      const assessment = { dimensions: ['premise_fidelity','character_consistency','timeline_consistency','plot_coherence','foreshadowing_usage','voice_quality'].map(name => ({ name, score: 80 })), summary: 'Fixture editorial response, not a live quality judgment.', findings: [], continuityNotes: [{ fact: '林岚取票走向摄像头。', quote: '林岚从黄色帆布包中取出旧票，走向车载摄像头。' }] };
      if (body.messages[1].content.includes('AutopilotQualityContract')) assessment.findings.push({ dimension:'plot_coherence',severity:'critical',quote:'雨水敲着车窗。',referenceQuote:'',problem:'Fixture unresolved hard problem.',suggestion:'Fixture correction direction.' });
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) }, finish_reason: 'stop' }] });
    } else if (system.includes('叙事节拍规划师')) {
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ beats: [0,1,2].map(i => ({ description:'Lin Lan checks the ticket, scene '+i, targetWords:1000,focus:'dialogue',sceneGoal:'Track the ticket owner.' })) }) },finish_reason:'stop' }] });
    } else if (system.includes('小说责任编辑')) {
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [{ before: '雨水敲着车窗。', after: '雨点敲着车顶。', reason: 'Fixture edit to exercise exact text application.' }, {before: '林岚从黄色帆布包中取出旧票，走向车载摄像头。', after:'A deliberately unwanted ending change.',reason:'Fixture edit to reject in the preview.'}] }) }, finish_reason: 'stop' }] });
    } else if (body.stream) {
      type = 'text/event-stream';
      result = 'data: ' + JSON.stringify({ choices: [{ delta: { content: content ? JSON.stringify(content) : novelProse }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
    } else {
      result = JSON.stringify({ choices: [{ message: { content: '林岚收车检查，在公交车上发现黄色帆布包，核对车票与监控记录。' }, finish_reason: 'stop' }] });
    }
    await app.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(result).toString('base64') });
  })().catch(error => app.errors.push(String(error)));
});
const fill = (selector, value) => app.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const choose = async (selector, label) => {
  const point = await app.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await app.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await app.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  const option = `(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)return;const popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');if(!popup||popup.classList.contains('ant-select-dropdown-hidden'))return;return[...popup.querySelectorAll('.ant-select-item-option')].find(e=>e.title===${JSON.stringify(label)});})()`;
  await app.waitFor(`!!(${option})`, 'option '+label); await app.evaluate(`(${option}).click()`);
};
const novelExpr = "JSON.parse(localStorage.getItem('mojing-projects')).state.projects[0]";
const comicExpr = "Object.values(JSON.parse(localStorage.getItem('mojing-comic-store')).state.projects)[0]";
let report;
try {
  await app.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await app.call('Page.navigate', { url });
  await app.waitFor('!!document.querySelector(".ws-titlebar")', 'application');
  // Seed only user input/configuration. All generated outputs go through the
  // UI, production router/adapters, pipeline, image decoder and Canvas.
  await app.evaluate(`(async()=>{
    const p=(await import('/src/stores/providerStore.ts')).useProviderStore;
    const config={...p.getState().config,llm:{...p.getState().config.llm,primary:'deepseek',endpointId:'llm',defaultModel:'deepseek-v4-pro',models:{}},image:{...p.getState().config.image,primary:'agnes-image',endpointId:'image',defaultModel:'agnes-image-2.1-flash',models:{}}};
    p.setState({config,endpoints:[{id:'llm',provider:'deepseek',category:'llm',baseUrl:${JSON.stringify(origin)},apiKey:'fixture',models:['deepseek-v4-pro'],enabled:true},{id:'image',provider:'agnes-image',category:'image',baseUrl:${JSON.stringify(origin)},apiKey:'fixture',models:['agnes-image-2.1-flash'],enabled:true}]});
  })()`);
  await app.waitFor('[...document.querySelectorAll("button")].some(e=>e.textContent==="新建小说")', 'novel wizard entry');
  await app.textButton('新建小说');
  await app.waitFor('!!document.querySelector(".ant-modal #title")', 'wizard');
  const description = '林岚，30岁女公交司机，发现黄色帆布包；车票日期是明天；禁止超自然。';
  await fill('.ant-modal #title', '末班车之后'); await fill('.ant-modal #description', description);
  await choose('.ant-modal #genre', '悬疑');
  for (const label of ['AI 生成世界观', 'AI 生成角色', 'AI 生成地点', 'AI 生成剧情总纲']) {
    await app.textButton('下一步', '.ant-modal');
    await app.waitFor(`document.querySelector('.ant-modal').innerText.includes(${JSON.stringify(label)})`, label+' entry');
    await app.textButton(label, '.ant-modal');
    await app.waitFor(`[...document.querySelectorAll('.ant-modal button')].some(e=>e.textContent==='重新生成')`, label+' result');
  }
  await app.textButton('完成创建', '.ant-modal');
  await app.waitFor('!document.querySelector(".ant-modal")', 'novel created');
  const wizardRequests = requests.filter(r => /小说世界观设计师|小说角色设计师|小说场景设计师|小说剧情规划师/.test(r.body.messages?.[0]?.content || ''));
  assert.equal(wizardRequests.length, 4);
  for (const { body } of wizardRequests) {
    assert.ok(body.messages[1].content.includes(description), 'every setup step retains the original premise');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
  }
  await app.waitFor('[...document.querySelectorAll("button")].some(e=>e.textContent==="添加章节")', 'novel input project');
  await app.textButton('添加章节');
  await app.waitFor(`!!document.querySelector('textarea[placeholder="章节大纲..."]')`, 'chapter');
  await app.textButton('生成 大纲');
  await app.waitFor(`${novelExpr}.metadata.storyNodes[0].outline.length>20`, 'generated outline');
  await app.evaluate('[...document.querySelectorAll(".ant-tabs-tab")].find(e=>e.textContent.includes("草稿")).click()');
  await app.waitFor('document.body.innerText.includes("悬疑反转")', 'project genre inherited');
  await app.textButton('生成');
  await app.waitFor(`${novelExpr}.metadata.storyNodes[0].content.length>20`, 'generated prose');
  await app.waitFor(`JSON.parse(localStorage.getItem('mojing-narrative:'+${novelExpr}.id+':chapter-reviews') || '[]').length===1`, 'automatic editorial review');
  const writing = requests.filter(r => /大纲规划师|你是一位小说作者/.test(r.body.messages?.[0]?.content || ''));
  assert.equal(writing.length, 2);
  assert.equal(requests.filter(r=>r.body.messages?.[0]?.content.includes('你是小说策划编辑')).length,1,'review a new plan once and reuse it while context is unchanged');
  assert.ok(writing[1].body.messages[1].content.includes('经审读：'),'write from the reviewed plan rather than the unexamined planning response');
  for (const { body } of writing) {
    assert.match(body.messages[0].content, /林岚，30岁女公交司机/);
    assert.match(body.messages[0].content, /线索必须可以验证/);
    assert.deepEqual(body.thinking, { type: 'disabled' });
  }
  await app.screenshot('novel-context.png');
  assert.ok(novelProse.length > 4000);
  await app.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='润色'&&!b.disabled)`, 'editor ready after review');
  await app.textButton('润色');
  await app.waitFor('!!document.querySelector(".ant-modal-confirm")', 'editorial edit preview');
  assert.equal(await app.evaluate(`${novelExpr}.metadata.storyNodes[0].content`), novelProse, 'proposals do not replace the chapter before adoption');
  await app.evaluate(`document.querySelectorAll('.ant-modal-confirm input[type="checkbox"]')[1].click()`);
  await app.textButton('采用修订并重新审稿', '.ant-modal-confirm');
  const revisedProse = '雨点敲着车顶。' + novelProse.slice('雨水敲着车窗。'.length);
  await app.waitFor(`${novelExpr}.metadata.storyNodes[0].content.startsWith('雨点敲着车顶。')`, 'adopt exact edit');
  assert.equal(await app.evaluate(`${novelExpr}.metadata.storyNodes[0].content`), revisedProse, 'retain every unedited character and the ending of a long chapter');
  await app.waitFor(`document.body.innerText.includes('已审读，待作者确认')`, 'review actual revised text');
  const editorialRequests = requests.filter(r => /认真通读作品的小说编辑|小说责任编辑/.test(r.body.messages?.[0]?.content || ''));
  assert.equal(editorialRequests.length, 3);
  for (const request of editorialRequests) {
    assert.ok(request.body.messages[1].content.includes('走向车载摄像头。'), 'review and revision requests contain the complete ending');
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.deepEqual(request.body.thinking, { type: 'enabled' }, 'editorial comparison and revision use reasoning mode');
    assert.ok(request.body.max_tokens >= 12000, 'leave room for both reasoning and the complete editorial response');
  }
  await app.screenshot('novel-editorial-review.png');
  const autoStart = requests.length;
  const autoContract = await app.evaluate(`(async()=>{
    const {AutopilotEngine}=await import('/src/services/novel/autopilot-engine.ts');
    const chapters=[{id:'auto-0',order:0,title:'Contract',outline:'林岚调查旧票。',content:'',status:'planned',wordCount:0}];
    const engine=new AutopilotEngine({novelId:'editorial-contract',title:'AutopilotQualityContract',description:'现实世界，禁止超自然。',genre:'mystery',style:'克制',targetChapterCount:1,targetWordCount:3000,existingChapters:chapters,getChapters:()=>chapters,onUpdateChapter:(id,updates)=>Object.assign(chapters[0],updates),onAddChapter:()=>chapters[0].id,onAddVolume:()=>'',onUpdateMetadata:()=>{}});
    engine.state.status='running';
    const content=await engine.doChapterGeneration(0,chapters[0].outline,chapters[0].id);
    await engine.doChapterReview(0,content,chapters[0].id);
    await engine.doQualityGateRewrite(0,content,chapters[0].id);
    return {content,status:engine.state.status,chapterStatus:chapters[0].status};
  })()`);
  assert.equal(autoContract.content, [novelProse,novelProse,novelProse].join('\n\n'), 'automatic writing preserves complete beats beyond target word counts');
  const beatRequests = requests.slice(autoStart).filter(r => r.body.stream);
  assert.equal(beatRequests.length,3);
  assert.ok(beatRequests[1].body.messages[0].content.includes(novelProse), 'second beat receives the complete first beat');
  assert.ok(beatRequests[2].body.messages[0].content.includes([novelProse,novelProse].join('\n\n')), 'third beat receives all text already written in the chapter');
  assert.equal(autoContract.status,'paused','an unresolved critical issue must pause automatic writing');
  assert.equal(autoContract.chapterStatus,'revising','failed review/revision must never mark the chapter complete');
  await app.click('button[aria-label="漫画工坊"]');
  await app.waitFor('[...document.querySelectorAll("button")].some(e=>e.textContent==="新建漫画")', 'comic page');
  await app.textButton('新建漫画');
  await app.waitFor('!!document.querySelector(".ant-modal #theme")', 'comic form');
  await fill('.ant-modal #title', 'Comic pipeline regression');
  await fill('.ant-modal #theme', '林岚在公交车上发现黄色帆布包。');
  await fill('.ant-modal #panelCount', '4');
  await app.textButton('创建', '.ant-modal');
  await app.waitFor('!document.querySelector(".ant-modal")', 'created comic');
  await app.textButton('生成');
  await app.waitFor(`${comicExpr}.currentStage==='complete'`, 'complete comic pipeline', 60000);
  const comic = await app.evaluate(comicExpr);
  assert.equal(comic.spec.panels.length, 4);
  assert.ok(comic.spec.panels.every(p => p.characterIds.includes('char_0') && p.imageUrl));
  assert.ok(Object.values(comic.stages).every(s => s.status === 'completed'));
  assert.equal(comic.stages.dialogue_burn.error, undefined, 'silent panels are valid, not failed dialogue burns');
  const imageRequests = requests.filter(r => r.path.includes('images'));
  const frameRequests = imageRequests.filter(r => /Panel marker/.test(r.body.prompt));
  assert.equal(frameRequests.length, 4);
  assert.ok(frameRequests.every(r => r.body.extra_body.image?.length > 0), 'each frame receives its cast reference');
  assert.ok(comic.spec.panels.every(p => p.originalImageUrl), 'retain clean panel images for dialogue edits');
  const lastPanel = comic.spec.panels.at(-1);
  assert.notEqual(lastPanel.imageUrl, lastPanel.originalImageUrl);
  await app.evaluate('[...document.querySelectorAll("div")].find(e=>e.style.cursor==="pointer"&&e.innerText.startsWith("对白烧录")).click()');
  await app.textButton('仅此步');
  await app.waitFor(`${comicExpr}.stages.dialogue_burn.completedAt && ${comicExpr}.stages.dialogue_burn.completedAt!==${JSON.stringify(comic.stages.dialogue_burn.completedAt)}`, 'repeat dialogue burn');
  assert.equal((await app.evaluate(comicExpr)).spec.panels.at(-1).imageUrl, lastPanel.imageUrl, 'repeated burn uses the original, without stacking bubbles');
  const beforeReflow = await app.evaluate(comicExpr);
  await fill('.ant-input-number-input', '48');
  await app.textButton('重跑及后续');
  await app.waitFor('!!document.querySelector(".ant-popconfirm")', 'rerun confirmation');
  await app.textButton('确定', '.ant-popconfirm');
  await app.waitFor(`${comicExpr}.stages.page_compose.completedAt && ${comicExpr}.stages.page_compose.completedAt!==${JSON.stringify(beforeReflow.stages.page_compose.completedAt)}`, 'dialogue reflow and page composition');
  const reflowed = await app.evaluate(comicExpr);
  assert.equal(reflowed.stages.dialogue_burn.input.bubbleFontSize, 48);
  assert.notEqual(reflowed.spec.panels.at(-1).imageUrl, lastPanel.imageUrl);
  assert.equal(reflowed.spec.panels.at(-1).originalImageUrl, lastPanel.originalImageUrl);
  assert.equal(requests.filter(r => r.path.includes('images')).length, imageRequests.length, 'dialogue reflow does not generate paid images again');

  // Test every offered composition layout using real images and Canvas pixels.
  const layouts = {};
  for (const layout of ['single', 'grid-2', 'grid-4', 'manga-row', 'yonkoma', 'grid-9', 'manga-splash', 'webtoon']) {
    const composed = await app.evaluate(`(async()=>{const {runPageCompose}=await import('/src/services/comic/core/step-page-compose.ts');return runPageCompose(${JSON.stringify(tiles.map((tile, i) => ({ id: 'color_'+i, index: i, description: '', characterIds: [], imageUrl: 'data:image/png;base64,'+tile.toString('base64') })))},{novelProjectId:'layout-fixture',layout:${JSON.stringify(layout)}});})()`);
    assert.deepEqual(composed.failedPanelIds, []);
    assert.deepEqual(composed.pages.flatMap(p => p.panelIds), ['color_0', 'color_1', 'color_2', 'color_3']);
    const found = new Set();
    for (const [i, page] of composed.pages.entries()) {
      const bytes = Buffer.from(page.imageUrl.split(',')[1], 'base64');
      const pixels = await sharp(bytes).removeAlpha().raw().toBuffer();
      for (let n = 0; n < pixels.length; n += 3) found.add(pixels.subarray(n,n+3).toString('hex'));
      await writeFile(join(output, `${layout}-${i+1}.png`), bytes);
    }
    for (const color of colors) assert.ok(found.has(color.slice(1)), `${layout} renders every panel instead of blank slots`);
    layouts[layout] = composed.pages.length;
  }

  // Compare real rendered text against the same bubble with glyph drawing
  // suppressed. Every changed pixel must sit on the bubble's light interior.
  const dialoguePixels = {};
  for (const shape of ['oval', 'rect', 'narration']) {
    const rendered = await app.evaluate(`(async()=>{
      const {runDialogueBurn}=await import('/src/services/comic/core/step-dialogue-burn.ts');
      const panel={id:'bubble',index:0,description:'',characterIds:['char_0'],dialogue:'这张票，为何印着明天的日期？\\nCheck the ticket.',imageUrl:${JSON.stringify('data:image/png;base64,'+tiles[0].toString('base64'))}};
      const ctx={novelProjectId:'bubble-fixture',bubbleShape:${JSON.stringify(shape)}};
      const visible=await runDialogueBurn([panel],ctx);
      const fill=CanvasRenderingContext2D.prototype.fillText;
      let blank;
      try{CanvasRenderingContext2D.prototype.fillText=function(){};blank=await runDialogueBurn([panel],ctx);}
      finally{CanvasRenderingContext2D.prototype.fillText=fill;}
      const tooLong=await runDialogueBurn([{...panel,dialogue:'很长的对白'.repeat(500)}],ctx);
      return {visible,blank,tooLongSkipped:tooLong.skippedPanelIds};
    })()`);
    assert.deepEqual(rendered.visible.skippedPanelIds, []);
    assert.deepEqual(rendered.blank.skippedPanelIds, []);
    assert.deepEqual(rendered.tooLongSkipped, ['bubble'], 'oversized dialogue is reported rather than silently truncated');
    const visibleBytes = Buffer.from(rendered.visible.panels[0].imageUrl.split(',')[1], 'base64');
    const visible = await sharp(visibleBytes).removeAlpha().raw().toBuffer();
    const blank = await sharp(Buffer.from(rendered.blank.panels[0].imageUrl.split(',')[1], 'base64')).removeAlpha().raw().toBuffer();
    let changed = 0;
    for (let n = 0; n < visible.length; n += 3) {
      if (visible.subarray(n,n+3).equals(blank.subarray(n,n+3))) continue;
      changed++;
      assert.ok(blank[n] > 245 && blank[n+1] > 235 && blank[n+2] > 190, `${shape} glyph stays inside the bubble`);
    }
    assert.ok(changed > 500, 'the actual dialogue glyphs are present');
    dialoguePixels[shape] = changed;
    await writeFile(join(output, `dialogue-${shape}.png`), visibleBytes);
  }
  await app.screenshot('comic-pipeline.png');
  const prior = await app.evaluate(`({novel:${novelExpr},comic:${comicExpr}})`);
  await app.call('Page.reload');
  await app.waitFor(`!!localStorage.getItem('mojing-comic-store') && !!document.querySelector('.ws-titlebar')`, 'reload');
  assert.deepEqual(await app.evaluate(`({novel:${novelExpr},comic:${comicExpr}})`), prior);
  assert.deepEqual(external, []); assert.deepEqual(app.errors, []);
  report = { result: 'passed', boundary: 'Remote LLM and images use HTTP fixtures. UI requests, prompt context, cast references, pipeline state, Canvas composition pixels and reload persistence are real. Connectivity probes are blocked. This does not assess model quality.', writingRequests: writing.length, imageRequests: imageRequests.length, frameRequests: frameRequests.length, stages: comic.stages, layouts, dialoguePixels, dialogueReflowWithoutImageGeneration: true, blockedProbes };
} catch (error) {
  report = { result: 'failed', error: String(error), runtimeErrors: app.errors, external };
  await app.screenshot('failure.png').catch(() => {}); throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); app.close();
}
console.log(JSON.stringify(report));

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
let outlineBeforeReview;
const novelProse = '雨水敲着车窗。\n\n' + '林岚核对登记簿，保安等她签字。'.repeat(350) + '\n\n林岚从黄色帆布包中取出旧票，走向车载摄像头。';
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
    if (system.includes('小说剧情规划师') && body.max_tokens===8192) {
      const sse='data: '+JSON.stringify({choices:[{delta:{content:'{"mainPlot":"incomplete'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\n';
      await app.call('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/event-stream'}],body:Buffer.from(sse).toString('base64')});return;
    }
    let content;
    const editorialContract = /Editorial(?:Truncation|AlwaysTruncated)Contract/.test(body.messages?.[1]?.content || '');
    if (editorialContract && /小说责任编辑|认真通读作品的小说编辑/.test(system)) {
      const truncated = body.max_tokens <= 16384 || body.messages[1].content.includes('EditorialAlwaysTruncatedContract');
      const complete = system.includes('小说责任编辑') ? {edits:[]} : {
        dimensions:['premise_fidelity','character_consistency','timeline_consistency','plot_coherence','foreshadowing_usage','voice_quality'].map(name=>({name,score:80})),
        summary:'Fixture complete review.', findings:[], continuityNotes:[],
      };
      await app.call('Fetch.fulfillRequest', {requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({choices:[{message:{content:truncated?'{"edits":[':JSON.stringify(complete)},finish_reason:truncated?'length':'stop'}]})).toString('base64')});
      return;
    }
    if (system.includes('小说世界观设计师')) content = { 'style公约': '克制的现实悬疑。', '核心法则': [{ key: '现实约束', value: '线索必须可以验证' }], '地理生态': [{ key: '总站', value: '雨夜的公交总站' }], '社会结构': [], '历史文化': [], '日常细节': [] };
    else if (system.includes('小说角色设计师')) content = { characters: [{ name: '林岚', importance: 'protagonist', description: '30岁女公交司机', appearance: '齐肩短发、深蓝制服', relationships: [] }] };
    else if (system.includes('小说场景设计师')) content = { locations: [{ name: '总站', description: '雨夜公交总站' }] };
    else if (system.includes('小说剧情规划师')) content = { mainPlot: '林岚发现黄色帆布包，调查日期为明天的车票。', stages: [{name:'预领核对',chapterRange:'第1-3章',description:'上报后核对原始交接记录',coreEvent:'未审稿：在包里添加第二张票',foreshadowSeeds:['次日预领栏']}], ending: '核实预盖日期并保留原始报告。' };
    else if (system.includes('资深小说总架构师')) content={mainPlot:'核实异常车票来源',coreConflict:'核对记录',themeMessage:'事实与猜测',volumes:[{title:'卷一',startChapter:0,endChapter:0,theme:'核对'}],chapters:[{order:0,title:'原始规划',outline:'未审读的全局方案',volumeIndex:0,keyEvents:[],tensionHint:5}],ending:'查清日期来源'};
    else if (system.includes('你是小说情节编辑')) {
      const draft=JSON.parse(body.messages[1].content.split('【待审全书方案，尚未发生】\n')[1]);
      if(draft.stages)draft.stages[0].coreEvent='保留交接簿原件';
      else draft.chapters[0].outline='全书审读后：留下原始登记，再核对可取得的记录。';
      const denied=body.messages[1].content.includes('DenyGlobalStoryPlanContract');
      content={ready:!denied,plan:draft,changes:['删除违背原始设定的推断，保留可核对的交接事件。'],unresolvedIssues:denied?['日期矛盾仍未解决']:[]};
    }
    if (target.pathname.includes('images')) {
      const index = Number(body.prompt.match(/Panel marker (\d)/)?.[1] ?? 0);
      result = JSON.stringify({ data: [{ b64_json: tiles[index].toString('base64') }] });
    } else if (body.messages[0].content.includes('漫画分镜师')) {
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ characters: [{ id: 'char_0', name: '林岚', appearance: '30-year-old woman, black bob, dark blue bus uniform.' }], panels }) }, finish_reason: 'stop' }] });
    } else if (system.includes('你是小说策划编辑')) {
      const firstReview = outlineBeforeReview === undefined;
      if (firstReview) outlineBeforeReview = await app.evaluate(`${novelExpr}.metadata.storyNodes[0].outline`);
      const assessment = {
        ready: true,
        outline: '经审读：林岚收车发现黄色帆布包，核对旧票并登记失物；调查来自可验证的来源。',
        changes: ['Remove unsupported planning details.'],
        unresolvedIssues: firstReview ? ['Incorrectly reported a deferred clue as unresolved.'] : [],
      };
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) }, finish_reason:'stop' }] });
    } else if (system.includes('认真通读作品的小说编辑')) {
      const assessment = { dimensions: ['premise_fidelity','character_consistency','timeline_consistency','plot_coherence','foreshadowing_usage','voice_quality'].map(name => ({ name, score: 80 })), summary: 'Fixture editorial response, not a live quality judgment.', findings: [], continuityNotes: [{ fact: '林岚取票走向摄像头。', quote: '林岚从黄色帆布包中取出旧票，走向车载摄像头。' }] };
      if (body.messages[1].content.includes('AutopilotQualityContract')) assessment.findings.push({ dimension:'plot_coherence',severity:'major',basis:'craft',quote:'雨水敲着车窗。',referenceQuote:'',problem:'Fixture unresolved story problem.',suggestion:'Fixture correction direction.' });
      if (/AutopilotCandidateContract|AutopilotPassingContract/.test(body.messages[1].content)) {
        if (body.messages[1].content.includes('雨水敲着车窗。')) assessment.findings.push({dimension:'plot_coherence',severity:'major',quote:'雨水敲着车窗。',referenceQuote:'',problem:'Fixture initial problem.',suggestion:'Fixture correction.'});
        if (body.messages[1].content.includes('AutopilotCandidateContract')) assessment.findings.push({dimension:'timeline_consistency',severity:'major',quote:'林岚从黄色帆布包中取出旧票，走向车载摄像头。',referenceQuote:'',problem:'Fixture remaining problem.',suggestion:'Requires author judgment.'});
      }
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) }, finish_reason: 'stop' }] });
    } else if (system.includes('叙事节拍规划师')) {
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ beats: [0,1,2].map(i => ({ description:'Lin Lan checks the ticket, scene '+i, targetWords:1000,focus:'dialogue',sceneGoal:'Track the ticket owner.' })) }) },finish_reason:'stop' }] });
    } else if (system.includes('小说责任编辑')) {
      const alreadyRevised = body.messages[1].content.includes('雨点敲着车顶。');
      const edits = [{ before: alreadyRevised ? '雨点敲着车顶。' : '雨水敲着车窗。', after: alreadyRevised ? '雨声落在车顶。' : '雨点敲着车顶。', reason: 'Fixture edit to exercise exact text application.' }];
      if (!/AutopilotCandidateContract|AutopilotPassingContract/.test(body.messages[1].content)) {
        // Exercise a cross-paragraph response through the actual preview and adoption controls.
        edits[0] = { paragraphId:'C1-C2', after:edits[0].after + '\n\n' + '林岚核对登记簿，保安等她签字。'.repeat(350), reason:'Fixture cross-paragraph edit.' };
        edits.push({before: '林岚从黄色帆布包中取出旧票，走向车载摄像头。', after:'A deliberately unwanted ending change.',reason:'Fixture edit to reject in the preview.'});
      }
      result = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits }) }, finish_reason: 'stop' }] });
    } else if (body.stream) {
      type = 'text/event-stream';
      result = 'data: ' + JSON.stringify({ choices: [{ delta: { content: content ? JSON.stringify(content) : novelProse }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
    } else {
      result = JSON.stringify({ choices: [{ message: { content: content ? JSON.stringify(content) : '林岚收车检查，在公交车上发现黄色帆布包，核对车票与监控记录。' }, finish_reason: 'stop' }] });
    }
    await app.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(result).toString('base64') });
  })().catch(error => app.errors.push(String(error)));
});
const fill = (selector, value) => app.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const choose = async (selector, label) => {
  await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`);
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
  const sceneGuides = await app.evaluate(`(async () => {
    const { getTemplate } = await import('/src/services/novel/prompt-templates.ts');
    const template = getTemplate('beat-generation');
    const vars = { title:'末班车之后', genre:'mystery', style:'现实悬疑', beatIndex:'0', totalBeats:'2', targetWords:'900', beatDescription:'核对票号' };
    return {
      action: template.buildSystem({ ...vars, beatFocus:'action' }),
      emotion: template.buildSystem({ ...vars, beatFocus:'emotion' }),
      ending: template.buildSystem({ ...vars, beatFocus:'dialogue', beatIndex:'1' }),
    };
  })()`);
  assert.ok(sceneGuides.action.includes('【行动场景】'));
  assert.equal(sceneGuides.action.includes('【动作场景】'), false, 'ordinary action does not select the combat protocol');
  assert.ok(sceneGuides.emotion.includes('【情绪场景】'));
  assert.equal(sceneGuides.emotion.includes('【情感场景】'), false, 'emotion does not select the romance protocol');
  assert.equal(sceneGuides.ending.includes('要么制造悬念'), false, 'the chapter ending is not forced into a formula');
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
  const savedPlot = await app.evaluate(`JSON.parse(localStorage.getItem('mojing-narrative:'+${novelExpr}.id+':plot-outline'))`);
  assert.equal(savedPlot.ending,'核实预盖日期并保留原始报告。');
  assert.equal(savedPlot.stages[0].coreEvent,'保留交接簿原件');
  assert.equal(JSON.stringify(savedPlot).includes('未审稿：在包里添加第二张票'),false,'adopt the reviewed story plan, not the raw generation');
  const storyPlanReviews=requests.filter(r=>r.body.messages?.[0]?.content.includes('你是小说情节编辑'));
  assert.equal(storyPlanReviews.length,1);
  assert.ok(storyPlanReviews[0].body.messages[1].content.includes(description));
  assert.ok(storyPlanReviews[0].body.messages[1].content.includes('未审稿：在包里添加第二张票'));
  await app.evaluate(`document.querySelector('[data-workbench-category="plot"]').click()`);
  await app.waitFor(`!!document.querySelector('[data-testid="story-plan-overview"]')`,'saved full plot visible');
  await app.evaluate(`[...document.querySelectorAll('[data-testid="story-plan-overview"] .ant-collapse-header')].find(e=>e.textContent.includes('阶段与关键事件')).click()`);
  await app.evaluate(`[...document.querySelectorAll('[data-testid="story-plan-overview"] .ant-collapse-header')].find(e=>e.textContent.includes('结局')).click()`);
  await app.waitFor(`document.querySelector('[data-testid="story-plan-overview"]').innerText.includes('核实预盖日期并保留原始报告。')`,'ending visible');
  const visiblePlan=await app.evaluate(`document.querySelector('[data-testid="story-plan-overview"]').innerText`);
  assert.ok(visiblePlan.includes(savedPlot.mainPlot));
  assert.ok(visiblePlan.includes(savedPlot.stages[0].coreEvent));
  assert.ok(visiblePlan.includes(savedPlot.ending));
  await app.evaluate(`document.querySelector('[data-workbench-category="overview"]').click()`);
  await app.evaluate(`(async()=>{const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');const p=${novelExpr};window.__reloadedPlot=new NarrativeRepository(p.id).loadWritingReferences().plotOutline;})()`);
  assert.deepEqual(await app.evaluate('window.__reloadedPlot'),savedPlot,'reconstructed repository loads the full saved plot');
  const snapshotPlot = await app.evaluate(`(async()=>{const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');const source=new NarrativeRepository(${novelExpr}.id);const target=new NarrativeRepository('plot-roundtrip-test');try{target.importAll(source.exportAll());return target.loadWritingReferences().plotOutline;}finally{target.clearAll();}})()`);
  assert.deepEqual(snapshotPlot,savedPlot,'repository snapshot export/import preserves the full plot');
  assert.equal(await app.evaluate(`localStorage.getItem('mojing-narrative:plot-roundtrip-test:plot-outline')`),null,'clearAll removes the copied plot');
  const wizardRequests = requests.filter(r => /小说世界观设计师|小说角色设计师|小说场景设计师|小说剧情规划师/.test(r.body.messages?.[0]?.content || ''));
  assert.equal(wizardRequests.length, 5,'truncated plot retries once without repeating world, characters or locations');
  assert.deepEqual(wizardRequests.filter(r=>r.body.messages[0].content.includes('小说剧情规划师')).map(r=>r.body.max_tokens),[8192,16384]);
  for (const { body } of wizardRequests) {
    assert.ok(body.messages[1].content.includes(description), 'every setup step retains the original premise');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
  }
  await app.waitFor('[...document.querySelectorAll("button")].some(e=>e.textContent==="添加章节")', 'novel input project');
  await app.textButton('添加章节');
  await app.waitFor(`!!document.querySelector('textarea[placeholder="章节大纲..."]')`, 'chapter');
  assert.ok((await app.evaluate('document.body.innerText')).includes('待写大纲'));
  await app.textButton('生成大纲', '.chapter-editor');
  await app.waitFor(`${novelExpr}.metadata.storyNodes[0].outline.startsWith('经审读：')`, 'generated and reviewed outline');
  assert.match(outlineBeforeReview, /^林岚收车检查/);
  assert.ok((await app.evaluate('document.body.innerText')).includes('待写正文'));
  await app.click('.chapter-editor [role=tab][id$="-tab-content"]');
  await app.textButton('写作设置', '[data-testid="chapter-actions"]');
  await app.waitFor('document.querySelector("[data-testid=chapter-writing-settings]")?.innerText.includes("悬疑")', 'project genre inherited');
  await app.textButton('写作设置', '[data-testid="chapter-actions"]');
  await app.click('.chapter-editor [role=tab][id$="-tab-outline"]');
  await app.click('[data-testid="chapter-outline-next"]');
  await app.waitFor('!!document.querySelector(\'.chapter-editor [aria-selected="true"][id$="-tab-content"]\')', 'next action opens prose');
  await app.waitFor(`${novelExpr}.metadata.storyNodes[0].content.length>20`, 'generated prose');
  await app.waitFor(`JSON.parse(localStorage.getItem('mojing-narrative:'+${novelExpr}.id+':chapter-reviews') || '[]').length===1`, 'automatic editorial review');
  const writing = requests.filter(r => /大纲规划师|你是一位小说作者/.test(r.body.messages?.[0]?.content || ''));
  assert.equal(writing.length, 2);
  const outlineReviews = requests.filter(r=>r.body.messages?.[0]?.content.includes('你是小说策划编辑'));
  assert.equal(outlineReviews.length,2,'repair one rejected review and reuse the valid result while context is unchanged');
  assert.match(outlineReviews[1].body.messages[1].content, /上次回复未通过格式检查/);
  assert.ok(writing[1].body.messages[1].content.includes('经审读：'),'write from the reviewed plan rather than the unexamined planning response');
  for (const { body } of writing) {
    assert.ok(body.messages[0].content.includes('保留交接簿原件'),'stage events reach the real writing request');
    assert.ok(body.messages[0].content.includes('核实预盖日期并保留原始报告。'),'planned resolution reaches the real writing request');
    assert.ok(body.messages[0].content.includes('不能当作已经发生的事实'));
    assert.match(body.messages[0].content, /林岚，30岁女公交司机/);
    assert.match(body.messages[0].content, /线索必须可以验证/);
    const proseRequest = body.messages[0].content.includes('你是一位小说作者');
    assert.deepEqual(body.thinking, { type: proseRequest ? 'enabled' : 'disabled' });
    if (proseRequest) assert.ok(body.max_tokens >= 16000,'reasoning must leave sufficient budget for the complete prose');
  }
  const plotReviews = requests.filter(r => /你是小说策划编辑|你是一位认真通读作品的小说编辑/.test(r.body.messages?.[0]?.content || ''));
  assert.equal(plotReviews.length,3,'check outline assessment recovery and automatic prose review');
  for(const {body} of plotReviews) assert.ok(body.messages.map(m=>m.content).join('\n').includes('核实预盖日期并保留原始报告。'),'review retains author resolution');
  await app.screenshot('novel-context.png');
  assert.ok(novelProse.length > 4000);
  const openPolish = async () => {
    await app.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='AI工具'&&!b.disabled)`, 'editor ready for revision');
    await app.textButton('AI工具', '[data-testid="chapter-actions"]');
    await app.click('[data-menu-id$="-polish"]');
  };
  await openPolish();
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
  // Keep the editor and review sidebar mounted while settings change in this window.
  await app.click('[data-workbench-category="quality"]');
  await app.evaluate(`[...document.querySelectorAll('.ant-tabs-tab')].find(e=>e.textContent.includes('章节评审')).click()`);
  await app.waitFor('!!document.querySelector(\'[data-testid="chapter-review-panel"]\')', 'review sidebar');
  const panel = 'document.querySelector(\'[data-testid="chapter-review-panel"]\')';
  await app.waitFor(`${panel}.innerText.includes('已审读，待作者确认')`, 'sidebar shares the editor report');
  await app.evaluate(`(async()=>{const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');const repo=new NarrativeRepository(${novelExpr}.id);const bible=repo.loadBible();bible.worldSettings.push({id:'changed-rule',name:'Changed rule',description:'车票需以实物核验。'});repo.saveBible(bible);})()`);
  await app.waitFor(`${panel}.innerText.includes('正文、前文或设定已变更')`, 'sidebar invalidates stale settings immediately');
  await app.waitFor(`document.body.innerText.split('正文、前文或设定已变更').length>=3`, 'editor invalidates the same report without reload');
  await app.textButton('审稿与连贯性');
  await app.waitFor(`${panel}.innerText.includes('已审读，待作者确认')&&!${panel}.innerText.includes('需重新审读')`, 'new editor review reaches sidebar');
  // A settings change while a preview is open must prevent adoption.
  await openPolish();
  await app.waitFor('!!document.querySelector(".ant-modal-confirm")', 'second revision preview');
  await app.evaluate(`(async()=>{const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');const repo=new NarrativeRepository(${novelExpr}.id);const bible=repo.loadBible();bible.worldSettings[0].description+=' 仅据提供的证据判断。';repo.saveBible(bible);})()`);
  await app.textButton('采用修订并重新审稿', '.ant-modal-confirm');
  await app.waitFor(`document.body.innerText.includes('正文或创作依据已改变')`, 'reject stale proposal');
  assert.equal(await app.evaluate(`${novelExpr}.metadata.storyNodes[0].content`),revisedProse,'stale proposals preserve the original draft and ending');
  await app.textButton('取消','.ant-modal-confirm');
  await app.screenshot('novel-stale-review.png');
  await app.evaluate("localStorage.setItem('mojing-workbench-width', '1200')");
  await app.call('Page.reload');
  await app.waitFor(`!!document.querySelector('.ant-tabs-tab-active[data-node-key="content"]')`, 'existing chapters open their prose by default');
  await app.waitFor(`!!document.querySelector('textarea[placeholder="章节正文..."]')`, 'saved prose editor mounted');
  assert.equal(await app.evaluate('document.querySelector(\'textarea[placeholder="章节正文..."]\')?.value'),revisedProse);
  const setViewport = (width, height) => app.call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
  const checkEditorLayout = async (narrow) => {
    const layout = await app.evaluate(`(() => {
      const editor = document.querySelector('.novel-workspace__editor');
      const pane = document.querySelector('#novel-narrative-pane');
      const count = document.querySelector('[data-testid=chapter-word-count]');
      const range = new Range();
      range.selectNodeContents(count);
      const rect = editor.getBoundingClientRect();
      const controls = [...editor.querySelectorAll('[data-testid=chapter-actions] button')];
      return { editorWidth:rect.width, panelWidth:pane.getBoundingClientRect().width, countLines:range.getClientRects().length,
        noHorizontalScroll:editor.scrollWidth<=editor.clientWidth, visibleActions:controls.length===4 && controls.every(button=>{
          const r=button.getBoundingClientRect();
          return r.left>=rect.left && r.right<=rect.right && r.top>=rect.top && r.bottom<=rect.bottom
            && button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
        }) };
    })()`);
    assert.equal(layout.countLines,1,'the word count stays on a single line');
    assert.ok(layout.noHorizontalScroll && layout.visibleActions,JSON.stringify(layout));
    if (narrow) assert.equal(layout.panelWidth,0,'the workbench gives the full area to the editor in a narrow window');
    else assert.ok(layout.panelWidth>0 && layout.editorWidth>=510, 'a previously oversized workbench cannot squeeze the editor');
  };
  await setViewport(1900,1000);
  await app.evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme('light');})()`);
  await app.waitFor('innerWidth===1900 && document.documentElement.dataset.theme==="light"', 'wide light workspace');
  await checkEditorLayout(false);
  await app.screenshot('novel-wide-light.png');
  await setViewport(900,600);
  await app.evaluate(`(async()=>{const {useSettingsStore}=await import('/src/stores/settingsStore.ts');useSettingsStore.getState().setTheme('dark');})()`);
  await app.waitFor('innerWidth===900 && document.querySelector("#novel-narrative-pane").hidden', 'narrow chapter workspace');
  await checkEditorLayout(true);
  await app.screenshot('novel-compact-dark.png');
  await app.click('[data-testid="novel-workbench-toggle"]');
  await app.waitFor(`document.querySelector('.novel-workspace__editor').hidden && !document.querySelector('#novel-narrative-pane').hidden`, 'narrow workbench');
  await app.click('[data-testid="novel-workbench-toggle"]');
  assert.equal(await app.evaluate(`document.querySelector('textarea[placeholder="章节正文..."]').value`),revisedProse,'switching views preserves the active draft');
  await setViewport(1600,1000);
  const autoStart = requests.length;
  const globalPlanContract=await app.evaluate(`(async()=>{
    const {AutopilotEngine}=await import('/src/services/novel/autopilot-engine.ts');
    const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');
    const results=[];
    for(const title of ['GlobalStoryPlanContract','DenyGlobalStoryPlanContract']){
      const chapters=[];const engine=new AutopilotEngine({novelId:title,title,description:'包内只有一张车票。',genre:'mystery',style:'克制',targetChapterCount:1,targetWordCount:3000,existingChapters:chapters,getChapters:()=>chapters,onUpdateChapter:()=>{},onAddChapter:()=>'',onAddVolume:()=>'',onUpdateMetadata:()=>{}});
      try{const plan=await engine.doGlobalPlanning();results.push({plan,saved:new NarrativeRepository(title).loadGlobalPlan()});}
      catch(error){results.push({error:String(error),saved:new NarrativeRepository(title).loadGlobalPlan()});}
    }
    return results;
  })()`);
  assert.equal(globalPlanContract[0].plan.chapters[0].outline,'全书审读后：留下原始登记，再核对可取得的记录。');
  assert.deepEqual(globalPlanContract[0].saved,globalPlanContract[0].plan,'save the reviewed global plan');
  assert.match(globalPlanContract[1].error,/日期矛盾仍未解决/);
  assert.equal(globalPlanContract[1].saved,null,'an unresolved global plan cannot become a resume checkpoint');
  const autoContract = await app.evaluate(`(async()=>{
    const {AutopilotEngine}=await import('/src/services/novel/autopilot-engine.ts');
    const chapters=[{id:'auto-0',order:0,title:'Contract',outline:'林岚调查旧票。',content:'',status:'planned',wordCount:0}];
    const engine=new AutopilotEngine({novelId:'editorial-contract',title:'AutopilotQualityContract',description:'现实世界，禁止超自然。',genre:'mystery',style:'克制',targetChapterCount:1,targetWordCount:3000,existingChapters:chapters,getChapters:()=>chapters,onUpdateChapter:(id,updates)=>Object.assign(chapters[0],updates),onAddChapter:()=>chapters[0].id,onAddVolume:()=>'',onUpdateMetadata:()=>{}});
    engine.state.status='running';
    const content=await engine.doChapterGeneration(0,chapters[0].outline,chapters[0].id);
    await engine.doQualityGateRewrite(0,content,chapters[0].id);
    return {content,status:engine.state.status,chapterStatus:chapters[0].status};
  })()`);
  assert.equal(autoContract.content, [novelProse,novelProse,novelProse].join('\n\n'), 'automatic writing preserves complete beats beyond target word counts');
  const beatRequests = requests.slice(autoStart).filter(r => r.body.stream);
  assert.equal(beatRequests.length,3);
  for (const {body} of beatRequests) {
    assert.deepEqual(body.thinking,{type:'enabled'},'automatic prose also reasons about continuity before writing');
    assert.ok(body.max_tokens>=12000);
  }
  assert.ok(beatRequests[1].body.messages[0].content.includes(novelProse), 'second beat receives the complete first beat');
  assert.ok(beatRequests[2].body.messages[0].content.includes([novelProse,novelProse].join('\n\n')), 'third beat receives all text already written in the chapter');
  assert.equal(autoContract.status,'paused','an unresolved major story issue must pause automatic writing');
  assert.equal(autoContract.chapterStatus,'revising','failed review/revision must never mark the chapter complete');
  for (const [novelId,title,accepted] of [['candidate-contract','AutopilotCandidateContract',false],['passing-contract','AutopilotPassingContract',true]]) {
    const result = await app.evaluate(`(async()=>{
      const {AutopilotEngine}=await import('/src/services/novel/autopilot-engine.ts');
      const {ChapterReviewer}=await import('/src/services/novel/chapter-reviewer.ts');
      const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');
      const chapters=[{id:'chapter',order:0,title:'Contract',outline:'林岚调查旧票。',content:${JSON.stringify(novelProse)},status:'drafting',wordCount:${novelProse.length}}];
      const engine=new AutopilotEngine({novelId:${JSON.stringify(novelId)},title:${JSON.stringify(title)},description:'现实世界，禁止超自然。',genre:'mystery',style:'克制',targetChapterCount:1,targetWordCount:3000,existingChapters:chapters,getChapters:()=>chapters,onUpdateChapter:(id,updates)=>Object.assign(chapters[0],updates),onAddChapter:()=>chapters[0].id,onAddVolume:()=>'',onUpdateMetadata:()=>{}});
      engine.state.status='running';
      const reviewer=new ChapterReviewer(${JSON.stringify(novelId)});
      await reviewer.reviewChapter(0,chapters[0].content,engine.reviewContext(0));
      const repo=new NarrativeRepository(${JSON.stringify(novelId)});
      const before=repo.loadCustomData('chapter-reviews',[])[0];
      const content=await engine.doQualityGateRewrite(0,chapters[0].content,'chapter');
      return {content,before,after:repo.loadCustomData('chapter-reviews',[])[0],candidate:repo.loadCustomData('chapter-revision-candidate:chapter',null),status:engine.state.status,chapterStatus:chapters[0].status};
    })()`);
    assert.ok(result.candidate,'retain candidate and its independent review');
    assert.equal(result.content,accepted?revisedProse:novelProse);
    if (accepted) {
      assert.equal(result.after.contentFingerprint,result.candidate.review.contentFingerprint);
      assert.equal(result.chapterStatus,'complete');
    } else {
      assert.equal(result.candidate.review.findings.length,1,'fixture removes one issue but leaves another major issue');
      assert.deepEqual(result.after,result.before,'rejected candidate review must not overwrite the original report');
      assert.equal(result.status,'paused');
      assert.equal(result.chapterStatus,'revising');
    }
  }
  const budgetStart = requests.length;
  const budgetRecovery = await app.evaluate(`(async () => {
    const {ChapterReviewer} = await import('/src/services/novel/chapter-reviewer.ts');
    const reviewer = new ChapterReviewer('editorial-budget-contract');
    const context = {source:{title:'EditorialTruncationContract',description:'现实调查。',genre:'mystery',style:'克制'},chapters:[]};
    const report = await reviewer.reviewChapter(0,'林岚把车票交给保安。',context);
    const edits = await reviewer.proposeRevision(0,'林岚把车票交给保安。',context,'rewrite',report);
    return {status:report.status,edits};
  })()`);
  assert.equal(budgetRecovery.status,'reviewed');
  assert.deepEqual(budgetRecovery.edits,[]);
  assert.deepEqual(requests.slice(budgetStart).map(r=>r.body.max_tokens),[16384,32768,16384,32768],'review and revision each retry a truncated response once with more output room');
  const failureStart = requests.length;
  const exhaustedBudget = await app.evaluate(`(async () => {
    const {ChapterReviewer} = await import('/src/services/novel/chapter-reviewer.ts');
    const reviewer = new ChapterReviewer('editorial-exhausted-budget-contract');
    try {
      await reviewer.reviewChapter(0,'林岚把车票交给保安。',{source:{title:'EditorialAlwaysTruncatedContract',description:'现实调查。',genre:'mystery',style:'克制'},chapters:[]});
      throw new Error('A truncated report was accepted');
    } catch (error) { return {error:String(error),reports:reviewer.loadHistory().length}; }
  })()`);
  assert.match(exhaustedBudget.error,/truncated/);
  assert.equal(exhaustedBudget.reports,0,'incomplete output must not become a successful review');
  assert.deepEqual(requests.slice(failureStart).map(r=>r.body.max_tokens),[16384,32768],'a persistent truncation stops at the output budget limit');
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
  assert.deepEqual(await app.evaluate(`JSON.parse(localStorage.getItem('mojing-narrative:'+${novelExpr}.id+':plot-outline'))`),savedPlot,'full plot survives page reload');
  assert.deepEqual(external, []); assert.deepEqual(app.errors, []);
  report = { result: 'passed', boundary: 'Remote LLM and images use HTTP fixtures. UI requests, prompt context, cast references, pipeline state, Canvas composition pixels and reload persistence are real. Connectivity probes are blocked. This does not assess model quality.', writingRequests: writing.length, imageRequests: imageRequests.length, frameRequests: frameRequests.length, stages: comic.stages, layouts, dialoguePixels, dialogueReflowWithoutImageGeneration: true, blockedProbes };
} catch (error) {
  report = { result: 'failed', error: String(error), runtimeErrors: app.errors, external };
  await app.screenshot('failure.png').catch(() => {}); throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); app.close();
}
console.log(JSON.stringify(report));

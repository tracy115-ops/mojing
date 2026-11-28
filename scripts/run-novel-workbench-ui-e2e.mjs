import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromeSession } from './lib/chrome-session.mjs';

// These cases exercise the production UI and HTTP adapters with deterministic
// model responses. They establish data flow and recovery, not literary quality.
const output = resolve(process.env.MOJING_E2E_ARTIFACT_DIR || 'artifacts/novel-workbench-ui-e2e');
await mkdir(output, { recursive: true });
const url = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1437/';
const origin = new URL(url).origin;
const app = await chromeSession({ url, port: 9269 });
const pane = '.narrative-workbench-tabs > .ant-tabs-content-holder > .ant-tabs-content > .ant-tabs-tabpane-active';
const novelId = 'workbench-ui-contract';
const projectExpr = `JSON.parse(localStorage.getItem('mojing-projects')).state.projects.find(p=>p.id===${JSON.stringify(novelId)})`;
const stored = suffix => `JSON.parse(localStorage.getItem(${JSON.stringify('mojing-narrative:' + novelId + ':' + suffix)}))`;
const requests = [], external = [], pages = [], assertions = [];
let failDialogue = false, streamIndex = 0, holdStream, holdRevision, offerRevision = false, revisionGatewayError = false;
let offerIncompleteRevision = false;
let failCandidateReview = false;
let truncatedBeat = false;
let malformedAutopilotReview = false;
let truncateChapterReview = false;
const drafts = ['林岚把登记簿放在值班桌上。', '保安核对编号后签了字。', '林岚收好回执，离开值班室。'];
const signedAlone = '本次由保安一人签收回执。';
const incompleteRevision = '保安独自签下回执。';
const countersignRule = '值班室内回执必须由两人共同签收。';
const archiveRule = '档案室仅在工作日开放。';
const incorrectArchiveVisit = '林岚周日进入档案室调阅。';
const revisedArchiveVisit = '林岚周一进入档案室调阅。';
const review = {
  dimensions: ['premise_fidelity', 'character_consistency', 'timeline_consistency', 'plot_coherence', 'foreshadowing_usage', 'voice_quality'].map(name => ({ name, score: 80 })),
  summary: 'Fixture review of the selected manuscript; not a live quality result.', findings: [],
  continuityNotes: [
    { paragraphId: 'C1', kind: 'clue', fact: '线索摘录测试' },
    { paragraphId: 'C1', kind: 'prop', fact: '道具摘录测试', link: { kind: 'fact', subject: '林岚', predicate: '放下', object: '登记簿' } },
    { paragraphId: 'C1', kind: 'world', fact: '规则摘录测试' },
  ],
};
app.onEvent(event => {
  if (event.method !== 'Fetch.requestPaused') return;
  void (async () => {
    const { requestId, request } = event.params;
    const target = new URL(request.url);
    if (target.origin !== origin) {
      if (['data:', 'blob:'].includes(target.protocol)) return app.call('Fetch.continueRequest', { requestId });
      if (!(target.pathname === '/' && ['api-beijing.klingai.com', 'api.deepseek.com', 'www.baidu.com'].includes(target.hostname))) external.push(request.url);
      return app.call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
    if (target.pathname !== '/chat/completions') return app.call('Fetch.continueRequest', { requestId });
    const body = JSON.parse(request.postData), system = body.messages[0].content;
    requests.push(body);
    let content, type = 'application/json', responseCode = 200;
    if (system.includes('角色对话生成器')) {
      if (failDialogue) { responseCode = 400; content = { error: { message: 'Fixture dialogue unavailable' } }; }
      else content = '记录里没有，不代表实物不存在。先去核对。';
    } else if (system.includes('负责局部情节审读')) {
      const user = body.messages[1].content;
      const fields = JSON.parse(user.split('【待审字段】\n\n')[1].split('\n\nJSON 格式示例')[0]);
      const references = user.split('【待审字段】')[0];
      const reference = [...references.matchAll(/\[(R\d+)\]\n([\s\S]*?)(?=\n\n\[R\d+\]\n|$)/g)]
        .find(match => match[2].includes(archiveRule));
      assert.ok(reference, 'local review receives the author’s original rule');
      content = { findings: fields.description?.includes(incorrectArchiveVisit) ? [{
        field: 'description', paragraphId: user.includes('上次审读无法定位修改') ? 'C1' : 'C99',
        referenceId: reference[1], reason: '周日无法调阅，档案室仅在工作日开放。', replacement: '[C1]\n' + revisedArchiveVisit,
      }] : [] };
    } else if (system.includes('认真通读作品的小说编辑')) {
      const user = body.messages[1].content;
      if (truncateChapterReview) {
        truncateChapterReview = false;
        const reply = JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
        return app.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(reply).toString('base64') });
      }
      if (truncatedBeat && !malformedAutopilotReview && drafts.every(draft => user.includes(draft))) {
        malformedAutopilotReview = true;
        const reply = JSON.stringify({ choices: [{ message: { content: '我已经读完该章。' }, finish_reason: 'stop' }] });
        return app.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(reply).toString('base64') });
      }
      if (failCandidateReview && user.includes(incompleteRevision)) {
        failCandidateReview = false;
        return app.call('Fetch.fulfillRequest', { requestId, responseCode: 400, body: '' });
      }
      content = user.includes(signedAlone) && user.includes(countersignRule) ? { ...review, findings: [{
        dimension: 'timeline_consistency', severity: 'minor', basis: 'conflict',
        quote: signedAlone, referenceQuote: countersignRule,
        currentEvidence: signedAlone, referenceEvidence: countersignRule,
        problem: '本次只有一人签收，违反值班室两人签收的规则。', suggestion: '核对签收现场。',
      }] } : review;
      if (user.includes('[C') && user.includes(incompleteRevision)) content = { ...review, findings: [{
        dimension: 'plot_coherence', severity: 'major', basis: 'craft',
        quote: incompleteRevision, problem: '改稿仍未交代另一位签收人。', suggestion: '写明两人共同签收。',
      }] };
      if (user.includes('[C1]\n林岚和陈默在二楼核对登记。')) content = {
        ...content,
        continuityNotes: [...content.continuityNotes, {
          kind: 'event', fact: '两人共同核对登记。', paragraphId: 'C1',
          link: { kind: 'relationship', subject: '林岚', predicate: '共同核对登记', object: '陈默' },
        }],
      };
    } else if (system.includes('小说责任编辑')) {
      if (revisionGatewayError) {
        revisionGatewayError = false;
        return app.call('Fetch.fulfillRequest', { requestId, responseCode: 503, body: '' });
      }
      const prose = body.messages[1].content.split('【审稿问题】')[0];
      content = prose.includes('本次两人共同签收回执。') ? { edits: [{
        before: '本次两人共同签收回执。', after: '两人一起在回执上签了字。', reason: '按作者要求让签收动作更具体。',
      }] } : holdRevision || offerRevision || offerIncompleteRevision ? { edits: [{
        before: prose.includes(incompleteRevision) ? incompleteRevision : signedAlone,
        after: offerIncompleteRevision ? incompleteRevision : '本次两人共同签收回执。',
        reason: '按世界规则签收。',
      }] } : { edits: [] };
      if (holdRevision) await holdRevision;
    }
    else if (system.includes('你是小说情节编辑')) {
      content = { ready: true, edits: [], unresolvedIssues: [] };
    }
    else if (system.includes('小说总架构师')) content = {
      mainPlot: '按前文继续核对登记。', coreConflict: '登记与实物须对照。', themeMessage: '尊重证据。',
      volumes: [{ title: '核对', startChapter: 0, endChapter: 4, theme: '追查凭据' }],
      chapters: Array.from({ length: 5 }, (_, order) => ({ order, title: '规划' + (order + 1), outline: '林岚依已有登记核对实物与凭据。', volumeIndex: 0, keyEvents: ['核对登记'] })), ending: '保留未解问题。',
    };
    else if (system.includes('资深小说策划师')) content = { title: '回执', direction: '林岚核对登记，保安签收，林岚保留回执。', conflictCore: '登记需要核实。', endingHook: '带回凭据。' };
    else if (system.includes('小说大纲规划师')) content = '林岚将登记簿交给保安，保安核对编号并签收，林岚收好回执。';
    else if (system.includes('你是小说策划编辑')) content = { ready: true, outline: '林岚将登记簿交给保安，保安核对编号并签收，林岚收好回执。', changes: [], unresolvedIssues: [] };
    else if (system.includes('叙事节拍规划师')) content = { beats: drafts.map((description, index) => ({ description, targetWords: 1000, focus: 'dialogue', sceneGoal: '完成核对的第' + (index + 1) + '步' })) };
    else if (body.stream) {
      type = 'text/event-stream';
      const truncate = streamIndex === 1 && !truncatedBeat;
      if (truncate) truncatedBeat = true;
      const text = truncate ? '未完成的重复正文。' : drafts[streamIndex++ % drafts.length];
      content = 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: '
        + (truncate ? JSON.stringify({ choices: [{ finish_reason: 'length' }] }) : '[DONE]') + '\n\n';
      if (holdStream) await holdStream;
    } else throw new Error('Unexpected model task: ' + system.slice(0, 80));
    const result = responseCode !== 200 ? JSON.stringify(content) : type === 'text/event-stream' ? content
      : JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }] });
    await app.call('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(result).toString('base64') });
  })().catch(error => app.errors.push(String(error)));
});
const fill = async (selector, value) => {
  await app.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 'input ' + selector);
  await app.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
};
const choose = async (selector, label) => {
  await app.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 'select ' + label);
  await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('.ant-select').querySelector('.ant-select-selector').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`);
  const option = `(()=>{const input=document.querySelector(${JSON.stringify(selector)});const popup=document.getElementById(input.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return popup&&[...popup.querySelectorAll('.ant-select-item-option')].find(e=>e.title===${JSON.stringify(label)});})()`;
  await app.waitFor(`!!(${option})`, 'option ' + label); await app.evaluate(`(${option}).click()`);
};
const open = async (category, key) => {
  await app.click(`[data-workbench-category="${category}"]`);
  await app.click(`.narrative-workbench-tabs > .ant-tabs-nav [role="tab"][id$="-tab-${key}"]`);
  await app.waitFor(`document.querySelector(${JSON.stringify(pane)})?.id.endsWith(${JSON.stringify('-panel-' + key)})`, 'panel ' + key);
};
const text = () => app.evaluate(`document.querySelector(${JSON.stringify(pane)}).innerText`);
const saveModal = async () => { await app.click('.ant-modal-footer .ant-btn-primary'); await app.waitFor('!document.querySelector(".ant-modal")', 'saved modal'); };
const shot = async name => {
  const capture = await app.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, name + '.png'), Buffer.from(capture.data, 'base64'));
};
const check = name => assertions.push(name);
let report = { result: 'running', boundary: 'Isolated Chrome; actual React UI and production provider adapters; deterministic HTTP fixtures; no live quality claim.' };
try {
  await app.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await app.call('Page.navigate', { url });
  await app.waitFor('!!document.querySelector(".ws-titlebar")', 'application');
  await app.evaluate(`(async()=>{
    const {useProjectStore}=await import('/src/stores/projectStore.ts');
    const {useProviderStore}=await import('/src/stores/providerStore.ts');
    const {NarrativeRepository}=await import('/src/services/novel/narrative-repository.ts');
    const now=new Date().toISOString(), id=${JSON.stringify(novelId)};
    const bodies=['林岚核对车票，记下了编号。','陈默把帆布包放进柜子。','林岚和陈默在二楼核对登记。','林岚不由得停了一下。她想起登记簿，不由得又回到值班室。'];
    const nodes=Array.from({length:34},(_,order)=>({id:'chapter-'+order,novelId:id,nodeType:'chapter',parentId:null,order,title:'作者章节'+(order+1),outline:'按作者资料核对登记。',content:bodies[order]||'',wordCount:(bodies[order]||'').length,status:order<4?'complete':'planned',createdAt:now,updatedAt:now}));
    const legacy=nodes.map(n=>({...n,content:'错误的旧正文不应被读取。',wordCount:13}));
    const project={id,type:'novel',title:'工作台验收',description:'现实公交行业悬疑，禁止超自然。'+${JSON.stringify(archiveRule)},status:'in_progress',createdAt:now,updatedAt:now,tags:[],isFavorite:false,metadata:{genre:'mystery',style:'克制',language:'中文',targetWordCount:15000,currentWordCount:bodies.join('').length,chapters:legacy,volumes:[],storyNodes:nodes}};
    const repo=new NarrativeRepository(id), bible=repo.loadBible();
    bible.characters=['林岚','陈默','许安'].map((name,i)=>({id:['driver','colleague','unmentioned'][i],name,aliases:[''],description:'职业与信息需要核实。',appearance:'工作制服',personality:'谨慎',backstory:'原始经历',importance:i?'supporting':'protagonist',status:'active',currentState:'',firstAppearChapter:0,lastUpdateChapter:0,relationships:i===0?[{targetCharacterId:'colleague',type:'同事',description:'作者关系',sinceChapter:0}]:[]}));
    bible.timelineNotes=[{id:'plot-outline',event:'过时总纲标记：档案室周日开放。',significance:''}];
    repo.saveBible(bible);
    repo.saveCustomData('plot-outline',{mainPlot:'林岚核对票务登记。',coreConflict:'台账与实物不符。',stages:[{name:'查证',chapterRange:'第1～5章',description:'先核对回执再查票源。',coreEvent:'保留原始回执。',foreshadowSeeds:['遗失一页']}],ending:'证据与口供互相印证。'});
    repo.saveForeshadowing([{id:'future-ledger',novelId:id,description:'未来才埋设的线索',plantedInChapter:9,suggestedResolveChapter:10,status:'planted',relatedCharacters:[],urgency:'medium',narrativeWeight:5}]);
    repo.saveTriples([
      {subject:'未确认甲',predicate:'未确认关系',object:'未确认乙',sinceChapter:0,source:'extracted'},
      {subject:'林岚',predicate:'模型猜测师徒',object:'陈默',sinceChapter:0,source:'extracted'}
    ]);
    useProjectStore.setState({projects:[project],activeProjectId:id});
    const p=useProviderStore.getState();
    useProviderStore.setState({config:{...p.config,llm:{...p.config.llm,primary:'deepseek',endpointId:'workbench-llm',defaultModel:'deepseek-v4-pro',models:{}}},endpoints:[{id:'workbench-llm',provider:'deepseek',category:'llm',baseUrl:${JSON.stringify(origin)},apiKey:'fixture',models:['deepseek-v4-pro'],enabled:true}]});
  })()`);
  await app.click('button[aria-label="小说引擎"]');
  await app.waitFor('!!document.querySelector("[data-testid=narrative-dashboard]")', 'dashboard');
  assert.match(await text(), /4\s*\/\s*34/);
  assert.doesNotMatch(await text(), /终局|治理|综合.*分|错误的旧正文/);
  check('Dashboard counts only four actual StoryNode manuscripts out of 34, without fabricated quality or phase');
  for (const category of ['overview', 'characters', 'plot', 'quality', 'tools']) {
    await app.click(`[data-workbench-category="${category}"]`);
    const tabs = await app.evaluate(`[...document.querySelectorAll('.narrative-workbench-tabs > .ant-tabs-nav [role="tab"]')].map(e=>({id:e.id,label:e.innerText}))`);
    for (const tab of tabs) {
      await app.click('[id=' + JSON.stringify(tab.id) + ']');
      await app.delay(150);
      const key = tab.id.split('-tab-').at(-1), body = await text();
      await writeFile(join(output, category + '-' + key + '.txt'), body);
      await shot(category + '-' + key);
      pages.push({ category, key, label: tab.label });
      assert.doesNotMatch(body, /错误的旧正文/);
    }
  }
  assert.equal(pages.length, 14);
  check('All 14 retained panels render; the 12 misleading entries are absent');

  await open('quality', 'chapterReview');
  await choose(pane + ' .ant-select input', '第4章 · 作者章节4');
  await open('overview', 'bible');
  await app.click(pane + ' button:has(.anticon-edit)');
  await app.waitFor('!!document.querySelector(".ant-modal #backstory")', 'character editor');
  await fill('.ant-modal #backstory', '作者确认经历：她曾负责登记簿归档。');
  await saveModal();
  assert.match(await app.evaluate(stored('bible') + '.characters[0].backstory'), /作者确认经历/);
  check('Character details save through the normal Bible form');

  await open('plot', 'worldbuilding');
  const worldInput = pane + ' textarea[placeholder="这个世界的根本运行法则"]';
  await fill(worldInput, '作者规则标记：所有异常票据须留原件供核对。');
  await app.textButton('保存', pane);
  assert.match(await app.evaluate(stored('worldbuilding') + '.dimensions.coreRules.fields.coreLaws'), /作者规则标记/);
  await open('plot', 'storyline');
  const plotOverview = '[data-testid=story-plan-overview]';
  assert.match(await text(), /林岚核对票务登记。/);
  await app.evaluate(`document.querySelectorAll('${plotOverview} .ant-collapse-header')[1].click()`);
  assert.match(await text(), /保留原始回执。/);
  await app.evaluate(`document.querySelectorAll('${plotOverview} .ant-collapse-header')[2].click()`);
  assert.match(await text(), /证据与口供互相印证。/);
  const savedPlanBeforeEdit = await app.evaluate(stored('plot-outline'));
  const stageEdit = '[data-testid=story-plan-editor][aria-label="查证"]';
  const untouchedPassage = '她先核对回执再查票源。';
  const draftStage = incorrectArchiveVisit + '\n\n' + untouchedPassage;
  await app.click(`${plotOverview} button[aria-label="编辑查证"]`);
  await fill(`${stageEdit} textarea`, draftStage);
  await app.textButton('保存', stageEdit);
  assert.equal(await app.evaluate(stored('plot-outline') + '.stages[0].description'), draftStage);
  const beforeSectionReview = requests.length;
  await app.textButton('审读此段', stageEdit);
  await app.waitFor(`document.querySelector('${stageEdit} [data-testid=story-plan-review-results]')?.innerText.includes(${JSON.stringify(revisedArchiveVisit)})`, 'scoped review preview');
  const preview = await app.evaluate(`document.querySelector('${stageEdit} [data-testid=story-plan-review-results]').innerText`);
  for (const value of [incorrectArchiveVisit, revisedArchiveVisit, archiveRule]) assert.ok(preview.includes(value));
  assert.equal(await app.evaluate(stored('plot-outline') + '.stages[0].description'), draftStage, 'preview leaves the saved text untouched');
  const reviewRequests = requests.slice(beforeSectionReview);
  assert.equal(reviewRequests.length, 2, 'invalid paragraph references are regenerated once');
  for (const request of reviewRequests) {
    const user = request.messages[1].content;
    const fields = JSON.parse(user.split('【待审字段】\n\n')[1].split('\n\nJSON 格式示例')[0]);
    assert.deepEqual(Object.keys(fields), ['description','coreEvent']);
    assert.ok(user.includes('证据与口供互相印证。'), 'ending is available for comparison');
    assert.ok(!user.includes('过时总纲标记'), 'the edited outline supersedes the legacy summary');
  }
  await shot('story-plan-section-review');
  await app.textButton('定位文本', stageEdit);
  assert.equal(await app.evaluate('document.activeElement.value?.slice(document.activeElement.selectionStart,document.activeElement.selectionEnd)'), incorrectArchiveVisit);
  await app.textButton('采纳并保存', stageEdit);
  await app.waitFor(`document.querySelector('${stageEdit} [data-testid=story-plan-review-results]')?.innerText.includes('修订已保存')`, 'saved comparison');
  const revisedPlan = await app.evaluate(stored('plot-outline'));
  assert.deepEqual(revisedPlan, { ...savedPlanBeforeEdit, stages: [{ ...savedPlanBeforeEdit.stages[0], description: revisedArchiveVisit + '\n\n' + untouchedPassage }] });
  await app.textButton('审读此段', stageEdit);
  await app.waitFor(`document.querySelector('${stageEdit} [data-testid=story-plan-review-results]')?.innerText.includes('本次审读未发现需改之处')`, 're-review of the saved passage');
  await app.textButton('完成', stageEdit);
  const endingEdit = '[data-testid=story-plan-editor][aria-label="结局"]';
  await app.click(`${plotOverview} button[aria-label="编辑结局"]`);
  await fill(`${endingEdit} textarea`, revisedPlan.ending + '林岚把原始回执归档。');
  await app.textButton('保存', endingEdit);
  assert.equal(await app.evaluate(stored('plot-outline') + '.ending'), revisedPlan.ending + '林岚把原始回执归档。');
  await app.textButton('完成', endingEdit);
  check('One outline section can be edited, reviewed with verified citations, selected in the editor, adopted and reviewed again while other passages stay intact. The ending also saves through the workbench.');
  await app.textButton('添加故事线', pane);
  await app.waitFor('!!document.querySelector(".ant-modal #chapterStart")', 'storyline editor');
  await fill('.ant-modal #name', '登记副线'); await fill('.ant-modal #description', '副线标记：核对签收人与登记次序。');
  await fill('.ant-modal #chapterStart', '2'); await fill('.ant-modal #chapterEnd', '5');
  await saveModal();
  assert.deepEqual(await app.evaluate(stored('storylines') + '[0].chapterRange'), [1, 4]);
  check('The full plot displays its actual stage and ending; side plots use the author’s one-based chapter range; world rules save');

  await open('characters', 'cast');
  await app.click(pane + ' button:has(.anticon-unlock)');
  // Plan the absent character, whose name must still count as zero mentions.
  await app.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(pane)});const row=[...root.querySelectorAll('span')].find(e=>e.textContent==='许安').closest('div[style*="justify-content"]');row.querySelector('button').click()})()`);
  assert.ok((await app.evaluate(stored('casts') + '.find(c=>c.chapterIndex===3).lockedCharacters')).includes('unmentioned'));
  await app.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(pane)});[...root.querySelectorAll('[role=tab]')].find(e=>e.innerText.includes('姓名提及')).click()})()`);
  assert.match(await app.evaluate(`document.querySelector(${JSON.stringify(pane + ' [data-row-key="unmentioned"]')}).innerText`), /0%/);
  assert.match(await app.evaluate(`document.querySelector(${JSON.stringify(pane + ' [data-row-key="driver"]')}).innerText`), /75%/);
  check('Cast plans persist for the selected chapter but never count as name mentions; empty chapters are excluded');

  await open('characters', 'relationGraph');
  await app.waitFor(`!!document.querySelector(${JSON.stringify(pane + ' canvas')})?.width`, 'relationship chart renders');
  const relationCounts = await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(pane + ' .ant-badge-count')})].map(e=>Number(e.getAttribute('title')||e.textContent))`);
  assert.deepEqual(relationCounts, [3, 1], 'three saved characters and their one confirmed relationship');
  check('Character graph keeps the confirmed Bible edge and excludes the unconfirmed relationship between the same two characters');

  await open('plot', 'foreshadow');
  assert.match(await text(), /建议复看 0 条/);
  await app.textButton('添加伏笔', pane);
  await fill('.ant-modal #description', '伏笔标记：登记簿缺失的一页仍未查明。');
  await fill('.ant-modal #plantedInChapter', '1'); await fill('.ant-modal #suggestedResolveChapter', '3');
  await saveModal();
  assert.match(await text(), /建议复看 1 条/);
  await app.click(pane + ' .ant-list-item:has(.anticon-check-circle) button:has(.anticon-check-circle):not([disabled])');
  assert.equal(await app.evaluate(stored('foreshadowing') + '.find(f=>f.description.includes("伏笔标记")).resolvedInChapter'), 4);
  assert.equal(await app.evaluate(stored('foreshadowing') + '.find(f=>f.id==="future-ledger").status'), 'planted');
  check('Foreshadow reminders use written prose; manual resolution records the selected chapter and preserves future plans');

  await open('plot', 'props');
  await app.textButton('添加道具', pane);
  await fill('.ant-modal #name', '值班登记簿'); await fill('.ant-modal #description', '道具标记：蓝色封面，保留原始签字。');
  await fill('.ant-modal #introducedChapter', '2');
  await fill('.ant-modal #stateAsOfChapter', '6');
  await choose('.ant-modal #lifecycleState', '使用中');
  await choose('.ant-modal #holderCharacterId', '陈默');
  await saveModal();
  assert.equal(await app.evaluate(stored('props') + '[0].lifecycleState'), 'active');
  assert.equal(await app.evaluate(stored('props') + '[0].introducedChapter'), 2);
  assert.equal(await app.evaluate(stored('props') + '[0].stateAsOfChapter'), 6);
  assert.equal(await app.evaluate(stored('props') + '[0].holderCharacterId'), 'colleague');
  check('Prop form persists its first chapter, state chapter and stable holder identity');

  await open('plot', 'knowledgeGraph');
  assert.match(await text(), /待核对/);
  assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(pane + ' .ant-list-item')}).querySelector('button:has(.anticon-delete)').disabled`), true);
  await app.textButton('添加', pane);
  await fill('.ant-modal #subject', '登记簿'); await fill('.ant-modal #predicate', '存放地点'); await fill('.ant-modal #object', '值班室');
  await saveModal();
  assert.equal(await app.evaluate(stored('triples') + '.find(t=>t.subject==="登记簿").source'), 'bible');
  check('Knowledge graph preserves author-derived relations and saves explicit author facts');

  await open('quality', 'chapterReview');
  const beforeFirstReview = requests.length;
  truncateChapterReview = true;
  await app.textButton('运行评审', pane);
  await app.waitFor(`${stored('chapter-reviews')}?.some(r=>r.chapter===3)`, 'selected chapter review');
  const [truncatedReviewRequest, firstReviewRequest] = requests.slice(beforeFirstReview);
  assert.equal(requests.length - beforeFirstReview, 2, 'one retry after truncated review');
  assert.equal(truncatedReviewRequest.thinking.type, 'enabled');
  assert.equal(firstReviewRequest.thinking.type, 'disabled');
  assert.equal(firstReviewRequest.max_tokens, 32768);
  assert.deepEqual(firstReviewRequest.messages, truncatedReviewRequest.messages, 'retry retains the full text and review instructions');
  const wholeRequest = JSON.stringify(firstReviewRequest.messages);
  for (const marker of ['作者确认经历', '作者规则标记', '副线标记', '作者本章出场计划', '许安', '伏笔标记', '道具标记', '存放地点', '林岚和陈默在二楼核对登记。']) assert.ok(wholeRequest.includes(marker), 'review includes saved reference: ' + marker);
  for (const marker of ['错误的旧正文', '未确认关系', '未来才埋设的线索', '截至第6章台账状态', '持有者：陈默']) assert.ok(!wholeRequest.includes(marker), 'exclude unsupported or future data: ' + marker);
  await choose(pane + ' .ant-select input', '第1章 · 作者章节1');
  await app.textButton('运行评审', pane);
  await app.waitFor(`${stored('chapter-reviews')}.some(r=>r.chapter===0)`, 'first chapter review');
  assert.equal(requests.at(-1).thinking.type, 'disabled', 'the next review on the same route avoids the truncated reasoning mode');
  assert.match(await text(), /第1章/);
  assert.equal((await app.evaluate(stored('chapter-reviews'))).length, 2);
  check('Review requests contain actual author references and complete recent prose; each chapter has its own selectable report');
  await open('plot', 'worldbuilding');
  await fill(worldInput, '作者规则标记：全部原件须由两人核对。'); await app.textButton('保存', pane);
  await open('quality', 'chapterReview');
  assert.match(await text(), /已变更|已过期|需重新审稿|重新审读/);
  check('Changing author references immediately marks an earlier review stale');

  await choose(pane + ' .ant-select input', '第4章 · 作者章节4');
  await open('quality', 'audit');
  assert.match(await text(), /不由得/);
  assert.doesNotMatch(await text(), /AI率|AI 概率|综合得分/);
  check('Repeated phrases show current prose context without claiming AI authorship or judging prose by frequency');

  await open('characters', 'dialogue');
  await choose(pane + ' .ant-select input', '林岚');
  await fill(pane + ' textarea', '林岚要求核对票据，先不下结论。');
  await app.textButton('生成对话', pane);
  await app.waitFor(`document.querySelector(${JSON.stringify(pane)}).innerText.includes('记录里没有，不代表实物不存在。')`, 'dialogue result');
  const dialogueRequest = requests.at(-1);
  assert.ok(dialogueRequest.messages[1].content.includes('林岚不由得停了一下。'));
  assert.ok(dialogueRequest.messages[0].content.includes('作者规则标记'));
  failDialogue = true;
  await app.textButton('生成对话', pane);
  await app.waitFor('document.body.innerText.includes("Fixture dialogue unavailable")', 'honest dialogue failure');
  assert.ok(!(await text()).includes('记录里没有，不代表实物不存在。'));
  failDialogue = false;
  check('Dialogue generation uses current prose and author context; a provider failure never becomes fabricated fallback dialogue');

  // Confirm a legacy extraction only through the explicit author confirmation UI.
  await open('plot', 'knowledgeGraph');
  await app.click(pane + ' button:has(.anticon-check)');
  assert.equal(await app.evaluate(stored('triples') + '.find(t=>t.subject==="未确认甲").source'), 'bible');
  await app.evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(pane)});[...root.querySelectorAll('.ant-list-item')].find(e=>e.innerText.includes('未确认甲')).querySelector('button:has(.anticon-delete)').click()})()`);
  assert.equal(await app.evaluate(stored('triples') + '.some(t=>t.subject==="未确认甲")'), false);
  check('Legacy extracted facts require author confirmation and can be deleted persistently');

  // Run an actual automatic-writing session via its normal start button.
  // The target is chapter five; 30 empty planning nodes must not move the cursor to chapter 35.
  const beforeBodies = await app.evaluate(projectExpr + '.metadata.storyNodes.filter(n=>n.nodeType==="chapter").slice(0,4).map(n=>n.content)');
  const beforeLedger = await app.evaluate(stored('foreshadowing'));
  let releaseStream;
  holdStream = new Promise(resolveStream => { releaseStream = resolveStream; });
  const beforeAutopilot = requests.length;
  await app.textButton('自动写多章');
  const writingDeadline = Date.now() + 20000;
  while (streamIndex === 0 && Date.now() < writingDeadline) await app.delay(100);
  assert.equal(streamIndex, 1, 'automatic writing reaches the real streaming adapter');
  assert.match(await text(), /第5章/);
  assert.match(await text(), /当前步骤: 生成内容/);
  assert.match(await text(), /80%/);
  await shot('autopilot-generating');
  releaseStream(); holdStream = undefined;
  await app.waitFor(`${stored('checkpoint')}?.nextChapterIndex===5`, 'completed chapter checkpoint', 30000);
  await app.waitFor('document.body.innerText.includes("已完成")', 'automatic session completion');
  const afterBodies = await app.evaluate(projectExpr + '.metadata.storyNodes.filter(n=>n.nodeType==="chapter").slice(0,4).map(n=>n.content)');
  assert.deepEqual(afterBodies, beforeBodies);
  assert.deepEqual(await app.evaluate(stored('foreshadowing')), beforeLedger);
  const newChapter = await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4")');
  assert.equal(newChapter.content, drafts.join('\n\n'));
  assert.equal(newChapter.status, 'complete');
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.filter(n=>n.nodeType==="chapter").length'), 34);
  const autoRequests = requests.slice(beforeAutopilot);
  const proseRequests = autoRequests.filter(body => body.stream);
  assert.equal(proseRequests.length, 4);
  assert.ok(JSON.stringify(proseRequests[0].messages).includes('道具标记'));
  assert.ok(JSON.stringify(proseRequests[0].messages).includes('副线标记'));
  assert.ok(JSON.stringify(proseRequests[1].messages).includes(drafts[0]));
  assert.deepEqual(proseRequests.slice(1, 3).map(body => body.max_tokens), [12288, 24576]);
  assert.deepEqual(proseRequests[1].messages, proseRequests[2].messages);
  assert.doesNotMatch(newChapter.content, /未完成的重复正文/);
  assert.ok(malformedAutopilotReview);
  const formatRetry = autoRequests.find(body => body.messages[0].content.includes('首个非空白字符必须是 {'));
  assert.equal(formatRetry?.thinking.type, 'disabled');
  assert.ok(!autoRequests.some(body => /张力评分师|声纹提取|事实提取师|读者模拟/.test(body.messages[0].content)));
  await open('tools', 'autopilotPipeline');
  assert.match(await text(), /100%/);
  await open('tools', 'checkpoint');
  assert.match(await text(), /第5章/);
  assert.doesNotMatch(await text(), /恢复快照|恢复此版本/);
  check('UI automatic session writes chapter five, keeps earlier prose and author ledgers intact, reuses references, shows 100% and saves nextChapterIndex=5');
  check('A truncated prose beat retries within the running chapter and saves only the completed response');
  check('A malformed editorial reply triggers a strict JSON retry without pausing the chapter');
  const evidence = pane + ' [data-testid=continuity-evidence]';
  for (const [tab, label] of [['foreshadow', '线索摘录测试'], ['props', '道具摘录测试'], ['worldbuilding', '规则摘录测试'], ['knowledgeGraph', '道具摘录测试']]) {
    await open('plot', tab);
    const noteHeader = evidence + ' .ant-collapse-item:last-child > .ant-collapse-header';
    if (await app.evaluate(`document.querySelector(${JSON.stringify(noteHeader)})?.getAttribute('aria-expanded')==='false'`)) await app.click(noteHeader);
    await app.waitFor(`document.querySelector(${JSON.stringify(evidence)})?.innerText.includes(${JSON.stringify(drafts[0])})`, tab + ' references actual prose');
    const visible = await app.evaluate(`document.querySelector(${JSON.stringify(evidence)})?.innerText`);
    assert.ok(visible.includes(label), tab + ' shows the model note');
  }
  check('Reviewed evidence appears in the relevant story panels with the exact saved chapter text');

  // A reload constructs a new engine from the checkpoint. Existing authored
  // prose must survive; a fully written target needs no additional HTTP calls.
  const beforeResume = requests.length;
  const oldLoader = (await app.call('Page.getFrameTree')).frameTree.frame.loaderId;
  await app.call('Page.reload');
  const reloadDeadline = Date.now() + 20000;
  while ((await app.call('Page.getFrameTree')).frameTree.frame.loaderId === oldLoader) {
    if (Date.now() > reloadDeadline) throw new Error('Reload did not navigate');
    await app.delay(100);
  }
  await app.waitFor(`!!document.querySelector('button[aria-label="小说引擎"]')`, 'reload');
  await app.click('button[aria-label="小说引擎"]');
  await app.waitFor('document.body.innerText.includes("自动写多章")', 'resume entry');
  await app.textButton('自动写多章');
  await app.waitFor('document.body.innerText.includes("已完成")', 'resume completion');
  assert.equal(requests.length, beforeResume);
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content'), drafts.join('\n\n'));
  check('Restart resumes after the saved chapter without generating over existing text');

  await open('quality', 'chapterReview');
  await choose(pane + ' .ant-select input', '第5章 · 回执');
  const authorDraft = drafts.join('\n\n') + '\n\n' + signedAlone;
  await fill('textarea[placeholder="章节正文..."]', authorDraft);
  await app.waitFor(`${projectExpr}.metadata.storyNodes.find(n=>n.id==="chapter-4").status==='drafting'`, 'manual edit invalidates completion');
  const beforeDraftResume = requests.length;
  await app.textButton('自动写多章');
  await app.waitFor(`${projectExpr}.metadata.storyNodes.find(n=>n.id==="chapter-4").status==='complete'`, 'review existing draft');
  await app.waitFor('document.body.innerText.includes("已完成")', 'draft resume completion');
  assert.equal(requests.length, beforeDraftResume + 1);
  assert.ok(requests.at(-1).messages[0].content.includes('认真通读作品的小说编辑'));
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content'), authorDraft);
  check('Editing completed prose invalidates completion; recovery reviews the saved author draft instead of rewriting it, even when its checkpoint points later');

  await open('plot', 'worldbuilding');
  await fill(worldInput, countersignRule);
  await app.textButton('保存', pane);
  const beforeRuleChange = requests.length;
  await app.textButton('自动写多章');
  await app.waitFor(`${stored('chapter-reviews')}.find(r=>r.chapter===4)?.findings[0]?.basis==='conflict'`, 'stale review is replaced with a cited conflict', 30000);
  await app.waitFor('document.body.innerText.includes("已保留草稿并暂停")', 'automatic writing pause');
  const gateRequests = requests.slice(beforeRuleChange);
  assert.ok(gateRequests.some(body => body.messages[0].content.includes('认真通读作品的小说编辑')));
  assert.equal(gateRequests.some(body => body.stream), false, 'stale completion must not generate new prose');
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").status'), 'revising');
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content'), authorDraft);
  await open('quality', 'chapterReview');
  await choose(pane + ' .ant-select input', '第5章 · 回执');
  assert.match(await text(), /事实或核心冲突/);
  assert.ok((await text()).includes(countersignRule));
  check('Changing an explicit world rule re-audits completed prose and pauses on a verified conflict despite the model calling it minor');

  let releaseRevision;
  holdRevision = new Promise(resolveRevision => { releaseRevision = resolveRevision; });
  const beforeStop = requests.length;
  await app.textButton('继续');
  const revisionDeadline = Date.now() + 10000;
  while (requests.length === beforeStop && Date.now() < revisionDeadline) await app.delay(100);
  assert.match(requests.at(-1).messages[0].content, /小说责任编辑/);
  await app.textButton('停止');
  releaseRevision();
  holdRevision = undefined;
  await app.delay(500);
  assert.equal(requests.length, beforeStop + 1, 'a stopped revision does not launch its candidate review');
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content'), authorDraft);
  check('A revision response arriving after Stop cannot replace saved prose or continue the writing pipeline');

  await app.call('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await app.waitFor('document.querySelector("#novel-narrative-pane")?.classList.contains("novel-workspace__workbench--full")', 'narrow workbench layout after viewport change');
  if (await app.evaluate('document.querySelector("#novel-narrative-pane").hidden')) await app.click('[data-testid=novel-workbench-toggle]');
  await open('overview', 'dashboard');
  await app.textButton('第5章 · 回执', pane);
  await app.waitFor('!!document.querySelector("[data-testid=chapter-review-panel]") && !document.querySelector("#novel-narrative-pane").hidden', 'dashboard link stays in review at 900px');
  assert.match(await text(), /第5章 · 回执/);
  check('The chapter review link opens the selected chapter at 900px without switching away from the workbench');

  await app.textButton('审读并修订', pane);
  await app.waitFor(`document.querySelector(${JSON.stringify(pane)}).innerText.includes('原稿已保留')`, 'review and revise retains unresolved draft');
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content'), authorDraft);
  offerIncompleteRevision = true;
  failCandidateReview = true;
  revisionGatewayError = true;
  const beforeGatewayRetry = requests.length;
  await app.textButton('审读并修订', pane);
  await app.waitFor(`document.querySelector(${JSON.stringify(pane)}).innerText.includes('LLM API error 400')`, 'failed candidate review preserves the proposed edits');
  assert.ok((await app.evaluate(stored('chapter-revision-pending:chapter-4'))).content.includes(incompleteRevision));
  const beforePendingReview = requests.length;
  assert.match(await text(), /修订稿已保存，等待复审/);
  await app.textButton('继续复审', pane);
  await app.waitFor('document.querySelector("[data-testid=chapter-revision-findings]")?.innerText.includes("改稿仍未交代另一位签收人")', 'candidate findings show the remaining issue');
  assert.equal(requests.length, beforePendingReview + 1, 'retry reviews the saved edits without asking for a new rewrite');
  assert.equal(await app.evaluate(stored('chapter-revision-pending:chapter-4')), null);
  assert.equal(await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content'), authorDraft);
  await app.evaluate('document.querySelector("[data-testid=chapter-revision-findings] .ant-card").scrollIntoView({block:"nearest",behavior:"instant"})');
  await shot('workbench-revision-findings');
  check('A blocked revision shows the remaining issue and source text while the original draft stays saved');
  assert.deepEqual(requests[beforeGatewayRetry], requests[beforeGatewayRetry + 1], 'gateway recovery retries the same revision once');
  offerIncompleteRevision = false;
  offerRevision = true;
  await app.evaluate(`(() => {
    const original = window.fetch;
    window.fetch = function (input, init) {
      if (new URL(String(input), location.origin).pathname === '/chat/completions'
        && JSON.parse(init.body).messages[0].content.includes('小说责任编辑')) {
        window.fetch = original;
        return Promise.reject('Request canceled');
      }
      return original.call(window, input, init);
    };
  })()`);
  const beforeWorkbenchRevision = requests.length;
  const focusText = '本轮核对两名签收人，保留前文的回执记录。';
  await app.click('[data-testid=chapter-review-panel] .ant-collapse-header');
  await fill('[data-testid=chapter-revision-focus]', focusText);
  await app.textButton('审读并修订', pane);
  await app.waitFor(`document.querySelector(${JSON.stringify(pane)}).innerText.includes('修订稿已通过复审并保存')`, 'successful workbench revision');
  const workbenchChapter = await app.evaluate(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4")');
  assert.equal(workbenchChapter.content, authorDraft.replace(signedAlone, '本次两人共同签收回执。'));
  assert.equal(await app.evaluate(stored('chapter-revision:chapter-4') + '.before'), authorDraft);
  assert.equal(await app.evaluate(stored('chapter-reviews') + '.find(r=>r.chapter===4).status'), 'reviewed');
  assert.deepEqual(requests.slice(beforeWorkbenchRevision).map(body=>body.messages[0].content.match(/小说责任编辑|认真通读作品的小说编辑/)?.[0]), ['小说责任编辑', '认真通读作品的小说编辑']);
  assert.equal(requests[beforeWorkbenchRevision].thinking.type, 'disabled', 'transport cancellation triggers compact recovery');
  assert.ok(requests[beforeWorkbenchRevision].messages[1].content.includes(incompleteRevision), 'retry revises the current saved candidate');
  assert.ok(requests[beforeWorkbenchRevision].messages[1].content.includes(focusText), 'the chapter revision uses the focus entered in the review panel');
  const candidateReviewPrompt = requests[beforeWorkbenchRevision + 1].messages[1].content;
  assert.ok(!candidateReviewPrompt.includes('本次只有一人签收，违反值班室两人签收的规则。'), 'candidate review does not reintroduce a stale finding from the original draft');
  assert.ok(candidateReviewPrompt.includes('改稿仍未交代另一位签收人。'), 'candidate review revisits the last revision issue');
  assert.equal(await app.evaluate('!!document.querySelector("[data-testid=chapter-revision-findings]")'), false, 'applied candidate no longer appears as unresolved');
  await shot('workbench-revised');
  check('At 900px, Review and revise uses the current report, retains a blocked draft and adopts a checked revision with a restorable backup');

  const afterApproval = requests.length;
  const proseFocus = '把共同签收写成具体动作。';
  await fill('[data-testid=chapter-revision-focus]', proseFocus);
  await app.textButton('审读并修订', pane);
  await app.waitFor(projectExpr + '.metadata.storyNodes.find(n=>n.id==="chapter-4").content.includes("两人一起在回执上签了字。")', 'targeted revision after approval');
  const focusedRequests = requests.slice(afterApproval);
  assert.equal(focusedRequests.length, 2);
  assert.match(focusedRequests[0].messages[0].content, /小说责任编辑/);
  assert.match(focusedRequests[1].messages[0].content, /认真通读作品的小说编辑/);
  assert.ok(focusedRequests.every(body => body.messages[1].content.includes(proseFocus)));
  check('An already reviewed chapter can be revised and reviewed again using a new focus');

  await app.call('Emulation.clearDeviceMetricsOverride');
  if (await app.evaluate('document.querySelector("#novel-narrative-pane").hidden')) await app.click('[data-testid=novel-workbench-toggle]');

  for (const theme of ['light', 'dark']) {
    await app.evaluate(`(async()=>{(await import('/src/stores/settingsStore.ts')).useSettingsStore.getState().setTheme(${JSON.stringify(theme)})})()`);
    await open('overview', 'dashboard');
    const layout = await app.evaluate(`(()=>{const e=document.querySelector('[data-testid=narrative-dashboard]');const r=e.getBoundingClientRect();const s=getComputedStyle(e);return{width:r.width,height:r.height,color:s.color,theme:document.documentElement.getAttribute('data-theme'),rootOverflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
    assert.equal(layout.theme, theme); assert.ok(layout.width > 250 && layout.height > 200); assert.equal(layout.rootOverflow, false);
    await shot('workbench-' + theme);
    await writeFile(join(output, 'layout-' + theme + '.json'), JSON.stringify(layout, null, 2));
  }
  check('Light and dark themes render at usable panel sizes without document overflow');

  await open('plot', 'foreshadow');
  const beforeRegistration = await app.evaluate(stored('foreshadowing'));
  await app.textButton('登记伏笔', evidence + ' .ant-collapse-item:first-child');
  await app.waitFor('!!document.querySelector(".ant-modal #plantedInChapter")', 'planned clue registration');
  assert.equal(await app.evaluate('document.querySelector(".ant-modal #description").value'), '遗失一页');
  assert.equal(await app.evaluate('document.querySelector(".ant-modal #plantedInChapter").value'), '');
  await fill('.ant-modal #plantedInChapter', '6');
  await app.click('.ant-modal-footer .ant-btn-primary');
  await app.waitFor('document.querySelector(".ant-modal").innerText.includes("请选择伏笔已经写进正文的章节")', 'reject unwritten chapter');
  assert.deepEqual(await app.evaluate(stored('foreshadowing')), beforeRegistration);
  await fill('.ant-modal #plantedInChapter', '3');
  await saveModal();
  const notesHeader = evidence + ' .ant-collapse-item:last-child > .ant-collapse-header';
  if (await app.evaluate(`document.querySelector(${JSON.stringify(notesHeader)})?.getAttribute('aria-expanded')==='false'`)) await app.click(notesHeader);
  await app.click(evidence + ' .ant-collapse-item:last-child .ant-list-item:first-child button');
  await app.waitFor('!!document.querySelector(".ant-modal #plantedInChapter")', 'register reviewed clue');
  assert.equal(await app.evaluate('document.querySelector(".ant-modal #plantedInChapter").value'), '5');
  await saveModal();
  const registered = await app.evaluate(stored('foreshadowing'));
  assert.deepEqual(registered.slice(-2).map(({description, plantedInChapter, status}) => [description, plantedInChapter, status]), [
    ['遗失一页', 3, 'planted'],
    ['线索摘录测试', 5, 'planted'],
  ]);
  await open('plot', 'storyline');
  await open('plot', 'foreshadow');
  assert.equal(await app.evaluate('document.querySelector("[data-testid=foreshadow-ledger-total]").textContent'), '共 ' + registered.length + ' 条');
  await shot('foreshadow-registered');
  check('Registering an outline clue or a reviewed excerpt saves its written chapter and updates the ledger totals');
  await open('quality', 'chapterReview');
  await choose(pane + ' .ant-select input', '第5章 · 回执');
  const beforeLedgerReview = requests.length;
  const previousReviewTime = await app.evaluate(stored('chapter-reviews') + '.find(r=>r.chapter===4).timestamp');
  await app.textButton('运行评审', pane);
  await app.waitFor(`${stored('chapter-reviews')}?.some(r=>r.chapter===4 && r.timestamp>${JSON.stringify(previousReviewTime)})`, 'review after clue registration');
  const ledgerReview = requests.slice(beforeLedgerReview).find(body => body.messages[0].content.includes('认真通读作品的小说编辑'));
  assert.ok(ledgerReview, 'chapter review runs through the provider adapter after registration');
  assert.match(ledgerReview.messages[1].content, /【伏笔台账，不能代替正文证据】\n遗失一页/);
  check('The newly registered clue is loaded from the ledger into the next actual chapter review request');

  await open('quality', 'chapterReview');
  await choose(pane + ' .ant-select input', '第3章 · 作者章节3');
  await app.textButton('运行评审', pane);
  await app.waitFor(`${stored('chapter-reviews')}?.some(r=>r.chapter===2 && r.continuityNotes.some(n=>n.link?.kind==='relationship'))`, 'saved relation with chapter evidence');
  await open('characters', 'relationGraph');
  assert.match(await text(), /虚线表示从正文提取/);
  const graphCounts = await app.evaluate(`[...document.querySelectorAll(${JSON.stringify(pane + ' .ant-badge-count')})].map(e=>Number(e.getAttribute('title')||e.textContent))`);
  assert.deepEqual(graphCounts, [3, 2], 'an observed action supplements the existing author relationship');
  await open('plot', 'knowledgeGraph');
  await choose(pane + ' input[aria-label="筛选正文关联的来源章节"]', '第3章');
  assert.match(await text(), /林岚 → 共同核对登记 → 陈默/);
  assert.match(await text(), /第3章 · 林岚和陈默在二楼核对登记。/);
  await shot('knowledge-graph-chapter-evidence');
  await open('quality', 'chapterReview');
  await choose(pane + ' .ant-select input', '第4章 · 作者章节4');
  const beforeGraphReview = requests.length;
  await app.textButton('运行评审', pane);
  await app.waitFor(`document.querySelector(${JSON.stringify(pane)}).innerText.includes('已审读')`, 'follow-up chapter review');
  const graphReview = requests.slice(beforeGraphReview).find(body => body.messages[0].content.includes('认真通读作品的小说编辑'));
  assert.match(graphReview.messages[1].content, /第3章叙事关联，须结合引文核对】\n林岚 → 共同核对登记 → 陈默\n林岚和陈默在二楼核对登记。/);
  check('A manuscript relationship reaches both graphs and the subsequent chapter review with its source passage');
  await app.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
  await open('plot', 'knowledgeGraph');
  const workbench = '#novel-narrative-pane';
  const expand = '[data-testid=novel-workbench-expand]';
  const width = `document.querySelector('${workbench}').getBoundingClientRect().width`;
  const splitWidth = await app.evaluate(width);
  await app.click(expand);
  await app.waitFor(`${width} > ${splitWidth} * 1.5`, 'expanded graph workbench');
  assert.equal(await app.evaluate('document.querySelector(".novel-workspace__editor").hidden'), true);
  assert.equal(await app.evaluate('document.querySelector("[id$=-tab-knowledgeGraph]").getAttribute("aria-selected")'), 'true');
  await app.waitFor('document.querySelector(".novel-knowledge-graph__details").getBoundingClientRect().left > document.querySelector(".novel-knowledge-graph__canvas").getBoundingClientRect().left', 'evidence beside enlarged graph');
  await shot('knowledge-graph-expanded');
  await open('quality', 'chapterReview');
  assert.ok(await app.evaluate(width) > splitWidth * 1.5);
  await app.click(expand);
  await app.waitFor(`Math.abs(${width} - ${splitWidth}) < 2`, 'restored split workbench');
  assert.equal(await app.evaluate('document.querySelector(".novel-workspace__editor").hidden'), false);
  check('Expanded knowledge graph and chapter review preserve the selected tab and restore the original split');
  assert.deepEqual(external, []); assert.deepEqual(app.errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = String(error); console.error(error);
  await shot('failure').catch(() => {});
  await writeFile(join(output, 'failure.txt'), await app.evaluate('document.body.innerText').catch(String));
  process.exitCode = 1;
} finally {
  report = { ...report, completedAt: new Date().toISOString(), pages, assertions, requests: requests.length, runtimeErrors: app.errors, external, output };
  await writeFile(join(output, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  app.close(); console.log(JSON.stringify(report));
}

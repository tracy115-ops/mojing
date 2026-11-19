import assert from 'node:assert/strict';
import { chromeSession } from './lib/chrome-session.mjs';

const appUrl = process.env.MOJING_SMOKE_URL || 'http://127.0.0.1:1420/', origin = new URL(appUrl).origin;
const browser = await chromeSession({ url: appUrl, port: 9245 });
const { call, evaluate, waitFor, click, textButton, screenshot, delay } = browser;
const requests = [], external = [], steps = [];
const planningRequests = [];
const planningBodies = [];
let failStoryboard = true, failExtraction = true;
let truncateStoryboard = false, emptyStoryboard = false;
const planningSource = 'Ada, an adult woman in a blue coat, walks through a quiet rainy street.';
const planningScript = 'Shared constraints: Ada has black shoulder-length hair. The cafe has no readable signs.\n\n' + planningSource;
let failMusic = true;
let pageLoads = 0;
const wave = Buffer.alloc(44 + 16000 * 2);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 0; i < 16000; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 9000), 44 + i * 2);
browser.onEvent(event => {
  if (event.method === 'Page.loadEventFired') pageLoads++;
  if (event.method !== 'Fetch.requestPaused') return;
  void (async () => {
    const { request, requestId } = event.params, url = new URL(request.url);
    if (url.hostname === 'music-fixture.invalid') {
      const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Methods', value: 'POST,OPTIONS' }, { name: 'Access-Control-Allow-Headers', value: '*' }];
      if (request.method === 'OPTIONS') { await call('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }); return; }
      requests.push({ url: request.url, body: JSON.parse(request.postData), method: request.method });
      await call('Fetch.fulfillRequest', { requestId, responseCode: failMusic ? 503 : 200, responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(failMusic ? { error: 'fixture failure' } : { id: 'actual-fixture-track', title: 'Rain fixture', audio_url: origin + '/__music/track.wav', duration: 2 })).toString('base64') });
    } else if (url.origin === origin && url.pathname === '/chat/completions') {
      const body = JSON.parse(request.postData), system = body.messages[0].content;
      const task = system.includes('source-preserving shot segmentation') ? 'slicing'
        : system.includes('schema-constrained entity extraction') ? 'extraction' : 'storyboard';
      planningRequests.push(task);
      planningBodies.push({ task, user: body.messages[1].content, maxTokens: body.max_tokens, thinking: body.thinking });
      const failed = task === 'storyboard' && failStoryboard || task === 'extraction' && failExtraction;
      const content = task === 'slicing'
        ? [{ index: 0, sourceChapterId: JSON.parse(body.messages[1].content).chapters[0].id, sourceChapterNumber: 1, sourceText: planningSource, visibleCharacters: ['Ada'], offscreenCharacters: [], location: 'Rainy street', mood: 'calm', hasDialogue: false, hasAction: true }]
        : task === 'storyboard'
          ? [{ videoPrompt: 'Ada walks slowly along the rainy street.', imagePrompt: 'Wide shot of Ada on the rainy street, soft morning light.', narration: '', dialogue: [], visibleCharacters: ['Ada'], offscreenCharacters: [], location: 'Rainy street', mood: 'calm', cameraMovement: 'static', transition: 'cut', durationSeconds: 5, startState: 'Ada stands on the left.', endState: 'Ada reaches the cafe.' }]
          : { characters: [{ name: 'Ada', appearance: 'adult woman in a blue coat', entityType: 'human', gender: 'female', ageGroup: 'adult' }], scenes: [{ name: 'Rainy street', description: 'Quiet rainy street' }], props: [] };
      await call('Fetch.fulfillRequest', { requestId, responseCode: failed ? 400 : 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(failed ? { error: 'Injected planning failure' } : { choices: [{ message: { content: task === 'storyboard' && emptyStoryboard ? '' : JSON.stringify(content) }, finish_reason: task === 'storyboard' && truncateStoryboard ? 'length' : 'stop' }] })).toString('base64') });
    } else if (url.origin === origin && url.pathname === '/__music/track.wav') {
      await call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'audio/wav' }], body: wave.toString('base64') });
    } else if (url.origin === origin) await call('Fetch.continueRequest', { requestId });
    else { external.push(request.url); await call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
  })().catch(error => browser.errors.push(String(error)));
});
const mark = message => { steps.push(message); console.log(message); };
const reload = async () => {
  const previousLoads = pageLoads;
  await call('Page.reload');
  for (let i = 0; i < 200 && pageLoads === previousLoads; i++) await delay(100);
  assert.ok(pageLoads > previousLoads, 'new page load completes before restored UI checks');
};
const fill = async (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const type = async (selector, chunks) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  for (const text of chunks) await call('Input.insertText', { text });
};
const choose = async (selector, label) => {
  const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}).closest('.ant-select');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  const option = `(()=>{const el=document.querySelector(${JSON.stringify(selector)}),popup=document.getElementById(el.getAttribute('aria-controls'))?.closest('.ant-select-dropdown');return [...(popup?.querySelectorAll('.ant-select-item-option')??[])].find(el=>el.title===${JSON.stringify(label)});})()`;
  await waitFor(`!!(${option})`, 'option ' + label); await evaluate(`(${option}).click()`);
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded')==='false'`, 'select closed');
};
try {
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await call('Page.navigate', { url: appUrl });
  await waitFor('!!document.querySelector(".ws-titlebar")', 'shell');
  await evaluate(`(async()=>{window.appTest={projects:(await import('/src/stores/projectStore.ts')).useProjectStore,comics:(await import('/src/stores/comicStore.ts')).useComicStore,music:(await import('/src/stores/musicStore.ts')).useMusicStore,providers:(await import('/src/stores/providerStore.ts')).useProviderStore,settings:(await import('/src/stores/settingsStore.ts')).useSettingsStore};})()`);
  await waitFor('[...document.querySelectorAll("button")].some(el=>el.textContent.replace(/\\s/g,"")==="新建小说")', 'novel page');
  await textButton('新建小说'); await waitFor('!!document.querySelector(".ant-modal #title")', 'novel wizard');
  await textButton('下一步', '.ant-modal'); await waitFor('!!document.querySelector(".ant-form-item-explain-error")', 'required title guard');
  await fill('.ant-modal #title', 'UI acceptance novel'); await fill('.ant-modal #description', 'A local editing and persistence fixture.');
  for (let index = 1; index < 5; index++) {
    await textButton('下一步', '.ant-modal');
    await waitFor(`[...document.querySelectorAll('.ant-steps-item')].findIndex(el=>el.classList.contains('ant-steps-item-process'))===${index}`, 'wizard step ' + index);
  }
  await textButton('完成创建', '.ant-modal'); await waitFor('appTest.projects.getState().projects.length===1 && !document.querySelector(".ant-modal")', 'novel created');
  await textButton('添加章节'); await waitFor(`!!document.querySelector('textarea[placeholder="章节大纲..."]')`, 'chapter editor');
  await type('textarea[placeholder="章节大纲..."]', ['雨停', '之后']);
  assert.equal(await evaluate(`document.querySelector('textarea[placeholder="章节大纲..."]').value`), '雨停之后', 'typing must immediately retain successive input');
  // Navigate before the 1.5s save delay; the draft must belong to the first chapter.
  await textButton('添加章节');
  await waitFor('appTest.projects.getState().projects[0].metadata.chapters.length===2', 'second chapter');
  await waitFor('appTest.projects.getState().projects[0].metadata.chapters[0].outline==="雨停之后"', 'draft flushed before changing chapter');
  assert.equal(await evaluate(`document.querySelector('textarea[placeholder="章节大纲..."]').value`), '');
  await fill('input[placeholder="章节标题"]', 'Second fixture chapter');
  await click('[role=tab][id$="-tab-content"]'); await waitFor(`!!document.querySelector('textarea[placeholder="章节正文..."]')`, 'body editor');
  await type('textarea[placeholder="章节正文..."]', ['窗外的雨停了。', '她推开门，看见清晨的阳光。']);
  await click('button[aria-label="漫画工坊"]');
  await waitFor('appTest.projects.getState().projects[0].metadata.chapters[1].content==="窗外的雨停了。她推开门，看见清晨的阳光。"', 'draft flushed when leaving novel');
  mark('Novel: required fields, five wizard steps, successive typing, chapter isolation and save on navigation passed.');

  await waitFor('[...document.querySelectorAll("button")].some(el=>el.textContent.replace(/\\s/g,"")==="新建漫画")', 'comic page');
  await textButton('新建漫画'); await waitFor('!!document.querySelector(".ant-modal #theme")', 'comic form');
  await click('.ant-modal-footer .ant-btn-primary'); await waitFor('!!document.querySelector(".ant-form-item-explain-error")', 'comic required guard');
  await fill('.ant-modal #title', 'UI acceptance comic'); await fill('.ant-modal #theme', 'Two adults meet at a rainy station.');
  await click('.ant-modal-footer .ant-btn-primary');
  await waitFor('Object.keys(appTest.comics.getState().projects).length===1 && !document.querySelector(".ant-modal")', 'comic created');
  const comic = await evaluate('Object.values(appTest.comics.getState().projects)[0]');
  assert.equal(comic.sourceText, 'Two adults meet at a rainy station.'); assert.equal(comic.panelCount, 6);
  assert.ok(Object.values(comic.stages).every(stage => stage.status === 'pending'));
  mark('Comic: required fields, creation, source text, six-panel defaults and initial production stages passed. No generation requested.');

  await evaluate(`(async()=>{
    appTest.video=(await import('/src/stores/videoStore.ts')).useVideoStore;
    const p=appTest.providers.getState();
    for(const [category,provider,model] of [['llm','custom','text-only-fixture'],['image','agnes-image','agnes-image-2.1-flash'],['video','agnes-video','agnes-video-2.5-flash'],['tts','edge-tts','zh-CN-XiaoxiaoNeural']]){
      const id=p.addEndpoint({name:'Review mode '+category,category,provider,baseUrl:location.origin,apiKey:'local-fixture-only',models:[model],enabled:true});
      if(category==='llm')p.setLLMProvider(provider,model,id);else if(category==='image')p.setImageProvider(provider,model,id);else if(category==='video')p.setVideoProvider(provider,model,id);else p.setTTSProvider(provider,model,'zh-CN-XiaoxiaoNeural',id);
    }
  })()`);
  await click('button[aria-label="视频工坊"]'); await waitFor('!!document.querySelector("[data-testid=studio-nav-projects]")', 'video project navigation');
  await click('[data-testid=studio-nav-projects]'); await waitFor('!!document.querySelector("[data-testid=video-new-video]")', 'video projects');
  await click('[data-testid=video-new-video]'); await waitFor('!!document.querySelector(".video-create-episode-modal #title")', 'video form');
  await fill('.video-create-episode-modal #title', 'Manual review acceptance'); await fill('.video-create-episode-modal #scriptText', planningScript);
  await click('.video-create-episode-modal .ant-modal-footer .ant-btn-primary'); await waitFor('!!document.querySelector("[data-testid=video-production-overview]")&&!document.querySelector(".video-create-episode-modal")', 'video created');
  await waitFor('document.querySelector(".video-command-center-preflight-issues")?.textContent.includes("text-only-fixture")', 'actionable text-only model warning');
  await choose('#video-visual-review-mode', '人工逐镜验收');
  await waitFor('!document.querySelector(".video-command-center-preflight-issues")&&appTest.video.getState().projects[appTest.video.getState().activePipelineId].options.enableVisualQualityGate===false', 'manual review clears only visual-model blocker');
  assert.match(await evaluate('document.querySelector(".video-command-center-review-mode").innerText'), /审核并锁定/);
  await choose('#video-visual-review-mode', '自动视觉质检'); await waitFor('!!document.querySelector(".video-command-center-preflight-issues")', 'automatic review restores vision gate');
  await choose('#video-visual-review-mode', '人工逐镜验收');
  assert.equal(requests.length, 0, 'review policy changes do not submit generation requests');
  mark('Video: text-only model gives an actionable warning; explicit manual review and automatic review switch without generating or approving outputs.');

  await evaluate(`(()=>{const p=appTest.providers.getState();const id=p.addEndpoint({name:'Structured DeepSeek fixture',category:'llm',provider:'deepseek',baseUrl:location.origin,apiKey:'local-fixture-only',models:['deepseek-v4-pro'],enabled:true});p.setLLMProvider('deepseek','deepseek-v4-pro',id);})()`);

  const videoProject = 'appTest.video.getState().projects[appTest.video.getState().activePipelineId]';
  await click('[data-testid=video-overview-next-action-button]');
  await waitFor(`${videoProject}.stages.storyboard_prompt.status==='error'`, 'storyboard failure is terminal');
  assert.equal(await evaluate(`${videoProject}.stages.script_slicing.status`), 'completed');
  assert.equal(await evaluate(`Object.values(${videoProject}.stages).some(s=>s.status==='running')`), false);
  assert.deepEqual(planningRequests, ['slicing', 'storyboard']);
  failStoryboard = false;
  await click('button[aria-label="生产链路"]'); await click('[data-testid=video-overview-next-action-button]');
  await waitFor(`${videoProject}.stages.extraction.status==='error'`, 'extraction failure is terminal');
  assert.equal(await evaluate(`${videoProject}.stages.storyboard_prompt.status`), 'completed');
  assert.equal(await evaluate(`${videoProject}.sceneSpec`), undefined);
  assert.equal(await evaluate(`Object.values(${videoProject}.stages).some(s=>s.status==='running')`), false);
  assert.deepEqual(planningRequests, ['slicing', 'storyboard', 'storyboard', 'extraction'], 'storyboard retry retains successful slicing');
  failExtraction = false;
  await click('button[aria-label="生产链路"]'); await click('[data-testid=video-overview-next-action-button]');
  await waitFor(`${videoProject}.stages.extraction.status==='awaiting_review'`, 'retry stops at planning approval');
  assert.deepEqual(planningRequests, ['slicing', 'storyboard', 'storyboard', 'extraction', 'extraction'], 'extraction retry retains both completed planning steps');
  assert.equal(await evaluate(`${videoProject}.sceneSpec.shots[0].transition`), 'cut');
  assert.equal(await evaluate(`${videoProject}.sceneSpec.shots[0].narration`), '', 'explicit silent narration remains silent');
  assert.deepEqual(await evaluate(`${videoProject}.sceneSpec.shots[0].dialogue`), [], 'explicit empty dialogue stays authoritative');
  assert.match(planningBodies.find(r => r.task === 'storyboard').user, /black shoulder-length hair/);
  assert.match(JSON.parse(planningBodies.find(r => r.task === 'extraction').user).sourceText, /no readable signs/);
  const speech = await evaluate(`(async()=>{const {extractDialogue}=await import('/src/services/video/storyboard-prompt.ts');const {runTTS}=await import('/src/services/video/core/step-tts.ts');const p=${videoProject};return {headings:extractDialogue('镜头1（0–5秒）：全景，人物行走。旁白：雨停了。'),dialogue:extractDialogue('Ada: "Hello."'),silent:(await runTTS(p.sceneSpec.shots,p.sceneSpec.characters,{ttsTier:'free',novelProjectId:p.novelProjectId})).failedShotIds};})()`);
  assert.equal(speech.headings, undefined); assert.deepEqual(speech.dialogue, [{ speaker: 'Ada', text: 'Hello.' }]); assert.deepEqual(speech.silent, []);
  assert.equal(await evaluate(`${videoProject}.error`), undefined);
  assert.equal(await evaluate(`${videoProject}.anchorImages.length+${videoProject}.clips.length`), 0, 'planning retry makes no paid asset generation');
  const requestsBeforeReplan = planningRequests.length;
  truncateStoryboard = true;
  await textButton('重新生成分镜');
  await waitFor('!!document.querySelector(".ant-modal-confirm .ant-btn-primary")', 'replan confirmation');
  await click('.ant-modal-confirm .ant-btn-primary');
  await waitFor(`${videoProject}.stages.storyboard_prompt.status==='error'`, 'truncated replan is rejected');
  assert.match(await evaluate(`${videoProject}.error`), /truncated.*8192/);
  assert.equal(await evaluate(`${videoProject}.sceneSpec.shots.length`), 1, 'failed replan retains the previous plan for review');
  assert.deepEqual(planningRequests.slice(requestsBeforeReplan), ['slicing', 'storyboard'], 'truncated complete-looking JSON is not accepted or silently repaired');
  truncateStoryboard = false; emptyStoryboard = true;
  await click('button[aria-label="生产链路"]'); await click('[data-testid=video-overview-next-action-button]');
  await waitFor(`${videoProject}.stages.storyboard_prompt.status==='error'&&${videoProject}.error?.includes('no text output')`, 'empty output is rejected');
  emptyStoryboard = false;
  await click('button[aria-label="生产链路"]'); await click('[data-testid=video-overview-next-action-button]');
  await waitFor(`${videoProject}.stages.extraction.status==='awaiting_review'`, 'replan retry reaches human review');
  assert.deepEqual(planningRequests.slice(requestsBeforeReplan), ['slicing', 'storyboard', 'storyboard', 'storyboard', 'extraction'], 'retry with a previous SceneSpec retains completed slicing');
  assert.ok(planningBodies.every(body => body.maxTokens === 8192), 'all planning steps have a reasoning-capable output budget');
  assert.ok(planningBodies.every(body => body.thinking?.type === 'disabled'), 'DeepSeek V4 structured tasks reserve output tokens for JSON');
  assert.equal(await evaluate(`${videoProject}.error`), undefined);
  await screenshot('application-planning-recovered.png');
  mark('Video planning: storyboard/extraction failures mark the failed step; UI retries preserve completed work and stop at human approval. LLM responses simulated.');

  await click('button[aria-label="音乐工坊"]'); await waitFor('!!document.querySelector("[data-testid=music-workspace]")', 'music');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=music-track]").length'), 0, 'no bundled demo in generated works');
  await fill('[data-testid=music-title]', 'Morning rain'); await fill('[data-testid=music-prompt]', 'Quiet piano after rain');
  await click('[data-testid=music-generate]'); await waitFor('document.querySelector(".ant-message")?.textContent.includes("配置并启用")', 'unconfigured music guard');
  assert.equal(requests.length, 0);
  await click('[data-testid=music-endpoint-open]'); await waitFor('!!document.querySelector(".music-endpoint-modal #baseUrl")', 'music endpoint form');
  await fill('.music-endpoint-modal #baseUrl', 'file:///invalid'); await click('.music-endpoint-modal .ant-modal-footer .ant-btn-primary');
  await waitFor('!!document.querySelector(".music-endpoint-modal .ant-form-item-explain-error")', 'invalid endpoint guard');
  assert.equal(await evaluate('appTest.providers.getState().endpoints.filter(e=>e.provider==="suno-music").length'), 0);
  await fill('.music-endpoint-modal #baseUrl', 'https://music-fixture.invalid/v1'); await fill('.music-endpoint-modal #apiKey', 'fixture-only');
  await click('.music-endpoint-modal #enabled'); await click('.music-endpoint-modal .ant-modal-footer .ant-btn-primary');
  await waitFor('!document.querySelector(".music-endpoint-modal")', 'disabled endpoint saved');
  await click('[data-testid=music-generate]'); await delay(200); assert.equal(requests.length, 0, 'disabled endpoints must not receive requests');
  await click('[data-testid=music-endpoint-open]'); await waitFor('!!document.querySelector(".music-endpoint-modal #enabled")', 'saved endpoint');
  assert.equal(await evaluate('document.querySelector(".music-endpoint-modal #baseUrl").value'), 'https://music-fixture.invalid/v1');
  await click('.music-endpoint-modal #enabled'); await click('.music-endpoint-modal .ant-modal-footer .ant-btn-primary'); await waitFor('!document.querySelector(".music-endpoint-modal")', 'endpoint enabled');
  await click('input[type=radio][value=custom]'); await waitFor('!!document.querySelector("[data-testid=music-lyrics]")', 'custom lyrics mode');
  await textButton('填入示例歌词模板'); assert.match(await evaluate('document.querySelector("[data-testid=music-lyrics]").value'), /\[Verse 1\]/);
  await click('input[type=radio][value=prompt]'); await waitFor('!!document.querySelector("[data-testid=music-prompt]")', 'description mode restored');
  await click('[data-testid=music-generate]'); await waitFor('document.querySelector(".ant-message")?.textContent.includes("未添加作品")', 'HTTP failure shown');
  assert.equal(await evaluate('appTest.music.getState().tracks.length'), 0, 'API failure must not fabricate a successful track');
  failMusic = false; await click('[data-testid=music-generate]'); await waitFor('document.querySelectorAll("[data-testid=music-track]").length===1', 'successful retry');
  assert.equal(requests.length, 2); assert.equal(requests[1].body.prompt, 'Quiet piano after rain');
  const music = await evaluate('appTest.music.getState().tracks[0]'); assert.equal(music.audioUrl, origin + '/__music/track.wav'); assert.equal(music.durationSeconds, 2);
  await waitFor('document.querySelector("audio")?.readyState>=2', 'audio decoded');
  assert.ok(Math.abs(await evaluate('document.querySelector("audio").duration') - 2) < .01);
  await evaluate('document.querySelector("audio").scrollIntoView({block:"center"})');
  const play = await evaluate('(()=>{const r=document.querySelector("audio").getBoundingClientRect();return{x:r.x+20,y:r.y+r.height/2};})()');
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...play, button: 'left', clickCount: 1 }); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...play, button: 'left', clickCount: 1 });
  await waitFor('document.querySelector("audio").currentTime>.1 && appTest.music.getState().isPlaying', 'real audio playback');
  await evaluate('document.querySelector("audio").pause()'); await waitFor('!appTest.music.getState().isPlaying', 'pause reflected');
  await waitFor('!document.querySelector(".ant-message-notice")', 'transient feedback cleared');
  for (const theme of ['dark', 'light']) {
    await evaluate(`appTest.settings.getState().setTheme(${JSON.stringify(theme)})`);
    for (const width of [1600, 900, 650]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(150);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+2'), `${theme} ${width}px music overflow`);
      await screenshot(`application-music-${theme}-${width}.png`);
    }
  }
  await call('Emulation.clearDeviceMetricsOverride');
  mark('Music: configuration, disabled endpoint guard, HTTP failure without fake tracks, successful retry, decoded WAV playback/pause and responsive themes passed. HTTP service simulated.');

  await click('button[aria-label="设置"]'); await waitFor(`!!document.querySelector('.ant-modal [role=tab][id$="-tab-appearance"]')`, 'settings');
  await click('.ant-modal [role=tab][id$="-tab-appearance"]');
  await choose('.ant-modal .ant-tabs-tabpane-active input[role=combobox]', '深色');
  await click('.ant-modal [role=tab][id$="-tab-general"]');
  await choose('.ant-modal .ant-tabs-tabpane-active input[role=combobox]', 'English');
  await waitFor('!!document.querySelector(\'button[aria-label="Music Studio"]\')', 'English navigation');
  await click('.ant-modal .ant-modal-close'); await reload();
  await waitFor('!window.appTest && !!document.querySelector(\'button[aria-label="Music Studio"]\')', 'language persisted');
  await click('button[aria-label="Music Studio"]'); await waitFor('document.querySelectorAll("[data-testid=music-track]").length===1', 'music persisted');
  assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'dark');
  await screenshot('application-settings-persisted.png');
  await click('[data-testid=music-track] button.ant-btn-dangerous'); await waitFor('!document.querySelector("[data-testid=music-track]")', 'track deleted');
  await reload(); await waitFor('!!document.querySelector(\'button[aria-label="Music Studio"]\')', 'fresh shell');
  await click('button[aria-label="Music Studio"]'); await waitFor('!!document.querySelector("[data-testid=music-workspace]")', 'empty music restored');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=music-track]").length'), 0);
  const restored = await evaluate(`(async()=>{const p=(await import('/src/stores/projectStore.ts')).useProjectStore.getState().projects.find(p=>p.type==='novel'),c=Object.values((await import('/src/stores/comicStore.ts')).useComicStore.getState().projects)[0],v=(await import('/src/stores/videoStore.ts')).useVideoStore.getState();return{novel:p,comic:c,videoOptions:v.projects[v.activePipelineId].options};})()`);
  assert.equal(restored.videoOptions.enableVisualQualityGate, false, 'explicit manual review persists');
  assert.equal(restored.novel.metadata.chapters[0].outline, '雨停之后'); assert.equal(restored.novel.metadata.chapters[1].title, 'Second fixture chapter'); assert.equal(restored.novel.metadata.chapters[1].content, '窗外的雨停了。她推开门，看见清晨的阳光。'); assert.equal(restored.comic.sourceText, comic.sourceText);
  assert.deepEqual(browser.errors, []);
  assert.ok(external.every(value => ['https://api-beijing.klingai.com/', 'https://api.deepseek.com/', 'https://www.baidu.com/'].includes(value)), 'only the settings connectivity probes were blocked');
  mark('Settings/application: language and theme selection, reload persistence of novel/comic/music, track deletion and deletion persistence passed. Runtime errors: [].');
} catch (error) {
  console.error('Application diagnostic:', await evaluate('({text:document.body.innerText.slice(-4500),inputs:[...document.querySelectorAll("input,textarea")].map(el=>({id:el.id,placeholder:el.placeholder,value:el.type==="password"?"[redacted]":el.value})),steps:document.querySelectorAll(".ant-steps-item-process").length})').catch(() => null));
  console.error('Completed:', steps, 'Runtime errors:', browser.errors); await screenshot('application-failure.png').catch(() => null); throw error;
} finally { browser.close(); }

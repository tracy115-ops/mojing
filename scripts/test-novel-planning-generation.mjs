import assert from 'node:assert/strict';
import {collectPlanningText,generatePlanningResponse} from '../src/services/novel/planning-generation.ts';
import {decodeNovelReference,formatNovelReference,prepareNovelReference,splitNovelReference} from '../src/services/novel/novel-reference.ts';

const attempts=[], previews=[];
let retries=0;
const text=await collectPlanningText(async function*(budget){
  attempts.push(budget);
  if(budget===8192){yield {delta:'{"mainPlot":"discarded',done:false};throw new Error('LLM output was truncated at max_tokens=8192; increase the output budget.');}
  yield {delta:'{"mainPlot":"complete"}',done:false};yield {delta:'',done:true};
},{onText:t=>previews.push(t),onRetry:()=>retries++});
assert.equal(text,'{"mainPlot":"complete"}');
assert.deepEqual(attempts,[8192,16384]);assert.equal(retries,1);
assert.deepEqual(previews.slice(0,3),['','{"mainPlot":"discarded',''],'clear incomplete JSON before retry');
for(const message of ['LLM API error 402','LLM API error 429','network error','invalid JSON']){
  let count=0;
  await assert.rejects(collectPlanningText(async function*(){count++;throw new Error(message);}),e=>e.message===message);
  assert.equal(count,1,'do not retry non-truncation errors');
}
let count=0;
await assert.rejects(collectPlanningText(async function*(){count++;throw new Error('LLM output was truncated at max_tokens=16384');}),/truncated/);
assert.equal(count,2,'stop after a second truncation');
const controller=new AbortController();count=0;
await assert.rejects(collectPlanningText(async function*(){count++;yield {delta:'partial',done:false};controller.abort();throw new Error('LLM output was truncated at max_tokens=8192');},{signal:controller.signal}),e=>e.name==='AbortError');
assert.equal(count,1,'cancellation does not start another billed request');
const budgets=[];
assert.equal(await generatePlanningResponse(async budget=>{budgets.push(budget);if(budget===8192)throw new Error('LLM output was truncated at max_tokens=8192');return 'complete';}),'complete');
assert.deepEqual(budgets,[8192,16384]);
count=0;
await assert.rejects(generatePlanningResponse(async()=>{count++;throw new Error('LLM API error 429');}),/429/);assert.equal(count,1);
console.log('Novel planning: bounded truncation retry, cleared partial JSON, no retry on account/network errors, cancellation honored.');

const referenceText = ['开篇。', '🐦'.repeat(5000), '中段。'.repeat(25000), '收尾标记。'].join('\n\n');
const sections = splitNovelReference(referenceText);
assert.equal(sections.join(''), referenceText);
assert.ok(sections.length > 6 && sections.every(part => part.length <= 10000 && !/[\uD800-\uDBFF]$/.test(part)));
const utf8 = new TextEncoder().encode('车票和渡口');
assert.equal(decodeNovelReference(utf8.buffer), '车票和渡口');
assert.equal(decodeNovelReference(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]).buffer), '你好');

const partialNotes = [];
let extractCount = 0;
await assert.rejects(prepareNovelReference(referenceText, async () => {
  if (++extractCount === 2) throw new Error('model temporarily unavailable');
  return { content: '开篇笔记' };
}, { mode: 'rewrite', notes: partialNotes }), /temporarily unavailable/);
assert.deepEqual(partialNotes, ['开篇笔记']);
const requests = [];
const reference = await prepareNovelReference(referenceText, async request => {
  requests.push(request);
  return { content: request.systemPrompt.includes('中长篇') ? '经过合并的范文参考' : '已检查段落的内容和结尾' };
}, { mode: 'rewrite', notes: partialNotes });
assert.deepEqual(requests.slice(0, sections.length - 1).map(request => request.userPrompt), sections.slice(1), 'retry resumes with the next source span and includes the ending');
assert.ok(requests.every(request => request.userPrompt.length <= 14400));
assert.equal(reference.sourceParts, sections.length);
assert.equal(reference.guide, '经过合并的范文参考');
assert.match(formatNovelReference(reference), /沿用适用的原作主线/);
assert.match(formatNovelReference({ ...reference, mode: 'style' }), /独立设计人物、事件和语言/);
console.log('Novel reference: complete source coverage, bounded merging, resume after provider failure and distinct writing modes.');

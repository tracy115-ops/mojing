import assert from 'node:assert/strict';
import {collectPlanningText,generatePlanningResponse} from '../src/services/novel/planning-generation.ts';

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

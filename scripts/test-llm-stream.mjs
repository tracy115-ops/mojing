import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/services/providers/llm-adapters.ts';

// Exercise the production adapter with byte-fragmented SSE at the HTTP boundary.
const originalFetch = globalThis.fetch;
const requests = [];
let source, cancelled = false;
globalThis.fetch = async (url, init) => {
  requests.push(JSON.parse(init.body));
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const next = Math.min(offset + 7, bytes.length);
      controller.enqueue(bytes.slice(offset, next)); offset = next;
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
};
const endpoint = { provider: 'deepseek', baseUrl: 'https://llm-fixture.invalid/v1', apiKey: 'fixture' };
const provider = new OpenAICompatibleProvider(endpoint, 'deepseek');
const request = { taskType: 'generation', model: 'deepseek-v4-pro', systemPrompt: 'Return settings.', userPrompt: 'A rainy bus station.', maxTokens: 8192, responseFormat: 'json' };
const event = (content, reason = null) => 'data:' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason }] }) + '\r\n\r\n';
const collect = async (overrides = {}) => {
  let text = '', completed = 0;
  for await (const chunk of provider.stream({ ...request, ...overrides })) {
    text += chunk.delta;
    if (chunk.done) completed++;
  }
  return { text, completed };
};
try {
  source = ': keepalive\r\n' + event('{"地点":"雨夜') + event('车站"}', 'stop') + 'data: [DONE]';
  assert.deepEqual(await collect(), { text: '{"地点":"雨夜车站"}', completed: 1 });
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.match(requests[0].messages[0].content, /json/i);

  source = event('unfinished') + event('', 'length') + 'data: [DONE]\n';
  await assert.rejects(collect(), /truncated/);
  source = event('unfinished');
  await assert.rejects(collect(), /before completion/);
  source = event('', 'stop') + 'data: [DONE]\n';
  await assert.rejects(collect(), /no text/);
  source = event('filtered', 'content_filter');
  await assert.rejects(collect(), /content filter/);
  source = 'data: {"error":{"message":"provider unavailable"}}\n';
  await assert.rejects(collect(), /provider unavailable/);
  source = 'data: {invalid}\n';
  await assert.rejects(collect(), SyntaxError);
  source = event('Complete chapter.', 'stop');
  assert.deepEqual(await collect({ responseFormat: 'text', thinking: false }), { text: 'Complete chapter.', completed: 1 });
  assert.equal(requests.at(-1).response_format, undefined);
  assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });

  source = event('First paragraph.') + event('Second paragraph.') + 'data: [DONE]\n';
  cancelled = false;
  for await (const chunk of provider.stream(request)) { assert.equal(chunk.delta, 'First paragraph.'); break; }
  assert.equal(cancelled, true, 'stopping consumption releases the network reader');
  const timeouts = [];
  provider.timeoutSignal = ms => { timeouts.push(ms); return undefined; };
  source = JSON.stringify({choices:[{message:{content:'{"summary":"Review finished."}'},finish_reason:'stop'}]});
  await provider.generate({...request,thinking:true,maxTokens:16384});
  assert.deepEqual(requests.at(-1).thinking,{type:'enabled'});
  assert.equal(timeouts.at(-1),360000,'reasoning editorial requests can outlast the former two-minute deadline');
  await provider.generate({...request,thinking:false});
  assert.equal(timeouts.at(-1),120000);
  console.log('LLM streaming passed: fragmented UTF-8 SSE, JSON mode, bounded DeepSeek writing, truncation, empty output, interrupted EOF, provider errors and reader cancellation.');
} finally { globalThis.fetch = originalFetch; }

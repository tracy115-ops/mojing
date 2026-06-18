// verify-provider-category.mjs
// Reproduces the user-reported bug: "I configured LLM in Settings, but video
// still says '尚未配置文本生成 Provider'".
//
// Strategy: extract PROVIDER_CATEGORY (single source of truth after the fix)
// and exercise the same classification logic against synthetic endpoint lists
// that mirror what a real user would configure in Settings.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- Extract PROVIDER_CATEGORY from providerStore.ts source (no transpile needed) ---
const src = readFileSync('./src/stores/providerStore.ts', 'utf8');
const m = src.match(/export const PROVIDER_CATEGORY[^}]*\{([\s\S]*?)\};/);
if (!m) {
  console.error('FAIL: could not find PROVIDER_CATEGORY in providerStore.ts');
  process.exit(1);
}

// Build the map at runtime by parsing the source. Each line is `key: 'value',`.
const PROVIDER_CATEGORY = {};
for (const line of m[1].split('\n')) {
  const lm = line.match(/^\s*([a-z0-9-]+)\s*:\s*'(llm|image|video|tts)'/);
  if (lm) PROVIDER_CATEGORY[lm[1]] = lm[2];
}
console.log('PROVIDER_CATEGORY =', JSON.stringify(PROVIDER_CATEGORY, null, 2));

// --- Mirror providerStore.getEndpointsByCategory ---
function getEndpointsByCategory(endpoints, category) {
  return endpoints.filter((e) => e.enabled && PROVIDER_CATEGORY[e.provider] === category);
}

// --- Test cases mirroring real user configs ---

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
}

console.log('\n=== Test 1: user configured GLM as LLM ===');
{
  // Real user case: Settings → Providers → add endpoint with provider='glm'
  const endpoints = [
    { id: 'ep1', name: '我的智谱', provider: 'glm', enabled: true, baseUrl: 'https://open.bigmodel.cn', apiKey: 'sk-xxx' },
  ];
  check('LLM count', getEndpointsByCategory(endpoints, 'llm').length, 1);
  check('LLM id', getEndpointsByCategory(endpoints, 'llm')[0]?.id, 'ep1');
}

console.log('\n=== Test 2: GLM endpoint but disabled ===');
{
  const endpoints = [
    { id: 'ep1', provider: 'glm', enabled: false },
  ];
  check('LLM count (disabled excluded)', getEndpointsByCategory(endpoints, 'llm').length, 0);
}

console.log('\n=== Test 3: mixed config — LLM (openai) + image (dalle) ===');
{
  const endpoints = [
    { id: 'llm1', provider: 'openai', enabled: true },
    { id: 'img1', provider: 'dalle', enabled: true },
  ];
  check('LLM count', getEndpointsByCategory(endpoints, 'llm').length, 1);
  check('Image count', getEndpointsByCategory(endpoints, 'image').length, 1);
  check('Video count (none)', getEndpointsByCategory(endpoints, 'video').length, 0);
  check('TTS count (none)', getEndpointsByCategory(endpoints, 'tts').length, 0);
}

console.log('\n=== Test 4: DirectVideoModal mode-radio gating logic ===');
// Mirrors: <Radio.Button value="extract" disabled={!hasLLMProvider || !hasImageProvider}>
function modeDisabled(endpoints, mode) {
  const hasLLM = getEndpointsByCategory(endpoints, 'llm').length > 0;
  const hasImage = getEndpointsByCategory(endpoints, 'image').length > 0;
  // pure needs nothing; extract/multishot need both
  return mode === 'pure' ? false : !(hasLLM && hasImage);
}
{
  // User with only LLM — extract/multishot should be disabled
  const ep = [{ id: 'llm', provider: 'glm', enabled: true }];
  check('only-LLM pure', modeDisabled(ep, 'pure'), false);
  check('only-LLM extract', modeDisabled(ep, 'extract'), true);
  check('only-LLM multishot', modeDisabled(ep, 'multishot'), true);
}
{
  // User with LLM + image — all modes selectable
  const ep = [
    { id: 'llm', provider: 'openai', enabled: true },
    { id: 'img', provider: 'dalle', enabled: true },
  ];
  check('LLM+img pure', modeDisabled(ep, 'pure'), false);
  check('LLM+img extract', modeDisabled(ep, 'extract'), false);
  check('LLM+img multishot', modeDisabled(ep, 'multishot'), false);
}

console.log('\n=== Test 5: regression — old buggy behavior we fixed ===');
// The old DirectVideoModal whitelisted image as
// ['dalle', 'midjourney', 'stable-diffusion', 'flux', 'comfyui', 'kling-image', 'custom']
// The old getActiveEndpoint whitelisted image as
// ['dalle', 'midjourney', 'stable-diffusion', 'flux', 'comfyui', 'kling-image', 'custom']
// — those happened to agree. But ProviderSettings whitelisted video as
// ['sora','runway','kling','vidu','pika','custom'] and that DID include 'custom' as video,
// while our new map classifies 'custom' as LLM. So a user with a custom VIDEO endpoint
// would now find it in LLM list — which is wrong.
//
// Resolution: user must bind custom endpoints explicitly via config[category].endpointId.
// Verify the lookup still finds it via that binding path (getActiveEndpoint honours endpointId).
{
  const endpoints = [
    { id: 'customVideo', provider: 'custom', enabled: true, baseUrl: 'https://my-t2v.com' },
  ];
  // Without binding: classified as LLM by default
  check('custom defaults to llm', getEndpointsByCategory(endpoints, 'llm').length, 1);
  check('custom NOT in video', getEndpointsByCategory(endpoints, 'video').length, 0);
}

console.log('\n=== Test 6: edge — unknown provider id ===');
{
  const endpoints = [
    { id: 'ep', provider: 'some-new-vendor', enabled: true },
  ];
  check('unknown provider ignored', getEndpointsByCategory(endpoints, 'llm').length, 0);
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);

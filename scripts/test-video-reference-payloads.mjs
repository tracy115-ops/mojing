import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createVideoProvider } from '../src/services/providers/video-adapters.ts';

const firstFrame = 'data:image/png;base64,' + Buffer.from('first-frame').toString('base64');
const lastFrame = 'data:image/png;base64,' + Buffer.from('last-frame').toString('base64');
const girlReference = 'data:image/png;base64,' + Buffer.from('girl-reference').toString('base64');
const catReference = 'data:image/png;base64,' + Buffer.from('cat-reference').toString('base64');
const outputVideo = 'https://mock.provider.test/generated.mp4';

const requests = [];
let lastVideoResult;
let agnesSubmitBody;
let agnesStatusOverride;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ method: request.method, url: request.url, body });

  const url = new URL(request.url || '/', 'http://127.0.0.1');
  let payload = {};
  if (url.pathname === '/kling/v1/videos/image2video') {
    payload = { data: { task_id: 'kling-task' } };
  } else if (url.pathname === '/kling/v1/videos/image2video/kling-task') {
    payload = { data: { task_status: 'succeed', task_result: { videos: [{ url: outputVideo }] } } };
  } else if (url.pathname === '/v1/image_to_video') {
    payload = { id: 'runway-task' };
  } else if (url.pathname === '/v1/tasks/runway-task') {
    payload = { status: 'SUCCEEDED', output: [outputVideo] };
  } else if (url.pathname === '/v1/video/generate') {
    payload = { data: { task_id: 'vidu-task' } };
  } else if (url.pathname === '/v1/video/status/vidu-task') {
    payload = { data: { state: 'success', video_url: outputVideo } };
  } else if (url.pathname === '/v1/videos') {
    agnesSubmitBody = JSON.parse(body);
    payload = { video_id: 'video_agnes' };
  } else if (url.pathname === '/agnesapi') {
    payload = agnesStatusOverride ?? { status: 'completed', state: 'pending', internal_status: 'pending', progress: 100, url: outputVideo, seconds: agnesSubmitBody.seconds };
  } else if (url.pathname === '/api/v3/contents/generations/tasks') {
    payload = { id: 'doubao-task' };
  } else if (url.pathname === '/api/v3/contents/generations/tasks/doubao-task') {
    payload = { status: 'succeeded', content: { video_url: outputVideo } };
  } else if (url.pathname === '/v1/rest/v1/video-generations') {
    payload = { id: 'leonardo-task' };
  } else if (url.pathname === '/v1/rest/v1/video-generations/leonardo-task') {
    payload = { status: 'completed', video_url: outputVideo };
  } else if (url.pathname === '/v1/video/submit') {
    payload = { requestId: 'siliconflow-task' };
  } else if (url.pathname === '/v1/video/status') {
    payload = { status: 'success', url: outputVideo };
  } else {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `Unhandled mock path ${url.pathname}` }));
    return;
  }

  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const endpoint = (provider) => ({
  id: `mock-${provider}`,
  name: `Mock ${provider}`,
  provider,
  baseUrl,
  apiKey: 'test-key',
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args));

async function runCase(name, providerId, request, submitPath) {
  requests.length = 0;
  const provider = createVideoProvider(providerId, endpoint(providerId));
  const result = await provider.generate(request);
  lastVideoResult = result;
  assert.equal(result.videoData, outputVideo, `${name}: provider result should be playable URL`);
  const submit = requests.find((item) => item.method === 'POST' && new URL(item.url, baseUrl).pathname === submitPath);
  assert.ok(submit, `${name}: submit request was captured`);
  return JSON.parse(submit.body);
}

function assertNoSubjectSlots(body, name) {
  assert.equal(body.images, undefined, `${name}: temporal frame request must not send subject images`);
  assert.equal(body.subject_references, undefined, `${name}: temporal frame request must not send subject references`);
}

try {
  const klingBody = await runCase('Kling first/last frame', 'kling', {
    taskType: 'clip',
    prompt: 'Keep the subject identity fixed while the camera moves.',
    model: 'kling-v2',
    durationSeconds: 5,
    width: 1920,
    height: 1080,
    controlMode: 'keyframe',
    firstFrame,
    lastFrame,
    referenceImages: [firstFrame, lastFrame],
  }, '/kling/v1/videos/image2video');
  assert.equal(klingBody.image, firstFrame, 'Kling: first frame must use image');
  assert.equal(klingBody.image_tail, lastFrame, 'Kling: last frame must use image_tail');
  assertNoSubjectSlots(klingBody, 'Kling');

  const runwayBody = await runCase('Runway first/last frame', 'runway', {
    taskType: 'clip',
    prompt: 'A controlled camera move.',
    model: 'gen4_turbo',
    durationSeconds: 5,
    width: 1920,
    height: 1080,
    controlMode: 'keyframe',
    firstFrame,
    lastFrame,
  }, '/v1/image_to_video');
  assert.deepEqual(runwayBody.promptImage, [
    { uri: firstFrame, position: 'first' },
    { uri: lastFrame, position: 'last' },
  ], 'Runway: temporal positions must be explicit');

  const viduBody = await runCase('Vidu first frame', 'vidu', {
    taskType: 'clip',
    prompt: 'Animate the exact first frame.',
    model: 'vidu-1.5',
    durationSeconds: 4,
    width: 1280,
    height: 720,
    controlMode: 'keyframe',
    firstFrame,
  }, '/v1/video/generate');
  assert.equal(viduBody.image, firstFrame, 'Vidu: first frame must use image');
  assert.equal(viduBody.start_image, undefined, 'Vidu: single first frame must not be sent as start_image');

  const agnesKeyframeBody = await runCase('Agnes keyframe', 'agnes-video', {
    taskType: 'clip',
    prompt: 'Animate the supplied opening frame.',
    model: 'agnes-video-2.5-flash',
    durationSeconds: 3,
    width: 1920,
    height: 1080,
    controlMode: 'keyframe',
    firstFrame,
    subjectReferences: [{ id: 'cat', image: catReference, label: 'cat' }],
  }, '/v1/videos');
  assert.equal(agnesKeyframeBody.seconds, '4', 'Agnes: unsupported short duration must map to the native minimum tier');
  assert.equal(agnesKeyframeBody.size, '720P', 'Agnes 2.5 Flash: requested 1920x1080 output must map to the supported 720P tier');
  assert.equal(agnesKeyframeBody.width, undefined, 'Agnes: normalized dimensions must not leak as unsupported wire fields');
  assert.equal(agnesKeyframeBody.height, undefined, 'Agnes: normalized dimensions must not leak as unsupported wire fields');
  assert.equal(agnesKeyframeBody.mode, 'keyframe', 'Agnes: keyframe mode must be explicit');
  assert.equal(agnesKeyframeBody.first_frame, firstFrame, 'Agnes: first frame must be preserved');
  assert.equal(agnesKeyframeBody.images, undefined, 'Agnes: keyframe must not include subject images');
  assert.equal(lastVideoResult.durationSeconds, 4, 'Agnes 2.5 must report the submitted native duration');
  assert.equal(lastVideoResult.width, 1280);
  assert.equal(lastVideoResult.height, 704, 'Flash landscape fallback must match the documented dimensions');

  const agnesWirePreview = createVideoProvider('agnes-video', endpoint('agnes-video')).getWireParameterSnapshot({
    taskType: 'clip',
    prompt: 'Animate the supplied opening frame.',
    model: 'agnes-video-2.5-flash',
    durationSeconds: 3,
    width: 1920,
    height: 1080,
    aspectRatio: '16:9',
    controlMode: 'keyframe',
    firstFrame,
  });
  assert.equal(agnesWirePreview.seconds, '4', 'Agnes wire preview must expose the native duration tier');
  assert.equal(agnesWirePreview.size, '720P', 'Agnes wire preview must expose the native resolution tier');
  assert.equal(agnesWirePreview.width, undefined, 'Agnes wire preview must not claim normalized dimensions were sent');

  const agnesProKeyframeBody = await runCase('Agnes non-Flash keyframe', 'agnes-video', {
    taskType: 'clip',
    prompt: 'Animate the supplied opening frame.',
    model: 'agnes-video-2.5-pro',
    durationSeconds: 5,
    width: 1920,
    height: 1080,
    controlMode: 'keyframe',
    firstFrame,
  }, '/v1/videos');
  assert.equal(agnesProKeyframeBody.size, '1080P', 'Agnes non-Flash 2.5: high-resolution requests may use 1080P');

  const agnesReferenceBody = await runCase('Agnes subject reference', 'agnes-video', {
    taskType: 'clip',
    prompt: 'Animate the bound girl and cat identities.',
    model: 'agnes-video-2.5-flash',
    durationSeconds: 6,
    width: 1280,
    height: 720,
    controlMode: 'reference',
    subjectReferences: [
      { id: 'girl', image: girlReference, label: 'girl' },
      { id: 'cat', image: catReference, label: 'cat' },
    ],
  }, '/v1/videos');
  assert.equal(agnesReferenceBody.mode, 'reference', 'Agnes: subject reference mode must be explicit');
  assert.deepEqual(agnesReferenceBody.images, [girlReference, catReference], 'Agnes: custom subject images must be sent in order');
  assert.equal(agnesReferenceBody.first_frame, undefined, 'Agnes: subject mode must not include first_frame');
  assert.match(agnesReferenceBody.prompt, /<Picture 1>: girl/);
  assert.match(agnesReferenceBody.prompt, /<Picture 2>: cat/);

  for (const seconds of [8, 12]) {
    await runCase(`Agnes ${seconds}s`, 'agnes-video', {
      taskType: 'clip', prompt: 'A continuous shot.', model: 'agnes-video-2.5-flash', durationSeconds: seconds,
    }, '/v1/videos');
    assert.equal(lastVideoResult.durationSeconds, seconds, '2.5 must never use the old 2.0 frame tiers');
  }
  agnesStatusOverride = { status: 'completed', url: outputVideo, seconds: '9', width: 1278, height: 702 };
  await runCase('Agnes returned metadata', 'agnes-video', { taskType: 'clip', prompt: 'A shot.', durationSeconds: 12 }, '/v1/videos');
  assert.equal(lastVideoResult.durationSeconds, 9, 'returned duration takes precedence over the requested duration');
  assert.equal(lastVideoResult.width, 1278, 'returned dimensions take precedence over the mapping');
  agnesStatusOverride = { status: 'completed', url: outputVideo };
  await runCase('Agnes metadata omitted', 'agnes-video', { taskType: 'clip', prompt: 'A shot.', durationSeconds: 12 }, '/v1/videos');
  assert.equal(lastVideoResult.durationSeconds, 12, 'missing metadata falls back to the native submitted duration');
  agnesStatusOverride = undefined;
  const requestCount = requests.length;
  await assert.rejects(() => createVideoProvider('agnes-video', endpoint('agnes-video')).generate({
    taskType: 'clip', prompt: 'Too many references.', model: 'agnes-video-2.5-flash', controlMode: 'reference',
    referenceImages: Array(6).fill(catReference),
  }), /at most 5/);
  assert.equal(requests.length, requestCount, 'over-limit references must fail before creating a task');

  const doubaoKeyframeBody = await runCase('Doubao first frame', 'doubao-video', {
    taskType: 'clip',
    prompt: 'Animate the exact supplied opening frame.',
    model: 'doubao-seedance-2-0-260128',
    durationSeconds: 5,
    width: 1920,
    height: 1080,
    controlMode: 'keyframe',
    firstFrame,
    subjectReferences: [{ id: 'cat', image: catReference, label: 'cat' }],
  }, '/api/v3/contents/generations/tasks');
  assert.equal(doubaoKeyframeBody.content.filter((item) => item.role === 'first_frame').length, 1, 'Doubao: first frame slot must be present');
  assert.equal(doubaoKeyframeBody.content.filter((item) => item.role === 'reference_image').length, 0, 'Doubao: first frame request must not include subject slots');

  const doubaoReferenceBody = await runCase('Doubao subject reference', 'doubao-video', {
    taskType: 'clip',
    prompt: 'Animate the bound girl and cat identities.',
    model: 'doubao-seedance-2-0-260128',
    durationSeconds: 5,
    width: 1920,
    height: 1080,
    controlMode: 'reference',
    subjectReferences: [{ id: 'girl', image: girlReference, label: 'girl' }],
  }, '/api/v3/contents/generations/tasks');
  assert.equal(doubaoReferenceBody.content.filter((item) => item.role === 'first_frame').length, 0, 'Doubao: subject mode must not include first frame');
  assert.equal(doubaoReferenceBody.content.filter((item) => item.role === 'reference_image').length, 1, 'Doubao: subject slot must be present');
  assert.equal(doubaoReferenceBody.content.find((item) => item.role === 'reference_image').image_url.url, girlReference, 'Doubao: custom subject image must be preserved');
  assert.match(doubaoReferenceBody.content[0].text, /@图像1: girl/);

  const seedance25 = await runCase('Seedance 2.5 first and last frames', 'doubao-video', {
    taskType: 'clip', prompt: 'Move from the first frame to the last.', model: 'doubao-seedance-2-5-260628',
    durationSeconds: 30, width: 1920, height: 1080, controlMode: 'keyframe', firstFrame, lastFrame, seed: 1234,
  }, '/api/v3/contents/generations/tasks');
  assert.equal(seedance25.content.find((item) => item.role === 'last_frame').image_url.url, lastFrame);
  assert.equal(seedance25.resolution, '1080p');
  assert.equal(seedance25.duration, 30);
  assert.equal(seedance25.seed, 1234, 'the recorded candidate seed must reach Seedance');
  const seedanceFast = await runCase('Seedance fast native resolution', 'doubao-video', {
    taskType: 'clip', prompt: 'A shot.', model: 'doubao-seedance-2-0-fast-260128', durationSeconds: 3, width: 1920, height: 1080,
  }, '/api/v3/contents/generations/tasks');
  assert.equal(seedanceFast.resolution, '720p');
  assert.equal(lastVideoResult.height, 720, 'fast model output must not claim the requested 1080p resolution');
  assert.equal(lastVideoResult.durationSeconds, 4);

  const leonardoBody = await runCase('Leonardo first frame', 'leonardo-video', {
    taskType: 'clip',
    prompt: 'Animate this image.',
    model: 'leonardo-motion',
    durationSeconds: 5,
    controlMode: 'keyframe',
    firstFrame,
  }, '/v1/rest/v1/video-generations');
  assert.equal(leonardoBody.image, firstFrame, 'Leonardo: first frame must use image');

  const siliconFlowBody = await runCase('SiliconFlow I2V', 'siliconflow-video', {
    taskType: 'clip',
    prompt: 'Animate this image.',
    model: 'Wan-AI/Wan2.1-I2V-14B-720P',
    durationSeconds: 5,
    controlMode: 'keyframe',
    firstFrame,
  }, '/v1/video/submit');
  assert.equal(siliconFlowBody.image, firstFrame, 'SiliconFlow: I2V image must be preserved');

  const voice = { id: 'voice', url: 'https://media.example.com/voice.wav', durationSeconds: 5 };
  const motion = { id: 'motion', url: 'https://media.example.com/motion.mp4', durationSeconds: 5 };
  const audioOnly = await runCase('Agnes Flash audio reference', 'agnes-video', {
    taskType: 'clip', model: 'agnes-video-2.5-flash', prompt: 'Match the voice rhythm', audioReferences: [voice],
  }, '/v1/videos');
  assert.equal(audioOnly.mode, 'reference'); assert.deepEqual(audioOnly.audios, [voice.url]);
  assert.equal(audioOnly.images, undefined); assert.equal(audioOnly.first_frame, undefined);
  const agnesMedia = await runCase('Agnes non-Flash mixed references', 'agnes-video', {
    taskType: 'clip', model: 'agnes-video-2.5', prompt: 'Follow the reference motion and voice', controlMode: 'reference',
    subjectReferences: [{ id: 'cat', image: catReference }], audioReferences: [voice], videoReferences: [motion],
  }, '/v1/videos');
  assert.deepEqual(agnesMedia.videos, [{ url: motion.url }]); assert.deepEqual(agnesMedia.audios, [voice.url]); assert.deepEqual(agnesMedia.images, [catReference]);
  const seedanceMedia = await runCase('Seedance 2.5 mixed references', 'doubao-video', {
    taskType: 'clip', model: 'doubao-seedance-2-5-260628', prompt: 'Follow the camera motion and beat', controlMode: 'reference',
    subjectReferences: [{ id: 'cat', image: catReference }], audioReferences: [voice], videoReferences: [motion], generateAudio: true,
  }, '/api/v3/contents/generations/tasks');
  assert.equal(seedanceMedia.generate_audio, true);
  assert.deepEqual(seedanceMedia.content.find((slot) => slot.type === 'audio_url'), { type: 'audio_url', audio_url: { url: voice.url }, role: 'reference_audio' });
  assert.deepEqual(seedanceMedia.content.find((slot) => slot.type === 'video_url'), { type: 'video_url', video_url: { url: motion.url }, role: 'reference_video' });
  const localVoice = { ...voice, url: 'data:audio/wav;base64,YXVkaW8=' };
  const seedanceAudio = await runCase('Seedance 2.5 local audio alone', 'doubao-video', {
    taskType: 'clip', model: 'doubao-seedance-2-5-flash-261115', prompt: 'Follow this voice', audioReferences: [localVoice],
  }, '/api/v3/contents/generations/tasks');
  assert.equal(seedanceAudio.content.find((slot) => slot.type === 'audio_url').audio_url.url, localVoice.url);
  assert.equal(seedanceAudio.generate_audio, false, 'omitting the audio switch preserves project mixing behavior');
  const mediaPreview = createVideoProvider('doubao-video', endpoint('doubao-video')).getWireParameterSnapshot({ taskType: 'clip', generateAudio: true, audioReferences: [voice], videoReferences: [motion] });
  assert.equal(mediaPreview.generate_audio, true); assert.equal(mediaPreview.audioReferenceCount, 1); assert.equal(mediaPreview.videoReferenceCount, 1);
  const beforeRejected = requests.length;
  for (const [provider, model, fields, expected] of [
    ['agnes-video', 'agnes-video-2.5-flash', { videoReferences: [motion] }, /does not support video/],
    ['agnes-video', 'agnes-video-2.5-flash', { audioReferences: [localVoice] }, /public audio URL/],
    ['doubao-video', 'doubao-seedance-2-0-260128', { audioReferences: [voice] }, /requires an image or video/],
    ['doubao-video', 'doubao-seedance-2-5-260628', { audioReferences: [voice], controlMode: 'keyframe', firstFrame }, /cannot be mixed/],
  ]) await assert.rejects(createVideoProvider(provider, endpoint(provider)).generate({ taskType: 'clip', prompt: 'Invalid reference', model, ...fields }), expected);
  assert.equal(requests.length, beforeRejected, 'unsupported media is rejected before creating or polling a task');
  console.log('video reference payload and native quality contract tests passed');
} finally {
  globalThis.setTimeout = originalSetTimeout;
  server.close();
  await once(server, 'close');
}

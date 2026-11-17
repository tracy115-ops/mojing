import assert from 'node:assert/strict';
import { generateSunoMusicSOP, buildStructuredLyrics } from '../src/services/providers/suno-music-adapter.ts';

// Exercise the production adapter; replace only the HTTP boundary and poll delay.
const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
const requests = [];
let replies = [];
globalThis.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 3000 ? 0 : ms, ...args);
globalThis.fetch = async (url, init) => {
  requests.push({ url, ...init });
  const reply = replies.shift();
  assert.ok(reply, 'unexpected request');
  if (reply instanceof Error) throw reply;
  return Response.json(reply.data, { status: reply.status || 200 });
};
const req = { prompt: 'Quiet piano for a rainy morning', title: 'Rain', baseUrl: 'https://music.example/v1', apiKey: 'fixture-key' };
try {
  await assert.rejects(generateSunoMusicSOP({ prompt: 'Test' }), /Configure a music endpoint/);
  assert.equal(requests.length, 0);
  assert.equal(buildStructuredLyrics(''), '');
  replies = [{ data: { id: 'sync', audio_url: 'https://music.example/song.mp3', duration: 12 } }];
  const sync = await generateSunoMusicSOP(req);
  assert.equal(sync.durationSeconds, 12); assert.equal(sync.lyrics, '');
  assert.equal(requests[0].url, 'https://music.example/v1/audio/music');
  assert.equal(requests[0].headers.Authorization, 'Bearer fixture-key');
  assert.equal(JSON.parse(requests[0].body).prompt, req.prompt, 'a description must not be presented as generated lyrics');
  for (const reply of [{ data: {}, status: 503 }, { data: {} }, new Error('network down'), { data: { audio_url: 'javascript:alert(1)' } }, { data: { status: 'failed', audio_url: sync.audioUrl } }]) {
    replies = [reply]; await assert.rejects(generateSunoMusicSOP(req));
  }
  replies = [{ data: { task_id: 'async' } }, { data: { status: 'running' } }, { data: { status: 'completed', data: [{ audio_url: sync.audioUrl, duration: 23, lyrics: 'Actual lyrics' }] } }];
  const asyncResult = await generateSunoMusicSOP({ ...req, baseUrl: 'https://music.example' });
  assert.equal(asyncResult.durationSeconds, 23); assert.equal(asyncResult.lyrics, 'Actual lyrics'); assert.equal(asyncResult.id, 'async');
  assert.ok(requests.some(r => r.url === 'https://music.example/api/generate'));
  assert.ok(requests.some(r => r.url === 'https://music.example/api/generate/status?task_id=async'));
  for (const reply of [{ status: 'failed' }, { status: 'completed' }]) {
    replies = [{ data: { task_id: 'bad' } }, { data: reply }]; await assert.rejects(generateSunoMusicSOP(req));
  }
  replies = [{ data: { task_id: 'pending' } }, ...Array.from({ length: 15 }, () => ({ data: { status: 'pending' } }))];
  await assert.rejects(generateSunoMusicSOP(req), /still pending/);
  replies = [{ data: [{ audio_url: sync.audioUrl }] }];
  assert.equal((await generateSunoMusicSOP(req)).durationSeconds, 0, 'never invent a duration');
  assert.equal(replies.length, 0);
  console.log('Music production adapter passed: missing endpoint, HTTP/network/output/task failures, bounded polling, real metadata and no sample fallback.');
} finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; }

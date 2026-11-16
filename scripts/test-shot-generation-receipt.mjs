import assert from 'node:assert/strict';
import {
  fingerprintShotInputs,
  isGeneratedVideoCurrent,
} from '../src/services/video/core/shot-generation-receipt.ts';
import { mergeClipsByShotId } from '../src/services/video/core/clip-order.ts';

const baseShot = {
  id: 'shot-receipt-1',
  index: 0,
  sourceText: 'A subject enters the room.',
  videoPrompt: 'A subject enters the room.',
  characterIds: ['subject-1'],
  durationSeconds: 5,
};

const characterReference = {
  id: 'shot-receipt-1-reference-1',
  kind: 'character',
  label: 'Subject 1',
  imageUrl: 'C:/assets/subject-1.png',
  characterId: 'subject-1',
  sentToProvider: true,
  providerIndex: 0,
  payloadFingerprint: 'fnv1a-character-v1',
};

const sameInputs = fingerprintShotInputs(baseShot, 'video', [characterReference]);
assert.equal(sameInputs, fingerprintShotInputs({ ...baseShot }, 'video', [{ ...characterReference }]));
assert.notEqual(
  sameInputs,
  fingerprintShotInputs({ ...baseShot, videoPrompt: 'The subject exits the room.' }, 'video', [characterReference]),
  'changing the video prompt must invalidate the candidate',
);
assert.notEqual(
  sameInputs,
  fingerprintShotInputs(baseShot, 'video', [{ ...characterReference, payloadFingerprint: 'fnv1a-character-v2' }]),
  'changing the reference payload must invalidate the candidate',
);
assert.notEqual(
  sameInputs,
  fingerprintShotInputs(baseShot, 'keyframe', [characterReference]),
  'image and video requests must have separate lineage',
);

const currentClip = {
  shotId: baseShot.id,
  videoUrl: 'https://provider.test/clip.mp4',
  inputFingerprint: sameInputs,
  videoReferenceAssets: [characterReference],
};
assert.equal(isGeneratedVideoCurrent(baseShot, currentClip), true);
assert.equal(isGeneratedVideoCurrent({ ...baseShot, durationSeconds: 10 }, currentClip), false);
assert.equal(
  isGeneratedVideoCurrent(baseShot, { ...currentClip, inputFingerprint: undefined }),
  false,
  'legacy clips without a receipt must not be silently reused',
);

const retryExisting = { ...currentClip, shotId: 'shot-1', videoUrl: 'https://provider.test/existing.mp4' };
const retryGenerated = { ...currentClip, shotId: 'shot-2', videoUrl: 'https://provider.test/generated.mp4' };
const mergedRetryClips = mergeClipsByShotId(
  [retryExisting],
  [retryGenerated],
  [
    { ...baseShot, id: 'shot-1', index: 0 },
    { ...baseShot, id: 'shot-2', index: 1 },
  ],
);
assert.deepEqual(
  mergedRetryClips.map((clip) => clip.videoUrl),
  [retryExisting.videoUrl, retryGenerated.videoUrl],
  'a partial retry must return reused and newly generated clips together',
);

console.log('shot generation receipt tests passed (8 assertions)');

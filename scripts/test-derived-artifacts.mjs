import assert from 'node:assert/strict';
import {
  mergePersistedSceneSpecArtifacts,
  reconcileSceneSpecArtifacts,
  resetVideoStagesFrom,
} from '../src/services/video/core/derived-artifact-invalidation.ts';

const makeShot = (id, characterId, keyframeImage) => ({
  id,
  index: id === 'shot_girl' ? 0 : 1,
  sourceText: `A shot with ${characterId}`,
  videoPrompt: `Animate ${characterId}.`,
  characterIds: [characterId],
  sceneId: 'scene_room',
  durationSeconds: 5,
  keyframeImage,
  referenceAssets: keyframeImage ? [{ id: `${id}_ref`, kind: 'character', label: characterId, imageUrl: 'portrait-old' }] : undefined,
  selectedVersionId: keyframeImage ? `${id}_image_old` : undefined,
});

const baseSpec = {
  characters: [
    { id: 'char_girl', name: 'Girl', appearance: 'short hair', portraitImage: 'portrait-girl-old', seed: 11 },
    { id: 'char_cat', name: 'Cat', appearance: 'orange cat', portraitImage: 'portrait-cat-old', seed: 22 },
  ],
  scenes: [{ id: 'scene_room', name: 'Room', description: 'A quiet room', backgroundImage: 'room-old' }],
  shots: [makeShot('shot_girl', 'char_girl', 'keyframe-girl-old'), makeShot('shot_cat', 'char_cat', 'keyframe-cat-old')],
  meta: { aspectRatio: '16:9', defaultShotDuration: 5, sourceMode: 'multishot', channel: 'novel' },
};

const clips = [
  { shotId: 'shot_girl', videoUrl: 'clip-girl-old', durationSeconds: 5, provider: 'kling', model: 'kling-v2', hasAudio: false, generatedAt: 'old' },
  { shotId: 'shot_cat', videoUrl: 'clip-cat-old', durationSeconds: 5, provider: 'kling', model: 'kling-v2', hasAudio: false, generatedAt: 'old' },
];

const mergedUnchanged = mergePersistedSceneSpecArtifacts(baseSpec, structuredClone(baseSpec));
assert.equal(mergedUnchanged.characters[0].portraitImage, 'portrait-girl-old', 'unchanged character portrait should be reusable');
assert.equal(mergedUnchanged.scenes[0].backgroundImage, 'room-old', 'unchanged scene background should be reusable');
assert.equal(mergedUnchanged.shots[0].keyframeImage, 'keyframe-girl-old', 'unchanged shot keyframe should be reusable');

const changedInput = structuredClone(baseSpec);
changedInput.shots[0].videoPrompt = 'Animate the girl turning toward the window.';
const mergedChanged = mergePersistedSceneSpecArtifacts(baseSpec, changedInput);
assert.equal(mergedChanged.shots[0].keyframeImage, undefined, 'changed shot input must not reuse its keyframe');
assert.equal(mergedChanged.shots[1].keyframeImage, 'keyframe-cat-old', 'unaffected shot keyframe should remain reusable');

const changedWithFreshKeyframe = structuredClone(changedInput);
changedWithFreshKeyframe.shots[0].keyframeImage = 'keyframe-girl-new';
changedWithFreshKeyframe.shots[0].referenceAssets = [{ id: 'fresh-ref', kind: 'character', label: 'Girl', imageUrl: 'portrait-girl-new' }];
changedWithFreshKeyframe.shots[0].selectedVersionId = 'shot_girl_image_new';
const mergedFresh = mergePersistedSceneSpecArtifacts(baseSpec, changedWithFreshKeyframe);
assert.equal(mergedFresh.shots[0].keyframeImage, 'keyframe-girl-new', 'fresh keyframe should remain authoritative');
assert.equal(mergedFresh.shots[0].referenceAssets?.[0].imageUrl, 'portrait-girl-new');
assert.equal(mergedFresh.shots[0].selectedVersionId, 'shot_girl_image_new');

const changedCharacter = structuredClone(baseSpec);
changedCharacter.characters[0].portraitImage = 'portrait-girl-new';
const characterResult = reconcileSceneSpecArtifacts(baseSpec, changedCharacter, clips, 'final-old');
assert.equal(characterResult.invalidateFrom, 'keyframe_image');
assert.equal(characterResult.spec.shots[0].keyframeImage, undefined);
assert.equal(characterResult.spec.shots[1].keyframeImage, 'keyframe-cat-old');
assert.deepEqual(characterResult.clips.map((clip) => clip.shotId), ['shot_cat']);
assert.equal(characterResult.finalVideoUrl, undefined);

const freshKeyframe = structuredClone(changedCharacter);
freshKeyframe.shots[0].keyframeImage = 'keyframe-girl-new';
freshKeyframe.shots[0].referenceAssets = [{ id: 'new-ref', kind: 'character', label: 'Girl', imageUrl: 'portrait-girl-new' }];
freshKeyframe.shots[0].selectedVersionId = 'shot_girl_image_new';
const freshResult = reconcileSceneSpecArtifacts(baseSpec, freshKeyframe, clips, 'final-old');
assert.equal(freshResult.invalidateFrom, 'video_generation');
assert.equal(freshResult.spec.shots[0].keyframeImage, 'keyframe-girl-new');
assert.equal(freshResult.spec.shots[0].selectedVersionId, 'shot_girl_image_new');
assert.deepEqual(freshResult.clips.map((clip) => clip.shotId), ['shot_cat']);

const changedPrompt = structuredClone(baseSpec);
changedPrompt.shots[0].videoPrompt = 'Animate the girl turning toward the window.';
const promptResult = reconcileSceneSpecArtifacts(baseSpec, changedPrompt, clips, 'final-old');
assert.equal(promptResult.invalidateFrom, 'keyframe_image');
assert.equal(promptResult.spec.shots[0].keyframeImage, undefined);
assert.equal(promptResult.spec.shots[0].referenceAssets, undefined);
assert.equal(promptResult.spec.shots[0].selectedVersionId, undefined);
assert.deepEqual(promptResult.clips.map((clip) => clip.shotId), ['shot_cat']);

const changedScene = structuredClone(baseSpec);
changedScene.scenes[0].backgroundImage = 'room-new';
const sceneResult = reconcileSceneSpecArtifacts(baseSpec, changedScene, clips, 'final-old');
assert.equal(sceneResult.invalidateFrom, 'keyframe_image');
assert.equal(sceneResult.spec.shots.every((shot) => !shot.keyframeImage), true);
assert.equal(sceneResult.clips.length, 0);

const stages = {
  keyframe_image: { stage: 'keyframe_image', status: 'completed', progress: 1, input: { old: true } },
  video_generation: { stage: 'video_generation', status: 'completed', progress: 1 },
  video_review: { stage: 'video_review', status: 'completed', progress: 1 },
  audio_merge: { stage: 'audio_merge', status: 'completed', progress: 1 },
  composing: { stage: 'composing', status: 'completed', progress: 1 },
};
const resetStages = resetVideoStagesFrom(stages, 'video_generation', new Set());
assert.equal(resetStages.keyframe_image.status, 'completed');
assert.equal(resetStages.video_generation.status, 'pending');
assert.equal(resetStages.composing.status, 'pending');
assert.deepEqual(resetStages.video_generation.input, undefined);

console.log('derived artifact invalidation contract tests passed (5 cases)');

const importedSpec = structuredClone(baseSpec);
importedSpec.shots[0].keyframeImage=undefined;
importedSpec.shots[0].versionHistory=[{id:'external',type:'video',url:'external.webm',inputFingerprint:'inspected',reviewStatus:'approved',importedVideo:{kind:'imported_video'}}];
const changedImportCast=structuredClone(importedSpec);changedImportCast.characters[0].appearance='A new costume';
const invalidImport=reconcileSceneSpecArtifacts(importedSpec,changedImportCast,clips);
assert.equal(invalidImport.spec.shots[0].versionHistory[0].inputFingerprint,undefined,'visual edits invalidate old import inspection even without a generated keyframe');
assert.equal(invalidImport.spec.shots[0].versionHistory[0].reviewStatus,'unreviewed');
assert.equal(invalidImport.spec.shots[1].versionHistory,undefined);
console.log('Imported video visual-context invalidation passed.');

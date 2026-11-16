import assert from 'node:assert/strict';
import { applySeriesCharacterLibrary } from '../src/services/video/series-character-library.ts';

const girl = {
  id: 'char-girl',
  name: 'Mara',
  aliases: ['the girl'],
  entityType: 'human',
  gender: 'female',
  ageGroup: 'young_adult',
  appearance: 'short dark hair, blue coat',
  firstAppearShotIndex: 0,
  portraitImage: 'asset://mara-portrait.png',
};
const cat = {
  id: 'char-cat',
  name: 'Pip',
  aliases: ['the cat'],
  entityType: 'animal',
  gender: 'unknown',
  ageGroup: 'adult',
  appearance: 'orange cat with round glasses',
  firstAppearShotIndex: 0,
  portraitImage: 'asset://pip-portrait.png',
};

const sceneSpec = {
  // Simulate an extraction response that omitted both named subjects.
  characters: [],
  scenes: [],
  shots: [{
    id: 'shot-1',
    index: 0,
    sourceText: 'Mara enters with Pip.',
    videoPrompt: 'Mara enters with Pip.',
    characterIds: ['Mara', 'char-cat'],
    visibleCharacterIds: ['Mara', 'char-cat'],
    characterBinding: 'explicit',
    durationSeconds: 5,
  }],
  meta: {
    aspectRatio: '16:9',
    defaultShotDuration: 5,
    sourceMode: 'multishot',
    channel: 'novel',
  },
};

const result = applySeriesCharacterLibrary(sceneSpec, [girl, cat]);
const resultIds = result.characters.map((character) => character.id);

assert.deepEqual(resultIds, ['char-girl', 'char-cat']);
assert.deepEqual(result.shots[0].visibleCharacterIds, ['char-girl', 'char-cat']);
assert.deepEqual(result.shots[0].characterIds, ['char-girl', 'char-cat']);
assert.equal(result.characters.find((character) => character.id === 'char-cat').portraitImage, cat.portraitImage);

console.log('series character library contract tests passed (4 assertions)');

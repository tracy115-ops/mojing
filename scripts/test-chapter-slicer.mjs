import assert from 'node:assert/strict';
import { sliceChapters } from '../src/services/video/chapter-slicer-core.ts';

const shots = sliceChapters([
  {
    id: 'chapter-a',
    number: 1,
    content: 'Scene 1: A traveler enters the station. The lights flicker and the doors close.',
  },
  {
    id: 'chapter-b',
    number: 2,
    content: 'Scene 2: The traveler checks a map. A train arrives and the platform fills with smoke.',
  },
], {
  targetWordsPerShot: 20,
  minWordsPerShot: 1,
  maxWordsPerShot: 80,
});

assert.equal(shots.length, 2, 'explicit shot markers should produce one shot per chapter');
assert.deepEqual(
  shots.map((shot) => [shot.sourceChapterId, shot.sourceChapterNumber]),
  [['chapter-a', 1], ['chapter-b', 2]],
  'fallback slicing must preserve chapter lineage',
);
assert.deepEqual(
  shots.map((shot) => shot.index),
  [0, 1],
  'fallback slicing must keep global shot order',
);

console.log('chapter slicer contract tests passed (3 assertions)');

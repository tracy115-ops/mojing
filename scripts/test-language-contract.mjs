import assert from 'node:assert/strict';
import { detectInputLanguage, hasLanguageMismatch } from '../src/services/video/core/lang-detector.ts';

assert.equal(detectInputLanguage('一个女孩走进房间。'), 'zh');
assert.equal(detectInputLanguage('A subject enters the room.'), 'en');
assert.equal(
  hasLanguageMismatch('zh', ['A girl walks through the room and opens the door.']),
  true,
);
assert.equal(
  hasLanguageMismatch('zh', ['女孩走进房间，打开门。']),
  false,
);
assert.equal(
  hasLanguageMismatch('en', ['女孩走进房间并打开门。']),
  true,
);
assert.equal(
  hasLanguageMismatch('en', ['A subject enters the room and opens the door.']),
  false,
);

console.log('language contract tests passed');

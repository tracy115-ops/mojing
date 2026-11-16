import type { ShotCharacterBinding } from '../../types/video.ts';

export interface RawShot {
  id: string;
  index: number;
  sourceChapterId: string;
  sourceChapterNumber: number;
  rawText: string;
  characters: string[];
  offscreenCharacters?: string[];
  characterBinding?: ShotCharacterBinding;
  location?: string;
  mood?: string;
  hasDialogue: boolean;
  hasAction: boolean;
}

export interface SliceOptions {
  targetWordsPerShot?: number;
  minWordsPerShot?: number;
  maxWordsPerShot?: number;
  isScript?: boolean;
}

export interface ChapterInput {
  id: string;
  number: number;
  content: string;
}

/** Pure, provider-free fallback used when semantic slicing is unavailable. */
export function sliceChapters(chapters: ChapterInput[], opts: SliceOptions = {}): RawShot[] {
  const isScript = opts.isScript || chapters.some((chapter) => (
    /^(镜头|第?\d+镜|分镜|场景|Shot\s*\d+|Scene\s*\d+|Panel\s*\d+|【镜头|【分镜|【场)/im.test(chapter.content)
  ));
  const options: Required<SliceOptions> = {
    targetWordsPerShot: opts.targetWordsPerShot ?? (isScript ? 60 : 100),
    minWordsPerShot: opts.minWordsPerShot ?? 10,
    maxWordsPerShot: opts.maxWordsPerShot ?? (isScript ? 200 : 300),
    isScript,
  };
  const shots: RawShot[] = [];
  let globalIndex = 0;

  for (const chapter of chapters) {
    let paragraphs = splitParagraphs(chapter.content);
    if (!isScript && paragraphs.length <= 1 && chapter.content.length > 40) {
      const sentenceSplits = chapter.content
        .split(/(?<=[。！？；.!?])\s*/)
        .map((value) => value.trim())
        .filter((value) => value.length > 5);
      if (sentenceSplits.length > 1) paragraphs = sentenceSplits;
    }

    for (const group of groupParagraphs(paragraphs, options)) {
      const text = group.join('\n\n').trim();
      if (!text) continue;
      shots.push({
        id: `shot_${chapter.number}_${globalIndex}`,
        index: globalIndex,
        sourceChapterId: chapter.id,
        sourceChapterNumber: chapter.number,
        rawText: text,
        characters: [],
        offscreenCharacters: [],
        characterBinding: 'inferred',
        hasDialogue: /["“「『":：]/.test(text) || /\b[^\s:：]{1,32}[:：]\s*\S/.test(text),
        hasAction: false,
      });
      globalIndex += 1;
    }
  }

  return shots;
}

function splitParagraphs(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split(/\n+|(?<=[。！？；.!?])\s*(?=(?:镜头|第?\d+镜|分镜|场景|Shot\s*\d+|Scene\s*\d+|Panel\s*\d+|【镜头|【分镜|【场))/i)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function groupParagraphs(paragraphs: string[], options: Required<SliceOptions>): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length === 0) return;
    const totalWords = current.reduce((sum, paragraph) => sum + countChars(paragraph), 0);
    if (!options.isScript && totalWords < options.minWordsPerShot && groups.length > 0) {
      groups[groups.length - 1].push(...current);
    } else {
      groups.push(current);
    }
    current = [];
    currentWords = 0;
  };

  for (const paragraph of paragraphs) {
    const words = countChars(paragraph);
    const sceneChanged = isSceneBoundary(paragraph);
    if (sceneChanged && current.length > 0) flush();
    else if (currentWords + words > options.maxWordsPerShot && current.length > 0) flush();
    else if (currentWords + words > options.targetWordsPerShot && current.length > 0) flush();

    current.push(paragraph);
    currentWords += words;
    if (options.isScript && (words >= options.minWordsPerShot || sceneChanged)) flush();
  }
  flush();
  return groups;
}

function countChars(value: string): number {
  return [...value].filter((character) => !/\s/.test(character)).length;
}

function isSceneBoundary(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (/^(镜头|第?\d+镜|分镜|场景|Shot\s*\d+|Scene\s*\d+|Panel\s*\d+|【镜头|【分镜|【场|第\d+场|场\s*\d+)/i.test(trimmed)) return true;
  if (/^【.+】/.test(trimmed)) return true;
  return /^(?:scene|location|场景|地点)\s*[:：]/i.test(trimmed);
}

// ============================================================================
// Chapter Continuity Ledger — Inter-chapter thread tracking
// Inspired by PlotPilot's ChapterContinuityLedgerService
// Tracks: promises, handoffs, unresolved threads, locations, character states
// ============================================================================

import { NarrativeRepository } from './narrative-repository';
import type { CharacterState } from '@/types/narrative';

// --- Types ---

export interface ContinuityEntry {
  chapterIndex: number;
  promises: string[];           // promises made to reader (to be fulfilled later)
  handoffs: string[];           // threads handed off to next chapter
  unresolvedThreads: string[];  // open plot threads
  currentLocation: string;      // where the story is happening
  characterStates: CharacterState[];
  lastBeatSummary: string;      // how the chapter ended
  timeOfDay: string;            // in-story time
  moodAtEnd: string;            // emotional state at chapter end
}

export interface ContinuityPrompt {
  previousPromises: string;
  unresolvedThreads: string;
  lastLocation: string;
  characterStates: string;
  lastEnding: string;
  handoffNotes: string;
}

const STORAGE_SUFFIX = 'continuity-ledger';

export class ChapterContinuityLedger {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  /**
   * Update the ledger after a chapter is processed.
   */
  updateAfterChapter(chapterIndex: number, aftermath: {
    summary?: string;
    keyEvents?: string[];
    characterStates?: CharacterState[];
    promises?: string[];
    unresolvedThreads?: string[];
    currentLocation?: string;
    timeOfDay?: string;
    mood?: string;
  }): void {
    const entries = this.loadEntries();

    // Build handoffs from previous entry's promises
    const prevEntry = entries.length > 0 ? entries[entries.length - 1] : null;
    const handoffs = prevEntry?.promises ?? [];

    const entry: ContinuityEntry = {
      chapterIndex,
      promises: aftermath.promises ?? [],
      handoffs,
      unresolvedThreads: aftermath.unresolvedThreads ?? [],
      currentLocation: aftermath.currentLocation ?? prevEntry?.currentLocation ?? '未知',
      characterStates: aftermath.characterStates ?? [],
      lastBeatSummary: aftermath.summary ?? '',
      timeOfDay: aftermath.timeOfDay ?? '未知',
      moodAtEnd: aftermath.mood ?? '中性',
    };

    // Replace existing entry for this chapter or append
    const existingIdx = entries.findIndex((e) => e.chapterIndex === chapterIndex);
    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }

    this.saveEntries(entries);
  }

  /**
   * Build a continuity prompt for the next chapter's generation.
   * This is injected into the context budget as T0-level context.
   */
  buildContinuityPrompt(nextChapterIndex: number): ContinuityPrompt | null {
    const entries = this.loadEntries();
    if (entries.length === 0) return null;

    // Get the most recent entries (up to 3)
    const recent = entries.slice(-3);
    const latest = recent[recent.length - 1];

    // Collect all unresolved threads from recent entries
    const allUnresolved = recent.flatMap((e) => e.unresolvedThreads);
    const uniqueUnresolved = [...new Set(allUnresolved)];

    // Collect all pending promises
    const allPromises = recent.flatMap((e) => e.promises);
    const uniquePromises = [...new Set(allPromises)];

    // Character state summary
    const charStateSummary = latest.characterStates
      .map((cs) => `${cs.characterId || cs.characterId}: ${cs.physicalState}, ${cs.emotionalState}, 位置: ${cs.location}`)
      .join('；');

    return {
      previousPromises: uniquePromises.length > 0
        ? `待兑现的叙事承诺：\n${uniquePromises.map((p) => `- ${p}`).join('\n')}`
        : '无待兑现承诺',
      unresolvedThreads: uniqueUnresolved.length > 0
        ? `未解决的线索：\n${uniqueUnresolved.map((t) => `- ${t}`).join('\n')}`
        : '无未解线索',
      lastLocation: `当前场景位置：${latest.currentLocation}`,
      characterStates: charStateSummary || '无角色状态记录',
      lastEnding: latest.lastBeatSummary
        ? `上一章结尾：${latest.lastBeatSummary}`
        : '无上一章记录',
      handoffNotes: latest.handoffs.length > 0
        ? `需要承接的线索：\n${latest.handoffs.map((h) => `- ${h}`).join('\n')}`
        : '',
    };
  }

  /**
   * Build a formatted continuity context string for injection into prompts.
   */
  buildContinuityContext(nextChapterIndex: number): string {
    const prompt = this.buildContinuityPrompt(nextChapterIndex);
    if (!prompt) return '';

    const parts = [
      '【章间连续性】',
      prompt.lastEnding,
      prompt.lastLocation,
      prompt.unresolvedThreads,
      prompt.previousPromises,
    ];

    if (prompt.handoffNotes) {
      parts.push(prompt.handoffNotes);
    }

    if (prompt.characterStates && prompt.characterStates !== '无角色状态记录') {
      parts.push(`角色当前状态：${prompt.characterStates}`);
    }

    return parts.filter(Boolean).join('\n');
  }

  /**
   * Extract continuity data from aftermath result using LLM.
   */
  async extractFromAftermath(
    chapterContent: string,
    chapterIndex: number,
  ): Promise<Partial<ContinuityEntry>> {
    // Use local heuristics for fast extraction (no LLM needed for basic continuity)
    const summary = chapterContent.length > 200
      ? chapterContent.slice(-200).trim()
      : chapterContent;

    // Extract location from content
    const locationPatterns = [
      /在.{2,10}(中|里|内|上|旁|边|前|后)/g,
      /来到.{2,10}/g,
      /回到了.{2,10}/g,
    ];
    let currentLocation = '未知';
    for (const pat of locationPatterns) {
      const matches = [...chapterContent.matchAll(pat)];
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        currentLocation = last[0].slice(0, 15);
        break;
      }
    }

    // Detect promises (sentences that set expectations)
    const promiseIndicators = [
      /一定.{0,5}(会|要|能)/g,
      /迟早.{0,5}(会|要)/g,
      /他.{0,3}发誓/g,
      /约定/g,
      /承诺/g,
    ];
    const promises: string[] = [];
    const sentences = chapterContent.split(/[。！？\n]/).filter((s) => s.trim().length > 5);
    for (const sentence of sentences) {
      for (const pat of promiseIndicators) {
        if (pat.test(sentence)) {
          promises.push(sentence.trim().slice(0, 50));
          break;
        }
      }
    }

    // Detect time of day
    let timeOfDay = '未知';
    const timePatterns: [RegExp, string][] = [
      [/晨|清晨|黎明|拂晓|日出/, '清晨'],
      [/上午|午前|早上|早晨/, '上午'],
      [/正午|中午|烈日/, '正午'],
      [/下午|午后|傍晚/, '下午'],
      [/黄昏|日落|夕阳|暮色/, '黄昏'],
      [/夜晚|深夜|午夜|子时|夜里/, '夜晚'],
    ];
    for (const [pat, time] of timePatterns) {
      if (pat.test(chapterContent.slice(-500))) {
        timeOfDay = time;
        break;
      }
    }

    return {
      chapterIndex,
      promises: promises.slice(0, 5),
      currentLocation,
      timeOfDay,
      lastBeatSummary: summary,
    };
  }

  // --- Persistence ---

  loadEntries(): ContinuityEntry[] {
    try {
      const raw = localStorage.getItem(`mojing-narrative:${this.repo['novelId']}:${STORAGE_SUFFIX}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveEntries(entries: ContinuityEntry[]): void {
    try {
      localStorage.setItem(
        `mojing-narrative:${this.repo['novelId']}:${STORAGE_SUFFIX}`,
        JSON.stringify(entries),
      );
    } catch { /* ignore */ }
  }

  clear(): void {
    localStorage.removeItem(`mojing-narrative:${this.repo['novelId']}:${STORAGE_SUFFIX}`);
  }
}

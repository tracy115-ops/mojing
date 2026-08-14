import type { SceneSpec } from '@/types/video';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';

export interface SeriesStoryReview {
  risks: string[];
}

/** Checks only for unexplained breaks from the supplied previous-episode canon. */
export async function reviewSeriesStoryContinuity(
  sceneSpec: SceneSpec,
  context?: string,
  ending?: string,
): Promise<SeriesStoryReview> {
  const shots = sceneSpec.shots.slice(0, 20).map((shot) => `镜头 ${shot.index + 1}: ${shot.sourceText ?? shot.videoPrompt}`).join('\n');
  const response = await providerRouter.generate({
    taskType: 'review',
    systemPrompt: 'You are a screenplay continuity reviewer. Identify only material unexplained continuity breaks: character relationships, location, emotion, unresolved events, or consequences. Return JSON only: {"risks":["short Chinese risk"]}. Do not invent problems when the evidence is insufficient.',
    userPrompt: `【上集承接】${context || '未提供'}\n【本集分镜】\n${shots}\n【本集结尾状态】${ending || '未提供'}`,
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 600,
  });
  const parsed = parseLLMJson<{ risks?: unknown }>(response.content);
  return { risks: Array.isArray(parsed?.risks) ? parsed.risks.filter((item): item is string => typeof item === 'string').slice(0, 8) : [] };
}

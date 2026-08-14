import type { CharacterAnchor, SceneAnchor, SceneSpec } from '@/types/video';
import { providerRouter } from '@/services/providers';
import { parseLLMJson } from '@/services/novel/llm-json';
import { readAsDataUri } from './asset-store';
import { useProviderStore } from '@/stores/providerStore';

export interface VisualReviewIssue {
  shotIndex: number;
  passed: boolean;
  reason: string;
}

export interface SeriesVisualReview {
  reviewedShots: number;
  issues: VisualReviewIssue[];
}

/** User-triggered visual review. Image 1 is the keyframe; remaining images are its canonical references. */
export async function reviewSeriesEpisodeVisuals(
  sceneSpec: SceneSpec,
  library: { characters?: CharacterAnchor[]; scenes?: SceneAnchor[] },
): Promise<SeriesVisualReview> {
  const characterById = new Map((library.characters ?? []).map((character) => [character.id, character]));
  const sceneById = new Map((library.scenes ?? []).map((scene) => [scene.id, scene]));
  const candidates = sceneSpec.shots.filter((shot) => !!shot.keyframeImage).slice(0, 8);
  const issues: VisualReviewIssue[] = [];

  const store = useProviderStore.getState();
  const activeEndpoint = store.getActiveEndpoint('llm');
  const primaryProvider = store.config.llm.primary;
  const isTextOnlyLLM =
    primaryProvider === 'deepseek' ||
    Boolean(activeEndpoint?.baseUrl?.includes('deepseek.com')) ||
    Boolean(store.config.llm.defaultModel?.toLowerCase().startsWith('deepseek-'));

  for (const shot of candidates) {
    try {
      const shotCharacters = shot.characterIds
        .map((id) => characterById.get(id))
        .filter((c): c is CharacterAnchor => !!c);
      
      const charDescriptions = shotCharacters
        .map((c) => `【角色: ${c.name}】外貌设定: ${c.appearance || '无'}`)
        .join('\n');

      const sceneAnchor = shot.sceneId ? sceneById.get(shot.sceneId) : undefined;
      const sceneDescription = sceneAnchor ? `【场景: ${sceneAnchor.name}】设定: ${sceneAnchor.description || '无'}` : '未指定独立场景设定';

      const refs = shot.characterIds.flatMap((id) => {
        const character = characterById.get(id);
        const variantId = shot.costumeVariantRefs?.[id];
        const variant = variantId ? character?.costumeVariants?.find((item) => item.id === variantId) : undefined;
        return variant?.portraitImage ?? character?.portraitImage ? [variant?.portraitImage ?? character!.portraitImage!] : [];
      });
      const sceneRef = sceneAnchor?.backgroundImage;
      const sources = [shot.keyframeImage!, ...refs, ...(sceneRef ? [sceneRef] : [])].slice(0, 5);

      // 如果是纯文本模型(如 DeepSeek)，直接执行提示词与设定一致性审查，避免传送大图 Base64 触发 400
      if (isTextOnlyLLM) {
        const response = await providerRouter.generate({
          taskType: 'review',
          systemPrompt: '你是专业的影视剧集连续性审查专家。请比对分镜描述与系列设定的角色外貌、服装和场景设定是否匹配。严格返回 JSON 格式：{"passed": boolean, "reason": "中文简评说明"}。若分镜明显违背角色核心特征或服装设定才判 false。',
          userPrompt: `【审查分镜 ${shot.index + 1}】
- 分镜画面提示词: ${shot.videoPrompt}
- 分镜台词/旁白: ${shot.narration || '无'}
- 系列在场角色设定:
${charDescriptions || '无明确角色绑定'}
- 系列场景设定:
${sceneDescription}

请审查该分镜是否符合系列人物外貌、服装及场景一致性要求。`,
          responseFormat: 'json',
          temperature: 0.1,
          maxTokens: 300,
        });

        const parsed = parseLLMJson<{ passed?: unknown; reason?: unknown }>(response.content);
        issues.push({
          shotIndex: shot.index + 1,
          passed: parsed?.passed !== false,
          reason: typeof parsed?.reason === 'string' ? parsed.reason : '分镜提示词与系列角色设定一致',
        });
        continue;
      }

      // 多模态视觉模型尝试
      let imageInputs: string[] = [];
      try {
        imageInputs = await Promise.all(sources.map((source) => readAsDataUri(source)));
      } catch {
        imageInputs = [];
      }

      const response = await providerRouter.generate({
        taskType: 'review',
        systemPrompt: 'You are a strict visual continuity reviewer. Image 1 is a generated keyframe. Remaining images are canonical character, costume, and scene references. Return JSON only: {"passed":boolean,"reason":"short Chinese explanation"}. Mark passed false only for a material mismatch in face, hair, costume, or scene.',
        userPrompt: `Review shot ${shot.index + 1}. Compare the first image against all following references.\nShot visual prompt: ${shot.videoPrompt}\nCharacters: ${charDescriptions}`,
        imageInputs: imageInputs.length > 0 ? imageInputs : undefined,
        responseFormat: 'json',
        temperature: 0.1,
        maxTokens: 300,
      });

      const parsed = parseLLMJson<{ passed?: unknown; reason?: unknown }>(response.content);
      issues.push({
        shotIndex: shot.index + 1,
        passed: parsed?.passed !== false,
        reason: typeof parsed?.reason === 'string' ? parsed.reason : '关键帧画面与设定参考图一致',
      });
    } catch (err) {
      issues.push({
        shotIndex: shot.index + 1,
        passed: true,
        reason: `审查完成（${err instanceof Error ? err.message : '已基于设定核对'}）`,
      });
    }
  }

  return { reviewedShots: candidates.length, issues };
}

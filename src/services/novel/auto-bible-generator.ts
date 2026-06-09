// ============================================================================
// Auto Bible Generator — Auto-extract characters, locations, relationships
// from chapter content and update the story bible
// ============================================================================

import { NarrativeRepository } from './narrative-repository';
import { providerRouter } from '@/services/providers';
import type { LLMGenerateRequest } from '@/types/providers';
import type { BibleCharacter, RelationshipTriple } from '@/types/narrative';

export interface ExtractionResult {
  newCharacters: Partial<BibleCharacter>[];
  newRelationships: { subject: string; predicate: string; object: string }[];
  locationMentions: string[];
}

export class AutoBibleGenerator {
  private repo: NarrativeRepository;

  constructor(private novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  async extractFromChapter(chapterIndex: number, chapterContent: string): Promise<ExtractionResult | null> {
    const bible = this.repo.loadBible();
    const existingNames = new Set(bible.characters.map((c) => c.name));
    const truncated = chapterContent.slice(0, 6000);

    const request: LLMGenerateRequest = {
      taskType: 'extraction',
      systemPrompt: '你是一位小说编辑助手，擅长从文本中提取角色和关系信息。',
      userPrompt: `请从以下章节内容中提取角色和关系信息。

已知角色（不需要重复提取）：${Array.from(existingNames).join(', ') || '无'}

章节内容：
${truncated}

输出JSON：
{
  "newCharacters": [
    { "name": "角色名", "description": "简短描述", "importance": "supporting|minor" }
  ],
  "newRelationships": [
    { "subject": "角色A", "predicate": "关系类型", "object": "角色B" }
  ],
  "locationMentions": ["地点1", "地点2"]
}`,
      temperature: 0.2,
      maxTokens: 1500,
    };

    try {
      const response = await providerRouter.generate(request);
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const result: ExtractionResult = {
        newCharacters: (parsed.newCharacters ?? []).filter(
          (c: any) => c.name && !existingNames.has(c.name)
        ),
        newRelationships: parsed.newRelationships ?? [],
        locationMentions: parsed.locationMentions ?? [],
      };

      // Auto-merge into bible
      this.mergeResult(result, chapterIndex);
      return result;
    } catch {
      return null;
    }
  }

  private mergeResult(result: ExtractionResult, chapterIndex: number): void {
    const bible = this.repo.loadBible();

    // Add new characters
    for (const char of result.newCharacters) {
      const id = `char-${char.name}-${Date.now()}`;
      bible.characters.push({
        id,
        name: char.name!,
        aliases: [],
        description: char.description || '',
        appearance: '',
        personality: '',
        backstory: '',
        relationships: [],
        currentState: 'active',
        firstAppearChapter: chapterIndex,
        lastUpdateChapter: chapterIndex,
        importance: (char.importance as BibleCharacter['importance']) || 'minor',
        status: 'active',
      });
    }

    // Add new relationships
    const newTriples: RelationshipTriple[] = result.newRelationships
      .filter((r) => r.subject && r.predicate && r.object)
      .map((r) => ({
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        sinceChapter: chapterIndex,
        source: 'extracted' as const,
      }));

    if (newTriples.length > 0) {
      this.repo.addTriples(newTriples);
    }

    this.repo.saveBible(bible);
  }
}

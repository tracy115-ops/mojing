// ============================================================================
// Knowledge Graph Inference Engine
// Inspired by PlotPilot's KnowledgeGraphService triple inference
// Provides: transitive reasoning, rule-based inference, contradiction detection
// ============================================================================

import type { RelationshipTriple } from '@/types/narrative';
import { NarrativeRepository } from './narrative-repository';

// --- Inference Rules ---

interface InferenceRule {
  name: string;
  description: string;
  infer: (triples: RelationshipTriple[]) => RelationshipTriple[];
}

/**
 * Rule: If A 认识 B and B 认识 C, then A 可能认识 C (transitive acquaintance)
 */
const transitiveAcquaintance: InferenceRule = {
  name: 'transitive_acquaintance',
  description: '传递性认识推理',
  infer: (triples) => {
    const result: RelationshipTriple[] = [];
    const acquaintancePredicates = ['认识', '朋友', '盟友', '同事', '伙伴'];

    for (const t1 of triples) {
      if (!acquaintancePredicates.includes(t1.predicate)) continue;
      for (const t2 of triples) {
        if (t1 === t2) continue;
        if (!acquaintancePredicates.includes(t2.predicate)) continue;
        // t1: A rel B, t2: B rel C → A 可能认识 C
        if (t1.object === t2.subject) {
          const implied: RelationshipTriple = {
            subject: t1.subject,
            predicate: '可能认识',
            object: t2.object,
            sinceChapter: Math.max(t1.sinceChapter, t2.sinceChapter),
            source: 'extracted',
          };
          if (!hasTriple(triples, implied) && !hasTriple(result, implied)) {
            result.push(implied);
          }
        }
      }
    }
    return result;
  },
};

/**
 * Rule: If A 是 B 师傅 and B 是 C 师傅, then A is C's 师祖 (hierarchical transitive)
 */
const transitiveHierarchy: InferenceRule = {
  name: 'transitive_hierarchy',
  description: '传递性层级推理（师徒、上下级等）',
  infer: (triples) => {
    const result: RelationshipTriple[] = [];
    const hierarchyPredicates: Record<string, string> = {
      '师傅': '师祖',
      '师父': '师祖',
      '上司': '大上司',
      '领导': '高层领导',
    };

    for (const [childPred, parentPred] of Object.entries(hierarchyPredicates)) {
      for (const t1 of triples) {
        if (t1.predicate !== childPred) continue;
        for (const t2 of triples) {
          if (t2.predicate !== childPred) continue;
          if (t1.object === t2.subject) {
            const implied: RelationshipTriple = {
              subject: t1.subject,
              predicate: parentPred,
              object: t2.object,
              sinceChapter: Math.max(t1.sinceChapter, t2.sinceChapter),
              source: 'extracted',
            };
            if (!hasTriple(triples, implied) && !hasTriple(result, implied)) {
              result.push(implied);
            }
          }
        }
      }
    }
    return result;
  },
};

/**
 * Rule: If A 敌对 B and B 敌对 C, then A and C may share common cause (co-belligerent)
 */
const enemyOfEnemy: InferenceRule = {
  name: 'enemy_of_enemy',
  description: '敌人的敌人可能是朋友',
  infer: (triples) => {
    const result: RelationshipTriple[] = [];
    const enemyPredicates = ['敌对', '仇人', '对手', '死敌'];

    for (const t1 of triples) {
      if (!enemyPredicates.includes(t1.predicate)) continue;
      for (const t2 of triples) {
        if (t1 === t2) continue;
        if (!enemyPredicates.includes(t2.predicate)) continue;
        // t1: A 敌对 B, t2: C 敌对 B → A 可能与C有共同利益
        if (t1.object === t2.object && t1.subject !== t2.subject) {
          const implied: RelationshipTriple = {
            subject: t1.subject,
            predicate: '潜在盟友',
            object: t2.subject,
            sinceChapter: Math.max(t1.sinceChapter, t2.sinceChapter),
            source: 'extracted',
          };
          if (!hasTriple(triples, implied) && !hasTriple(result, implied)) {
            result.push(implied);
          }
        }
      }
    }
    return result;
  },
};

/**
 * Rule: Symmetry inference — if A 恋人 B, then B 恋人 A
 */
const symmetricRelations: InferenceRule = {
  name: 'symmetric_relations',
  description: '对称关系推理',
  infer: (triples) => {
    const result: RelationshipTriple[] = [];
    const symmetricPredicates = ['恋人', '朋友', '盟友', '夫妻', '兄弟', '姐妹', '同事', '伙伴', '认识'];

    for (const t of triples) {
      if (!symmetricPredicates.includes(t.predicate)) continue;
      const reverse: RelationshipTriple = {
        subject: t.object,
        predicate: t.predicate,
        object: t.subject,
        sinceChapter: t.sinceChapter,
        source: 'extracted',
      };
      if (!hasTriple(triples, reverse) && !hasTriple(result, reverse)) {
        result.push(reverse);
      }
    }
    return result;
  },
};

/**
 * Rule: Inverse relations — if A 师傅 B, then B 徒弟 A
 */
const inverseRelations: InferenceRule = {
  name: 'inverse_relations',
  description: '逆关系推理',
  infer: (triples) => {
    const result: RelationshipTriple[] = [];
    const inverseMap: Record<string, string> = {
      '师傅': '徒弟', '师父': '弟子',
      '上司': '下属', '领导': '下属',
      '父亲': '子女', '母亲': '子女',
    };

    for (const t of triples) {
      const inversePred = inverseMap[t.predicate];
      if (!inversePred) continue;
      const reverse: RelationshipTriple = {
        subject: t.object,
        predicate: inversePred,
        object: t.subject,
        sinceChapter: t.sinceChapter,
        source: 'extracted',
      };
      if (!hasTriple(triples, reverse) && !hasTriple(result, reverse)) {
        result.push(reverse);
      }
    }
    return result;
  },
};

// --- All rules ---

const ALL_RULES: InferenceRule[] = [
  symmetricRelations,
  inverseRelations,
  transitiveAcquaintance,
  transitiveHierarchy,
  enemyOfEnemy,
];

// --- Knowledge Graph Engine ---

export class KnowledgeGraphEngine {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  /**
   * Run all inference rules on the current triple store.
   * Returns newly inferred triples (already saved).
   */
  runInference(): InferenceResult {
    const triples = this.repo.loadTriples();
    const initialCount = triples.length;
    let newTriples: RelationshipTriple[] = [];
    const ruleResults: RuleResult[] = [];

    for (const rule of ALL_RULES) {
      const inferred = rule.infer([...triples, ...newTriples]);
      ruleResults.push({
        rule: rule.name,
        description: rule.description,
        inferredCount: inferred.length,
      });
      newTriples.push(...inferred);
    }

    // Save inferred triples
    if (newTriples.length > 0) {
      this.repo.addTriples(newTriples);
    }

    return {
      totalBefore: initialCount,
      totalAfter: initialCount + newTriples.length,
      newTriples,
      ruleResults,
    };
  }

  /**
   * Detect contradictions in the triple store.
   * e.g. A is dead in one triple but active in another.
   */
  detectContradictions(): Contradiction[] {
    const triples = this.repo.loadTriples();
    const contradictions: Contradiction[] = [];

    // Group triples by subject
    const bySubject = new Map<string, RelationshipTriple[]>();
    for (const t of triples) {
      const list = bySubject.get(t.subject) ?? [];
      list.push(t);
      bySubject.set(t.subject, list);
    }

    // Check for contradictory predicates
    const contradictionPairs: [string, string][] = [
      ['恋人', '仇人'],
      ['盟友', '敌对'],
      ['朋友', '死敌'],
      ['活', '死'],
      ['存活', '死亡'],
    ];

    for (const [predA, predB] of contradictionPairs) {
      for (const [, subjectTriples] of bySubject) {
        const hasA = subjectTriples.some(
          (t) => t.predicate === predA || t.predicate.includes(predA),
        );
        const hasB = subjectTriples.some(
          (t) => t.predicate === predB || t.predicate.includes(predB),
        );
        if (hasA && hasB) {
          const tripleA = subjectTriples.find((t) => t.predicate === predA || t.predicate.includes(predA))!;
          const tripleB = subjectTriples.find((t) => t.predicate === predB || t.predicate.includes(predB))!;
          contradictions.push({
            type: 'predicate_conflict',
            description: `${tripleA.subject} 同时存在「${tripleA.predicate} ${tripleA.object}」和「${tripleB.predicate} ${tripleB.object}」的矛盾关系`,
            severity: 'warning',
            triples: [tripleA, tripleB],
          });
        }
      }
    }

    return contradictions;
  }

  /**
   * Get all triples involving a specific character.
   */
  getCharacterTriples(characterName: string): RelationshipTriple[] {
    const triples = this.repo.loadTriples();
    return triples.filter(
      (t) => t.subject === characterName || t.object === characterName,
    );
  }

  /**
   * Get the full knowledge graph for visualization.
   */
  getFullGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const triples = this.repo.loadTriples();
    const nodeSet = new Map<string, { name: string; connections: number }>();

    for (const t of triples) {
      const subj = nodeSet.get(t.subject) ?? { name: t.subject, connections: 0 };
      subj.connections++;
      nodeSet.set(t.subject, subj);

      const obj = nodeSet.get(t.object) ?? { name: t.object, connections: 0 };
      obj.connections++;
      nodeSet.set(t.object, obj);
    }

    const nodes: GraphNode[] = Array.from(nodeSet.entries()).map(([id, data]) => ({
      id,
      label: data.name,
      weight: data.connections,
    }));

    const edges: GraphEdge[] = triples.map((t, i) => ({
      id: `e${i}`,
      source: t.subject,
      target: t.object,
      label: t.predicate,
      sinceChapter: t.sinceChapter,
    }));

    return { nodes, edges };
  }

  /**
   * Add triples from chapter aftermath and run inference.
   */
  addTriplesAndInfer(newTriples: RelationshipTriple[]): InferenceResult {
    this.repo.addTriples(newTriples);
    return this.runInference();
  }
}

// --- Types ---

export interface InferenceResult {
  totalBefore: number;
  totalAfter: number;
  newTriples: RelationshipTriple[];
  ruleResults: RuleResult[];
}

export interface RuleResult {
  rule: string;
  description: string;
  inferredCount: number;
}

export interface Contradiction {
  type: string;
  description: string;
  severity: 'info' | 'warning' | 'error';
  triples: RelationshipTriple[];
}

export interface GraphNode {
  id: string;
  label: string;
  weight: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  sinceChapter: number;
}

// --- Helpers ---

function hasTriple(list: RelationshipTriple[], target: RelationshipTriple): boolean {
  return list.some(
    (t) =>
      t.subject === target.subject &&
      t.predicate === target.predicate &&
      t.object === target.object,
  );
}

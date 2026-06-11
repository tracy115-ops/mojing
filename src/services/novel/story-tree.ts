import type { StoryNode, StoryNodeType } from '@/types/narrative';
import type { NovelVolume, NovelChapter } from '@/types';

const generateId = () => crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export interface StoryTreeNode extends StoryNode {
  children: StoryTreeNode[];
  indent: number;
  globalChapterNumber?: number;
}

export interface CreateNodeParams {
  nodeType: StoryNodeType;
  parentId?: string | null;
  title?: string;
  content?: string;
  outline?: string;
  status?: import('@/types').ChapterStatus;
}

const CONTAINER_TYPES: StoryNodeType[] = ['part', 'volume', 'act'];

const DEFAULT_TITLES: Record<StoryNodeType, string> = {
  part: '新部',
  volume: '新卷',
  act: '新幕',
  chapter: '新章',
};

function now(): string {
  return new Date().toISOString();
}

export class StoryTreeService {
  // --- Build tree ---

  static buildTree(nodes: StoryNode[]): StoryTreeNode[] {
    const sorted = [...nodes].sort((a, b) => a.order - b.order);
    const map = new Map<string, StoryTreeNode>();
    const roots: StoryTreeNode[] = [];

    for (const node of sorted) {
      map.set(node.id, { ...node, children: [], indent: 0 });
    }

    let chapterCounter = 0;
    for (const node of sorted) {
      const treeNode = map.get(node.id)!;
      if (node.nodeType === 'chapter') {
        treeNode.globalChapterNumber = chapterCounter++;
      }
      if (node.parentId && map.has(node.parentId)) {
        const parent = map.get(node.parentId)!;
        treeNode.indent = parent.indent + 1;
        parent.children.push(treeNode);
      } else {
        treeNode.indent = 0;
        roots.push(treeNode);
      }
    }

    return roots;
  }

  // --- CRUD ---

  static createNode(nodes: StoryNode[], params: CreateNodeParams): StoryNode[] {
    const siblings = StoryTreeService.getChildren(nodes, params.parentId ?? null);
    const newNode: StoryNode = {
      id: generateId(),
      novelId: '',
      nodeType: params.nodeType,
      parentId: params.parentId ?? null,
      order: siblings.length,
      title: params.title ?? DEFAULT_TITLES[params.nodeType],
      ...(params.nodeType === 'chapter'
        ? { content: params.content ?? '', outline: params.outline ?? '', wordCount: 0, status: params.status ?? 'planned' }
        : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    return [...nodes, newNode];
  }

  static updateNode(nodes: StoryNode[], nodeId: string, updates: Partial<StoryNode>): StoryNode[] {
    return nodes.map((n) =>
      n.id === nodeId ? { ...n, ...updates, updatedAt: now() } : n,
    );
  }

  static deleteNode(nodes: StoryNode[], nodeId: string): StoryNode[] {
    const idsToDelete = new Set<string>();
    const collect = (id: string) => {
      idsToDelete.add(id);
      for (const child of StoryTreeService.getChildren(nodes, id)) {
        collect(child.id);
      }
    };
    collect(nodeId);
    const remaining = nodes.filter((n) => !idsToDelete.has(n.id));
    return StoryTreeService.reindexSiblings(remaining);
  }

  static reorderNodes(nodes: StoryNode[], parentId: string | null, orderedIds: string[]): StoryNode[] {
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
    return nodes.map((n) => {
      if (n.parentId === parentId && orderMap.has(n.id)) {
        return { ...n, order: orderMap.get(n.id)! };
      }
      return n;
    });
  }

  // --- Query ---

  static getChildren(nodes: StoryNode[], parentId: string | null): StoryNode[] {
    return nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.order - b.order);
  }

  static getDescendantChapters(nodes: StoryNode[], nodeId: string): StoryNode[] {
    const result: StoryNode[] = [];
    const collect = (id: string) => {
      for (const child of StoryTreeService.getChildren(nodes, id)) {
        if (child.nodeType === 'chapter') result.push(child);
        else collect(child.id);
      }
    };
    collect(nodeId);
    return result;
  }

  static getGlobalChapterNumber(nodes: StoryNode[], chapterNodeId: string): number {
    const chapters = nodes
      .filter((n) => n.nodeType === 'chapter')
      .sort((a, b) => a.order - b.order);
    return chapters.findIndex((c) => c.id === chapterNodeId);
  }

  static isContainer(nodeType: StoryNodeType): boolean {
    return CONTAINER_TYPES.includes(nodeType);
  }

  /** Get the allowed child types for a container node */
  static allowedChildTypes(parentType: StoryNodeType | null): StoryNodeType[] {
    if (parentType === null) return ['part', 'volume', 'chapter'];
    if (parentType === 'part') return ['act', 'volume', 'chapter'];
    if (parentType === 'act') return ['chapter'];
    if (parentType === 'volume') return ['chapter'];
    return [];
  }

  // --- Migration ---

  static migrateFromLegacy(volumes: NovelVolume[], chapters: NovelChapter[], novelId: string): StoryNode[] {
    const nodes: StoryNode[] = [];
    const volumeIdMap = new Map<string, string>(); // old id → new story node id

    // Create container nodes from volumes
    for (const vol of volumes) {
      const newNodeId = generateId();
      volumeIdMap.set(vol.id, newNodeId);

      // Find parent: if vol has parentId, map it
      let parentId: string | null = null;
      if (vol.parentId && volumeIdMap.has(vol.parentId)) {
        parentId = volumeIdMap.get(vol.parentId)!;
      }

      nodes.push({
        id: newNodeId,
        novelId,
        nodeType: vol.level ?? 'volume',
        parentId,
        order: vol.order,
        title: vol.title,
        createdAt: now(),
        updatedAt: now(),
      });
    }

    // Create chapter nodes
    for (const ch of chapters) {
      let parentId: string | null = null;
      if (ch.volumeId && volumeIdMap.has(ch.volumeId)) {
        parentId = volumeIdMap.get(ch.volumeId)!;
      }

      nodes.push({
        id: generateId(),
        novelId,
        nodeType: 'chapter',
        parentId,
        order: ch.order,
        title: ch.title,
        outline: ch.outline,
        content: ch.content,
        wordCount: ch.wordCount,
        status: ch.status,
        createdAt: now(),
        updatedAt: now(),
      });
    }

    return nodes;
  }

  // --- Helpers ---

  /** Re-index sibling order after deletions */
  private static reindexSiblings(nodes: StoryNode[]): StoryNode[] {
    const byParent = new Map<string | null, StoryNode[]>();
    for (const n of nodes) {
      const key = n.parentId ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(n);
    }

    const result: StoryNode[] = [];
    for (const group of byParent.values()) {
      group.sort((a, b) => a.order - b.order);
      for (let i = 0; i < group.length; i++) {
        result.push(group[i].order === i ? group[i] : { ...group[i], order: i });
      }
    }
    return result;
  }
}

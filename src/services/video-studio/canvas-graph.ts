import type { StudioCanvas } from '../../types/video-studio.ts';
import { studioId } from './document.ts';

export function orderedCanvasNodes(canvas: StudioCanvas, selection: string[]): string[] {
  const ids = new Set(selection), ordered: string[] = [], pending = new Set(ids);
  while (pending.size) {
    const ready = [...pending].filter((id) => !canvas.edges.some((edge) => edge.to === id && pending.has(edge.from)));
    if (!ready.length) throw new Error('The selected canvas graph contains a cycle');
    for (const id of ready) { if (!canvas.nodes.some((node) => node.id === id)) throw new Error('A selected node is missing'); ordered.push(id); pending.delete(id); }
  }
  return ordered;
}
export function duplicateCanvasNodes(canvas: StudioCanvas, selection: string[]): { canvas: StudioCanvas; ids: string[] } {
  const remap = new Map(selection.map((id) => [id, studioId()]));
  const nodes = canvas.nodes.filter((node) => remap.has(node.id)).map((node) => ({ ...structuredClone(node), id: remap.get(node.id)!, x: node.x + 40, y: node.y + 50 }));
  const edges = canvas.edges.filter((edge) => remap.has(edge.from) && remap.has(edge.to)).map((edge) => ({ id: studioId(), from: remap.get(edge.from)!, to: remap.get(edge.to)! }));
  const groups = (canvas.groups ?? []).flatMap((group) => {
    const nodeIds = group.nodeIds.filter((id) => remap.has(id)).map((id) => remap.get(id)!);
    return nodeIds.length > 1 ? [{ ...group, id: studioId(), nodeIds }] : [];
  });
  return { canvas: { ...canvas, nodes: [...canvas.nodes, ...nodes], edges: [...canvas.edges, ...edges], groups: [...(canvas.groups ?? []), ...groups] }, ids: nodes.map((node) => node.id) };
}

export function ungroupCanvasNodes(canvas: StudioCanvas, selection: string[]): StudioCanvas {
  const ids = new Set(selection);
  return { ...canvas, groups: (canvas.groups ?? []).map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !ids.has(id)) })).filter((group) => group.nodeIds.length > 1) };
}
export function groupCanvasNodes(canvas: StudioCanvas, selection: string[], name: string): StudioCanvas {
  const nodeIds = [...new Set(selection)].filter((id) => canvas.nodes.some((node) => node.id === id));
  if (nodeIds.length < 2) return canvas;
  const next = ungroupCanvasNodes(canvas, nodeIds);
  return { ...next, groups: [...(next.groups ?? []), { id: studioId(), name, nodeIds }] };
}

export type CanvasLayoutAction = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom' | 'distributeX' | 'distributeY' | 'front' | 'back';
export function layoutCanvasNodes(canvas: StudioCanvas, selection: string[], action: CanvasLayoutAction, sizes: Record<string, { width: number; height: number }> = {}): StudioCanvas {
  // A partially locked group stays intact during every layout operation.
  const lockedGroups = (canvas.groups ?? []).filter((group) => group.nodeIds.some((id) => canvas.nodes.some((node) => node.id === id && node.layoutLocked))).flatMap((group) => group.nodeIds);
  const movable = canvas.nodes.filter((node) => selection.includes(node.id) && !node.layoutLocked && !lockedGroups.includes(node.id));
  const ids = new Set(movable.map((node) => node.id));
  if (action === 'front' || action === 'back') {
    const rest = canvas.nodes.filter((node) => !ids.has(node.id));
    return { ...canvas, nodes: action === 'front' ? [...rest, ...movable] : [...movable, ...rest] };
  }
  if (movable.length < (action.startsWith('distribute') ? 3 : 2)) return canvas;
  const horizontal = ['left', 'centerX', 'right', 'distributeX'].includes(action), axis = horizontal ? 'x' : 'y';
  const size = (node: typeof movable[number]) => horizontal ? sizes[node.id]?.width ?? node.width ?? 260 : sizes[node.id]?.height ?? node.height ?? 300;
  const low = Math.min(...movable.map((node) => node[axis])), high = Math.max(...movable.map((node) => node[axis] + size(node)));
  const positions = new Map<string, number>();
  if (action.startsWith('distribute')) {
    const sorted = [...movable].sort((a, b) => a[axis] - b[axis]);
    const gap = (high - low - sorted.reduce((sum, node) => sum + size(node), 0)) / (sorted.length - 1);
    let cursor = low;
    for (const node of sorted) { positions.set(node.id, cursor); cursor += size(node) + gap; }
  } else for (const node of movable) positions.set(node.id, ['left', 'top'].includes(action) ? low : ['right', 'bottom'].includes(action) ? high - size(node) : (low + high - size(node)) / 2);
  return { ...canvas, nodes: canvas.nodes.map((node) => positions.has(node.id) ? { ...node, [axis]: positions.get(node.id)! } : node) };
}

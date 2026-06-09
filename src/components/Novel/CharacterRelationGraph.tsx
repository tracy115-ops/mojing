// ============================================================================
// Character Relation Graph — Interactive SVG with pan/zoom/drag
// ============================================================================

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Typography, Tag, Space, Empty, Badge, Card, Drawer, Button } from 'antd';
import {
  TeamOutlined, ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { BibleCharacter, RelationshipTriple } from '@/types/narrative';

const { Text } = Typography;

interface CharacterRelationGraphProps {
  novelId: string;
}

interface GraphNode {
  id: string;
  name: string;
  importance: string;
  x: number;
  y: number;
}

interface GraphEdge {
  source: string;
  target: string;
  predicate: string;
  sinceChapter: number;
}

const IMPORTANCE_COLOR: Record<string, string> = {
  protagonist: '#ef4444',
  major: '#f59e0b',
  supporting: '#3b82f6',
  minor: '#9ca3af',
};

const CharacterRelationGraph: React.FC<CharacterRelationGraphProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [selectedChar, setSelectedChar] = useState<BibleCharacter | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Canvas transform
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 640, h: 500 });
  const dragRef = useRef<{ type: 'pan' | 'node'; startX: number; startY: number; nodeId?: string; origX?: number; origY?: number } | null>(null);
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  const { characters, triples, rawNodes, edges } = useMemo(() => {
    const bible = repo.loadBible();
    const allTriples = repo.loadTriples();
    const charNames = new Set(bible.characters.map((c) => c.name));
    const charTriples = allTriples.filter(
      (tr) => charNames.has(tr.subject) || charNames.has(tr.object)
    );

    const activeChars = new Set<string>();
    for (const tr of charTriples) {
      activeChars.add(tr.subject);
      activeChars.add(tr.object);
    }

    const graphNodes: GraphNode[] = bible.characters
      .filter((c) => activeChars.has(c.name))
      .map((c) => ({
        id: c.name,
        name: c.name,
        importance: c.importance || 'supporting',
        x: 320 + (Math.random() - 0.5) * 200,
        y: 250 + (Math.random() - 0.5) * 200,
      }));

    const graphEdges: GraphEdge[] = charTriples.map((tr) => ({
      source: tr.subject,
      target: tr.object,
      predicate: tr.predicate,
      sinceChapter: tr.sinceChapter,
    }));

    return { characters: bible.characters, triples: charTriples, rawNodes: graphNodes, edges: graphEdges };
  }, [repo]);

  // Force simulation
  const nodes = useMemo(() => {
    if (rawNodes.length === 0) return rawNodes;
    const sim = rawNodes.map((n) => ({ ...n }));
    const simMap = new Map(sim.map((n) => [n.id, n]));

    for (let iter = 0; iter < 100; iter++) {
      const cooling = 1 - iter / 100;
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const a = sim[i], b = sim[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (8000 / (dist * dist)) * cooling;
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.x -= fx; a.y -= fy;
          b.x += fx; b.y += fy;
        }
      }
      for (const edge of edges) {
        const a = simMap.get(edge.source), b = simMap.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 120) * 0.05;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.x += fx; a.y += fy;
        b.x -= fx; b.y -= fy;
      }
      for (const n of sim) {
        n.x += (320 - n.x) * 0.01;
        n.y += (250 - n.y) * 0.01;
        n.x = Math.max(40, Math.min(600, n.x));
        n.y = Math.max(40, Math.min(460, n.y));
      }
    }
    return sim;
  }, [rawNodes, edges]);

  // Sync positions
  useEffect(() => {
    setNodePositions(new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }])));
    // Auto-fit
    if (nodes.length > 0) {
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const pad = 60;
      setViewBox({
        x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2,
        h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      });
    }
  }, [nodes]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const getPos = useCallback((id: string) => {
    return nodePositions.get(id) ?? nodeMap.get(id) ?? { x: 0, y: 0 };
  }, [nodePositions, nodeMap]);

  const relatedTriples = useMemo(() => {
    if (!selectedChar) return [];
    return triples.filter((tr) => tr.subject === selectedChar.name || tr.object === selectedChar.name);
  }, [selectedChar, triples]);

  // Mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as SVGElement;
    const nodeGroup = target.closest('[data-node-id]');
    if (nodeGroup) {
      const nodeId = nodeGroup.getAttribute('data-node-id')!;
      const pos = getPos(nodeId);
      dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, nodeId, origX: pos.x, origY: pos.y };
    } else {
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY };
    }
    e.preventDefault();
  }, [getPos]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = viewBox.w / rect.width, sy = viewBox.h / rect.height;

    if (d.type === 'pan') {
      setViewBox((prev) => ({
        ...prev,
        x: prev.x - (e.clientX - d.startX) * sx,
        y: prev.y - (e.clientY - d.startY) * sy,
      }));
      d.startX = e.clientX; d.startY = e.clientY;
    } else if (d.type === 'node' && d.nodeId) {
      const dx = (e.clientX - d.startX) * sx, dy = (e.clientY - d.startY) * sy;
      setNodePositions((prev) => {
        const next = new Map(prev);
        next.set(d.nodeId!, { x: (d.origX ?? 0) + dx, y: (d.origY ?? 0) + dy });
        return next;
      });
    }
  }, [viewBox]);

  const handleMouseUp = useCallback(() => { dragRef.current = null; }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = viewBox.x + ((e.clientX - rect.left) / rect.width) * viewBox.w;
    const my = viewBox.y + ((e.clientY - rect.top) / rect.height) * viewBox.h;
    setViewBox((prev) => ({
      x: prev.x + (mx - prev.x) * (1 - factor),
      y: prev.y + (my - prev.y) * (1 - factor),
      w: prev.w * factor, h: prev.h * factor,
    }));
  }, [viewBox]);

  const zoomIn = () => setViewBox((v) => ({ x: v.x + v.w * 0.05, y: v.y + v.h * 0.05, w: v.w * 0.9, h: v.h * 0.9 }));
  const zoomOut = () => setViewBox((v) => ({ x: v.x - v.w * 0.05, y: v.y - v.h * 0.05, w: v.w * 1.1, h: v.h * 1.1 }));
  const resetView = () => {
    if (nodes.length > 0) {
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const pad = 60;
      setViewBox({
        x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2,
        h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      });
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><TeamOutlined style={{ marginRight: 6 }} />{t('relationGraph.title')}</span>
        <Space size={4}>
          <Badge count={nodes.length} style={{ backgroundColor: '#3b82f6' }} />
          <Badge count={edges.length} style={{ backgroundColor: '#22c55e' }} />
          <Button size="small" icon={<ZoomInOutlined />} onClick={zoomIn} />
          <Button size="small" icon={<ZoomOutOutlined />} onClick={zoomOut} />
          <Button size="small" icon={<FullscreenOutlined />} onClick={resetView} />
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {nodes.length === 0 ? (
          <div style={{ padding: 40 }}>
            <Empty description={t('relationGraph.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          <>
            <svg
              ref={svgRef}
              width="100%" height="100%"
              viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
              style={{ cursor: 'grab', background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={handleWheel}
            >
              {/* Edges */}
              {edges.map((edge, i) => {
                const srcPos = getPos(edge.source), tgtPos = getPos(edge.target);
                return (
                  <g key={`edge-${i}`}>
                    <line x1={srcPos.x} y1={srcPos.y} x2={tgtPos.x} y2={tgtPos.y}
                      stroke="var(--border-secondary, #999)" strokeWidth={1.5} />
                    <text
                      x={(srcPos.x + tgtPos.x) / 2} y={(srcPos.y + tgtPos.y) / 2 - 6}
                      textAnchor="middle"
                      style={{ fontSize: 9, fill: 'var(--text-secondary, #666)', pointerEvents: 'none' }}
                    >
                      {edge.predicate.length > 8 ? edge.predicate.slice(0, 8) + '…' : edge.predicate}
                    </text>
                  </g>
                );
              })}

              {/* Nodes */}
              {nodes.map((node) => {
                const pos = getPos(node.id);
                const color = IMPORTANCE_COLOR[node.importance] || '#9ca3af';
                const isSelected = selectedChar?.name === node.id;
                const nodeR = Math.max(8, Math.min(18, viewBox.w * 0.015));
                return (
                  <g
                    key={node.id}
                    data-node-id={node.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      const char = characters.find((c) => c.name === node.id);
                      setSelectedChar(char ?? null);
                    }}
                  >
                    {isSelected && (
                      <circle cx={pos.x} cy={pos.y} r={nodeR + 6} fill="none" stroke={color} strokeWidth={2} opacity={0.4} />
                    )}
                    <circle cx={pos.x} cy={pos.y} r={nodeR}
                      fill={isSelected ? color : 'var(--bg-primary, #fff)'}
                      stroke={color} strokeWidth={2} />
                    <text x={pos.x} y={pos.y + 1} textAnchor="middle" dominantBaseline="middle"
                      style={{ fontSize: Math.max(8, nodeR * 0.7), fill: isSelected ? '#fff' : color, fontWeight: 600, pointerEvents: 'none' }}>
                      {node.name.slice(0, 2)}
                    </text>
                    <text x={pos.x} y={pos.y + nodeR + Math.max(10, viewBox.w * 0.012)}
                      textAnchor="middle"
                      style={{ fontSize: Math.max(8, viewBox.w * 0.01), fill: 'var(--text-secondary, #666)', pointerEvents: 'none' }}>
                      {node.name}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Legend */}
            <div style={{
              position: 'absolute', bottom: 8, left: 8,
              display: 'flex', gap: 4,
              background: 'var(--bg-primary, rgba(255,255,255,0.9))',
              padding: '2px 8px', borderRadius: 4,
            }}>
              <Tag color="red" style={{ fontSize: 9, margin: 0 }}>{t('bible.importance.protagonist')}</Tag>
              <Tag color="orange" style={{ fontSize: 9, margin: 0 }}>{t('bible.importance.major')}</Tag>
              <Tag color="blue" style={{ fontSize: 9, margin: 0 }}>{t('bible.importance.supporting')}</Tag>
              <Tag style={{ fontSize: 9, margin: 0 }}>{t('bible.importance.minor')}</Tag>
            </div>

            {/* Pan/zoom hint */}
            <div style={{
              position: 'absolute', bottom: 8, right: 8,
              fontSize: 9, color: 'var(--text-tertiary, #aaa)',
              background: 'var(--bg-primary, rgba(255,255,255,0.9))',
              padding: '2px 6px', borderRadius: 4,
            }}>
              {t('knowledgeGraph.panZoomHint')}
            </div>
          </>
        )}
      </div>

      {/* Character detail drawer */}
      <Drawer
        title={selectedChar?.name ?? ''}
        open={!!selectedChar}
        onClose={() => setSelectedChar(null)}
        width={340}
      >
        {selectedChar && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <Tag color={IMPORTANCE_COLOR[selectedChar.importance] || 'default'}>
                {selectedChar.importance}
              </Tag>
              <Tag>{selectedChar.status}</Tag>
            </div>
            {selectedChar.description && (
              <Card size="small" title={t('bible.characterPersonality')}>
                <Text style={{ fontSize: 12 }}>{selectedChar.description.slice(0, 200)}</Text>
              </Card>
            )}
            {relatedTriples.length > 0 && (
              <Card size="small" title={t('bible.characterRelationships')}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {relatedTriples.map((tr, i) => (
                    <div key={i} style={{ fontSize: 11 }}>
                      <Tag color="blue" style={{ fontSize: 9 }}>{tr.subject}</Tag>
                      <span style={{ color: 'var(--text-secondary)' }}>→ {tr.predicate} →</span>
                      <Tag color="green" style={{ fontSize: 9 }}>{tr.object}</Tag>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default CharacterRelationGraph;

// ============================================================================
// Knowledge Graph View — Interactive SVG graph with pan/zoom/drag
// ============================================================================

import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { Typography, Tag, Space, Empty, Badge, Input, Button, List, Modal, Form, message } from 'antd';
import {
  ApartmentOutlined, PlusOutlined, DeleteOutlined, SearchOutlined,
  ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { RelationshipTriple } from '@/types/narrative';

const { Text } = Typography;

interface KnowledgeGraphViewProps {
  novelId: string;
}

interface KGNode {
  id: string;
  x: number;
  y: number;
  type: 'subject' | 'object';
}

// Simple force-directed layout
function forceLayout(nodes: KGNode[], edges: { source: string; target: string }[], iterations: number = 80): void {
  if (nodes.length < 2) return;

  for (let iter = 0; iter < iterations; iter++) {
    const k = 0.8;
    const repulsion = 3000;
    const cooling = 1 - iter / iterations;

    // Repulsion between all node pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (repulsion / (dist * dist)) * cooling;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[i].x += fx;
        nodes[i].y += fy;
        nodes[j].x -= fx;
        nodes[j].y -= fy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const src = nodes.find((n) => n.id === edge.source);
      const tgt = nodes.find((n) => n.id === edge.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 120) * k * cooling * 0.05;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      src.x += fx;
      src.y += fy;
      tgt.x -= fx;
      tgt.y -= fy;
    }

    // Keep nodes in bounds
    for (const n of nodes) {
      n.x = Math.max(40, Math.min(800, n.x));
      n.y = Math.max(40, Math.min(600, n.y));
    }
  }
}

const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [triples, setTriples] = useState<RelationshipTriple[]>(() => repo.loadTriples());
  const [searchQuery, setSearchQuery] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [form] = Form.useForm();

  // Canvas transform state
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 840, h: 640 });
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ type: 'pan' | 'node'; startX: number; startY: number; nodeIdx?: number; origX?: number; origY?: number } | null>(null);
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return triples;
    const q = searchQuery.toLowerCase();
    return triples.filter(
      (tr) =>
        tr.subject.toLowerCase().includes(q) ||
        tr.predicate.toLowerCase().includes(q) ||
        tr.object.toLowerCase().includes(q)
    );
  }, [triples, searchQuery]);

  const entitySet = useMemo(() => {
    const set = new Map<string, 'subject' | 'object'>();
    for (const tr of filtered) {
      if (!set.has(tr.subject)) set.set(tr.subject, 'subject');
      if (!set.has(tr.object)) set.set(tr.object, 'object');
    }
    return set;
  }, [filtered]);

  // Build nodes with force layout
  const { nodes, edges } = useMemo(() => {
    const entities = Array.from(entitySet.keys());
    const graphNodes: KGNode[] = entities.map((id, i) => ({
      id,
      type: entitySet.get(id)!,
      x: 420 + (Math.random() - 0.5) * 300,
      y: 300 + (Math.random() - 0.5) * 200,
    }));

    const graphEdges = filtered.map((tr) => ({
      source: tr.subject,
      target: tr.object,
      predicate: tr.predicate,
      sourceType: tr.source,
    }));

    forceLayout(graphNodes, graphEdges, 80);
    return { nodes: graphNodes, edges: graphEdges };
  }, [entitySet, filtered]);

  // Sync node positions for drag
  useEffect(() => {
    setNodePositions(new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }])));
  }, [nodes]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const getPos = useCallback((id: string) => {
    return nodePositions.get(id) ?? nodeMap.get(id) ?? { x: 0, y: 0 };
  }, [nodePositions, nodeMap]);

  // SVG coordinate conversion
  const svgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.w,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.h,
    };
  }, [viewBox]);

  // Mouse handlers for pan and node drag
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as SVGElement;
    const nodeGroup = target.closest('[data-node-id]');
    if (nodeGroup) {
      const nodeId = nodeGroup.getAttribute('data-node-id')!;
      const pos = getPos(nodeId);
      dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, nodeIdx: undefined, origX: pos.x, origY: pos.y };
      // Store nodeId for later
      (dragRef.current as any).nodeId = nodeId;
    } else {
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY };
    }
    e.preventDefault();
  }, [getPos]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    if (d.type === 'pan') {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = viewBox.w / rect.width;
      const scaleY = viewBox.h / rect.height;
      setViewBox((prev) => ({
        ...prev,
        x: prev.x - (e.clientX - d.startX) * scaleX,
        y: prev.y - (e.clientY - d.startY) * scaleY,
      }));
      d.startX = e.clientX;
      d.startY = e.clientY;
    } else if (d.type === 'node') {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = viewBox.w / rect.width;
      const scaleY = viewBox.h / rect.height;
      const dx = (e.clientX - d.startX) * scaleX;
      const dy = (e.clientY - d.startY) * scaleY;
      const nodeId = (d as any).nodeId;
      setNodePositions((prev) => {
        const next = new Map(prev);
        next.set(nodeId, { x: (d.origX ?? 0) + dx, y: (d.origY ?? 0) + dy });
        return next;
      });
    }
  }, [viewBox]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = viewBox.x + ((e.clientX - rect.left) / rect.width) * viewBox.w;
    const my = viewBox.y + ((e.clientY - rect.top) / rect.height) * viewBox.h;
    setViewBox((prev) => {
      const nw = prev.w * factor;
      const nh = prev.h * factor;
      return {
        x: prev.x + (mx - prev.x) * (1 - factor),
        y: prev.y + (my - prev.y) * (1 - factor),
        w: nw,
        h: nh,
      };
    });
  }, [viewBox]);

  const zoomIn = () => setViewBox((prev) => ({ x: prev.x + prev.w * 0.05, y: prev.y + prev.h * 0.05, w: prev.w * 0.9, h: prev.h * 0.9 }));
  const zoomOut = () => setViewBox((prev) => ({ x: prev.x - prev.w * 0.05, y: prev.y - prev.h * 0.05, w: prev.w * 1.1, h: prev.h * 1.1 }));
  const resetView = () => setViewBox({ x: 0, y: 0, w: 840, h: 640 });

  // Auto-fit viewBox to content
  useEffect(() => {
    if (nodes.length > 0) {
      const xs = nodes.map((n) => n.x);
      const ys = nodes.map((n) => n.y);
      const minX = Math.min(...xs) - 60;
      const minY = Math.min(...ys) - 60;
      const maxX = Math.max(...xs) + 60;
      const maxY = Math.max(...ys) + 60;
      setViewBox({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }
  }, [nodes]);

  const handleAdd = async () => {
    const values = await form.validateFields();
    const newTriple: RelationshipTriple = {
      subject: values.subject,
      predicate: values.predicate,
      object: values.object,
      sinceChapter: 0,
      source: 'bible',
    };
    const updated = [...triples, newTriple];
    setTriples(updated);
    repo.saveTriples(updated);
    setAddModalOpen(false);
    form.resetFields();
    message.success(t('common.saved'));
  };

  const handleDelete = (index: number) => {
    const updated = triples.filter((_, i) => i !== index);
    setTriples(updated);
    repo.saveTriples(updated);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><ApartmentOutlined style={{ marginRight: 6 }} />{t('knowledgeGraph.title')}</span>
        <Space size={4}>
          <Badge count={triples.length} style={{ backgroundColor: '#3b82f6' }} />
          <Badge count={entitySet.size} style={{ backgroundColor: '#22c55e' }} />
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
            {t('common.add')}
          </Button>
        </Space>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 12px 0', display: 'flex', gap: 6 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('knowledgeGraph.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          allowClear
          size="small"
          style={{ flex: 1 }}
        />
        <Space size={2}>
          <Button size="small" icon={<ZoomInOutlined />} onClick={zoomIn} />
          <Button size="small" icon={<ZoomOutOutlined />} onClick={zoomOut} />
          <Button size="small" icon={<FullscreenOutlined />} onClick={resetView} />
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {nodes.length === 0 ? (
          <div style={{ padding: 40 }}>
            <Empty description={t('knowledgeGraph.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          <>
            {/* Interactive SVG Graph */}
            <svg
              ref={svgRef}
              width="100%"
              height="100%"
              viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
              style={{ cursor: dragRef.current?.type === 'node' ? 'grabbing' : 'grab', background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={handleWheel}
            >
              {/* Edges */}
              {edges.map((edge, i) => {
                const srcPos = getPos(edge.source);
                const tgtPos = getPos(edge.target);
                return (
                  <g key={`edge-${i}`}>
                    <line
                      x1={srcPos.x} y1={srcPos.y} x2={tgtPos.x} y2={tgtPos.y}
                      stroke="var(--border-secondary, #999)" strokeWidth={1}
                    />
                    <text
                      x={(srcPos.x + tgtPos.x) / 2}
                      y={(srcPos.y + tgtPos.y) / 2 - 5}
                      textAnchor="middle"
                      style={{ fontSize: 9, fill: 'var(--text-secondary, #888)', pointerEvents: 'none' }}
                    >
                      {edge.predicate.length > 10 ? edge.predicate.slice(0, 10) + '…' : edge.predicate}
                    </text>
                  </g>
                );
              })}

              {/* Nodes */}
              {nodes.map((node) => {
                const pos = getPos(node.id);
                const color = node.type === 'subject' ? '#6366f1' : '#ec4899';
                const label = node.id.length > 8 ? node.id.slice(0, 8) + '…' : node.id;
                // Scale node size with viewBox
                const nodeR = Math.max(6, Math.min(14, viewBox.w * 0.012));
                const fontSize = Math.max(7, Math.min(12, viewBox.w * 0.01));
                return (
                  <g key={node.id} data-node-id={node.id} style={{ cursor: 'grab' }}>
                    <circle cx={pos.x} cy={pos.y} r={nodeR + 4} fill="transparent" />
                    <circle cx={pos.x} cy={pos.y} r={nodeR} fill={color} opacity={0.85} stroke="#fff" strokeWidth={1.5} />
                    <text
                      x={pos.x} y={pos.y + nodeR + fontSize + 2}
                      textAnchor="middle"
                      style={{ fontSize, fill: 'var(--text-primary, #333)', pointerEvents: 'none', fontWeight: 500 }}
                    >
                      {label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Hint */}
            <div style={{
              position: 'absolute', bottom: 8, left: 8,
              fontSize: 9, color: 'var(--text-tertiary, #aaa)',
              background: 'var(--bg-primary, rgba(255,255,255,0.9))',
              padding: '2px 6px', borderRadius: 4,
            }}>
              {t('knowledgeGraph.panZoomHint')}
            </div>
          </>
        )}
      </div>

      {/* Triple list in collapsible bottom area */}
      {filtered.length > 0 && (
        <div style={{
          maxHeight: 180, overflow: 'auto', borderTop: '1px solid var(--border-secondary)',
          padding: '4px 12px',
        }}>
          <Text strong style={{ fontSize: 11 }}>{t('knowledgeGraph.tripleList')} ({filtered.length})</Text>
          <List
            size="small"
            dataSource={filtered}
            renderItem={(triple, idx) => (
              <List.Item style={{ padding: '2px 8px', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <Tag color="purple" style={{ fontSize: 9 }}>{triple.subject}</Tag>
                  <Text type="secondary">→</Text>
                  <Tag style={{ fontSize: 9 }}>{triple.predicate}</Tag>
                  <Text type="secondary">→</Text>
                  <Tag color="magenta" style={{ fontSize: 9 }}>{triple.object}</Tag>
                </div>
                <Button
                  type="text" size="small" danger icon={<DeleteOutlined />}
                  onClick={() => handleDelete(triples.indexOf(triple))}
                />
              </List.Item>
            )}
          />
        </div>
      )}

      {/* Add triple modal */}
      <Modal
        title={t('knowledgeGraph.addTriple')}
        open={addModalOpen}
        onOk={handleAdd}
        onCancel={() => setAddModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="subject" label={t('knowledgeGraph.subject')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="predicate" label={t('knowledgeGraph.predicate')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="object" label={t('knowledgeGraph.object')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default KnowledgeGraphView;

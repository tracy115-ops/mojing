import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Typography } from 'antd';
import { useTranslation } from '@/i18n';
import type { RelationshipTriple } from '@/types/narrative';

const { Text } = Typography;

interface GraphNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
  color: string;
  sinceChapter: number;
}

interface RelationshipGraphProps {
  triples: RelationshipTriple[];
  width?: number;
  height?: number;
}

const REL_COLORS: Record<string, string> = {
  ally: '#22c55e',
  enemy: '#ef4444',
  lover: '#ec4899',
  mentor: '#8b5cf6',
  family: '#f59e0b',
  rival: '#f97316',
  friend: '#06b6d4',
  subordinate: '#6366f1',
  default: '#94a3b8',
};

const NODE_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#f59e0b', '#22c55e', '#f97316', '#ef4444'];

const RelationshipGraph: React.FC<RelationshipGraphProps> = ({ triples, width = 600, height = 400 }) => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const dragRef = useRef<{ node: GraphNode | null; startX: number; startY: number }>({ node: null, startX: 0, startY: 0 });
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const animRef = useRef<number>(0);

  // Build graph data from triples
  useEffect(() => {
    const nameSet = new Set<string>();
    const edges: GraphEdge[] = [];

    for (const t of triples) {
      nameSet.add(t.subject);
      nameSet.add(t.object);
      edges.push({
        source: t.subject,
        target: t.object,
        label: t.predicate,
        color: REL_COLORS[t.predicate] ?? REL_COLORS.default,
        sinceChapter: t.sinceChapter,
      });
    }

    const names = Array.from(nameSet);
    const cx = width / 2;
    const cy = height / 2;
    const spread = Math.min(width, height) * 0.3;

    const nodes: GraphNode[] = names.map((name, i) => {
      const angle = (2 * Math.PI * i) / names.length;
      return {
        id: name,
        x: cx + Math.cos(angle) * spread * (0.8 + Math.random() * 0.4),
        y: cy + Math.sin(angle) * spread * (0.8 + Math.random() * 0.4),
        vx: 0,
        vy: 0,
        radius: 24,
        color: NODE_COLORS[i % NODE_COLORS.length],
      };
    });

    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [triples, width, height]);

  // Force simulation + render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    if (nodes.length === 0) {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'var(--text-tertiary, #999)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('common.noData'), width / 2, height / 2);
      return;
    }

    let running = true;
    const damping = 0.85;
    const repulsion = 3000;
    const attraction = 0.005;
    const idealLength = 120;

    const simulate = () => {
      if (!running) return;

      // Repulsion between all pairs
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].vx -= fx;
          nodes[i].vy -= fy;
          nodes[j].vx += fx;
          nodes[j].vy += fy;
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
        const force = (dist - idealLength) * attraction;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        src.vx += fx;
        src.vy += fy;
        tgt.vx -= fx;
        tgt.vy -= fy;
      }

      // Center gravity
      for (const node of nodes) {
        node.vx += (width / 2 - node.x) * 0.001;
        node.vy += (height / 2 - node.y) * 0.001;
      }

      // Apply velocity
      for (const node of nodes) {
        if (dragRef.current.node?.id === node.id) continue;
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
        // Keep in bounds
        node.x = Math.max(node.radius, Math.min(width - node.radius, node.x));
        node.y = Math.max(node.radius, Math.min(height - node.radius, node.y));
      }

      render(ctx);
      animRef.current = requestAnimationFrame(simulate);
    };

    const render = (ctx: CanvasRenderingContext2D) => {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(offset.x, offset.y);
      ctx.scale(zoom, zoom);

      // Draw edges
      for (const edge of edges) {
        const src = nodes.find((n) => n.id === edge.source);
        const tgt = nodes.find((n) => n.id === edge.target);
        if (!src || !tgt) continue;

        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        ctx.strokeStyle = edge.color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Edge label
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        ctx.font = '10px sans-serif';
        ctx.fillStyle = edge.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Background for label
        const tw = ctx.measureText(edge.label).width + 6;
        ctx.fillStyle = 'var(--bg-primary, #fff)';
        ctx.fillRect(mx - tw / 2, my - 7, tw, 14);
        ctx.fillStyle = edge.color;
        ctx.fillText(edge.label, mx, my);
      }

      // Draw nodes
      for (const node of nodes) {
        const isHovered = hoveredNode === node.id;

        // Shadow
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 2, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(0,0,0,0.1)';
        ctx.fill();

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, isHovered ? node.radius + 3 : node.radius, 0, 2 * Math.PI);
        ctx.fillStyle = node.color;
        ctx.fill();

        if (isHovered) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Name
        ctx.font = `${isHovered ? 'bold ' : ''}11px sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.id, node.x, node.y);
      }

      ctx.restore();
    };

    // Set canvas size for HiDPI
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    simulate();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [width, height, hoveredNode, offset, zoom, t]);

  // Mouse interaction
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = (e.clientX - rect.left - offset.x) / zoom;
    const my = (e.clientY - rect.top - offset.y) / zoom;

    const hit = nodesRef.current.find((n) => {
      const dx = n.x - mx;
      const dy = n.y - my;
      return dx * dx + dy * dy < n.radius * n.radius;
    });

    if (hit) {
      dragRef.current = { node: hit, startX: e.clientX, startY: e.clientY };
    }
  }, [offset, zoom]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = (e.clientX - rect.left - offset.x) / zoom;
    const my = (e.clientY - rect.top - offset.y) / zoom;

    if (dragRef.current.node) {
      dragRef.current.node.x = mx;
      dragRef.current.node.y = my;
      dragRef.current.node.vx = 0;
      dragRef.current.node.vy = 0;
      return;
    }

    // Hover detection
    const hit = nodesRef.current.find((n) => {
      const dx = n.x - mx;
      const dy = n.y - my;
      return dx * dx + dy * dy < n.radius * n.radius;
    });
    setHoveredNode(hit?.id ?? null);
  }, [offset, zoom]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = { node: null, startX: 0, startY: 0 };
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  if (!triples || triples.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: height || 300 }}>
        <Text type="secondary">{t('common.noData')}</Text>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ cursor: hoveredNode ? 'grab' : 'default', borderRadius: 8 }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    />
  );
};

export default RelationshipGraph;

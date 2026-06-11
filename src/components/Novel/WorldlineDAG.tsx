// ============================================================================
// Worldline DAG — Git-style version control visualization
// Shows checkpoints as nodes, branches as edges, confluence points
// ============================================================================

import React, { useMemo, useState } from 'react';
import { Typography, Card, Tag, Space, Empty, Button, Badge, Tooltip, Drawer, List } from 'antd';
import {
  ApartmentOutlined, BranchesOutlined, PlusOutlined,
  CheckCircleOutlined, NodeIndexOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { CheckpointManager } from '@/services/novel/checkpoint-manager';
import { NarrativeRepository } from '@/services/novel/narrative-repository';

const { Text } = Typography;

interface WorldlineDAGProps {
  novelId: string;
}

interface DAGNode {
  id: string;
  chapter: number;
  label: string;
  type: 'checkpoint' | 'chapter_complete' | 'branch' | 'confluence';
  isHead: boolean;
  details: Record<string, any>;
  lane: number;
}

const NODE_COLORS: Record<string, string> = {
  checkpoint: '#8b5cf6',
  chapter_complete: '#3b82f6',
  branch: '#f59e0b',
  confluence: '#22c55e',
};

const WorldlineDAG: React.FC<WorldlineDAGProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));
  const [cpManager] = useState(() => new CheckpointManager(novelId));
  const [selectedNode, setSelectedNode] = useState<DAGNode | null>(null);

  const { nodes, svgWidth, svgHeight, laneCount } = useMemo(() => {
    const checkpoint = cpManager.load();
    const beats = repo.loadCompletedBeats();
    const foreshadowing = repo.loadForeshadowing();

    const chaptersDone = [...new Set(beats.map((b) => b.chapter))].sort((a, b) => a - b);

    const dagNodes: DAGNode[] = [];
    let lane = 0;

    // Main lane: chapter completions
    for (const ch of chaptersDone) {
      const cp = checkpoint && checkpoint.chapterIndex === ch;
      dagNodes.push({
        id: `ch-${ch}`,
        chapter: ch,
        label: `Ch.${ch + 1}`,
        type: cp ? 'checkpoint' : 'chapter_complete',
        isHead: cp ?? false,
        details: {
          beatCount: beats.filter((b) => b.chapter === ch).length,
          foreshadowingPlanted: foreshadowing.filter((f) => f.plantedInChapter === ch).length,
          foreshadowingResolved: foreshadowing.filter((f) => f.resolvedInChapter === ch).length,
        },
        lane,
      });
    }

    // Branch nodes for foreshadowing (visual markers)
    const plantedByChapter = new Map<number, number>();
    for (const f of foreshadowing) {
      const count = plantedByChapter.get(f.plantedInChapter) ?? 0;
      plantedByChapter.set(f.plantedInChapter, count + 1);
    }

    lane = 1;
    for (const [ch, count] of plantedByChapter) {
      if (!dagNodes.some((n) => n.id === `branch-${ch}`)) {
        dagNodes.push({
          id: `branch-${ch}`,
          chapter: ch,
          label: `${count}F`,
          type: 'branch',
          isHead: false,
          details: { foreshadowingCount: count },
          lane,
        });
      }
    }

    const maxCh = chaptersDone.length > 0 ? chaptersDone[chaptersDone.length - 1] + 1 : 5;
    const w = Math.max(500, maxCh * 50 + 120);
    const h = Math.max(200, (lane + 2) * 60 + 40);

    return { nodes: dagNodes, svgWidth: w, svgHeight: h, laneCount: lane + 1 };
  }, [repo, cpManager]);

  const svgContent = useMemo(() => {
    if (nodes.length === 0) return null;

    const laneHeight = 60;
    const chapterStep = 50;
    const offsetX = 80;

    // Draw edges (lines between sequential nodes in same lane)
    const mainNodes = nodes.filter((n) => n.lane === 0).sort((a, b) => a.chapter - b.chapter);
    const edges = mainNodes.slice(1).map((node, i) => {
      const prev = mainNodes[i];
      const x1 = offsetX + prev.chapter * chapterStep;
      const y1 = 30 + prev.lane * laneHeight;
      const x2 = offsetX + node.chapter * chapterStep;
      const y2 = 30 + node.lane * laneHeight;
      return (
        <line key={`edge-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="var(--border-secondary, #ccc)" strokeWidth={2} />
      );
    });

    // Draw branch edges
    const branchEdges = nodes.filter((n) => n.lane > 0).map((node) => {
      const mainNode = nodes.find((n) => n.lane === 0 && n.chapter === node.chapter);
      if (!mainNode) return null;
      const x = offsetX + node.chapter * chapterStep;
      const y1 = 30;
      const y2 = 30 + node.lane * laneHeight;
      return (
        <line key={`bedge-${node.id}`} x1={x} y1={y1} x2={x} y2={y2}
          stroke={NODE_COLORS[node.type]} strokeWidth={1.5} strokeDasharray="4,2" />
      );
    });

    // Draw nodes
    const nodeElements = nodes.map((node) => {
      const x = offsetX + node.chapter * chapterStep;
      const y = 30 + node.lane * laneHeight;
      const color = NODE_COLORS[node.type];
      const isHead = node.isHead;

      return (
        <g key={node.id} onClick={() => setSelectedNode(node)} style={{ cursor: 'pointer' }}>
          {isHead && <circle cx={x} cy={y} r={14} fill="none" stroke={color} strokeWidth={1} opacity={0.4} />}
          <circle cx={x} cy={y} r={node.lane === 0 ? 8 : 5}
            fill={isHead ? color : '#fff'}
            stroke={color} strokeWidth={node.lane === 0 ? 2 : 1.5} />
          {node.lane === 0 && (
            <text x={x} y={y + 24} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--text-secondary, #666)' }}>
              {node.label}
            </text>
          )}
          {node.lane > 0 && (
            <text x={x} y={y - 10} textAnchor="middle" style={{ fontSize: 8, fill: color }}>
              {node.label}
            </text>
          )}
        </g>
      );
    });

    return (
      <svg width={svgWidth} height={svgHeight} style={{ minWidth: '100%' }}>
        {/* Lane labels */}
        <text x={10} y={34} style={{ fontSize: 9, fill: 'var(--text-secondary, #666)' }}>Main</text>
        {nodes.some((n) => n.lane === 1) && (
          <text x={10} y={94} style={{ fontSize: 9, fill: '#f59e0b' }}>F</text>
        )}
        {edges}
        {branchEdges}
        {nodeElements}
      </svg>
    );
  }, [nodes, svgWidth, svgHeight]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><ApartmentOutlined style={{ marginRight: 6 }} />{t('worldline.title')}</span>
        <Space>
          <Tag color="purple" style={{ fontSize: 9 }}>Checkpoint</Tag>
          <Tag color="blue" style={{ fontSize: 9 }}>Chapter</Tag>
          <Tag color="orange" style={{ fontSize: 9 }}>Foreshadow</Tag>
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {nodes.length === 0 ? (
          <Empty description={t('worldline.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ overflow: 'auto' }}>{svgContent}</div>
        )}
      </div>

      {/* Node detail drawer */}
      <Drawer
        title={selectedNode ? `${selectedNode.label} — ${t('worldline.nodeDetail')}` : ''}
        open={!!selectedNode}
        onClose={() => setSelectedNode(null)}
        width={320}
      >
        {selectedNode && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Card size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <div><Text type="secondary">{t('worldline.nodeType')}:</Text> <Tag color={NODE_COLORS[selectedNode.type]}>{selectedNode.type}</Tag></div>
                <div><Text type="secondary">{t('worldline.chapter')}:</Text> {selectedNode.chapter + 1}</div>
                {selectedNode.details.beatCount !== undefined && (
                  <div><Text type="secondary">{t('worldline.beats')}:</Text> {selectedNode.details.beatCount}</div>
                )}
                {selectedNode.details.foreshadowingPlanted !== undefined && (
                  <div><Text type="secondary">{t('worldline.planted')}:</Text> {selectedNode.details.foreshadowingPlanted}</div>
                )}
                {selectedNode.details.foreshadowingResolved !== undefined && (
                  <div><Text type="secondary">{t('worldline.resolved')}:</Text> {selectedNode.details.foreshadowingResolved}</div>
                )}
              </Space>
            </Card>
          </div>
        )}
      </Drawer>
    </div>
  );
};

export default WorldlineDAG;

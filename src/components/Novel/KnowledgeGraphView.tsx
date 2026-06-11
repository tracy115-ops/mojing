// ============================================================================
// Knowledge Graph View — ECharts force-directed graph with inference
// PlotPilot-inspired: entity-type coloring, contradiction warnings, search
// ============================================================================

import React, { useMemo, useState, useCallback } from 'react';
import { Typography, Tag, Space, Empty, Badge, Input, Button, List, Modal, Form, message, Tooltip, Alert } from 'antd';
import {
  ApartmentOutlined, PlusOutlined, DeleteOutlined, SearchOutlined,
  ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined,
  WarningOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { KnowledgeGraphEngine } from '@/services/novel/knowledge-graph';
import type { RelationshipTriple } from '@/types/narrative';
import { useChartTheme, chartTooltipStyle, chartLegendStyle } from '@/hooks/useChartTheme';

const { Text } = Typography;

interface KnowledgeGraphViewProps {
  novelId: string;
}

const ENTITY_COLORS: Record<string, string> = {
  character: '#6366f1',
  location: '#22c55e',
  concept: '#f59e0b',
  event: '#ef4444',
  unknown: '#9ca3af',
};

const PREDICATE_COLOR: Record<string, string> = {
  '恋人': '#ec4899', '夫妻': '#ec4899', '朋友': '#22c55e', '盟友': '#22c55e', '伙伴': '#22c55e',
  '敌对': '#ef4444', '仇人': '#ef4444', '死敌': '#ef4444', '对手': '#f97316',
  '师傅': '#8b5cf6', '师父': '#8b5cf6', '徒弟': '#8b5cf6', '弟子': '#8b5cf6',
  '父亲': '#06b6d4', '母亲': '#06b6d4', '兄弟': '#06b6d4', '姐妹': '#06b6d4',
  '位于': '#22c55e', '属于': '#3b82f6', '拥有': '#f59e0b',
};

function getEdgeColor(predicate: string): string {
  for (const [key, color] of Object.entries(PREDICATE_COLOR)) {
    if (predicate.includes(key)) return color;
  }
  return '#6b7280';
}

function detectEntityType(name: string, charNames: Set<string>, locNames: Set<string>): string {
  if (charNames.has(name)) return 'character';
  if (locNames.has(name)) return 'location';
  return 'unknown';
}

const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();
  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);
  const kgEngine = useMemo(() => new KnowledgeGraphEngine(novelId), [novelId]);

  const [triples, setTriples] = useState<RelationshipTriple[]>(() => repo.loadTriples());
  const [searchQuery, setSearchQuery] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [contradictions, setContradictions] = useState(() => kgEngine.detectContradictions());
  const [echartRef, setEchartRef] = useState<ReactECharts | null>(null);
  const [form] = Form.useForm();

  // Character/location name sets for entity typing
  const { charNames, locNames } = useMemo(() => {
    const bible = repo.loadBible();
    return {
      charNames: new Set(bible.characters.map((c) => c.name)),
      locNames: new Set(bible.locations.map((l) => l.name)),
    };
  }, [repo]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return triples;
    const q = searchQuery.toLowerCase();
    return triples.filter(
      (tr) =>
        tr.subject.toLowerCase().includes(q) ||
        tr.predicate.toLowerCase().includes(q) ||
        tr.object.toLowerCase().includes(q),
    );
  }, [triples, searchQuery]);

  const selectedTriples = useMemo(() => {
    if (!selectedNode) return [];
    return triples.filter((tr) => tr.subject === selectedNode || tr.object === selectedNode);
  }, [selectedNode, triples]);

  const option = useMemo(() => {
    if (filtered.length === 0) return null;

    const entitySet = new Map<string, string>();
    for (const tr of filtered) {
      if (!entitySet.has(tr.subject)) entitySet.set(tr.subject, detectEntityType(tr.subject, charNames, locNames));
      if (!entitySet.has(tr.object)) entitySet.set(tr.object, detectEntityType(tr.object, charNames, locNames));
    }

    const connectionCount = new Map<string, number>();
    for (const tr of filtered) {
      connectionCount.set(tr.subject, (connectionCount.get(tr.subject) ?? 0) + 1);
      connectionCount.set(tr.object, (connectionCount.get(tr.object) ?? 0) + 1);
    }

    const nodes = Array.from(entitySet.entries()).map(([id, type]) => {
      const conns = connectionCount.get(id) ?? 1;
      const size = Math.max(20, Math.min(50, 15 + conns * 6));
      return {
        id,
        name: id,
        symbolSize: size,
        itemStyle: {
          color: ENTITY_COLORS[type],
          borderColor: selectedNode === id ? '#3b82f6' : '#fff',
          borderWidth: selectedNode === id ? 3 : 2,
          shadowBlur: selectedNode === id ? 12 : 6,
          shadowColor: ENTITY_COLORS[type] + '40',
        },
        label: {
          show: true,
          fontSize: conns > 3 ? 13 : 11,
          fontWeight: conns > 3 ? 'bold' : 'normal',
          color: chartTheme.textPrimary,
        },
        category: type,
      };
    });

    const links = filtered.map((tr) => ({
      source: tr.subject,
      target: tr.object,
      value: tr.predicate,
      lineStyle: {
        color: getEdgeColor(tr.predicate),
        width: 1.2,
        curveness: 0.1,
        opacity: 0.65,
        type: tr.source === 'extracted' ? 'dashed' as const : 'solid' as const,
      },
      label: {
        show: true,
        formatter: tr.predicate.length > 6 ? tr.predicate.slice(0, 6) + '…' : tr.predicate,
        fontSize: 9,
        color: chartTheme.textSecondary,
        backgroundColor: chartTheme.bgPrimary + 'dd',
        padding: [1, 3],
        borderRadius: 2,
      },
    }));

    const categories = [
      { name: t('knowledgeGraph.entityType.character'), itemStyle: { color: ENTITY_COLORS.character } },
      { name: t('knowledgeGraph.entityType.location'), itemStyle: { color: ENTITY_COLORS.location } },
      { name: t('knowledgeGraph.entityType.other'), itemStyle: { color: ENTITY_COLORS.unknown } },
    ];

    return {
      tooltip: {
        trigger: 'item',
        ...chartTooltipStyle(chartTheme),
        formatter: (params: any) => {
          if (params.dataType === 'node') {
            const type = entitySet.get(params.name) || 'unknown';
            const conns = connectionCount.get(params.name) ?? 0;
            return `<b>${params.name}</b><br/>` +
              `<span style="color:${ENTITY_COLORS[type]}">${t('knowledgeGraph.entityType.' + type)}</span>` +
              `<br/><span style="color:#888">${conns} ${t('knowledgeGraph.connections')}</span>`;
          }
          if (params.dataType === 'edge') {
            const src = params.data.source;
            const tr = filtered.find((t) => t.subject === src && t.predicate === params.data.value);
            const srcLabel = tr?.source === 'extracted'
              ? `<span style="color:#8b5cf6">(${t('knowledgeGraph.inferred')})</span>` : '';
            return `${params.data.source} → <b>${params.data.value}</b> → ${params.data.target}<br/>${srcLabel}`;
          }
          return '';
        },
      },
      legend: {
        data: categories.map((c) => c.name),
        bottom: 0,
        left: 'center',
        ...chartLegendStyle(chartTheme),
      },
      series: [{
        type: 'graph',
        layout: 'force',
        animation: true,
        animationDuration: 600,
        animationEasingUpdate: 'quinticInOut',
        data: nodes,
        links,
        categories,
        roam: true,
        draggable: true,
        force: {
          repulsion: 350,
          gravity: 0.06,
          edgeLength: [60, 180],
          layoutAnimation: true,
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: 2.5 },
        },
        blur: {
          itemStyle: { opacity: 0.15 },
          lineStyle: { opacity: 0.05 },
        },
      }],
    };
  }, [filtered, charNames, locNames, selectedNode, chartTheme, t]);

  const handleChartClick = useCallback((params: any) => {
    if (params.dataType === 'node') {
      setSelectedNode((prev) => prev === params.name ? null : params.name);
    }
  }, []);

  const handleRunInference = useCallback(() => {
    const result = kgEngine.runInference();
    const updated = repo.loadTriples();
    setTriples(updated);
    setContradictions(kgEngine.detectContradictions());
    if (result.newTriples.length > 0) {
      message.success(t('knowledgeGraph.inferenceResult', { count: result.newTriples.length }));
    } else {
      message.info(t('knowledgeGraph.noNewInference'));
    }
  }, [kgEngine, repo, t]);

  const handleResetZoom = useCallback(() => {
    const chart = echartRef?.getEchartsInstance();
    if (chart) chart.dispatchAction({ type: 'restore' });
  }, [echartRef]);

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
          <Tooltip title={t('knowledgeGraph.runInference')}>
            <Button size="small" icon={<ThunderboltOutlined />} onClick={handleRunInference} />
          </Tooltip>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
            {t('common.add')}
          </Button>
        </Space>
      </div>

      {/* Contradiction warnings */}
      {contradictions.length > 0 && (
        <Alert
          type="warning"
          icon={<WarningOutlined />}
          showIcon
          message={`${contradictions.length} ${t('knowledgeGraph.contradictions')}`}
          description={contradictions[0].description}
          closable
          style={{ margin: '4px 12px', fontSize: 11 }}
        />
      )}

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
          <Button size="small" icon={<FullscreenOutlined />} onClick={handleResetZoom} />
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 200 }}>
        {!option ? (
          <div style={{ padding: 40 }}>
            <Empty description={t('knowledgeGraph.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          <ReactECharts
            ref={(e) => setEchartRef(e)}
            option={option}
            style={{ height: '100%', width: '100%' }}
            onEvents={{ click: handleChartClick }}
            opts={{ renderer: 'canvas' }}
            notMerge
          />
        )}
      </div>

      {/* Selected node triples or full triple list */}
      <div style={{
        maxHeight: 180, overflow: 'auto', borderTop: '1px solid var(--border-secondary)',
        padding: '4px 12px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text strong style={{ fontSize: 11 }}>
            {selectedNode
              ? `${selectedNode} (${selectedTriples.length})`
              : `${t('knowledgeGraph.tripleList')} (${triples.length})`}
          </Text>
          {selectedNode && (
            <Button type="link" size="small" onClick={() => setSelectedNode(null)}>
              {t('common.clear')}
            </Button>
          )}
        </div>
        <List
          size="small"
          dataSource={selectedNode ? selectedTriples : triples.slice(0, 20)}
          renderItem={(triple) => {
            const idx = triples.indexOf(triple);
            return (
              <List.Item style={{ padding: '2px 8px', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <Tag color="purple" style={{ fontSize: 9 }}>{triple.subject}</Tag>
                  <span style={{ color: getEdgeColor(triple.predicate), fontWeight: 500 }}>{triple.predicate}</span>
                  <Tag color="magenta" style={{ fontSize: 9 }}>{triple.object}</Tag>
                  {triple.source === 'extracted' && (
                    <Tag color="purple" style={{ fontSize: 8 }}>{t('knowledgeGraph.inferred')}</Tag>
                  )}
                </div>
                <Button
                  type="text" size="small" danger icon={<DeleteOutlined />}
                  onClick={() => handleDelete(idx)}
                />
              </List.Item>
            );
          }}
        />
      </div>

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

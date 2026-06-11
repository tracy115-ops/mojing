// ============================================================================
// Character Relation Graph — ECharts force-directed graph
// PlotPilot-inspired interactive visualization with importance coloring
// ============================================================================

import React, { useMemo, useState, useCallback } from 'react';
import { Typography, Tag, Space, Empty, Badge, Drawer, Card, Button } from 'antd';
import {
  TeamOutlined, ZoomInOutlined, ZoomOutOutlined, FullscreenOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { BibleCharacter, RelationshipTriple } from '@/types/narrative';
import { useChartTheme, chartTooltipStyle, chartLegendStyle } from '@/hooks/useChartTheme';

const { Text } = Typography;

interface CharacterRelationGraphProps {
  novelId: string;
}

const IMPORTANCE_COLOR: Record<string, string> = {
  protagonist: '#ef4444',
  major: '#f59e0b',
  supporting: '#3b82f6',
  minor: '#9ca3af',
};

const IMPORTANCE_SIZE: Record<string, number> = {
  protagonist: 50,
  major: 40,
  supporting: 30,
  minor: 22,
};

const PREDICATE_COLOR: Record<string, string> = {
  '恋人': '#ec4899', '夫妻': '#ec4899', '朋友': '#22c55e', '盟友': '#22c55e',
  '敌对': '#ef4444', '仇人': '#ef4444', '死敌': '#ef4444', '对手': '#f97316',
  '师傅': '#8b5cf6', '师父': '#8b5cf6', '徒弟': '#8b5cf6', '弟子': '#8b5cf6',
  '父亲': '#06b6d4', '母亲': '#06b6d4', '兄弟': '#06b6d4', '姐妹': '#06b6d4',
};

function getEdgeColor(predicate: string): string {
  for (const [key, color] of Object.entries(PREDICATE_COLOR)) {
    if (predicate.includes(key)) return color;
  }
  return '#6b7280';
}

const CharacterRelationGraph: React.FC<CharacterRelationGraphProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const chartTheme = useChartTheme();
  const [selectedChar, setSelectedChar] = useState<BibleCharacter | null>(null);
  const [echartRef, setEchartRef] = useState<ReactECharts | null>(null);

  const repo = useMemo(() => new NarrativeRepository(novelId), [novelId]);

  const { characters, triples, charSet } = useMemo(() => {
    const bible = repo.loadBible();
    const allTriples = repo.loadTriples();
    const charNames = new Set(bible.characters.map((c) => c.name));
    const charTriples = allTriples.filter(
      (tr) => charNames.has(tr.subject) && charNames.has(tr.object),
    );

    // Also extract relationships from Bible character data
    const bibleTriples: RelationshipTriple[] = [];
    const charNameToId = new Map(bible.characters.map((c) => [c.id, c.name]));
    for (const char of bible.characters) {
      for (const rel of char.relationships) {
        const targetName = charNameToId.get(rel.targetCharacterId) || rel.targetCharacterId;
        if (charNames.has(targetName)) {
          bibleTriples.push({
            subject: char.name,
            predicate: rel.type,
            object: targetName,
            sinceChapter: rel.sinceChapter,
            source: 'bible',
          });
        }
      }
    }

    // Merge: deduplicate by subject+predicate+object
    const allLinks = [...charTriples];
    const existingKeys = new Set(charTriples.map((t) => `${t.subject}|${t.predicate}|${t.object}`));
    for (const bt of bibleTriples) {
      const key = `${bt.subject}|${bt.predicate}|${bt.object}`;
      if (!existingKeys.has(key)) {
        allLinks.push(bt);
        existingKeys.add(key);
      }
    }

    return { characters: bible.characters, triples: allLinks, charSet: charNames };
  }, [repo]);

  const relatedTriples = useMemo(() => {
    if (!selectedChar) return [];
    return triples.filter((tr) => tr.subject === selectedChar.name || tr.object === selectedChar.name);
  }, [selectedChar, triples]);

  const option = useMemo(() => {
    // Show graph if we have characters (even without relationships)
    if (characters.length === 0) return null;

    const activeNames = new Set<string>();
    for (const tr of triples) {
      activeNames.add(tr.subject);
      activeNames.add(tr.object);
    }
    // If no triples, include all characters as standalone nodes
    if (activeNames.size === 0) {
      for (const c of characters) {
        activeNames.add(c.name);
      }
    } else {
      // Also add characters that have no triples but exist in Bible
      for (const c of characters) {
        activeNames.add(c.name);
      }
    }

    const charMap = new Map(characters.map((c) => [c.name, c]));

    const nodes = Array.from(activeNames).map((name) => {
      const char = charMap.get(name);
      const importance = char?.importance || 'supporting';
      return {
        id: name,
        name,
        symbolSize: IMPORTANCE_SIZE[importance],
        itemStyle: {
          color: IMPORTANCE_COLOR[importance],
          borderColor: '#fff',
          borderWidth: 2,
          shadowBlur: 8,
          shadowColor: IMPORTANCE_COLOR[importance] + '40',
        },
        label: {
          show: true,
          fontSize: importance === 'protagonist' ? 13 : importance === 'major' ? 12 : 11,
          fontWeight: importance === 'protagonist' ? 'bold' : 'normal',
          color: chartTheme.textPrimary,
        },
        category: importance,
        value: importance === 'protagonist' ? 4 : importance === 'major' ? 3 : importance === 'supporting' ? 2 : 1,
      };
    });

    const links = triples.map((tr, i) => ({
      source: tr.subject,
      target: tr.object,
      value: tr.predicate,
      lineStyle: {
        color: getEdgeColor(tr.predicate),
        width: 1.5,
        curveness: 0.15,
        opacity: 0.7,
      },
      label: {
        show: true,
        formatter: tr.predicate,
        fontSize: 10,
        color: chartTheme.textSecondary,
        backgroundColor: chartTheme.bgPrimary + 'dd',
        padding: [2, 4],
        borderRadius: 3,
      },
      emphasis: {
        lineStyle: { width: 3, opacity: 1 },
        label: { fontSize: 12, fontWeight: 'bold' },
      },
    }));

    const categories = [
      { name: t('bible.importance.protagonist'), itemStyle: { color: '#ef4444' } },
      { name: t('bible.importance.major'), itemStyle: { color: '#f59e0b' } },
      { name: t('bible.importance.supporting'), itemStyle: { color: '#3b82f6' } },
      { name: t('bible.importance.minor'), itemStyle: { color: '#9ca3af' } },
    ];

    return {
      tooltip: {
        trigger: 'item',
        ...chartTooltipStyle(chartTheme),
        formatter: (params: any) => {
          if (params.dataType === 'node') {
            const char = charMap.get(params.name);
            const imp = char?.importance || 'supporting';
            const desc = char?.description?.slice(0, 80) || '';
            return `<b>${params.name}</b><br/>` +
              `<span style="color:${IMPORTANCE_COLOR[imp]}">${t('bible.importance.' + imp) || imp}</span>` +
              (desc ? `<br/><span style="color:#888;font-size:11px">${desc}…</span>` : '');
          }
          if (params.dataType === 'edge') {
            return `${params.data.source} → <b>${params.data.value}</b> → ${params.data.target}`;
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
        animationDuration: 800,
        animationEasingUpdate: 'quinticInOut',
        data: nodes,
        links,
        categories,
        roam: true,
        draggable: true,
        force: {
          repulsion: 400,
          gravity: 0.08,
          edgeLength: [80, 200],
          layoutAnimation: true,
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: 3 },
        },
        blur: {
          itemStyle: { opacity: 0.2 },
          lineStyle: { opacity: 0.1 },
        },
        selectedMode: 'single',
        select: {
          itemStyle: { borderWidth: 3, borderColor: '#3b82f6' },
        },
      }],
    };
  }, [characters, triples, chartTheme, t]);

  const handleChartClick = useCallback((params: any) => {
    if (params.dataType === 'node') {
      const char = characters.find((c) => c.name === params.name);
      setSelectedChar(char ?? null);
    }
  }, [characters]);

  const handleResetZoom = useCallback(() => {
    const chart = echartRef?.getEchartsInstance();
    if (chart) {
      chart.dispatchAction({ type: 'restore' });
    }
  }, [echartRef]);

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        <span><TeamOutlined style={{ marginRight: 6 }} />{t('relationGraph.title')}</span>
        <Space size={4}>
          <Badge count={charSet.size} style={{ backgroundColor: '#3b82f6' }} />
          <Badge count={triples.length} style={{ backgroundColor: '#22c55e' }} />
          <Button size="small" icon={<FullscreenOutlined />} onClick={handleResetZoom} />
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {!option ? (
          <div style={{ padding: 40 }}>
            <Empty description={characters.length === 0 ? t('relationGraph.empty') : t('relationGraph.noData')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
                {t('bible.importance.' + selectedChar.importance) || selectedChar.importance}
              </Tag>
              <Tag>{selectedChar.status}</Tag>
            </div>
            {selectedChar.description && (
              <Card size="small" title={t('bible.characterPersonality')}>
                <Text style={{ fontSize: 12 }}>{selectedChar.description.slice(0, 200)}</Text>
              </Card>
            )}
            {selectedChar.personality && (
              <Card size="small" title={t('bible.characterPersonality')}>
                <Text style={{ fontSize: 12 }}>{selectedChar.personality}</Text>
              </Card>
            )}
            {relatedTriples.length > 0 && (
              <Card size="small" title={t('bible.characterRelationships')}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {relatedTriples.map((tr, i) => (
                    <div key={i} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Tag color="blue" style={{ fontSize: 9, margin: 0 }}>{tr.subject}</Tag>
                      <span style={{ color: getEdgeColor(tr.predicate), fontWeight: 500 }}>{tr.predicate}</span>
                      <Tag color="green" style={{ fontSize: 9, margin: 0 }}>{tr.object}</Tag>
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

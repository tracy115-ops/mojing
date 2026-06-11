// ============================================================================
// Cast Panel — Chapter-level character locking & coverage analysis
// Shows which Bible characters appear in which chapters
// Coverage is auto-derived from chapter content (name matching)
// Cast lock lets users manually pin characters to chapters
// ============================================================================

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Button, Space, Tag, Empty, Table, Badge, message, Tabs, Tooltip, Alert,
} from 'antd';
import { TeamOutlined, LockOutlined, UnlockOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { BibleCharacter, ChapterCast } from '@/types/narrative';

interface CastPanelProps {
  novelId: string;
  totalChapters: number;
  currentChapter: number;
}

const importanceColor: Record<string, string> = {
  protagonist: 'red',
  major: 'orange',
  supporting: 'blue',
  minor: 'default',
};

const CastPanel: React.FC<CastPanelProps> = ({ novelId, totalChapters, currentChapter }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [characters, setCharacters] = useState<BibleCharacter[]>([]);
  const [casts, setCasts] = useState<ChapterCast[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number>(currentChapter);

  const projects = useProjectStore((s) => s.projects);
  const getStoryNodes = useProjectStore((s) => s.getStoryNodes);

  const refresh = useCallback(() => {
    setCharacters(repo.getCharacters());
    setCasts(repo.loadChapterCasts());
  }, [repo]);

  useEffect(() => { refresh(); }, [refresh]);

  // Get all chapter contents for coverage analysis
  const chapterContents = useMemo(() => {
    const proj = projects.find((p) => p.id === novelId);
    if (!proj || proj.type !== 'novel') return [] as string[];

    const nodes = getStoryNodes(novelId);
    const chapterNodes = nodes
      .filter((n) => n.nodeType === 'chapter')
      .sort((a, b) => a.order - b.order);
    return chapterNodes.map((n) => n.content ?? '');
  }, [projects, novelId, getStoryNodes]);

  // Build a name→charId lookup (including aliases)
  const nameLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of characters) {
      map.set(c.name, c.id);
      for (const alias of (c.aliases ?? [])) {
        map.set(alias, c.id);
      }
    }
    return map;
  }, [characters]);

  // Auto-detect which characters appear in each chapter based on content
  const autoDetectedPresence = useMemo(() => {
    const result: Map<number, Set<string>> = new Map();
    for (let i = 0; i < chapterContents.length; i++) {
      const content = chapterContents[i];
      if (!content) continue;
      const found = new Set<string>();
      for (const [name, charId] of nameLookup) {
        if (content.includes(name)) {
          found.add(charId);
        }
      }
      result.set(i, found);
    }
    return result;
  }, [chapterContents, nameLookup]);

  const currentCast = useMemo(
    () => casts.find((c) => c.chapterIndex === selectedChapter),
    [casts, selectedChapter],
  );

  const lockedIds = useMemo(() => {
    if (!currentCast) return new Set<string>();
    return new Set(currentCast.lockedCharacters);
  }, [currentCast]);

  const toggleLock = (charId: string) => {
    const existing = currentCast?.lockedCharacters ?? [];
    const updated = existing.includes(charId)
      ? existing.filter((id) => id !== charId)
      : [...existing, charId];

    const cast: ChapterCast = { chapterIndex: selectedChapter, lockedCharacters: updated };
    repo.upsertChapterCast(cast);
    refresh();
    message.success(t('common.saved'));
  };

  // Coverage analysis: combine auto-detected + manually locked
  const coverage = useMemo(() => {
    const map = new Map<string, number>();
    const total = Math.max(totalChapters, chapterContents.length);

    for (const [chapterIdx, presentChars] of autoDetectedPresence) {
      for (const charId of presentChars) {
        map.set(charId, (map.get(charId) ?? 0) + 1);
      }
    }
    // Also count manually locked characters
    for (const cast of casts) {
      for (const charId of cast.lockedCharacters) {
        if (!autoDetectedPresence.get(cast.chapterIndex)?.has(charId)) {
          map.set(charId, (map.get(charId) ?? 0) + 1);
        }
      }
    }

    return characters.map((c) => ({
      id: c.id,
      name: c.name,
      importance: c.importance,
      chapters: map.get(c.id) ?? 0,
      coverage: total > 0 ? Math.round(((map.get(c.id) ?? 0) / total) * 100) : 0,
    }));
  }, [characters, autoDetectedPresence, casts, totalChapters, chapterContents.length]);

  const chapterOptions = Array.from({ length: Math.max(totalChapters, chapterContents.length) }, (_, i) => ({
    value: i,
    label: t('novel.chapterOrder', { order: i + 1 }),
  }));

  const isAutoDetected = (charId: string): boolean => {
    return autoDetectedPresence.get(selectedChapter)?.has(charId) ?? false;
  };

  const castLockTab = (
    <div>
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message={t('cast.autoDetectHint')}
        style={{ marginBottom: 8, fontSize: 11 }}
        banner
      />
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cast.selectChapter')}:</span>
        {chapterOptions.length > 0 ? (
          <select
            value={selectedChapter}
            onChange={(e) => setSelectedChapter(Number(e.target.value))}
            style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-secondary)' }}
          >
            {chapterOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cast.noChapters')}</span>
        )}
      </div>

      {characters.length === 0 ? (
        <Empty description={t('cast.noCharacters')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {characters.map((char) => {
            const isLocked = lockedIds.has(char.id);
            const isDetected = isAutoDetected(char.id);
            return (
              <div
                key={char.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '4px 8px', borderRadius: 4,
                  background: isLocked ? 'rgba(22,119,255,0.06)' : isDetected ? 'rgba(82,196,26,0.06)' : 'transparent',
                  border: isLocked ? '1px solid rgba(22,119,255,0.2)' : isDetected ? '1px solid rgba(82,196,26,0.2)' : '1px solid transparent',
                }}
              >
                <Space>
                  <Tag color={importanceColor[char.importance]} style={{ fontSize: 10 }}>
                    {t(`bible.importance.${char.importance}`)}
                  </Tag>
                  <span style={{ fontSize: 12 }}>{char.name}</span>
                  {isDetected && !isLocked && (
                    <Tag color="green" style={{ fontSize: 9 }}>{t('cast.autoDetected')}</Tag>
                  )}
                </Space>
                <Tooltip title={isLocked ? t('cast.unlock') : t('cast.lock')}>
                  <Button
                    type={isLocked ? 'primary' : 'text'}
                    size="small"
                    icon={isLocked ? <LockOutlined /> : <UnlockOutlined />}
                    onClick={() => toggleLock(char.id)}
                  />
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const coverageColumns = [
    {
      title: t('cast.charName'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: typeof coverage[0]) => (
        <Space>
          <Tag color={importanceColor[record.importance]} style={{ fontSize: 10 }}>
            {t(`bible.importance.${record.importance}`)}
          </Tag>
          <span>{name}</span>
        </Space>
      ),
    },
    {
      title: t('cast.chapterCount'),
      dataIndex: 'chapters',
      key: 'chapters',
      width: 80,
      render: (v: number) => <Badge count={v} style={{ backgroundColor: v > 0 ? '#52c41a' : '#d9d9d9' }} />,
    },
    {
      title: t('cast.coverageRate'),
      dataIndex: 'coverage',
      key: 'coverage',
      width: 100,
      render: (v: number) => (
        <div style={{ fontSize: 11 }}>
          <div style={{ width: '100%', height: 6, background: 'var(--bg-secondary)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(v, 100)}%`, height: '100%', background: v > 0 ? '#52c41a' : '#d9d9d9', borderRadius: 3 }} />
          </div>
          <span style={{ color: 'var(--text-secondary)' }}>{v}%</span>
        </div>
      ),
    },
  ];

  const coverageTab = (
    <Table
      dataSource={coverage}
      rowKey="id"
      columns={coverageColumns}
      size="small"
      pagination={false}
      locale={{ emptyText: <Empty description={t('cast.noCharacters')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
    />
  );

  const tabItems = [
    { key: 'cast', label: <span><LockOutlined /> {t('cast.castLock')}</span>, children: castLockTab },
    { key: 'coverage', label: <span><TeamOutlined /> {t('cast.coverage')}</span>, children: coverageTab },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 12px', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--border-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><TeamOutlined style={{ marginRight: 6 }} />{t('cast.title')}</span>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
        {characters.length === 0 ? (
          <div style={{ padding: 20 }}>
            <Empty description={t('cast.noCharacters')} image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Button type="primary" size="small" onClick={() => message.info(t('cast.gotoBible'))}>
                {t('cast.gotoBible')}
              </Button>
            </Empty>
          </div>
        ) : (
          <Tabs items={tabItems} size="small" />
        )}
      </div>
    </div>
  );
};

export default CastPanel;

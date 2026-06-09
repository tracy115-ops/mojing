// ============================================================================
// Cast Panel — Chapter-level character locking & coverage analysis
// Shows which Bible characters are locked to appear in which chapters
// ============================================================================

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Card, Select, Button, Space, Tag, Empty, Table, Badge, message, Tabs, Tooltip,
} from 'antd';
import { TeamOutlined, LockOutlined, UnlockOutlined, UserOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import type { BibleCharacter, ChapterCast } from '@/types/narrative';

interface CastPanelProps {
  novelId: string;
  totalChapters: number;
}

const importanceColor: Record<string, string> = {
  protagonist: 'red',
  major: 'orange',
  supporting: 'blue',
  minor: 'default',
};

const CastPanel: React.FC<CastPanelProps> = ({ novelId, totalChapters }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [characters, setCharacters] = useState<BibleCharacter[]>([]);
  const [casts, setCasts] = useState<ChapterCast[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number>(0);

  const refresh = useCallback(() => {
    setCharacters(repo.getCharacters());
    setCasts(repo.loadChapterCasts());
  }, [repo]);

  useEffect(() => { refresh(); }, [refresh]);

  const currentCast = useMemo(
    () => casts.find((c) => c.chapterIndex === selectedChapter),
    [casts, selectedChapter],
  );

  const lockedNames = useMemo(() => {
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

  // Coverage analysis: how many chapters each character appears in
  const coverage = useMemo(() => {
    const map = new Map<string, number>();
    for (const cast of casts) {
      for (const charId of cast.lockedCharacters) {
        map.set(charId, (map.get(charId) ?? 0) + 1);
      }
    }
    return characters.map((c) => ({
      id: c.id,
      name: c.name,
      importance: c.importance,
      chapters: map.get(c.id) ?? 0,
      coverage: totalChapters > 0 ? Math.round(((map.get(c.id) ?? 0) / totalChapters) * 100) : 0,
    }));
  }, [characters, casts, totalChapters]);

  const chapterOptions = Array.from({ length: totalChapters }, (_, i) => ({
    value: i,
    label: t('novel.chapterOrder', { order: i + 1 }),
  }));

  const castLockTab = (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cast.selectChapter')}:</span>
        {chapterOptions.length > 0 ? (
          <Select
            value={selectedChapter}
            onChange={setSelectedChapter}
            options={chapterOptions}
            style={{ width: 160 }}
            size="small"
          />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('cast.noChapters')}</span>
        )}
      </div>

      {characters.length === 0 ? (
        <Empty description={t('cast.noCharacters')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {characters.map((char) => {
            const isLocked = lockedNames.has(char.id);
            return (
              <div
                key={char.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '4px 8px', borderRadius: 4,
                  background: isLocked ? 'rgba(22,119,255,0.06)' : 'transparent',
                  border: isLocked ? '1px solid rgba(22,119,255,0.2)' : '1px solid transparent',
                }}
              >
                <Space>
                  <Tag color={importanceColor[char.importance]} style={{ fontSize: 10 }}>
                    {t(`bible.importance.${char.importance}`)}
                  </Tag>
                  <span style={{ fontSize: 12 }}>{char.name}</span>
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

import React, { useMemo } from 'react';
import { Card, Empty, Tag, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import { ClicheScanner } from '@/services/novel/cliche-scanner';
import { getNovelChapters } from '@/services/novel/writing-context';
import type { NovelMetadata } from '@/types';

const { Text } = Typography;

// This is a local phrase concordance. It does not identify authorship or grade prose.
const AntiAIDashboard: React.FC<{ novelId: string; chapterIndex: number }> = ({ novelId, chapterIndex }) => {
  const { t } = useTranslation();
  const project = useProjectStore(s => s.projects.find(p => p.id === novelId));
  const chapter = project?.type === 'novel' ? getNovelChapters(project.metadata as NovelMetadata).find(c => c.order === chapterIndex) : undefined;
  const content = chapter?.content || '';
  const hits = useMemo(() => ClicheScanner.scan(content).filter(hit => hit.count > 1).sort((a, b) => b.count - a.count), [content]);
  return (
    <div data-testid="phrase-concordance" style={{ height: '100%', overflow: 'auto', padding: 12 }}>
      <Text strong>{t('workbench.phrases.title')}</Text>
      <p>{t('novel.chapterOrder', { order: chapterIndex + 1 })} · {chapter?.title}</p>
      <p><Text type="secondary">{t('workbench.phrases.hint')}</Text></p>
      {!content.trim() ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workbench.manuscript.empty')} />
        : !hits.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workbench.phrases.empty')} />
        : hits.map(hit => (
          <Card size="small" key={hit.id} style={{ marginBottom: 8 }} title={<span>{hit.label} <Tag>{t('workbench.phrases.count', { count: hit.count })}</Tag></span>}>
            {hit.positions.map((position, i) => (
              <blockquote key={position} style={{ margin: '8px 0', paddingLeft: 8, borderLeft: '2px solid var(--border-base)', whiteSpace: 'pre-wrap' }}>
                <Text type="secondary">{i + 1}. </Text>{content.slice(Math.max(0, position - 45), Math.min(content.length, position + 90))}
              </blockquote>
            ))}
          </Card>
        ))}
    </div>
  );
};
export default AntiAIDashboard;

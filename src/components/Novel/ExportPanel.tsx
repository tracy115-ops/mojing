// ============================================================================
// Export Panel — Simple inline panel (no modal to avoid webview freeze)
// ============================================================================

import React, { useState } from 'react';
import { Radio, Space, Typography, Button, message } from 'antd';
import { DownloadOutlined, FileTextOutlined, CloseOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { ExportService, type ExportFormat } from '@/services/novel/export-service';
import type { NovelChapter } from '@/types';

const { Text } = Typography;

interface ExportPanelProps {
  onClose: () => void;
  title: string;
  chapters: NovelChapter[];
}

const ExportPanel: React.FC<ExportPanelProps> = ({ onClose, title, chapters }) => {
  const { t } = useTranslation();

  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [exporting, setExporting] = useState(false);

  const contentChapters = chapters.filter((c) => c.content);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await ExportService.exportToFile({ title, chapters, format });

      if (result.success) {
        message.success(t('export.success', {
          count: result.chapterCount,
          words: result.wordCount.toLocaleString(),
        }));
        onClose();
      } else if (result.error !== 'Export cancelled') {
        message.error(result.error || t('export.failed'));
      }
    } catch {
      message.error(t('export.failed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      right: 16,
      bottom: 48,
      width: 360,
      background: 'var(--bg-primary, #fff)',
      border: '1px solid var(--border-secondary)',
      borderRadius: 8,
      boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
      padding: 16,
      zIndex: 12000,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text strong style={{ fontSize: 14 }}>
          <DownloadOutlined style={{ marginRight: 8 }} />
          {t('export.title')}
        </Text>
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
      </div>

      <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)} style={{ marginBottom: 12 }}>
        <Space direction="vertical">
          <Radio value="markdown"><FileTextOutlined /> Markdown (.md)</Radio>
          <Radio value="html"><FileTextOutlined /> HTML (.html)</Radio>
          <Radio value="txt"><FileTextOutlined /> TXT (.txt)</Radio>
        </Space>
      </Radio.Group>

      <div style={{
        padding: '6px 10px', borderRadius: 4, marginBottom: 12,
        background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        border: '1px solid var(--border-secondary)',
      }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('export.stats', {
            chapters: contentChapters.length,
            words: contentChapters.reduce((s, c) => s + c.wordCount, 0).toLocaleString(),
          })}
        </Text>
      </div>

      <Button
        type="primary"
        icon={<DownloadOutlined />}
        loading={exporting}
        onClick={handleExport}
        block
        disabled={contentChapters.length === 0}
      >
        {t('export.button')}
      </Button>
    </div>
  );
};

export default ExportPanel;

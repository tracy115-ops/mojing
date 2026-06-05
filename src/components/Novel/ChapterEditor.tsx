import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Input, Button, Space, Tabs, message, Tooltip, Typography } from 'antd';
import { ThunderboltOutlined, SaveOutlined, FileTextOutlined, AlignLeftOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import type { NovelChapter } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';

const { Text } = Typography;

const FONT_SIZE_KEY = 'mojing-editor-fontsize';
const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 28;

function loadFontSize(): number {
  try { return Number(localStorage.getItem(FONT_SIZE_KEY)) || DEFAULT_FONT_SIZE; } catch { return DEFAULT_FONT_SIZE; }
}
function saveFontSize(s: number) { try { localStorage.setItem(FONT_SIZE_KEY, String(s)); } catch {} }

interface ChapterEditorProps {
  chapter: NovelChapter;
  onUpdate: (updates: Partial<NovelChapter>) => void;
  allChapters: NovelChapter[];
  novelTitle: string;
}

const ChapterEditor: React.FC<ChapterEditorProps> = ({ chapter, onUpdate, allChapters, novelTitle }) => {
  const { t } = useTranslation();
  const [generating, setGenerating] = useState<string | null>(null);
  const [streamContent, setStreamContent] = useState('');
  const [fontSize, setFontSize] = useState(loadFontSize);
  const abortRef = useRef<AbortController | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endpoints = useProviderStore((s) => s.endpoints);

  const hasEndpoint = endpoints.length > 0;

  const handleZoom = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prev + delta));
      saveFontSize(next);
      return next;
    });
  }, []);

  // Auto-save with debounce
  const debouncedSave = useCallback((field: 'outline' | 'content', value: string) => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      onUpdate({ [field]: value });
    }, 1500);
  }, [onUpdate]);

  useEffect(() => {
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, []);

  const handleGenerateOutline = async () => {
    if (!hasEndpoint) {
      message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint'));
      return;
    }

    setGenerating('outline');
    try {
      const prevChapters = allChapters
        .filter((c) => c.order < chapter.order && c.content)
        .slice(-3)
        .map((c) => `第${c.order + 1}章 ${c.title}: ${c.outline}`)
        .join('\n');

      const request: LLMGenerateRequest = {
        taskType: 'planning',
        systemPrompt: `你是一个专业的小说大纲规划师。根据已有章节信息，为当前章节生成详细大纲。
大纲应包含：场景设定、主要事件、人物行动、情绪走向、关键对话要点。
小说名称：${novelTitle}`,
        userPrompt: `${prevChapters ? `前几章摘要：\n${prevChapters}\n\n` : ''}请为第${chapter.order + 1}章 "${chapter.title}" 生成详细大纲。`,
        temperature: 0.8,
        maxTokens: 1024,
      };

      const response = await providerRouter.generate(request);
      onUpdate({ outline: response.content, status: 'drafting' });
      message.success(t('common.success'));
    } catch (err) {
      message.error(`${t('common.failed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(null);
    }
  };

  const handleGenerateContent = async () => {
    if (!hasEndpoint) {
      message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint'));
      return;
    }

    if (!chapter.outline) {
      message.warning(t('novel.outline') + ' — ' + t('novel.empty'));
      return;
    }

    setGenerating('content');
    setStreamContent('');
    abortRef.current = new AbortController();

    try {
      const prevSummary = allChapters
        .filter((c) => c.order < chapter.order && c.content)
        .slice(-1)
        .map((c) => c.content.slice(-500))
        .join('\n');

      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt: `你是一个优秀的小说作家。根据大纲写出精彩的章节正文。
要求：
- 文笔流畅，描写生动
- 对话自然，符合人物性格
- 情节紧凑，有张力
- 字数 2000-4000 字
小说名称：${novelTitle}`,
        userPrompt: `${prevSummary ? `上一章结尾：\n${prevSummary}\n\n` : ''}大纲：\n${chapter.outline}\n\n请写出第${chapter.order + 1}章 "${chapter.title}" 的正文。`,
        temperature: 0.85,
        maxTokens: 4096,
      };

      let fullContent = '';

      for await (const chunk of providerRouter.stream(request)) {
        if (abortRef.current?.signal.aborted) break;
        fullContent += chunk.delta;
        setStreamContent(fullContent);
      }

      if (fullContent) {
        onUpdate({ content: fullContent, status: 'drafting', wordCount: fullContent.length });
        setStreamContent('');
        message.success(t('common.success'));
      }
    } catch (err) {
      if (!abortRef.current?.signal.aborted) {
        message.error(`${t('common.failed')}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setGenerating(null);
      abortRef.current = null;
    }
  };

  const handleStopGeneration = () => {
    abortRef.current?.abort();
    if (streamContent) {
      onUpdate({ content: streamContent, status: 'drafting' });
      setStreamContent('');
    }
    setGenerating(null);
  };

  const wordCount = streamContent || chapter.content || '';
  const wc = wordCount.length;

  const textareaStyle: React.CSSProperties = {
    fontSize,
    lineHeight: 1.8,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Chapter title + zoom controls */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          value={chapter.title}
          onChange={(e) => { onUpdate({ title: e.target.value }); }}
          placeholder={t('novel.chapterTitle')}
          variant="borderless"
          style={{ flex: 1, fontSize: 15, fontWeight: 600, padding: '4px 0' }}
        />
        <Space size={2}>
          <Tooltip title={t('editor.zoomOut')}>
            <Button size="small" icon={<ZoomOutOutlined />} onClick={() => handleZoom(-1)} disabled={fontSize <= MIN_FONT_SIZE} />
          </Tooltip>
          <Text style={{ fontSize: 11, minWidth: 28, textAlign: 'center', color: 'var(--text-tertiary)' }}>{fontSize}px</Text>
          <Tooltip title={t('editor.zoomIn')}>
            <Button size="small" icon={<ZoomInOutlined />} onClick={() => handleZoom(1)} disabled={fontSize >= MAX_FONT_SIZE} />
          </Tooltip>
        </Space>
      </div>

      {/* Tabs: outline / content */}
      <Tabs
        size="small"
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        items={[
          {
            key: 'outline',
            label: <span><AlignLeftOutlined /> {t('novel.outline')}</span>,
            children: (
              <div style={{ padding: '0 12px', height: '100%' }}>
                <Input.TextArea
                  value={chapter.outline}
                  onChange={(e) => debouncedSave('outline', e.target.value)}
                  placeholder={t("novel.outlinePlaceholder")}
                  style={{ height: 'calc(100% - 40px)', resize: 'vertical', ...textareaStyle }}
                  disabled={generating === 'outline'}
                />
                <div style={{ marginTop: 8 }}>
                  <Button
                    icon={<ThunderboltOutlined />}
                    onClick={handleGenerateOutline}
                    loading={generating === 'outline'}
                    size="small"
                    type="primary"
                    ghost
                  >
                    {t('novel.generate') + ' ' + t('novel.outline')}
                  </Button>
                </div>
              </div>
            ),
          },
          {
            key: 'content',
            label: <span><FileTextOutlined /> {t('novel.draft')}</span>,
            children: (
              <div style={{ padding: '0 12px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                <Input.TextArea
                  value={streamContent || chapter.content}
                  onChange={(e) => { if (!generating) debouncedSave('content', e.target.value); }}
                  placeholder={t("novel.contentPlaceholder")}
                  style={{ flex: 1, resize: 'vertical', minHeight: 300, ...textareaStyle }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('novel.wordCount', { count: wc.toLocaleString() })}</Text>
                  <Space>
                    {generating === 'content' ? (
                      <Button size="small" danger onClick={handleStopGeneration}>
                        {t('novel.stopGeneration')}
                      </Button>
                    ) : (
                      <Button
                        icon={<ThunderboltOutlined />}
                        onClick={handleGenerateContent}
                        loading={generating === 'content'}
                        size="small"
                        type="primary"
                      >
                        {t('novel.generate')}
                      </Button>
                    )}
                    <Tooltip title={t('common.save')}>
                      <Button
                        icon={<SaveOutlined />}
                        size="small"
                        onClick={() => {
                          onUpdate({
                            content: streamContent || chapter.content,
                            wordCount: (streamContent || chapter.content).length,
                          });
                          message.success(t('message.saved'));
                        }}
                      >
                        {t('common.save')}
                      </Button>
                    </Tooltip>
                  </Space>
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};

export default ChapterEditor;

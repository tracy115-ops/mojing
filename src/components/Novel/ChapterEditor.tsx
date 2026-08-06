import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Input, Button, Space, Tabs, message, Tooltip, Typography, Dropdown, Modal, Select } from 'antd';
import {
  ThunderboltOutlined, SaveOutlined, FileTextOutlined, AlignLeftOutlined,
  ZoomInOutlined, ZoomOutOutlined, LineChartOutlined, ExperimentOutlined,
  ReloadOutlined, ExpandOutlined, FormatPainterOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
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
  const [tensionScore, setTensionScore] = useState<number | null>(null);
  const [showOutlineRef, setShowOutlineRef] = useState(true);
  const [editingRef, setEditingRef] = useState(false);
  const [refText, setRefText] = useState(chapter.outline ?? '');
  const [novelGenre, setNovelGenre] = useState<string>('xuanhuan');
  const [novelPOV, setNovelPOV] = useState<string>('third_person');
  const [novelPacing, setNovelPacing] = useState<string>('standard');
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

  // Sync outline ref text when chapter changes
  useEffect(() => {
    setRefText(chapter.outline ?? '');
    setEditingRef(false);
  }, [chapter.id, chapter.outline]);

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

      const genrePrompts: Record<string, string> = {
        xuanhuan: '玄幻热血风格：强调气场压迫感、招式光影、境界突破的震撼细节，动作打斗干净利落，充满爽点。',
        urban_romance: '都市细腻风格：强调人物眼神拉扯、微表情、心理活动与柔光氛围感，台词带有潜台词。',
        suspense: '悬疑冷酷风格：强调冷色调环境描摹、细节伏笔、心理压迫感与出人意料的反转。',
        cyberpunk: '赛博朋克风格：强调霓虹霓影、机械质感、高科技低生活氛围与冷峻叙事。',
        wuxia: '古风武侠风格：强调诗意环境描摹、侠义风骨、招式意境与古风用词韵味。',
      };

      const styleGuide = genrePrompts[novelGenre] ?? genrePrompts.xuanhuan;
      const povGuide = novelPOV === 'first_person' ? '使用第一人称("我")沉浸式叙述。' : '使用第三人称全知视角叙述。';
      const pacingGuide =
        novelPacing === 'climax' ? '高潮爆发节奏：动作紧凑，单句篇幅简练，制造极强剧情张力与爽点。' :
        novelPacing === 'buildup' ? '铺垫蓄力节奏：注重环境细节烘托、眼神心理描写，为后续冲突蓄势。' :
        '标准叙事节奏：张弛有度，情节与描写交替推进。';

      const systemPrompt = `你是一位顶尖的大神级网络小说作家。请根据大纲创作文学品质极高、极具吸引力的章节正文。

【流派文风指导】：${styleGuide}
【叙事视角】：${povGuide}
【叙事节奏】：${pacingGuide}

【顶级写作与反 AI 规则（必须严格遵守）】：
1. 严禁出现“首先...其次...总而言之”等机械连接词。
2. 严禁在章节结尾写空洞的鸡汤感升华总结（如“这一刻他明白了生活的真谛”），直接停留在具体的情节动作或悬念留白处。
3. 拒绝平铺直叙，对话中必须插入人物神态、无意识动作或心理活动潜台词（如“他压低眼帘，指尖捏紧杯沿”）。
4. 语言要富有画面感与镜头感，拒绝假大空的修饰词。
5. 目标字数：2500 - 4500 字。

小说名称：《${novelTitle}》`;

      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt,
        userPrompt: `${prevSummary ? `上一章结尾接续：\n${prevSummary}\n\n` : ''}本章大纲：\n${chapter.outline}\n\n请开始创作第${chapter.order + 1}章 "${chapter.title}" 的精彩正文：`,
        temperature: 0.88,
        maxTokens: 6000,
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

  // --- AI Rewrite / Polish / Expand / Summarize ---

  const handleAITool = async (mode: 'rewrite' | 'polish' | 'expand' | 'summarize' | 'consistency_check') => {
    if (!hasEndpoint) {
      message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint'));
      return;
    }

    const content = streamContent || chapter.content;
    if (!content || content.length < 20) {
      message.warning(t('editor.noContent'));
      return;
    }

    setGenerating(mode);
    try {
      const prompts: Record<string, { system: string; user: string }> = {
        rewrite: {
          system: '你是一位小说编辑。请重写以下段落，保持核心情节不变，但使用不同的表达方式，使文笔更加优美流畅。',
          user: `请重写以下段落：\n\n${content.slice(0, 3000)}`,
        },
        polish: {
          system: '你是一位资深文字编辑。请润色以下文本，修复语法问题，提升文笔质量，减少重复和冗余表达。只输出润色后的文本。',
          user: `请润色以下文本：\n\n${content.slice(0, 4000)}`,
        },
        expand: {
          system: '你是一位小说家。请在保持原有内容和风格的基础上，适当扩展以下段落的细节描写（如环境、心理、动作），增加约30%的篇幅。只输出扩展后的文本。',
          user: `请扩展以下段落的细节描写：\n\n${content.slice(0, 3000)}`,
        },
        summarize: {
          system: '你是一位小说编辑助手。请为以下章节内容生成摘要，包含：核心事件、角色行动、情感走向。100-200字。',
          user: `请总结以下章节：\n\n${content.slice(0, 6000)}`,
        },
        consistency_check: {
          system: '你是一位严苛的小说主编。请针对以下小说文本进行【剧情逻辑、角色人设一致性、伏笔闭环】的质检，给出综合评分（100分制），并列出可能存在的吃书/逻辑冲突/细节漏洞。格式要清晰明了。',
          user: `小说名称：《${novelTitle}》\n章节：${chapter.title}\n大纲：${chapter.outline ?? '无'}\n正文内容：\n${content.slice(0, 5000)}`,
        },
      };

      const { system, user } = prompts[mode as keyof typeof prompts];
      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt: system,
        userPrompt: user,
        temperature: mode === 'rewrite' ? 0.8 : 0.3,
        maxTokens: mode === 'expand' ? 6000 : mode === 'summarize' ? 500 : 4096,
      };

      const response = await providerRouter.generate(request);

      if (mode === 'summarize') {
        // Update outline with summary
        onUpdate({ outline: response.content });
        message.success(t('editor.summaryDone'));
      } else if (mode === 'consistency_check') {
        Modal.info({
          title: '🔍 AI 剧情逻辑与人设一致性质检报告',
          width: 680,
          content: (
            <div style={{ maxHeight: 450, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
              {response.content}
            </div>
          ),
          okText: '收到并优化',
        });
      } else {
        // Replace content with rewritten/polished/expanded version
        onUpdate({ content: response.content, wordCount: response.content.length });
        message.success(t('editor.rewriteDone'));
      }
    } catch (err) {
      message.error(`${t('common.failed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(null);
    }
  };

  // --- Tension Scoring (local heuristic) ---

  const handleTensionScore = () => {
    const content = streamContent || chapter.content;
    if (!content || content.length < 100) return;

    // Simple heuristic scoring based on content patterns
    let score = 5;
    const text = content;

    // Conflict indicators
    if (text.match(/冲突|对抗|争执|战斗|打斗|厮杀/g)) score += 1;
    if (text.match(/危险|威胁|紧急|崩溃|绝望/g)) score += 0.5;
    if (text.match(/惊讶|震惊|不可思议|难以置信/g)) score += 0.5;

    // Dialogue density (more dialogue = more tension)
    const dialogMatches = text.match(/[""][^""]*[""]|「[^」]*」/g);
    if (dialogMatches && dialogMatches.length > 5) score += 0.5;

    // Short sentences (pacing indicator)
    const shortSentences = text.split(/[。！？\n]/).filter((s) => s.length > 0 && s.length < 10);
    if (shortSentences.length > text.split(/[。！？\n]/).length * 0.3) score += 0.5;

    // Suspense keywords
    if (text.match(/秘密|隐藏|真相|谜团|不知|困惑/g)) score += 0.5;

    score = Math.min(10, Math.max(0, Math.round(score * 10) / 10));
    setTensionScore(score);
    message.info(`${t('tension.score')}: ${score}/10`);
  };

  const wordCount = streamContent || chapter.content || '';
  const wc = wordCount.length;

  const textareaStyle: React.CSSProperties = {
    fontSize,
    lineHeight: 1.8,
  };

  const aiToolItems = [
    {
      key: 'polish',
      icon: <FormatPainterOutlined />,
      label: t('editor.aiPolish'),
      onClick: () => handleAITool('polish'),
    },
    {
      key: 'rewrite',
      icon: <ReloadOutlined />,
      label: t('editor.aiRewrite'),
      onClick: () => handleAITool('rewrite'),
    },
    {
      key: 'expand',
      icon: <ExpandOutlined />,
      label: t('editor.aiExpand'),
      onClick: () => handleAITool('expand'),
    },
    {
      key: 'summarize',
      icon: <FileSearchOutlined />,
      label: t('editor.aiSummarize'),
      onClick: () => handleAITool('summarize'),
    },
    {
      key: 'consistency_check',
      icon: <FileSearchOutlined />,
      label: '🔍 AI 剧情与人设一致性检查',
      onClick: () => handleAITool('consistency_check'),
    },
  ];

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
                {/* Outline reference banner — collapsible */}
                {chapter.outline && (
                  <div style={{
                    marginBottom: 6, borderRadius: 6,
                    border: '1px solid var(--border-secondary)',
                    background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
                    overflow: 'hidden',
                  }}>
                    <div
                      onClick={() => setShowOutlineRef(!showOutlineRef)}
                      style={{
                        padding: '4px 10px', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', cursor: 'pointer',
                        fontSize: 11, color: 'var(--text-secondary)',
                        userSelect: 'none',
                      }}
                    >
                      <span><AlignLeftOutlined style={{ marginRight: 4 }} />{t('novel.outlineRef')}</span>
                      <span style={{ fontSize: 9 }}>{showOutlineRef ? '▲' : '▼'}</span>
                    </div>
                    {showOutlineRef && (
                      <div
                        onDoubleClick={() => { setEditingRef(true); setRefText(chapter.outline ?? ''); }}
                        style={{ padding: '0 10px 6px', fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)', maxHeight: 120, overflowY: 'auto' }}
                        title={t('novel.outlineRef.hint')}
                      >
                        {editingRef ? (
                          <Input.TextArea
                            value={refText}
                            onChange={(e) => setRefText(e.target.value)}
                            onBlur={() => { onUpdate({ outline: refText }); setEditingRef(false); }}
                            onPressEnter={(e) => { if (!e.shiftKey) { onUpdate({ outline: refText }); setEditingRef(false); } }}
                            autoSize={{ minRows: 2, maxRows: 6 }}
                            style={{ fontSize: 11 }}
                            autoFocus
                          />
                        ) : (
                          <div style={{ whiteSpace: 'pre-wrap' }}>{chapter.outline}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <Input.TextArea
                  value={streamContent || chapter.content}
                  onChange={(e) => { if (!generating) debouncedSave('content', e.target.value); }}
                  placeholder={t("novel.contentPlaceholder")}
                  style={{ flex: 1, resize: 'vertical', minHeight: 300, ...textareaStyle }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t('novel.wordCount', { count: wc.toLocaleString() })}</Text>
                    {tensionScore !== null && (
                      <Tooltip title={t('tension.score')}>
                        <Text style={{ fontSize: 12, color: tensionScore >= 7 ? '#22c55e' : tensionScore >= 4 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>
                          <LineChartOutlined /> {tensionScore}/10
                        </Text>
                      </Tooltip>
                    )}
                  </Space>
                  <Space>
                    {generating === 'content' ? (
                      <Button size="small" danger onClick={handleStopGeneration}>
                        {t('novel.stopGeneration')}
                      </Button>
                    ) : (
                      <>
                        <Select
                          size="small"
                          value={novelGenre}
                          onChange={(v) => setNovelGenre(v)}
                          style={{ width: 110 }}
                          options={[
                            { value: 'xuanhuan', label: '🔥 玄幻热血' },
                            { value: 'urban_romance', label: '🌸 都市细腻' },
                            { value: 'suspense', label: '🔍 悬疑反转' },
                            { value: 'cyberpunk', label: '⚡ 赛博朋克' },
                            { value: 'wuxia', label: '🏮 古风武侠' },
                          ]}
                        />
                        <Select
                          size="small"
                          value={novelPOV}
                          onChange={(v) => setNovelPOV(v)}
                          style={{ width: 90 }}
                          options={[
                            { value: 'third_person', label: '👁️ 第三人称' },
                            { value: 'first_person', label: '🙋 第一人称' },
                          ]}
                        />
                        <Button
                          size="small"
                          icon={<FormatPainterOutlined />}
                          loading={generating === 'polish'}
                          disabled={!chapter.content || generating !== null}
                          onClick={() => handleAITool('polish')}
                        >
                          {t('editor.aiPolish')}
                        </Button>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={generating === 'rewrite'}
                          disabled={!chapter.content || generating !== null}
                          onClick={() => handleAITool('rewrite')}
                        >
                          {t('editor.aiRewrite')}
                        </Button>
                        <Dropdown menu={{ items: aiToolItems }} trigger={['click']}>
                          <Button size="small" icon={<ExperimentOutlined />} loading={generating !== null}>
                            {t('editor.aiTools')}
                          </Button>
                        </Dropdown>
                        <Tooltip title={t('editor.tensionScore')}>
                          <Button
                            size="small"
                            icon={<LineChartOutlined />}
                            onClick={handleTensionScore}
                            disabled={!chapter.content}
                          />
                        </Tooltip>
                        <Button
                          icon={<ThunderboltOutlined />}
                          onClick={handleGenerateContent}
                          loading={generating === 'content'}
                          size="small"
                          type="primary"
                        >
                          {t('novel.generate')}
                        </Button>
                      </>
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

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Input, Button, Space, Tabs, message, Tooltip, Typography, Dropdown, Modal, Select, Checkbox, Tag } from 'antd';
import {
  ThunderboltOutlined, SaveOutlined, FileTextOutlined, AlignLeftOutlined,
  ZoomInOutlined, ZoomOutOutlined, ExperimentOutlined,
  ReloadOutlined, ExpandOutlined, FormatPainterOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { ChapterReviewer, type ChapterReviewReport } from '@/services/novel/chapter-reviewer';
import { NOVEL_WRITING_PRINCIPLES, textFingerprint, WRITING_REFERENCE_KEYS } from '@/services/novel/writing-context';
import { applyEditorialEdits, isReviewCurrent } from '@/services/novel/editorial-review';
import type { NovelChapter, NovelMetadata, CreativeProject } from '@/types';
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
  novel: CreativeProject;
}

const ChapterEditor: React.FC<ChapterEditorProps> = ({ chapter, onUpdate, allChapters, novel }) => {
  const { t } = useTranslation();
  const novelTitle = novel.title;
  const metadata = novel.metadata as NovelMetadata;
  const [generating, setGenerating] = useState<string | null>(null);
  const [streamContent, setStreamContent] = useState('');
  const [outlineDraft, setOutlineDraft] = useState(chapter.outline);
  const [contentDraft, setContentDraft] = useState(chapter.content);
  const [activeTab, setActiveTab] = useState(chapter.content.trim() ? 'content' : 'outline');
  const [, refreshReference] = useState(0);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const [reviewer] = useState(() => new ChapterReviewer(novel.id));
  const [review, setReview] = useState<ChapterReviewReport | null>(() => reviewer.loadHistory().find(r => r.chapter === chapter.order) ?? null);
  const [autoReview, setAutoReview] = useState(true);
  const [showOutlineRef, setShowOutlineRef] = useState(true);
  const [editingRef, setEditingRef] = useState(false);
  const [refText, setRefText] = useState(chapter.outline ?? '');
  const [novelGenre, setNovelGenre] = useState<string>(() => ({
    fantasy: 'xuanhuan', scifi: 'scifi', romance: 'urban_romance', mystery: 'suspense', literary: 'literary', wuxia: 'wuxia',
  }[metadata.genre] ?? metadata.genre ?? 'literary'));
  const [novelPOV, setNovelPOV] = useState<string>('third_person');
  const abortRef = useRef<AbortController | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<{ updates: Partial<NovelChapter>; save: typeof onUpdate } | null>(null);
  const endpoints = useProviderStore((s) => s.endpoints);
  const contentRef = useRef(contentDraft);
  contentRef.current = contentDraft;

  const hasEndpoint = endpoints.some(e => e.enabled && e.category === 'llm');

  const getReviewContext = () => ({
    source: { title: novelTitle, description: novel.description, genre: metadata.genre, style: metadata.style, language: metadata.language },
    chapters: allChapters, outline: outlineDraft,
  });
  const getNovelContext = () => reviewer.buildContext(chapter.order, getReviewContext(), 'writing');
  const reference = reviewer.buildContext(chapter.order, getReviewContext());
  const reviewContextRef = useRef(getReviewContext);
  reviewContextRef.current = getReviewContext;
  const currentReview = isReviewCurrent(review, contentDraft, reference) ? review : null;

  useEffect(() => new NarrativeRepository(novel.id).subscribe(WRITING_REFERENCE_KEYS, () => {
    setReview(reviewer.loadHistory().find(r => r.chapter === chapter.order) ?? null);
    refreshReference(value => value + 1);
  }), [novel.id, reviewer, chapter.order]);

  const handleZoom = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, prev + delta));
      saveFontSize(next);
      return next;
    });
  }, []);

  // Keep typing immediate; batch persistence and flush the original chapter on exit.
  const flushSave = useCallback(() => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    const pending = pendingSave.current;
    pendingSave.current = null;
    if (pending) pending.save(pending.updates);
  }, []);
  const debouncedSave = useCallback((field: 'outline' | 'content', value: string) => {
    if (field === 'outline') setOutlineDraft(value);
    else { setContentDraft(value); setStreamContent(''); }
    pendingSave.current = { save: onUpdate, updates: { ...pendingSave.current?.updates, [field]: value,
      ...(field === 'content' ? { status: 'drafting', wordCount: value.length } : {}) } };
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(flushSave, 1500);
  }, [onUpdate, flushSave]);

  useEffect(() => { setOutlineDraft(chapter.outline); }, [chapter.outline]);
  useEffect(() => { setContentDraft(chapter.content); }, [chapter.content]);

  useEffect(() => {
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);
    return () => { window.removeEventListener('pagehide', flushSave); window.removeEventListener('beforeunload', flushSave); flushSave(); };
  }, [flushSave]);

  // Sync outline ref text when chapter changes
  useEffect(() => {
    setRefText(chapter.outline ?? '');
    setEditingRef(false);
  }, [chapter.id, chapter.outline]);

  const handleGenerateOutline = async () => {
    flushSave();
    if (!hasEndpoint) {
      message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint'));
      return;
    }

    setGenerating('outline');
    try {
      const request: LLMGenerateRequest = {
        taskType: 'planning',
        systemPrompt: `你是一个专业的小说大纲规划师。根据已有章节信息，为当前章节生成详细大纲。
大纲应明确本章要改变的处境、人物目标和阻力、关键选择及其代价、场景之间的因果、与上章的接点和本章结束时的新状态。每个情节依据已发生的正文，不能把旧大纲当作事实。不要用重复检查、无来由的线索或强制反转填满篇幅。
${NOVEL_WRITING_PRINCIPLES}
用约600～1000字写清可以展开的场景与人物选择，不逐项规定比喻、手势、微表情和秒数。
必须遵守以下项目简介、人物和世界规则，不得擅自改换题材或主角：\n${getNovelContext()}`,
        userPrompt: `当前写作意图：${outlineDraft || '依据主线决定本章的实质推进'}\n请为第${chapter.order + 1}章 "${chapter.title}" 生成详细大纲。`,
        temperature: 0.65,
        maxTokens: 4096,
        thinking: false,
      };

      const response = await providerRouter.generate(request);
      const outline = await reviewer.prepareOutline(chapter.order, response.content, getReviewContext());
      onUpdate({ outline, status: 'drafting' });
      message.success(t('common.success'));
    } catch (err) {
      message.error(`${t('common.failed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(null);
    }
  };

  const handleGenerateContent = async () => {
    flushSave();
    if (!hasEndpoint) {
      message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint'));
      return;
    }

    if (!outlineDraft.trim()) {
      message.warning(t('novel.outline') + ' — ' + t('novel.empty'));
      return;
    }

    setGenerating('content');
    setActiveTab('content');
    setStreamContent('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const writingOutline = await reviewer.prepareOutline(chapter.order, outlineDraft, getReviewContext());
      if (controller.signal.aborted) return;
      setOutlineDraft(writingOutline);
      onUpdate({ outline: writingOutline });
      const genrePrompts: Record<string, string> = {
        xuanhuan: '玄幻：能力、境界与成长遵守既有规则，让力量变化影响人物选择和利益，不用光影与威压替代战斗过程和代价。',
        urban_romance: '都市情感：让关系变化来自双方的处境与选择，不靠误会反复拖延或堆叠微表情。',
        suspense: '悬疑：调查来自可获得的信息与可执行的行动，线索有来源，推论有边界，答案回应原始谜题。',
        cyberpunk: '赛博朋克：技术、权力和生计影响人物处境，让设定在具体行动中起作用，避免用霓虹与机械名词堆砌气氛。',
        scifi: '科幻风格：技术与社会设定自洽，通过具体行动呈现技术带来的冲突，遵守已有世界规则。',
        literary: '文学叙事风格：通过具体细节、人物行动与有潜台词的对话推进故事，尊重现实与人物动机。',
        wuxia: '武侠：立场、恩怨与行动代价构成侠义选择，武功和江湖规则前后一致，叙述用语沿用作品风格。',
      };

      const styleGuide = genrePrompts[novelGenre] ?? genrePrompts.literary;
      const povGuide = novelPOV === 'first_person' ? '使用第一人称，保持叙述者的知识边界。' : '使用第三人称有限视角，沿用前文的焦点人物，不任意进入其他人的内心。';

      const systemPrompt = `你是一位小说作者。根据故事约束、已发生的正文与本章写作意图，完成能够接续阅读的章节。

【流派文风指导】：${styleGuide}
【叙事视角】：${povGuide}
${NOVEL_WRITING_PRINCIPLES}
目标篇幅约2500～3500字，以本章事件的完整性为先，不为凑字数重复描写，不重复上一章开头或已经完成的调查。
写作前先在内部核对：前文约定是否兑现、信息是怎样被看见或获知的、关键推断还有哪些未排除的解释、场景结束后到底改变了什么。大纲是可调整的方案，不能为了照抄它而破坏前文、强加职业规章或将猜测写成证实。只输出最终正文，不重复章节标题。

必须遵守以下项目简介、人物和世界规则：\n${getNovelContext()}`;

      const request: LLMGenerateRequest = {
        taskType: 'generation',
        systemPrompt,
        userPrompt: `本章大纲：\n${writingOutline}\n\n请创作第${chapter.order + 1}章 "${chapter.title}" 的完整正文，承接前文的最终处境。`,
        temperature: 0.75,
        maxTokens: 16384,
        thinking: true,
      };

      let fullContent = '';

      for await (const chunk of providerRouter.stream(request)) {
        if (controller.signal.aborted) return;
        fullContent += chunk.delta;
        setStreamContent(fullContent);
      }

      if (fullContent) {
        saveRevisionBackup(contentDraft, fullContent);
        setContentDraft(fullContent);
        contentRef.current = fullContent;
        onUpdate({ content: fullContent, status: 'drafting', wordCount: fullContent.length });
        setStreamContent('');
        if (autoReview) await runReview(fullContent, { ...getReviewContext(), outline: writingOutline });
        else message.success(t('novel.editor.draftSaved'));
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        message.error(`${t('common.failed')}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (abortRef.current === controller) { setGenerating(null); abortRef.current = null; }
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

  const saveRevisionBackup = (before: string, after: string) => {
    if (before && before !== after) new NarrativeRepository(novel.id).saveCustomData('chapter-revision:' + chapter.id,
      { before, afterFingerprint: textFingerprint(after), timestamp: new Date().toISOString() });
  };

  const showReview = (report: ChapterReviewReport) => Modal.info({
    title: t('novel.editor.reviewTitle'), width: 760,
    content: <div style={{ maxHeight: 500, overflowY: 'auto', lineHeight: 1.7 }}>
      <p>{report.summary}</p>
      <Text type="secondary">{t('novel.editor.reviewLimit')}</Text>
      {report.findings.map((f, i) => <div key={i} style={{ marginBottom: 16 }}>
        <Tag color={f.severity === 'critical' ? 'error' : f.severity === 'major' ? 'warning' : 'default'}>{t('novel.editor.severity.' + f.severity)}</Tag>
        <strong>{f.problem}</strong>
        <blockquote style={{ borderLeft: '2px solid var(--border-secondary)', paddingLeft: 12, whiteSpace: 'pre-wrap' }}>{f.quote}</blockquote>
        {f.referenceQuote && <p><Text type="secondary">{t('novel.editor.reference')}: {f.referenceQuote}</Text></p>}
        <p>{f.suggestion}</p>
      </div>)}
    </div>,
  });

  const runReview = async (content = contentRef.current, context = getReviewContext()) => {
    if (!content.trim() || !hasEndpoint) return;
    setGenerating('review');
    const originalReference = reviewer.buildContext(chapter.order, context);
    try {
      const result = await reviewer.reviewChapter(chapter.order, content, context);
      setReview(result);
      if (contentRef.current === content && reviewer.buildContext(chapter.order, reviewContextRef.current()) === originalReference) onUpdate({ status: result.status === 'needs-revision' ? 'revising' : 'drafting' });
    } catch (error) {
      message.error(t('novel.editor.reviewFailed') + ': ' + (error instanceof Error ? error.message : String(error)));
    } finally { setGenerating(null); }
  };

  const handleAITool = async (mode: 'rewrite' | 'polish' | 'expand' | 'summarize' | 'consistency_check' | 'review') => {
    flushSave();
    if (!hasEndpoint) { message.warning(t('provider.title') + ' — ' + t('provider.addEndpoint')); return; }
    const content = contentRef.current;
    const originalReference = reviewer.buildContext(chapter.order, getReviewContext());
    if (content.trim().length < 20) { message.warning(t('editor.noContent')); return; }
    if (mode === 'consistency_check') { await runReview(content); return; }
    setGenerating(mode);
    try {
      if (mode === 'summarize') {
        const response = await providerRouter.generate({ taskType: 'extraction',
          systemPrompt: '你是小说编辑。根据完整正文提取100～200字摘要，区分已发生事实和人物猜想，保留结尾处境、重要选择和未解问题。不要把规划当作事实。',
          userPrompt: content, temperature: 0.2, maxTokens: 700, thinking: false });
        new NarrativeRepository(novel.id).saveCustomData('manual-summary:' + chapter.id,
          { contentFingerprint: textFingerprint(content), summary: response.content });
        Modal.info({ title: t('editor.aiSummarize'), content: <p style={{ whiteSpace: 'pre-wrap' }}>{response.content}</p>, width: 680 });
        return;
      }
      const edits = await reviewer.proposeRevision(chapter.order, content, getReviewContext(), mode, currentReview ?? undefined);
      if (!edits.length) { message.info(t('novel.editor.noEdits')); return; }
      const selected = new Set(edits.map((_, i) => i));
      Modal.confirm({
        title: t('novel.editor.revisionPreview'), width: 800,
        okText: t('novel.editor.applyRevision'), cancelText: t('common.cancel'),
        content: <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {edits.map((edit, i) => <div key={i} style={{ marginBottom: 20 }}>
            <p><Checkbox defaultChecked onChange={e => { if (e.target.checked) selected.add(i); else selected.delete(i); }}><strong>{edit.reason}</strong></Checkbox></p>
            <Text type="secondary">{t('novel.editor.before')}</Text><p style={{ whiteSpace: 'pre-wrap' }}>{edit.before}</p>
            <Text type="secondary">{t('novel.editor.after')}</Text><p style={{ whiteSpace: 'pre-wrap' }}>{edit.after || t('novel.editor.deleted')}</p>
          </div>)}
        </div>,
        onOk: close => {
          if (contentRef.current !== content || reviewer.buildContext(chapter.order, reviewContextRef.current()) !== originalReference) {
            message.warning(t('novel.editor.sourceChanged'));
            return;
          }
          if (!selected.size) {
            message.warning(t('novel.editor.selectEdits'));
            return;
          }
          const revised = applyEditorialEdits(content, edits.filter((_, i) => selected.has(i)));
          saveRevisionBackup(content, revised);
          contentRef.current = revised;
          setContentDraft(revised);
          onUpdate({ content: revised, wordCount: revised.length, status: 'revising' });
          close();
          void runReview(revised);
        },
      });
    } catch (error) { message.error(t('common.failed') + ': ' + (error instanceof Error ? error.message : String(error))); }
    finally { setGenerating(null); }
  };

  const restoreRevision = () => {
    const backup = new NarrativeRepository(novel.id).loadCustomData<{ before: string; afterFingerprint: string } | null>('chapter-revision:' + chapter.id, null);
    if (!backup || backup.afterFingerprint !== textFingerprint(contentDraft)) { message.warning(t('novel.editor.restoreUnavailable')); return; }
    flushSave();
    setContentDraft(backup.before);
    onUpdate({ content: backup.before, wordCount: backup.before.length, status: 'revising' });
  };

  const wordCount = streamContent || contentDraft || '';
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
      label: t('novel.editor.reviewTitle'),
      onClick: () => handleAITool('consistency_check'),
    },
    { key: 'restore_revision', icon: <ReloadOutlined />, label: t('novel.editor.restoreRevision'), onClick: restoreRevision },
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

      <div style={{ padding: '6px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-secondary)' }}>
        <Checkbox checked={autoReview} onChange={e => setAutoReview(e.target.checked)}>{t('novel.editor.autoReview')}</Checkbox>
        <Button size="small" icon={<FileSearchOutlined />} loading={generating === 'review'} disabled={!contentDraft.trim() || generating !== null || !hasEndpoint} onClick={() => { flushSave(); void runReview(); }}>{t('novel.editor.runReview')}</Button>
        {currentReview ? <>
          <Tag color={currentReview.status === 'needs-revision' ? 'warning' : 'default'}>{t(currentReview.status === 'needs-revision' ? 'novel.editor.needsRevision' : 'novel.editor.reviewed')}</Tag>
          <Button size="small" type="link" onClick={() => showReview(currentReview)}>{t('novel.editor.viewReview')}</Button>
          <Button size="small" disabled={generating !== null || !currentReview.findings.length} onClick={() => handleAITool('review')}>{t('novel.editor.reviseIssues')}</Button>
        </> : <Text type="secondary">{t(review ? 'novel.editor.reviewStale' : 'novel.editor.unreviewed')}</Text>}
      </div>
      {/* Tabs: outline / content */}
      <Tabs
        size="small"
        activeKey={activeTab}
        onChange={setActiveTab}
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        items={[
          {
            key: 'outline',
            label: <span><AlignLeftOutlined /> {t('novel.outline')}</span>,
            children: (
              <div style={{ padding: '0 12px', height: '100%' }}>
                <Input.TextArea
                  value={outlineDraft}
                  onChange={(e) => debouncedSave('outline', e.target.value)}
                  onBlur={flushSave}
                  placeholder={t("novel.outlinePlaceholder")}
                  style={{ height: 'calc(100% - 40px)', resize: 'vertical', ...textareaStyle }}
                  disabled={generating !== null}
                />
                <div style={{ marginTop: 8 }}>
                  <Button
                    icon={<ThunderboltOutlined />}
                    onClick={handleGenerateOutline}
                    loading={generating === 'outline'}
                    disabled={generating !== null}
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
                  value={streamContent || contentDraft}
                  onChange={(e) => { if (!generating) debouncedSave('content', e.target.value); }}
                  onBlur={flushSave}
                  disabled={generating === 'content'}
                  placeholder={t("novel.contentPlaceholder")}
                  style={{ flex: 1, resize: 'vertical', minHeight: 300, ...textareaStyle }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t('novel.wordCount', { count: wc.toLocaleString() })}</Text>
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
                            { value: 'scifi', label: t('novel.genre.scifi') },
                            { value: 'literary', label: t('novel.genre.literary') },
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
                        <Button
                          icon={<ThunderboltOutlined />}
                          onClick={handleGenerateContent}
                          loading={generating === 'content'}
                          disabled={generating !== null}
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
                          flushSave();
                          onUpdate({
                            content: streamContent || contentDraft,
                            wordCount: (streamContent || contentDraft).length,
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

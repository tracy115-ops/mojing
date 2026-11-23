import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Input, Button, Space, Tabs, message, Tooltip, Typography, Dropdown, Modal, Select, Checkbox, Tag, Popover } from 'antd';
import {
  ThunderboltOutlined, SaveOutlined, FileTextOutlined, AlignLeftOutlined,
  ZoomInOutlined, ZoomOutOutlined, ExperimentOutlined,
  ReloadOutlined, ExpandOutlined, FormatPainterOutlined,
  FileSearchOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { ChapterReviewer, type ChapterReviewReport } from '@/services/novel/chapter-reviewer';
import { NOVEL_WRITING_PRINCIPLES, textFingerprint, WRITING_REFERENCE_KEYS } from '@/services/novel/writing-context';
import { applyEditorialEdits, isReviewCurrent } from '@/services/novel/editorial-review';
import { generatePlanningResponse } from '@/services/novel/planning-generation';
import type { NovelChapter, NovelMetadata, CreativeProject } from '@/types';
import type { LLMGenerateRequest } from '@/types/providers';
import './novel-workspace.css';

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
  const [showOutlineRef, setShowOutlineRef] = useState(false);
  const [preparingProse, setPreparingProse] = useState(false);
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

      const response = await generatePlanningResponse(maxTokens => providerRouter.generate({ ...request, maxTokens }));
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
    setPreparingProse(true);
    setActiveTab('content');
    setStreamContent('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const writingOutline = await reviewer.prepareOutline(chapter.order, outlineDraft, getReviewContext());
      if (controller.signal.aborted) return;
      setPreparingProse(false);
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
      if (abortRef.current === controller) { setGenerating(null); setPreparingProse(false); abortRef.current = null; }
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
        <Tag color={f.basis === 'uncertain' ? 'default' : f.severity === 'critical' ? 'error' : f.severity === 'major' ? 'warning' : 'default'}>
          {t(f.basis === 'uncertain' ? 'novel.editor.evidencePending' : 'novel.editor.severity.' + f.severity)}
        </Tag>
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
    setGenerating(mode === 'review' ? 'revise' : mode);
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

  const wc = (streamContent || contentDraft).length;

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

  const writingSettings = (
    <div className="chapter-editor__settings" data-testid="chapter-writing-settings">
      <label htmlFor="chapter-writing-genre">{t('novel.genre')}</label>
      <Select id="chapter-writing-genre" size="small" value={novelGenre} onChange={setNovelGenre} options={[
        { value: 'xuanhuan', label: t('novel.genre.fantasy') },
        { value: 'urban_romance', label: t('novel.genre.romance') },
        { value: 'suspense', label: t('novel.genre.mystery') },
        { value: 'cyberpunk', label: t('novel.editor.cyberpunk') },
        { value: 'scifi', label: t('novel.genre.scifi') },
        { value: 'literary', label: t('novel.genre.literary') },
        { value: 'wuxia', label: t('novel.genre.wuxia') },
      ]} />
      <label htmlFor="chapter-writing-pov">{t('novel.editor.pointOfView')}</label>
      <Select id="chapter-writing-pov" size="small" value={novelPOV} onChange={setNovelPOV} options={[
        { value: 'third_person', label: t('novel.editor.thirdPerson') },
        { value: 'first_person', label: t('novel.editor.firstPerson') },
      ]} />
      <Checkbox checked={autoReview} onChange={e => setAutoReview(e.target.checked)}>{t('novel.editor.autoReview')}</Checkbox>
    </div>
  );

  const generationStatus = generating === 'content' ? (preparingProse ? 'preparingProse' : 'writingProse')
    : generating === 'review' ? 'reviewingProse' : generating === 'outline' ? 'planningOutline'
    : generating ? 'preparingEdits' : undefined;

  return (
    <div className="chapter-editor" data-testid="chapter-editor">
      {/* Chapter title + zoom controls */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          value={chapter.title}
          onChange={(e) => { onUpdate({ title: e.target.value }); }}
          placeholder={t('novel.chapterTitle')}
          variant="borderless"
          style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, padding: '4px 0' }}
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

      <div className="chapter-editor__review">
        <Button size="small" icon={<FileSearchOutlined />} loading={generating === 'review'} disabled={!contentDraft.trim() || generating !== null || !hasEndpoint} onClick={() => { flushSave(); void runReview(); }}>{t('novel.editor.runReview')}</Button>
        {currentReview ? <>
          {!generationStatus && <Tag color={currentReview.status === 'needs-revision' ? 'warning' : 'default'}>{t(currentReview.status === 'needs-revision' ? 'novel.editor.needsRevision' : 'novel.editor.reviewed')}</Tag>}
          <Button size="small" type="link" disabled={!!generating} onClick={() => showReview(currentReview)}>{t('novel.editor.viewReview')}</Button>
          {currentReview.findings.some(finding => finding.basis !== 'uncertain') && <Button size="small" loading={generating === 'revise'} disabled={generating !== null} onClick={() => handleAITool('review')}>{t('novel.editor.reviseIssues')}</Button>}
        </> : null}
        <Text type="secondary" role="status" className="chapter-editor__status">
          {generationStatus ? t('novel.editor.' + generationStatus) : !currentReview && t(review ? 'novel.editor.reviewStale' : 'novel.editor.unreviewed')}
        </Text>
      </div>
      {/* Tabs: outline / content */}
      <Tabs
        size="small"
        className="chapter-editor__tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'outline',
            label: <span><AlignLeftOutlined /> {t('novel.outline')}</span>,
            children: (
              <div className="chapter-editor__page">
                <Input.TextArea
                  value={outlineDraft}
                  onChange={(e) => debouncedSave('outline', e.target.value)}
                  onBlur={flushSave}
                  placeholder={t("novel.outlinePlaceholder")}
                  className="chapter-editor__text"
                  style={textareaStyle}
                  disabled={generating !== null}
                />
                <div className="chapter-editor__footer">
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
              <div className="chapter-editor__page">
                {outlineDraft && <div className="chapter-editor__outline">
                  <Button size="small" type="text" icon={<AlignLeftOutlined />} aria-expanded={showOutlineRef}
                    onClick={() => setShowOutlineRef(visible => !visible)}>{t('novel.outlineRef')}</Button>
                  {showOutlineRef && <div className="chapter-editor__outline-preview">
                    <div>{outlineDraft}</div>
                    <Button size="small" type="link" onClick={() => setActiveTab('outline')}>{t('novel.editor.editOutline')}</Button>
                  </div>}
                </div>}
                <Input.TextArea
                  value={streamContent || contentDraft}
                  onChange={(e) => { if (!generating) debouncedSave('content', e.target.value); }}
                  onBlur={flushSave}
                  disabled={generating === 'content'}
                  placeholder={t("novel.contentPlaceholder")}
                  className="chapter-editor__text"
                  style={textareaStyle}
                />
                <div className="chapter-editor__footer" data-testid="chapter-actions">
                  <Text type="secondary" className="chapter-editor__count" data-testid="chapter-word-count">{t('novel.wordCount', { count: wc.toLocaleString() })}</Text>
                  <div className="chapter-editor__actions">
                    {generating === 'content' ? (
                      <Button size="small" danger onClick={handleStopGeneration}>
                        {t('novel.stopGeneration')}
                      </Button>
                    ) : (
                      <>
                        <Popover content={writingSettings} trigger="click" placement="topRight">
                          <Button size="small" icon={<SettingOutlined />} disabled={!!generating} data-testid="chapter-writing-settings-toggle">
                            {t('novel.editor.writingSettings')}
                          </Button>
                        </Popover>
                        <Dropdown menu={{ items: aiToolItems }} trigger={['click']} disabled={!!generating || !contentDraft.trim()}>
                          <Button size="small" icon={<ExperimentOutlined />}>
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
                          {t('novel.editor.generateProse')}
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
                  </div>
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

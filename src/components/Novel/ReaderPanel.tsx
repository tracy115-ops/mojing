// ============================================================================
// Reader Panel — Immersive novel reading mode
// ============================================================================

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Button, Slider, Select, Tooltip, Empty } from 'antd';
import {
  CloseOutlined, LeftOutlined, RightOutlined,
  FontSizeOutlined, MenuOutlined, ReadOutlined,
  SettingOutlined, ExpandOutlined, CompressOutlined,
} from '@ant-design/icons';

const tauriWin = () => (window as any).__TAURI__.window.getCurrent();
import { useTranslation } from '@/i18n';
import type { NovelChapter } from '@/types';

interface ReaderPanelProps {
  title: string;
  chapters: NovelChapter[];
  initialChapterId?: string | null;
  onClose: () => void;
}

const FONT_FAMILIES = [
  { value: 'serif', label: '宋体/衬线' },
  { value: 'sans-serif', label: '黑体/无衬线' },
  { value: '"Noto Serif SC", "Source Han Serif SC", serif', label: '思源宋体' },
];

const ReaderPanel: React.FC<ReaderPanelProps> = ({
  title, chapters, initialChapterId, onClose,
}) => {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);

  const contentChapters = useMemo(
    () => chapters.filter((c) => c.content),
    [chapters],
  );

  const [currentIndex, setCurrentIndex] = useState(() => {
    if (initialChapterId) {
      const idx = contentChapters.findIndex((c) => c.id === initialChapterId);
      if (idx >= 0) return idx;
    }
    return 0;
  });
  const [fontSize, setFontSize] = useState(18);
  const [fontFamily, setFontFamily] = useState('serif');
  const [lineHeight, setLineHeight] = useState(1.9);
  const [showToc, setShowToc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const currentChapter = contentChapters[currentIndex];
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < contentChapters.length - 1;

  // Parse markdown-style content into paragraphs
  const paragraphs = useMemo(() => {
    if (!currentChapter?.content) return [];
    return currentChapter.content
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [currentChapter]);

  const handleTitlebarMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.ant-btn') || target.closest('.ant-tooltip')) return;
    try {
      await tauriWin().startDragging();
    } catch { /* not in Tauri */ }
  }, []);

  const goTo = useCallback((index: number) => {
    setCurrentIndex(index);
    contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setShowToc(false);
  }, []);

  const goPrev = useCallback(() => {
    if (canPrev) goTo(currentIndex - 1);
  }, [canPrev, currentIndex, goTo]);

  const goNext = useCallback(() => {
    if (canNext) goTo(currentIndex + 1);
  }, [canNext, currentIndex, goTo]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goNext(); }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goPrev, goNext, onClose]);

  // Auto-hide controls in fullscreen
  useEffect(() => {
    if (!isFullscreen) { setShowControls(true); return; }
    let timer: ReturnType<typeof setTimeout>;
    const show = () => { setShowControls(true); clearTimeout(timer); timer = setTimeout(() => setShowControls(false), 3000); };
    show();
    window.addEventListener('mousemove', show);
    return () => { clearTimeout(timer); window.removeEventListener('mousemove', show); };
  }, [isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  const totalWords = contentChapters.reduce((s, c) => s + c.wordCount, 0);
  const readProgress = currentChapter
    ? Math.round(((currentIndex + 1) / contentChapters.length) * 100)
    : 0;

  if (contentChapters.length === 0) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 13000,
        background: 'var(--bg-primary, #fff)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 16,
      }}>
        <Empty description={t('reader.noContent')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        <Button onClick={onClose}>{t('common.close')}</Button>
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 13000,
      background: 'var(--bg-primary, #fff)',
      display: 'flex', flexDirection: 'column',
      transition: 'all 0.2s',
    }}>
      {/* Top bar — draggable */}
      <div
        onMouseDown={handleTitlebarMouseDown}
        style={{
          padding: '8px 16px',
          borderBottom: showControls ? '1px solid var(--border-secondary)' : '1px solid transparent',
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-primary, #fff)',
          opacity: showControls ? 1 : 0,
          transition: 'opacity 0.3s',
          flexShrink: 0,
          zIndex: 10,
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <Tooltip title={t('reader.toc')}>
          <Button type="text" size="small" icon={<MenuOutlined />} onClick={() => { setShowToc(!showToc); setShowSettings(false); }} />
        </Tooltip>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {currentChapter?.title || t('novel.chapterN', { order: (currentChapter?.order ?? 0) + 1 })}
          </div>
        </div>
        <Tooltip title={t('reader.settings')}>
          <Button type="text" size="small" icon={<SettingOutlined />} onClick={() => { setShowSettings(!showSettings); setShowToc(false); }} />
        </Tooltip>
        <Tooltip title={isFullscreen ? t('reader.exitFullscreen') : t('reader.fullscreen')}>
          <Button type="text" size="small" icon={isFullscreen ? <CompressOutlined /> : <ExpandOutlined />} onClick={toggleFullscreen} />
        </Tooltip>
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{
          padding: '12px 20px', borderBottom: '1px solid var(--border-secondary)',
          background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
          display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <FontSizeOutlined /> {t('reader.fontSize')}
            <Slider min={14} max={28} value={fontSize} onChange={setFontSize} style={{ width: 120 }} />
            <span style={{ color: 'var(--text-secondary)', minWidth: 28 }}>{fontSize}px</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            {t('reader.fontFamily')}
            <Select
              size="small" value={fontFamily} onChange={setFontFamily}
              options={FONT_FAMILIES} style={{ width: 140 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            {t('reader.lineHeight')}
            <Slider min={1.4} max={2.6} step={0.1} value={lineHeight} onChange={setLineHeight} style={{ width: 100 }} />
            <span style={{ color: 'var(--text-secondary)', minWidth: 28 }}>{lineHeight.toFixed(1)}</span>
          </div>
        </div>
      )}

      {/* TOC sidebar */}
      {showToc && (
        <div style={{
          position: 'absolute', top: 49, left: 0, bottom: 44, width: 260,
          background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
          borderRight: '1px solid var(--border-secondary)',
          overflow: 'auto', zIndex: 5,
        }}>
          <div style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {t('reader.toc')} ({contentChapters.length})
          </div>
          {contentChapters.map((ch, i) => (
            <div
              key={ch.id}
              onClick={() => goTo(i)}
              style={{
                padding: '6px 16px', cursor: 'pointer', fontSize: 12,
                background: i === currentIndex ? 'var(--bg-active, rgba(59,130,246,0.08))' : 'transparent',
                color: i === currentIndex ? 'var(--accent-primary, #3b82f6)' : 'var(--text-primary)',
                fontWeight: i === currentIndex ? 600 : 400,
                borderLeft: i === currentIndex ? '3px solid var(--accent-primary, #3b82f6)' : '3px solid transparent',
              }}
            >
              {ch.title || t('novel.chapterN', { order: ch.order + 1 })}
              <span style={{ float: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>{ch.wordCount}</span>
            </div>
          ))}
        </div>
      )}

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div
          ref={contentRef}
          style={{
            flex: 1, overflow: 'auto', padding: '24px 0',
          }}
        >
          <div style={{
            maxWidth: 720, margin: '0 auto', padding: '0 32px',
          }}>
            {/* Chapter title */}
            <h2 style={{
              fontFamily, fontSize: fontSize + 6, fontWeight: 700,
              textAlign: 'center', marginBottom: 8,
              color: 'var(--text-primary)',
            }}>
              {currentChapter?.title || t('novel.chapterN', { order: (currentChapter?.order ?? 0) + 1 })}
            </h2>
            <div style={{
              textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)',
              marginBottom: 32, paddingBottom: 24,
              borderBottom: '1px solid var(--border-secondary)',
            }}>
              {t('reader.wordCount', { count: currentChapter?.wordCount ?? 0 })}
            </div>

            {/* Paragraphs */}
            {paragraphs.map((p, i) => (
              <p key={i} style={{
                fontFamily, fontSize, lineHeight,
                textIndent: fontSize * 2,
                marginBottom: fontSize * 0.8,
                color: 'var(--text-primary)',
                textAlign: 'justify',
                wordBreak: 'break-word',
              }}>
                {p}
              </p>
            ))}

            {/* Chapter end nav */}
            <div style={{
              textAlign: 'center', padding: '32px 0 48px',
              borderTop: '1px solid var(--border-secondary)', marginTop: 32,
            }}>
              {canNext ? (
                <Button type="primary" ghost icon={<RightOutlined />} onClick={goNext}>
                  {t('reader.nextChapter')} — {contentChapters[currentIndex + 1]?.title || t('novel.chapterN', { order: (contentChapters[currentIndex + 1]?.order ?? currentIndex + 2) })}
                </Button>
              ) : (
                <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('reader.theEnd')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{
        padding: '6px 16px',
        borderTop: showControls ? '1px solid var(--border-secondary)' : '1px solid transparent',
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--bg-primary, #fff)',
        opacity: showControls ? 1 : 0,
        transition: 'opacity 0.3s',
        flexShrink: 0,
      }}>
        <Button type="text" size="small" icon={<LeftOutlined />} disabled={!canPrev} onClick={goPrev} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            flex: 1, height: 3, borderRadius: 2,
            background: 'var(--border-secondary)', overflow: 'hidden',
          }}>
            <div style={{
              width: `${readProgress}%`, height: '100%',
              background: 'var(--accent-primary, #3b82f6)',
              transition: 'width 0.3s',
            }} />
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {currentIndex + 1} / {contentChapters.length}
          </span>
        </div>
        <Button type="text" size="small" icon={<RightOutlined />} disabled={!canNext} onClick={goNext} />
      </div>
    </div>
  );
};

export default ReaderPanel;

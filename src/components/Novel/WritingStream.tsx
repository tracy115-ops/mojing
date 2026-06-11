// ============================================================================
// Writing Stream Panel — Typewriter effect + progress for chapter generation
// Shows real-time streaming content with word count targets
// ============================================================================

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Typography, Tag, Space, Progress, Empty, Badge } from 'antd';
import {
  EditOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';

const { Text } = Typography;

interface WritingStreamProps {
  novelId: string;
}

const WritingStream: React.FC<WritingStreamProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  const states = useAutopilotStore((s) => s.states);
  const beatProgressMap = useAutopilotStore((s) => s.beatProgress);

  const autopilotState = states[novelId];
  const beatProgress = beatProgressMap[novelId];

  const isGenerating = autopilotState?.status === 'running';
  const currentStage = autopilotState?.currentStage ?? 'idle';
  const currentBeatIndex = beatProgress?.currentBeatIndex ?? 0;
  const totalBeats = beatProgress?.totalBeats ?? 0;
  const displayContent = autopilotState?.currentChapterContent ?? '';

  // Typewriter effect
  const [visibleChars, setVisibleChars] = useState(0);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (displayContent.length > prevLengthRef.current) {
      const target = displayContent.length;
      const start = prevLengthRef.current;
      let current = start;

      const interval = setInterval(() => {
        current += 3;
        if (current >= target) {
          current = target;
          clearInterval(interval);
        }
        setVisibleChars(current);
      }, 16);

      prevLengthRef.current = target;
      return () => clearInterval(interval);
    } else if (displayContent.length < prevLengthRef.current) {
      prevLengthRef.current = 0;
      setVisibleChars(0);
    }
  }, [displayContent]);

  // Auto-scroll: follow content growth, but stop if user scrolled up
  const userScrolledUpRef = useRef(false);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUpRef.current = !atBottom;
  };

  useEffect(() => {
    if (!containerRef.current || userScrolledUpRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [displayContent]);

  const wordCount = displayContent.length;
  const targetWords = autopilotState?.targetWordCount || 3000;
  const progressPercent = Math.min(100, Math.round((wordCount / targetWords) * 100));

  const beatProgressLabel = totalBeats > 0 ? `${currentBeatIndex + 1}/${totalBeats}` : '-';
  const writingSpeed = useMemo(() => {
    if (visibleChars > 100) return `~${Math.round(visibleChars / 30)} ${t('autopilot.words')}/${t('writingStream.perMinute')}`;
    return '-';
  }, [visibleChars, t]);

  const stageLabel: Record<string, string> = {
    idle: t('pipeline.node.idle'),
    macro_planning: t('novel.engine.stage.macroPlanning'),
    act_beat_planning: t('novel.engine.stage.actBeatPlanning'),
    chapter_generation: t('novel.engine.stage.chapterGeneration'),
    chapter_review: t('novel.engine.stage.chapterReview'),
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><EditOutlined style={{ marginRight: 6 }} />{t('writingStream.title')}</span>
        <Space>
          <Badge status={isGenerating ? 'processing' : 'default'} />
          <Text type="secondary" style={{ fontSize: 10 }}>
            {stageLabel[currentStage] ?? 'Idle'}
          </Text>
        </Space>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '8px 12px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <Space>
            <Tag color="blue" style={{ fontSize: 9 }}>
              Beat {beatProgressLabel}
            </Tag>
            <Tag style={{ fontSize: 9 }}>{writingSpeed}</Tag>
          </Space>
          <Text type="secondary" style={{ fontSize: 10 }}>
            {wordCount.toLocaleString()} / {targetWords.toLocaleString()} {t('autopilot.words')}
          </Text>
        </div>
        <Progress
          percent={progressPercent}
          size="small"
          strokeColor={progressPercent >= 100 ? '#22c55e' : '#3b82f6'}
          showInfo={false}
        />
      </div>

      {/* Content area */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1, overflow: 'auto', padding: '12px',
          fontSize: 13, lineHeight: 1.8,
          whiteSpace: 'pre-wrap',
          color: 'var(--text-primary)',
        }}
      >
        {displayContent.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Empty
              description={isGenerating ? t('writingStream.preparing') : t('writingStream.idle')}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        ) : (
          <>
            {displayContent.slice(0, visibleChars)}
            {visibleChars < displayContent.length && (
              <span style={{
                display: 'inline-block', width: 2, height: 16,
                background: 'var(--accent-primary, #3b82f6)',
                animation: 'blink 0.8s infinite',
                verticalAlign: 'middle', marginLeft: 1,
              }} />
            )}
          </>
        )}
      </div>

      {/* Cursor blink animation */}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
};

export default WritingStream;

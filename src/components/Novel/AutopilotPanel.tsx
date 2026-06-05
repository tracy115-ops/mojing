import React, { useCallback, useMemo } from 'react';
import { Button, Progress, Tag, Space, Tooltip, Typography } from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';

const { Text } = Typography;

interface AutopilotPanelProps {
  novelId: string;
  novelTitle: string;
  genre: string;
  targetWordCount: number;
  currentWordCount: number;
  chapterCount: number;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: 'default',
  running: 'processing',
  paused: 'warning',
  error: 'error',
  completed: 'success',
};

const AutopilotPanel: React.FC<AutopilotPanelProps> = ({
  novelId,
  novelTitle,
  genre,
  targetWordCount,
  currentWordCount,
  chapterCount,
  onStart,
  onPause,
  onResume,
  onStop,
}) => {
  const { t } = useTranslation();

  const autopilotState = useAutopilotStore((s) => s.states[novelId]);
  const breakerState = useAutopilotStore((s) => s.breakers[novelId]);

  const status = autopilotState?.status ?? 'idle';
  const stage = autopilotState?.currentStage ?? 'idle';
  const progress = autopilotState?.progress ?? 0;
  const currentChapter = autopilotState?.currentChapterNumber ?? 0;
  const targetChapters = autopilotState?.targetChapterCount ?? 0;
  const lastError = autopilotState?.lastError;

  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isIdle = status === 'idle';
  const isCompleted = status === 'completed';
  const isError = status === 'error';
  const breakerOpen = breakerState?.state === 'open';

  const stageLabel = useMemo(() => {
    const keyMap: Record<string, string> = {
      macro_planning: 'novel.engine.stage.macroPlanning',
      act_beat_planning: 'novel.engine.stage.actBeatPlanning',
      chapter_generation: 'novel.engine.stage.chapterGeneration',
      chapter_review: 'novel.engine.stage.chapterReview',
    };
    return keyMap[stage] ? t(keyMap[stage]) : '';
  }, [stage, t]);

  const progressPercent = useMemo(() => Math.round(progress * 100), [progress]);

  const wordPercent = useMemo(() => {
    if (!targetWordCount) return 0;
    return Math.min(100, Math.round((currentWordCount / targetWordCount) * 100));
  }, [currentWordCount, targetWordCount]);

  // Idle state — show prominent start card
  if (isIdle && !isCompleted) {
    return (
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border-secondary)',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.06) 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 18,
            flexShrink: 0,
          }}>
            <ThunderboltOutlined />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
              {t('novel.engine.autopilot')}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('autopilot.desc', {
                title: novelTitle,
                genre: t(`novel.genre.${genre}`),
                chapters: targetChapters || Math.max(1, Math.ceil(targetWordCount / 3000)),
              })}
            </Text>
          </div>
        </div>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={onStart}
          style={{ flexShrink: 0 }}
        >
          {t('autopilot.start')}
        </Button>
      </div>
    );
  }

  // Running / Paused — compact toolbar
  return (
    <div style={{
      padding: '10px 20px',
      borderBottom: '1px solid var(--border-secondary)',
      background: isPaused
        ? 'rgba(245,158,11,0.06)'
        : 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.06) 100%)',
    }}>
      {/* Row 1: title + controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isRunning || isPaused ? 8 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ThunderboltOutlined spin={isRunning} style={{ color: 'var(--accent-primary, #3b82f6)', fontSize: 16 }} />
          <Text strong style={{ fontSize: 13 }}>{t('novel.engine.autopilot')}</Text>
          <Tag color={STATUS_COLORS[status]} style={{ fontSize: 11 }}>
            {t(`novel.engine.autopilot.${status}`)}
          </Tag>
          {breakerOpen && (
            <Tag color="error" icon={<WarningOutlined />} style={{ fontSize: 11 }}>
              {t('novel.engine.circuitBreaker')}
            </Tag>
          )}
        </div>
        <Space size={6}>
          {(isIdle || isError || isCompleted) && (
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={onStart}>
              {t('autopilot.start')}
            </Button>
          )}
          {isRunning && (
            <>
              <Button size="small" icon={<PauseCircleOutlined />} onClick={onPause}>
                {t('autopilot.pause')}
              </Button>
              <Button size="small" danger icon={<StopOutlined />} onClick={onStop}>
                {t('autopilot.stop')}
              </Button>
            </>
          )}
          {isPaused && (
            <>
              <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={onResume}>
                {t('autopilot.resume')}
              </Button>
              <Button size="small" danger icon={<StopOutlined />} onClick={onStop}>
                {t('autopilot.stop')}
              </Button>
            </>
          )}
        </Space>
      </div>

      {/* Row 2: progress (running or paused) */}
      {(isRunning || isPaused) && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {stageLabel}
              {stage === 'chapter_generation' && ` — ${t('novel.chapterOrder', { order: currentChapter + 1 })}`}
            </Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {currentChapter}/{targetChapters} {t('novel.chapters')} | {currentWordCount.toLocaleString()}/{targetWordCount.toLocaleString()} {t('novel.wordCount', { count: '' }).replace(' 字', '')}
            </Text>
          </div>
          <Progress
            percent={progressPercent}
            size="small"
            strokeColor={{ '0%': '#3b82f6', '100%': '#8b5cf6' }}
          />
          {/* Paused reason */}
          {isPaused && lastError && (
            <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', borderLeft: '3px solid #f59e0b' }}>
              <Text type="warning" style={{ fontSize: 11, lineHeight: '16px' }}>
                <WarningOutlined style={{ marginRight: 4 }} />
                {lastError}
              </Text>
            </div>
          )}
        </div>
      )}

      {/* Completed */}
      {isCompleted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CheckCircleOutlined style={{ color: '#22c55e' }} />
          <Text style={{ fontSize: 12, color: '#22c55e' }}>
            {t('novel.engine.autopilot.completed')} — {chapterCount} {t('novel.chapters')}, {currentWordCount.toLocaleString()} {t('novel.wordCount', { count: '' }).replace(' 字', '')}
          </Text>
        </div>
      )}

      {/* Error */}
      {isError && lastError && (
        <div style={{ marginTop: 4 }}>
          <Text type="danger" style={{ fontSize: 11 }}>{lastError}</Text>
        </div>
      )}
    </div>
  );
};

export default AutopilotPanel;

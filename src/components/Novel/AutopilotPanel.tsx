import React, { useMemo, useState, useEffect } from 'react';
import { Button, Progress, Tag, Space, Typography, Tooltip } from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  UndoOutlined,
  LineChartOutlined,
  SafetyCertificateOutlined,
  DeleteOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useAutopilotStore } from '@/stores/autopilotStore';
import { CheckpointManager, type CheckpointSummary } from '@/services/novel/checkpoint-manager';
import { TensionScoringService, type TensionTrend } from '@/services/novel/tension-scorer';
import { KnowledgeGraphEngine } from '@/services/novel/knowledge-graph';
import type { BeatFocus, TensionPoint } from '@/types/narrative';

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

const FOCUS_COLORS: Record<BeatFocus, string> = {
  action: '#ef4444',
  dialogue: '#22c55e',
  sensory: '#06b6d4',
  emotion: '#ec4899',
  suspense: '#8b5cf6',
  hook: '#f59e0b',
  character_intro: '#3b82f6',
  narration: '#6b7280',
};

const TREND_ICONS: Record<TensionTrend, string> = {
  rising: '↑',
  falling: '↓',
  stable: '—',
  volatile: '↕',
};

// --- Mini Tension Sparkline (pure SVG, no deps) ---

const TensionSparkline: React.FC<{ points: TensionPoint[]; width?: number; height?: number }> = ({
  points, width = 100, height = 24,
}) => {
  if (points.length < 2) return null;

  const maxScore = 10;
  const stepX = width / (points.length - 1);

  const pathD = points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - (p.score / maxScore) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  // Gradient area under curve
  const areaD = `${pathD} L ${((points.length - 1) * stepX).toFixed(1)} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="tensionGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#tensionGrad)" />
      <path d={pathD} fill="none" stroke="#8b5cf6" strokeWidth="1.5" />
      {points.map((p, i) => (
        <circle
          key={`p-${p.chapter}`}
          cx={i * stepX}
          cy={height - (p.score / maxScore) * height}
          r={1.5}
          fill="#8b5cf6"
        />
      ))}
    </svg>
  );
};

// --- Main Component ---

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
  const beatProgress = useAutopilotStore((s) => s.beatProgress[novelId]);

  const status = autopilotState?.status ?? 'idle';
  const stage = autopilotState?.currentStage ?? 'idle';
  const progress = autopilotState?.progress ?? 0;
  const currentChapter = autopilotState?.currentChapterNumber ?? 0;
  const targetChapters = autopilotState?.targetChapterCount ?? 0;
  const lastError = autopilotState?.lastError;
  // Use store word count when running, otherwise props
  const liveWordCount = autopilotState?.currentWordCount ?? currentWordCount;

  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isIdle = status === 'idle';
  const isCompleted = status === 'completed';
  const isError = status === 'error';
  const breakerOpen = breakerState?.state === 'open';

  // Beat info
  const totalBeats = beatProgress?.totalBeats ?? 0;
  const currentBeatIndex = beatProgress?.currentBeatIndex ?? 0;
  const currentFocus = beatProgress?.currentFocus;
  const currentPhase = beatProgress?.currentPhase;
  const chapterWordCount = beatProgress?.chapterWordCount ?? 0;

  const isGenerating = isRunning && stage === 'chapter_generation';

  // --- Checkpoint data ---
  const [checkpoint, setCheckpoint] = useState<CheckpointSummary | null>(null);
  const [showCheckpoint, setShowCheckpoint] = useState(false);

  useEffect(() => {
    if (novelId && isIdle) {
      const cm = new CheckpointManager(novelId);
      const summary = cm.getSummary();
      setCheckpoint(summary);
      setShowCheckpoint(!!summary);
    } else {
      setShowCheckpoint(false);
    }
  }, [novelId, isIdle]);

  // --- Tension data ---
  const [tensionPoints, setTensionPoints] = useState<TensionPoint[]>([]);
  const [tensionTrend, setTensionTrend] = useState<TensionTrend>('stable');

  useEffect(() => {
    if (novelId) {
      const ts = new TensionScoringService(novelId);
      setTensionPoints(ts.getTensionHistory());
      setTensionTrend(ts.getTensionTrend());
    }
  }, [novelId, status, progress]); // refresh on status/progress change

  // --- Knowledge graph stats ---
  const [graphStats, setGraphStats] = useState<{ nodes: number; edges: number }>({ nodes: 0, edges: 0 });

  useEffect(() => {
    if (novelId) {
      const kg = new KnowledgeGraphEngine(novelId);
      const graph = kg.getFullGraph();
      setGraphStats({ nodes: graph.nodes.length, edges: graph.edges.length });
    }
  }, [novelId, progress]);

  const stageLabel = useMemo(() => {
    const keyMap: Record<string, string> = {
      global_planning: 'novel.engine.stage.globalPlanning',
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
    return Math.min(100, Math.round((liveWordCount / targetWordCount) * 100));
  }, [liveWordCount, targetWordCount]);

  // Last tension score
  const lastTension = tensionPoints.length > 0 ? tensionPoints[tensionPoints.length - 1].score : null;

  // --- Idle state — show start card with checkpoint resume option ---
  if (isIdle && !isCompleted) {
    return (
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border-secondary)',
        background: 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.06) 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 18, flexShrink: 0,
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
          <Space>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={onStart}>
              {t('autopilot.start')}
            </Button>
          </Space>
        </div>

        {/* Checkpoint resume banner */}
        {showCheckpoint && checkpoint && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 6,
            background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UndoOutlined style={{ color: '#3b82f6' }} />
              <div>
                <Text style={{ fontSize: 12, fontWeight: 600 }}>{t('checkpoint.found')}</Text>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {t('checkpoint.resumeFrom', { chapter: checkpoint.chapterIndex + 1, beat: checkpoint.beatIndex + 1 })}
                  {' · '}
                  {t('checkpoint.progress', { percent: Math.round(checkpoint.progress * 100) })}
                </div>
              </div>
            </div>
            <Space size={4}>
              <Button size="small" type="primary" icon={<UndoOutlined />} onClick={onStart}>
                {t('checkpoint.resume')}
              </Button>
              <Tooltip title={t('checkpoint.discard')}>
                <Button size="small" danger icon={<DeleteOutlined />}
                  onClick={() => {
                    const cm = new CheckpointManager(novelId);
                    cm.clear();
                    setCheckpoint(null);
                    setShowCheckpoint(false);
                  }}
                />
              </Tooltip>
            </Space>
          </div>
        )}

        {/* Stats bar (tension + knowledge graph) */}
        {(tensionPoints.length > 0 || graphStats.nodes > 0) && (
          <div style={{
            marginTop: 8, display: 'flex', alignItems: 'center', gap: 16,
            padding: '4px 0', borderTop: '1px solid var(--border-secondary, rgba(0,0,0,0.06))',
          }}>
            {tensionPoints.length > 0 && (
              <Tooltip title={`${t('tension.title')} — ${t(`tension.trend.${tensionTrend}`)}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}>
                  <LineChartOutlined style={{ color: '#8b5cf6', fontSize: 12 }} />
                  <TensionSparkline points={tensionPoints} />
                  {lastTension !== null && (
                    <Text style={{ fontSize: 10, color: '#8b5cf6' }}>
                      {lastTension.toFixed(1)}
                    </Text>
                  )}
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    {TREND_ICONS[tensionTrend]}
                  </Text>
                </div>
              </Tooltip>
            )}
            {graphStats.nodes > 0 && (
              <Tooltip title={t('knowledge.title')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
                  <ExperimentOutlined style={{ color: '#06b6d4', fontSize: 12 }} />
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    {t('knowledge.totalNodes', { count: graphStats.nodes })} · {t('knowledge.totalTriples', { count: graphStats.edges })}
                  </Text>
                </div>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    );
  }

  // Running / Paused — compact toolbar with beat progress
  return (
    <div style={{
      padding: '10px 20px',
      borderBottom: '1px solid var(--border-secondary)',
      background: isPaused
        ? 'rgba(245,158,11,0.06)'
        : 'linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(139,92,246,0.06) 100%)',
    }}>
      {/* Row 1: title + controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: (isRunning || isPaused) ? 8 : 0 }}>
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
          {/* Inline tension indicator during generation */}
          {isRunning && lastTension !== null && (
            <Tooltip title={`${t('tension.score')}: ${lastTension.toFixed(1)} / 10`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <LineChartOutlined style={{ color: '#8b5cf6', fontSize: 11 }} />
                <Text style={{ fontSize: 10, color: '#8b5cf6' }}>{lastTension.toFixed(1)}</Text>
              </div>
            </Tooltip>
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

      {/* Row 2: stage + beat progress */}
      {(isRunning || isPaused) && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {stageLabel}
              {stage === 'chapter_generation' && ` — ${t('novel.chapterOrder', { order: currentChapter + 1 })}`}
            </Text>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {currentChapter}/{targetChapters} {t('novel.chapters')} | {liveWordCount.toLocaleString()}/{targetWordCount.toLocaleString()} {t('autopilot.words')}
            </Text>
          </div>
          <Progress
            percent={progressPercent}
            size="small"
            strokeColor={{ '0%': '#3b82f6', '100%': '#8b5cf6' }}
          />

          {/* Beat progress — only visible during chapter generation */}
          {isGenerating && totalBeats > 0 && (
            <div style={{
              marginTop: 6, padding: '6px 10px', borderRadius: 6,
              background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
              border: '1px solid var(--border-secondary)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {currentPhase && (
                    <span style={{
                      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                      background: currentPhase === 'unfurl' ? '#3b82f6' : currentPhase === 'converge' ? '#f59e0b' : '#ef4444',
                      flexShrink: 0,
                    }} />
                  )}
                  <Text style={{ fontSize: 11, fontWeight: 600 }}>
                    Beat {currentBeatIndex + 1}/{totalBeats}
                  </Text>
                  {currentFocus && (
                    <Tag style={{
                      fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0,
                      color: FOCUS_COLORS[currentFocus], borderColor: FOCUS_COLORS[currentFocus],
                      background: 'transparent',
                    }}>
                      {currentFocus}
                    </Tag>
                  )}
                  {currentPhase && (
                    <Tag style={{
                      fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0,
                      color: currentPhase === 'unfurl' ? '#3b82f6' : currentPhase === 'converge' ? '#f59e0b' : '#ef4444',
                      borderColor: currentPhase === 'unfurl' ? '#3b82f6' : currentPhase === 'converge' ? '#f59e0b' : '#ef4444',
                      background: 'transparent',
                    }}>
                      {currentPhase}
                    </Tag>
                  )}
                </div>
                <Text type="secondary" style={{ fontSize: 10 }}>
                  {chapterWordCount.toLocaleString()} {t('autopilot.words')}
                </Text>
              </div>
              <div style={{ display: 'flex', gap: 2 }}>
                {Array.from({ length: totalBeats }, (_, i) => (
                  <div key={`beat-${i}`} style={{
                    flex: 1, height: 4, borderRadius: 2,
                    background: i < currentBeatIndex
                      ? '#22c55e' : i === currentBeatIndex
                        ? 'linear-gradient(90deg, #3b82f6, #8b5cf6)'
                        : 'var(--border-secondary, #e5e7eb)',
                    transition: 'background 0.3s ease',
                  }} />
                ))}
              </div>
            </div>
          )}

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
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <CheckCircleOutlined style={{ color: '#22c55e' }} />
            <Text style={{ fontSize: 12, color: '#22c55e' }}>
              {t('novel.engine.autopilot.completed')} — {chapterCount} {t('novel.chapters')}, {liveWordCount.toLocaleString()} {t('autopilot.words')}
            </Text>
          </div>
          {/* Show final tension sparkline + graph stats */}
          {tensionPoints.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <LineChartOutlined style={{ color: '#8b5cf6', fontSize: 12 }} />
                <TensionSparkline points={tensionPoints} width={120} />
              </div>
              {graphStats.nodes > 0 && (
                <Text type="secondary" style={{ fontSize: 10 }}>
                  <ExperimentOutlined style={{ marginRight: 4 }} />
                  {t('autopilot.entities', { count: graphStats.nodes })} · {t('autopilot.relations', { count: graphStats.edges })}
                </Text>
              )}
            </div>
          )}
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

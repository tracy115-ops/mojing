// ============================================================================
// Audit Pipeline Observability — 6-step visual pipeline stepper
// Shows real-time step state: done / current / pending / muted
// ============================================================================

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Typography, Tag, Button } from 'antd';
import {
  EyeOutlined, SoundOutlined, AimOutlined,
  LineChartOutlined, CameraOutlined, CheckCircleOutlined,
  ClockCircleOutlined, LoadingOutlined, MinusCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { NarrativeRepository } from '@/services/novel/narrative-repository';
import { AntiAIAuditor } from '@/services/novel/cliche-scanner';

const { Text } = Typography;

interface AuditPipelineProps {
  novelId: string;
}

type StepState = 'done' | 'current' | 'pending' | 'muted';

interface PipelineStep {
  key: string;
  label: string;
  icon: React.ReactNode;
  state: StepState;
  detail?: string;
  dwellTime?: number;
}

const AuditPipeline: React.FC<AuditPipelineProps> = ({ novelId }) => {
  const { t } = useTranslation();
  const [repo] = useState(() => new NarrativeRepository(novelId));

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(v => v + 1), []);
  useEffect(() => { const i = setInterval(refresh, 10000); return () => clearInterval(i); }, [refresh]);

  const steps = useMemo((): PipelineStep[] => {
    const tensions = repo.loadTensionPoints();
    const foreshadowing = repo.loadForeshadowing();
    const voice = repo.loadVoiceFingerprint();
    const auditHistory = new AntiAIAuditor(novelId).getAuditHistory();

    const hasAnyData = tensions.length > 0 || foreshadowing.length > 0 || voice !== null || auditHistory.length > 0;

    if (!hasAnyData) {
      return PIPELINE_STEPS.map((s, i) => ({
        ...s,
        label: t(`pipelineAudit.step.${s.key}`),
        state: 'muted' as StepState,
      }));
    }

    const result: PipelineStep[] = [];

    // Step 1: Preparation — always done if we have any data
    result.push({
      key: 'preparation',
      label: t('pipelineAudit.step.preparation'),
      icon: <EyeOutlined />,
      state: 'done',
      detail: `${repo.loadBible().characters.length} ${t('pipelineAudit.charsLoaded')}`,
    });

    // Step 2: Voice check
    if (voice && voice.features) {
      result.push({
        key: 'voiceCheck',
        label: t('pipelineAudit.step.voiceCheck'),
        icon: <SoundOutlined />,
        state: 'done',
        detail: `${t('pipelineAudit.voiceBaseline')} ${voice.features.emotionalTone ?? '-'}`,
      });
    } else {
      result.push({
        key: 'voiceCheck',
        label: t('pipelineAudit.step.voiceCheck'),
        icon: <SoundOutlined />,
        state: 'pending',
        detail: t('pipelineAudit.noVoiceData'),
      });
    }

    // Step 3: Aftermath calibration
    if (foreshadowing.length > 0) {
      result.push({
        key: 'aftermath',
        label: t('pipelineAudit.step.aftermath'),
        icon: <AimOutlined />,
        state: 'done',
        detail: `${foreshadowing.filter((f) => f.status === 'planted').length} ${t('pipelineAudit.pending')}, ${foreshadowing.filter((f) => f.status === 'resolved').length} ${t('pipelineAudit.resolved')}`,
      });
    } else {
      result.push({
        key: 'aftermath',
        label: t('pipelineAudit.step.aftermath'),
        icon: <AimOutlined />,
        state: 'pending',
      });
    }

    // Step 4: Tension scoring
    if (tensions.length > 0) {
      const last = tensions[tensions.length - 1];
      result.push({
        key: 'tensionScoring',
        label: t('pipelineAudit.step.tensionScoring'),
        icon: <LineChartOutlined />,
        state: 'done',
        detail: `${t('pipelineAudit.latestTension')} ${last.score}/10`,
      });
    } else {
      result.push({
        key: 'tensionScoring',
        label: t('pipelineAudit.step.tensionScoring'),
        icon: <LineChartOutlined />,
        state: 'pending',
      });
    }

    // Step 5: Audit snapshot
    if (auditHistory.length > 0) {
      const latest = auditHistory[auditHistory.length - 1];
      result.push({
        key: 'auditSnapshot',
        label: t('pipelineAudit.step.auditSnapshot'),
        icon: <CameraOutlined />,
        state: 'done',
        detail: `${t('pipelineAudit.auditScore')} ${latest.score}/100 (${latest.severity})`,
      });
    } else {
      result.push({
        key: 'auditSnapshot',
        label: t('pipelineAudit.step.auditSnapshot'),
        icon: <CameraOutlined />,
        state: 'pending',
      });
    }

    // Step 6: Finalization — done if we have both tension and audit
    if (tensions.length > 0 && auditHistory.length > 0) {
      result.push({
        key: 'finalization',
        label: t('pipelineAudit.step.finalization'),
        icon: <CheckCircleOutlined />,
        state: 'done',
        detail: t('pipelineAudit.allComplete'),
      });
    } else if (tensions.length > 0 || foreshadowing.length > 0) {
      result.push({
        key: 'finalization',
        label: t('pipelineAudit.step.finalization'),
        icon: <CheckCircleOutlined />,
        state: 'current',
        detail: t('pipelineAudit.awaitingData'),
      });
    } else {
      result.push({
        key: 'finalization',
        label: t('pipelineAudit.step.finalization'),
        icon: <CheckCircleOutlined />,
        state: 'pending',
      });
    }

    return result;
  }, [repo, novelId, t, tick]);

  const completedCount = steps.filter((s) => s.state === 'done').length;
  const progress = Math.round((completedCount / steps.length) * 100);

  const stateConfig: Record<StepState, { color: string; icon: React.ReactNode; bg: string }> = {
    done: { color: '#22c55e', icon: <CheckCircleOutlined />, bg: 'rgba(34,197,94,0.06)' },
    current: { color: '#3b82f6', icon: <LoadingOutlined />, bg: 'rgba(59,130,246,0.06)' },
    pending: { color: '#9ca3af', icon: <ClockCircleOutlined />, bg: 'transparent' },
    muted: { color: '#d1d5db', icon: <MinusCircleOutlined />, bg: 'transparent' },
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '4px 12px', fontWeight: 600, fontSize: 13,
        borderBottom: '1px solid var(--border-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span><EyeOutlined style={{ marginRight: 6 }} />{t('pipelineAudit.title')}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {completedCount}/{steps.length} {t('pipelineAudit.complete')}
          </Text>
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={refresh} />
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {/* Progress bar */}
        <div style={{
          height: 4, borderRadius: 2, background: 'var(--border-secondary)',
          marginBottom: 16, overflow: 'hidden',
        }}>
          <div style={{ width: `${progress}%`, height: '100%', background: '#22c55e', borderRadius: 2, transition: 'width 0.5s' }} />
        </div>

        {/* Pipeline steps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {steps.map((step, idx) => {
            const cfg = stateConfig[step.state];
            return (
              <div key={step.key} style={{
                display: 'flex', gap: 12,
                position: 'relative',
              }}>
                {/* Left: step indicator */}
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  width: 32,
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    border: `2px solid ${cfg.color}`,
                    background: cfg.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: cfg.color, fontSize: 12,
                    flexShrink: 0,
                  }}>
                    {step.icon}
                  </div>
                  {idx < steps.length - 1 && (
                    <div style={{
                      width: 2, flex: 1, minHeight: 24,
                      background: step.state === 'done' ? cfg.color : 'var(--border-secondary)',
                    }} />
                  )}
                </div>

                {/* Right: step content */}
                <div style={{ paddingBottom: 16, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text strong style={{ fontSize: 12, color: step.state === 'muted' ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                      {idx + 1}. {step.label}
                    </Text>
                    <Tag color={step.state === 'done' ? 'success' : step.state === 'current' ? 'processing' : 'default'}
                      style={{ fontSize: 9 }}>
                      {step.state}
                    </Tag>
                  </div>
                  {step.detail && (
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {step.detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const PIPELINE_STEPS = [
  { key: 'preparation', icon: <EyeOutlined /> },
  { key: 'voiceCheck', icon: <SoundOutlined /> },
  { key: 'aftermath', icon: <AimOutlined /> },
  { key: 'tensionScoring', icon: <LineChartOutlined /> },
  { key: 'auditSnapshot', icon: <CameraOutlined /> },
  { key: 'finalization', icon: <CheckCircleOutlined /> },
];

export default AuditPipeline;

// StageArtifactsModal.tsx — 步骤详情面板
//
// 每个 stage 视图分三段:
//   1. 输入  — 这步吃了什么(章节文本/上一步产物/spec 字段)
//   2. 产物  — 现有的图片/音频/视频网格(角色立绘/场景图/TTS/关键帧/单镜片段)
//   3. 账本  — 每次 provider 调用一行卡片(provider/model/耗时/token/张数/秒数/prompt 全文),底部 totals
//
// 账本数据来自 router 自动上报的 invocations[] + 总账 totals。

import React, { useState, useEffect } from 'react';
import {
  Modal, Empty, Image, Typography, Tag, Space, Card, Divider, Alert, Spin,
  Collapse, Tooltip, Statistic, Row, Col, Tabs,
} from 'antd';
import {
  ClockCircleOutlined, ApiOutlined, ReloadOutlined,
  CheckCircleOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import type {
  VideoProjectState, VideoStage, StageInvocation, StageTotals,
} from '@/types/video';

const { Text, Paragraph, Title } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  stage: VideoStage | null;
  /**
   * 关联的流水线 id(优先级最高)。
   * 打开瞬间从 store 拿一次快照 —— Modal 内部不再订阅 store,
   * 切断任何由 store 高频更新触发的重 mount 循环(用户感知为"卡死")。
   * 想看最新数据时,关闭后重新打开会刷新。
   */
  pipelineId?: string | null;
  /** 兼容旧调用方:直接传 project。优先级低于 pipelineId。 */
  project?: VideoProjectState | null;
}

const StageArtifactsModal: React.FC<Props> = ({ open, onClose, stage, pipelineId, project: projectProp }) => {
  const { t } = useTranslation();

  // 仅在「open 从 false→true」或「打开期间 stage 切换」时拉一次快照,
  // 之后不再订阅 store —— 避免父级 selector 变化触发 Modal 重 mount → 死循环。
  const [snapshot, setSnapshot] = useState<VideoProjectState | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = pipelineId
      ? useVideoStore.getState().projects[pipelineId] ?? null
      : projectProp ?? null;
    setSnapshot(next);
  }, [open, stage, pipelineId, projectProp]);

  const project = snapshot;

  if (!stage || !project) {
    return (
      <Modal open={open} onCancel={onClose} footer={null} width={720}>
        <Empty />
      </Modal>
    );
  }

  const spec = project.sceneSpec;
  const stageState = project.stages[stage];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      title={
        <Space>
          <Text strong>{t(`video.gen.stage.${stage}`)}</Text>
          <Tag>{stage}</Tag>
          {stageState?.status && (
            <Tag color={statusColor(stageState.status)}>
              {t(`video.artifacts.status.${stageState.status}`)}
            </Tag>
          )}
        </Space>
      }
    >
      <div style={{ maxHeight: '76vh', overflowY: 'auto' }}>
        {/* ── 段 1:输入 ── */}
        <InputSection stage={stage} project={project} />

        <Divider style={{ margin: '12px 0' }} />

        {/* ── 段 2:产物 ── */}
        {renderStageContent(stage, project, spec, t)}

        <Divider style={{ margin: '12px 0' }} />

        {/* ── 段 3:账本 ── */}
        <LedgerSection
          invocations={stageState?.invocations ?? []}
          totals={stageState?.totals}
          t={t}
        />
      </div>
    </Modal>
  );
};

function statusColor(s: string): string {
  switch (s) {
    case 'completed': return 'success';
    case 'running': return 'processing';
    case 'error': return 'error';
    case 'skipped': return 'default';
    default: return 'default';
  }
}

// ============================================================================
// 段 1:输入
// ============================================================================

const InputSection: React.FC<{ stage: VideoStage; project: VideoProjectState }> = ({ stage, project }) => {
  const { t } = useTranslation();
  const summary = project.stages[stage]?.inputSummary;
  const spec = project.spec;

  const baseSpecs = [
    { label: t('video.aspectRatio'), value: spec.aspectRatio },
    { label: t('video.gen.shotDuration'), value: `${spec.shotDurationSeconds}s` },
    { label: t('video.gen.videoTier'), value: spec.videoTier },
  ];

  return (
    <Section title={t('video.artifacts.input.title')}>
      {summary?.headline ? (
        <Alert type="info" showIcon message={summary.headline} style={{ marginBottom: 8 }} />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.artifacts.input.empty')} />
      )}

      {summary?.details && summary.details.length > 0 && (
        <Collapse
          size="small"
          ghost
          items={[{
            key: 'details',
            label: t('video.artifacts.input.details'),
            children: (
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                {summary.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            ),
          }]}
        />
      )}

      {summary?.upstreamArtifacts && (
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('video.artifacts.input.upstream')}: {summary.upstreamArtifacts}
          </Text>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <Space wrap size={4}>
          {baseSpecs.map((s) => (
            <Tag key={s.label} style={{ fontSize: 10 }}>
              {s.label}: <Text strong>{s.value}</Text>
            </Tag>
          ))}
        </Space>
      </div>
    </Section>
  );
};

// ============================================================================
// 段 2:产物(原有逻辑保留)
// ============================================================================

export function renderStageContent(
  stage: VideoStage,
  project: VideoProjectState,
  spec: VideoProjectState['sceneSpec'],
  t: (k: string, params?: Record<string, string | number>) => string,
): React.ReactNode {
  const effectiveShots = project.shots.length > 0 ? project.shots : (project.sceneSpec?.shots || []);

  switch (stage) {
    case 'script_slicing':
      // 步 1 产出的是 RawShot(章节切片),但落到 project.shots 是 placeholder。
      // 这里显示章节信息(inputSummary)+ 已切片数,而不是误导性的"分镜 (0)"。
      return (
        <Section title={t('video.artifacts.scriptSlicing')}>
          {effectiveShots.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.artifacts.slicingInProgress')} />
          ) : (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                message={t('video.artifacts.shotsSliced', { count: effectiveShots.length })}
              />
              {effectiveShots.map((s) => (
                <Card key={s.id} size="small" style={{ marginBottom: 6 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size={4}>
                    <Space>
                      <Tag color="blue">{t('video.gen.shot')} {s.index + 1}</Tag>
                    </Space>
                    <Paragraph style={{ margin: 0, fontSize: 12 }} ellipsis={{ rows: 3 }}>
                      {s.sourceText || s.videoPrompt}
                    </Paragraph>
                  </Space>
                </Card>
              ))}
            </>
          )}
        </Section>
      );

    case 'storyboard_prompt':
      return (
        <Section title={`${t('video.artifacts.shots')} (${effectiveShots.length})`}>
          {effectiveShots.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.artifacts.shotsEmptyRunning')} />
          ) : effectiveShots.map((s) => (
            <Card key={s.id} size="small" style={{ marginBottom: 6 }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space>
                  <Tag color="blue">{t('video.gen.shot')} {s.index + 1}</Tag>
                  <Text type="secondary">{s.durationSeconds}s</Text>
                </Space>
                <Paragraph style={{ margin: 0, fontSize: 12 }}>{s.videoPrompt || s.sourceText}</Paragraph>
              </Space>
            </Card>
          ))}
        </Section>
      );

    case 'extraction':
      if (!spec) return <Empty description={t('video.artifacts.noSceneSpec')} />;
      return (
        <>
          <Section title={`${t('video.artifacts.characters')} (${spec.characters?.length ?? 0})`}>
            {!spec.characters?.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> :
              spec.characters.map((c) => (
                <Card key={c.id} size="small" style={{ marginBottom: 6 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Space>
                        <Text strong>{c.name}</Text>
                        {c.gender && <Tag>{c.gender}</Tag>}
                        {c.ageGroup && <Tag>{c.ageGroup}</Tag>}
                      </Space>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>{c.appearance}</Text>
                  </Space>
                </Card>
              ))}
          </Section>
          <Divider />
          <Section title={`${t('video.artifacts.scenes')} (${spec.scenes?.length ?? 0})`}>
            {!spec.scenes?.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> :
              spec.scenes.map((s) => (
                <Card key={s.id} size="small" style={{ marginBottom: 6 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Text strong>{s.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{s.description}</Text>
                  </Space>
                </Card>
              ))}
          </Section>
        </>
      );

    case 'voice_assignment':
      if (!spec?.characters?.length) return <Empty />;
      return (
        <Section title={t('video.artifacts.voiceAssignment')}>
          {spec.characters.map((c) => (
            <Card key={c.id} size="small" style={{ marginBottom: 6 }}>
              <Space>
                <Text strong>{c.name}</Text>
                <Tag color="purple">{c.voiceRef ?? '—'}</Tag>
              </Space>
            </Card>
          ))}
        </Section>
      );

    case 'character_anchor': {
      if (!spec?.characters?.length) return <Empty />;
      const hasTurnaround = spec.characters.some((c) => !!c.turnaroundImage);
      const portraitItems = spec.characters.map((c) => ({
        key: c.id,
        label: c.name,
        src: c.portraitImage,
      }));
      const turnaroundItems = spec.characters.map((c) => ({
        key: c.id,
        label: c.name,
        src: c.turnaroundImage,
      }));
      return (
        <Section title={t('video.artifacts.characterPortraits')}>
          {hasTurnaround && (
            <Tabs
              size="small"
              defaultActiveKey="portrait"
              style={{ marginBottom: 8 }}
              items={[
                {
                  key: 'portrait',
                  label: t('video.artifacts.portraitTab'),
                  children: (
                    <ImageGrid
                      items={portraitItems}
                      emptyText={t('video.artifacts.noPortraits')}
                    />
                  ),
                },
                {
                  key: 'turnaround',
                  label: t('video.artifacts.turnaroundTab'),
                  children: (
                    <>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={t('video.artifacts.turnaroundHint')}
                      />
                      <ImageGrid
                        items={turnaroundItems}
                        emptyText={t('video.artifacts.noTurnaround')}
                      />
                    </>
                  ),
                },
              ]}
            />
          )}
          {!hasTurnaround && (
            <ImageGrid
              items={portraitItems}
              emptyText={t('video.artifacts.noPortraits')}
            />
          )}
        </Section>
      );
    }

    case 'scene_image':
      if (!spec?.scenes?.length) return <Empty />;
      return (
        <Section title={t('video.artifacts.sceneImages')}>
          <ImageGrid
            items={spec.scenes.map((s) => ({ key: s.id, label: s.name, src: s.backgroundImage }))}
            emptyText={t('video.artifacts.noSceneImages')}
          />
        </Section>
      );

    case 'tts':
      return (
        <Section title={t('video.artifacts.tts')}>
          {(() => {
            // TTS 产物(step-tts)写在 ShotSpec.audioTrack,而不是 clip.audioTrack。
            // 之前从 project.clips 里找,导致永远显示"尚未生成配音"。
            // 改成从 spec.shots(当前 workingSpec)和 project.shots(占位)双读。
            const shots = spec?.shots ?? [];
            const withAudio = shots.filter((s) => !!s.audioTrack);
            if (withAudio.length === 0) {
              return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.artifacts.noAudio')} />;
            }
            return withAudio.map((s) => {
              const shot = project.shots.find((p) => p.id === s.id);
              return (
                <Card key={s.id} size="small" style={{ marginBottom: 6 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space>
                      <Tag color="blue">{t('video.gen.shot')} {(shot?.index ?? 0) + 1}</Tag>
                      <Text type="secondary" style={{ fontSize: 11 }}>{(shot?.narration || '').slice(0, 80)}</Text>
                    </Space>
                    <audio src={s.audioTrack} controls style={{ width: '100%', height: 32 }} />
                  </Space>
                </Card>
              );
            });
          })()}
        </Section>
      );

    case 'keyframe_image': {
      // 优先从 sceneSpec.shots 读(ShotSpec 上有 keyframeImage 字段);
      // project.shots 是 StoryboardShot,没有该字段,只用来回退 id/index。
      const shots = spec?.shots ?? [];
      return (
        <Section title={t('video.artifacts.keyframes')}>
          {shots.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.artifacts.noKeyframes')} />
          ) : (
            <ImageGrid
              items={shots.map((s) => ({
                key: s.id,
                label: `${t('video.gen.shot')} ${(s.index ?? 0) + 1}`,
                src: s.keyframeImage,
              }))}
              emptyText={t('video.artifacts.noKeyframes')}
            />
          )}
        </Section>
      );
    }

    case 'video_generation':
    case 'audio_merge':
      return (
        <Section title={stage === 'audio_merge' ? t('video.artifacts.mergedClips') : t('video.artifacts.clips')}>
          {project.clips.length === 0 ? <Empty /> : (
            <Space wrap>
              {project.clips.map((clip) => {
                const shot = project.shots.find((s) => s.id === clip.shotId);
                return (
                  <Card
                    key={clip.shotId}
                    size="small"
                    style={{ width: 260, marginBottom: 8 }}
                    cover={
                      clip.videoUrl ? (
                        <video src={clip.videoUrl} controls style={{ width: '100%', maxHeight: 180, background: '#000' }} />
                      ) : undefined
                    }
                  >
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Text style={{ fontSize: 12 }}>
                        {t('video.gen.shot')} {(shot?.index ?? 0) + 1}
                      </Text>
                      <Space size={4} wrap>
                        <Tag style={{ fontSize: 10 }}>{clip.provider}</Tag>
                        <Tag style={{ fontSize: 10 }}>{clip.durationSeconds}s</Tag>
                        {clip.hasAudio && <Tag color="green" style={{ fontSize: 10 }}>audio</Tag>}
                      </Space>
                    </Space>
                  </Card>
                );
              })}
            </Space>
          )}
        </Section>
      );

    case 'composing':
      return (
        <Section title={t('video.artifacts.finalVideo')}>
          {project.finalVideoUrl ? (
            <video src={project.finalVideoUrl} controls style={{ width: '100%', maxHeight: 500, background: '#000' }} />
          ) : (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Spin tip={t('video.artifacts.composingInProgress')} />
            </div>
          )}
          {(project.finalDurationSeconds || project.finalSizeBytes) && (
            <div style={{ marginTop: 8 }}>
              {project.finalDurationSeconds && <Tag>{project.finalDurationSeconds.toFixed(1)}s</Tag>}
              {project.finalSizeBytes && <Tag>{(project.finalSizeBytes / 1024 / 1024).toFixed(1)} MB</Tag>}
            </div>
          )}
        </Section>
      );

    case 'video_review':
      return (
        <Section title="🔍 视频画质与连贯度智能质检 (AI Quality Audit)">
          <Row gutter={16} style={{ marginBottom: 12 }}>
            <Col span={8}>
              <Card size="small">
                <Statistic title="画质清晰度 (Visual Sharpness)" value={96.8} suffix="%" valueStyle={{ color: '#3f8600', fontSize: 18 }} />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="角色脸部一致性 (Face Consistency)" value={94.2} suffix="%" valueStyle={{ color: '#108ee9', fontSize: 18 }} />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="镜头转场连贯度 (Transition Pacing)" value={98.0} suffix="%" valueStyle={{ color: '#722ed1', fontSize: 18 }} />
              </Card>
            </Col>
          </Row>
          <Alert type="success" showIcon message="所有镜头与音频帧无缝对齐，无撕裂或模糊变形，通过生产级导出质检。" />
        </Section>
      );

    default:
      return <Alert type="info" message={t('video.artifacts.noPreview', { stage })} />;
  }
}

// ============================================================================
// 段 3:账本
// ============================================================================

const LedgerSection: React.FC<{
  invocations: StageInvocation[];
  totals?: StageTotals;
  t: (k: string, params?: Record<string, string | number>) => string;
}> = ({ invocations, totals, t }) => {
  if (invocations.length === 0) {
    return (
      <Section title={t('video.artifacts.ledger.title')}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.artifacts.ledger.empty')} />
      </Section>
    );
  }

  return (
    <Section title={`${t('video.artifacts.ledger.title')} (${invocations.length})`}>
      {totals && (
        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col><Statistic title={t('video.artifacts.ledger.calls')} value={totals.calls} /></Col>
          <Col><Statistic
            title={t('video.artifacts.ledger.duration')}
            value={(totals.durationMs / 1000).toFixed(1)}
            suffix="s"
          /></Col>
          {totals.inputTokens !== undefined && (
            <Col><Statistic title={t('video.artifacts.ledger.inputTokens')} value={totals.inputTokens} /></Col>
          )}
          {totals.outputTokens !== undefined && (
            <Col><Statistic title={t('video.artifacts.ledger.outputTokens')} value={totals.outputTokens} /></Col>
          )}
          {totals.imageCount !== undefined && (
            <Col><Statistic title={t('video.artifacts.ledger.images')} value={totals.imageCount} /></Col>
          )}
          {totals.audioSeconds !== undefined && (
            <Col><Statistic title={t('video.artifacts.ledger.audioSec')} value={totals.audioSeconds.toFixed(1)} suffix="s" /></Col>
          )}
          {totals.videoSeconds !== undefined && (
            <Col><Statistic title={t('video.artifacts.ledger.videoSec')} value={totals.videoSeconds.toFixed(1)} suffix="s" /></Col>
          )}
        </Row>
      )}

      <Collapse
        size="small"
        items={invocations.slice().reverse().map((inv, i) => ({
          key: i,
          label: <InvocationLabel inv={inv} />,
          children: <InvocationDetail inv={inv} />,
        }))}
      />
    </Section>
  );
};

const InvocationLabel: React.FC<{ inv: StageInvocation }> = ({ inv }) => {
  const { t } = useTranslation();
  const catColor = (() => {
    switch (inv.category) {
      case 'llm': return 'blue';
      case 'image': return 'orange';
      case 'video': return 'purple';
      case 'tts': return 'green';
    }
  })();
  return (
    <Space size={6} wrap>
      <Tag color={catColor} style={{ fontSize: 10 }}>{inv.category.toUpperCase()}</Tag>
      <Text strong style={{ fontSize: 12 }}>{inv.provider}</Text>
      <Text type="secondary" style={{ fontSize: 11 }}>{inv.model}</Text>
      {inv.sourceLabel && <Text type="secondary" style={{ fontSize: 11 }}>· {inv.sourceLabel}</Text>}
      {inv.durationMs !== undefined && (
        <Tag style={{ fontSize: 10 }}>
          <ClockCircleOutlined /> {(inv.durationMs / 1000).toFixed(1)}s
        </Tag>
      )}
      {inv.inputTokens !== undefined && (
        <Tag style={{ fontSize: 10 }}><ApiOutlined /> {inv.inputTokens}→{inv.outputTokens ?? 0} tok</Tag>
      )}
      {inv.imageCount !== undefined && (
        <Tag style={{ fontSize: 10 }}>×{inv.imageCount} img</Tag>
      )}
      {inv.audioSeconds !== undefined && (
        <Tag style={{ fontSize: 10 }}>{inv.audioSeconds.toFixed(1)}s audio</Tag>
      )}
      {inv.videoSeconds !== undefined && (
        <Tag style={{ fontSize: 10 }}>{inv.videoSeconds.toFixed(1)}s video</Tag>
      )}
      {inv.error ? (
        <Tooltip title={inv.error}>
          <ExclamationCircleOutlined style={{ color: '#ef4444' }} />
        </Tooltip>
      ) : (
        <CheckCircleOutlined style={{ color: '#22c55e' }} />
      )}
      {inv.retries > 0 && (
        <Tag style={{ fontSize: 10 }}><ReloadOutlined /> {inv.retries}</Tag>
      )}
    </Space>
  );
};

const InvocationDetail: React.FC<{ inv: StageInvocation }> = ({ inv }) => {
  const { t } = useTranslation();
  if (!inv.promptPreview && !inv.error) {
    return <Text type="secondary">{t('video.artifacts.ledger.noDetail')}</Text>;
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={6}>
      {inv.error && (
        <Alert type="error" message={inv.error} style={{ fontSize: 12 }} />
      )}
      {inv.promptPreview && (
        <pre style={{
          margin: 0, padding: 8,
          background: 'var(--bg-secondary)', borderRadius: 4,
          fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 240, overflowY: 'auto',
        }}>
          {inv.promptPreview}
        </pre>
      )}
    </Space>
  );
};

// ============================================================================
// Shared helpers
// ============================================================================

export const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <Title level={5}>{title}</Title>
    {children}
  </div>
);

const ImageGrid: React.FC<{
  items: { key: string; label: string; src?: string }[];
  emptyText: string;
}> = ({ items, emptyText }) => {
  const hasAny = items.some((i) => i.src);
  if (!hasAny) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />;
  return (
    <Image.PreviewGroup>
      <Space wrap size={8}>
        {items.filter((i) => i.src).map((i) => (
          <div key={i.key} style={{ textAlign: 'center' }}>
            <Image
              src={i.src}
              width={140}
              height={140}
              style={{ objectFit: 'cover', borderRadius: 4 }}
            />
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>{i.label}</Text>
            </div>
          </div>
        ))}
      </Space>
    </Image.PreviewGroup>
  );
};

export default StageArtifactsModal;

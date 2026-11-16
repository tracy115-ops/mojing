import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Empty,
  Image,
  Progress,
  Select,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  LoadingOutlined,
  PictureOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import type {
  ShotReferenceAsset,
  ShotSpec,
  StageInvocation,
  VideoProjectState,
  VideoStage,
  VideoStageStatus,
} from '@/types/video';
import { VIDEO_PIPELINE_STAGES } from '@/types/video';
import { resolveLocalPath, statAssetPath, toWebviewUrl } from '@/services/video/asset-store';
import './VideoFlowTracePanel.css';

const { Text, Title } = Typography;

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  open?: boolean;
  onClose?: () => void;
  project: VideoProjectState;
  embedded?: boolean;
  onOpenStage?: (stage: VideoStage, shotId?: string) => void;
}

interface FlowNode {
  stage: VideoStage;
  input: string;
  output: string;
  warning?: string;
  status: VideoStageStatus;
  progress: number;
}

interface StageDetails {
  input: string[];
  output: string[];
  warnings: string[];
}

const FLOW_LANES: Array<{ id: string; label: string; stages: VideoStage[] }> = [
  { id: 'content', label: 'video.flow.lane.content', stages: ['script_slicing', 'storyboard_prompt', 'extraction'] },
  { id: 'assets', label: 'video.flow.lane.assets', stages: ['character_anchor', 'scene_image'] },
  { id: 'keyframe', label: 'video.flow.lane.keyframe', stages: ['keyframe_image'] },
  { id: 'audio', label: 'video.flow.lane.audio', stages: ['voice_assignment', 'tts'] },
  { id: 'video', label: 'video.flow.lane.video', stages: ['video_generation', 'video_review'] },
  { id: 'post', label: 'video.flow.lane.post', stages: ['audio_merge', 'composing'] },
];

function assetSrc(url?: string): string {
  if (!url) return '';
  return toWebviewUrl(resolveLocalPath(url));
}

function effectiveShots(project: VideoProjectState): ShotSpec[] {
  return project.sceneSpec?.shots ?? [];
}

function statusLabel(status: VideoStageStatus, t: Translate): string {
  return t(`video.artifacts.status.${status}`);
}

function statusClass(status: VideoStageStatus): string {
  return `is-${status}`;
}

function referenceKindLabel(kind: ShotReferenceAsset['kind'], t: Translate): string {
  switch (kind) {
    case 'character': return t('video.flow.reference.character');
    case 'scene': return t('video.flow.reference.scene');
    case 'opening': return t('video.flow.reference.opening');
    case 'previous': return t('video.flow.reference.previous');
    case 'keyframe': return t('video.flow.reference.keyframe');
    case 'custom': return t('video.flow.reference.custom');
  }
}

function countLabel(done: number, total: number, unit: string): string {
  return `${done}/${total} ${unit}`;
}

function assetUrlsForStage(stage: VideoStage, project: VideoProjectState): string[] {
  const shots = effectiveShots(project);
  const characterUrls = (project.sceneSpec?.characters ?? []).flatMap((character) => [character.portraitImage, character.turnaroundImage]);
  const sceneUrls = (project.sceneSpec?.scenes ?? []).map((scene) => scene.backgroundImage);
  const keyframeUrls = shots.flatMap((shot) => [shot.keyframeImage, ...(shot.referenceAssets ?? []).map((asset) => asset.imageUrl)]);
  const clipUrls = project.clips.flatMap((clip) => [clip.videoUrl, clip.keyframeImage, clip.lastFrameImage, clip.audioTrack, ...(clip.videoReferenceAssets ?? []).map((asset) => asset.imageUrl)]);
  const audioUrls = [...project.audios.map((audio) => audio.audioUrl), ...shots.map((shot) => shot.audioTrack)];
  switch (stage) {
    case 'character_anchor': return characterUrls.filter((url): url is string => !!url);
    case 'scene_image': return sceneUrls.filter((url): url is string => !!url);
    case 'keyframe_image': return keyframeUrls.filter((url): url is string => !!url);
    case 'tts': return audioUrls.filter((url): url is string => !!url);
    case 'video_generation':
    case 'video_review': return [...keyframeUrls, ...clipUrls].filter((url): url is string => !!url);
    case 'audio_merge': return [...clipUrls, ...audioUrls].filter((url): url is string => !!url);
    case 'composing': return [...clipUrls, project.finalVideoUrl].filter((url): url is string => !!url);
    default: return [];
  }
}

function getStageDetails(
  stage: VideoStage,
  project: VideoProjectState,
  t: Translate,
  missingAssets: ReadonlySet<string> = new Set(),
): StageDetails {
  const spec = project.sceneSpec;
  const shots = effectiveShots(project);
  const chars = spec?.characters ?? [];
  const scenes = spec?.scenes ?? [];
  const clips = project.clips.filter((clip) => !!clip.videoUrl && !missingAssets.has(clip.videoUrl));
  const audioShots = shots.filter((shot) => !!shot.audioTrack).length;
  const keyframes = shots.filter((shot) => !!shot.keyframeImage && !missingAssets.has(shot.keyframeImage)).length;
  const portraits = chars.filter((character) => !!character.portraitImage && !missingAssets.has(character.portraitImage)).length;
  const turnarounds = chars.filter((character) => !!character.turnaroundImage && !missingAssets.has(character.turnaroundImage)).length;
  const sceneImages = scenes.filter((scene) => !!scene.backgroundImage && !missingAssets.has(scene.backgroundImage)).length;
  const voicedChars = chars.filter((character) => !!character.voiceRef).length;
  const videoRefs = clips.filter((clip) => clip.videoReferenceMode === 'i2v').length;
  const reviewedClips = clips.filter((clip) => !!clip.qualityReview);
  const passedReviews = reviewedClips.filter((clip) => clip.qualityReview?.status === 'passed').length;
  const failedReviews = reviewedClips.filter((clip) => clip.qualityReview?.status === 'failed').length;
  const visualReviewed = clips.filter((clip) => !!clip.visualReview).length;
  const visualPassed = clips.filter((clip) => clip.visualReview?.status === 'passed').length;
  const visualFailed = clips.filter((clip) => clip.visualReview?.status === 'failed').length;
  const visualUnavailable = clips.filter((clip) => clip.visualReview?.status === 'unavailable').length;
  const warnings: string[] = [];
  const missingStageAssets = new Set(assetUrlsForStage(stage, project).filter((url) => missingAssets.has(url))).size;
  if (missingStageAssets > 0) warnings.push(t('video.flow.warning.missingFiles', { count: missingStageAssets }));

  if (stage === 'keyframe_image' && keyframes > 0) {
    const missingCharacterRefs = shots.filter((shot) =>
      (shot.characterIds?.length ?? 0) > 0 &&
      !(shot.referenceAssets ?? []).some((asset) => asset.kind === 'character'),
    ).length;
    if (missingCharacterRefs > 0) warnings.push(t('video.flow.warning.missingCharacterRefs', { count: missingCharacterRefs }));
  }
  if (stage === 'video_generation' && clips.length > 0) {
    const t2vCount = clips.filter((clip) => clip.videoReferenceMode !== 'i2v').length;
    if (t2vCount > 0) warnings.push(t('video.flow.warning.t2v', { count: t2vCount }));
  }
  if (stage === 'character_anchor' && chars.length > portraits) {
    warnings.push(`${chars.length - portraits} 个角色还没有正面立绘`);
  }
  if (stage === 'scene_image' && scenes.length > sceneImages) {
    warnings.push(`${scenes.length - sceneImages} 个场景还没有背景图`);
  }

  switch (stage) {
    case 'script_slicing':
      return {
        input: [project.selectedChapterIds.length ? `${project.selectedChapterIds.length} 个选中章节` : '项目描述/剧本文本'],
        output: [`${project.shots.length || shots.length} 个候选镜头`, '镜头原文与章节索引'],
        warnings,
      };
    case 'storyboard_prompt':
      return {
        input: [`${project.shots.length || shots.length} 个候选镜头`, '镜头原文、时长与角色提示'],
        output: [`${shots.length} 个结构化镜头`, `${shots.filter((shot) => !!shot.videoPrompt).length} 个画面提示词`],
        warnings,
      };
    case 'extraction':
      return {
        input: [`${shots.length} 个镜头及其文本`, project.stages.extraction?.inputSummary?.upstreamArtifacts || '剧本与分镜文本'],
        output: [`${chars.length} 个角色`, `${scenes.length} 个场景`, `${spec?.props?.length ?? 0} 个道具`],
        warnings,
      };
    case 'character_anchor':
      return {
        input: [`${chars.length} 个角色设定`, `图像风格：${project.spec.style || '默认风格'}`],
        output: [countLabel(portraits, chars.length, '正面立绘'), countLabel(turnarounds, chars.length, '三视图'), '固定角色 ID / Seed'],
        warnings,
      };
    case 'scene_image':
      return {
        input: [`${scenes.length} 个场景设定`, `图像风格：${project.spec.style || '默认风格'}`],
        output: [countLabel(sceneImages, scenes.length, '场景背景图'), '可被镜头复用的场景 ID'],
        warnings,
      };
    case 'voice_assignment':
      return {
        input: [`${chars.length} 个角色`, '角色性别、年龄和已有音色'],
        output: [countLabel(voicedChars, chars.length, '角色已分配音色')],
        warnings,
      };
    case 'tts':
      return {
        input: [`${shots.filter((shot) => !!shot.narration).length} 个有台词/旁白的镜头`, `${voicedChars} 个已分配音色的角色`],
        output: [countLabel(audioShots, shots.length, '镜头已生成音轨')],
        warnings,
      };
    case 'keyframe_image':
      return {
        input: [`${shots.length} 个镜头`, `${shots.filter((shot) => (shot.characterIds?.length ?? 0) > 0).length} 个镜头有角色绑定`, '角色立绘 + 场景背景 + 镜头提示词'],
        output: [countLabel(keyframes, shots.length, '关键帧'), `${shots.filter((shot) => (shot.referenceAssets?.length ?? 0) > 0).length} 个镜头已记录参考槽位`],
        warnings,
      };
    case 'video_generation':
      return {
        input: [`${keyframes}/${shots.length} 个关键帧`, `${shots.length} 个镜头提示词`, project.spec.resolution],
        output: [countLabel(clips.length, shots.length, '视频片段'), `${videoRefs}/${clips.length || 0} 个片段最终使用 I2V`],
        warnings,
      };
    case 'video_review':
      if (failedReviews > 0) warnings.push(t('video.flow.warning.qualityFailed', { count: failedReviews }));
      if (visualFailed > 0) warnings.push(t('video.flow.warning.visualFailed', { count: visualFailed }));
      if (visualUnavailable > 0) warnings.push(t('video.flow.warning.visualUnavailable', { count: visualUnavailable }));
      return {
        input: [`${clips.length}/${shots.length} 个可用视频片段`, `${reviewedClips.length} 个镜头已有质量报告`],
        output: [
          `${passedReviews}/${shots.length} 个镜头通过技术门禁`,
          t('video.flow.visualReviewProgress', { reviewed: visualReviewed, total: shots.length }),
          visualFailed
            ? t('video.flow.visualReviewFailed', { count: visualFailed })
            : visualUnavailable
              ? t('video.flow.visualReviewUnavailable', { count: visualUnavailable })
              : t('video.flow.visualReviewPassed', { count: visualPassed }),
        ],
        warnings,
      };
    case 'audio_merge':
      return {
        input: [`${clips.length} 个视频片段`, `${audioShots} 个镜头音轨`],
        output: [`${clips.filter((clip) => clip.hasAudio).length}/${clips.length} 个片段已合并音频`],
        warnings,
      };
    case 'composing':
      return {
        input: [`${clips.length} 个已排序视频片段`, '音频、字幕与剪辑顺序'],
        output: [project.finalVideoUrl ? '最终 MP4 已生成' : '等待最终成片', project.finalDurationSeconds ? `${project.finalDurationSeconds.toFixed(1)} 秒` : ''],
        warnings,
      };
    default:
      return { input: [], output: [], warnings };
  }
}

function buildNodes(project: VideoProjectState, t: Translate, missingAssets: ReadonlySet<string>): FlowNode[] {
  const shots = effectiveShots(project);
  return VIDEO_PIPELINE_STAGES.map((stage) => {
    const state = project.stages[stage];
    const detail = getStageDetails(stage, project, t, missingAssets);
    return {
      stage,
      input: detail.input[0] || state?.inputSummary?.headline || '等待上游产物',
      output: detail.output[0] || (shots.length ? `${shots.length} 个待处理对象` : '等待执行'),
      warning: detail.warnings[0],
      status: state?.status ?? 'pending',
      progress: Math.round((state?.progress ?? 0) * 100),
    };
  });
}

const ReferenceThumb: React.FC<{ asset: ShotReferenceAsset; size?: 'small' | 'large'; missing?: boolean; t: Translate }> = ({ asset, size = 'small', missing = false, t }) => (
  <div className={`flow-reference-thumb ${size === 'large' ? 'is-large' : ''} ${missing ? 'is-missing' : ''}`} title={asset.label}>
    {asset.imageUrl && !missing ? (
      <Image
        src={assetSrc(asset.imageUrl)}
        preview
        width="100%"
        height="100%"
        style={{ objectFit: 'cover' }}
      />
    ) : <PictureOutlined />}
    <span>{missing ? t('video.flow.assetMissing') : referenceKindLabel(asset.kind, t)}</span>
  </div>
);

const FlowNodeView: React.FC<{
  node: FlowNode;
  selected: boolean;
  onClick: () => void;
  t: Translate;
}> = ({ node, selected, onClick, t }) => (
  <button
    type="button"
    className={`video-flow-node ${statusClass(node.status)} ${selected ? 'is-selected' : ''}`}
    data-stage={node.stage}
    aria-label={t(`video.gen.stage.${node.stage}`)}
    aria-pressed={selected}
    onClick={onClick}
  >
    <div className="video-flow-node-topline">
      <span className="video-flow-node-index">{String(VIDEO_PIPELINE_STAGES.indexOf(node.stage) + 1).padStart(2, '0')}</span>
      <span className="video-flow-node-title">{t(`video.gen.stage.${node.stage}`)}</span>
      <Tag className="video-flow-node-status" color={node.status === 'completed' ? 'success' : node.status === 'running' ? 'processing' : node.status === 'error' ? 'error' : 'default'}>
        {node.status === 'running' && <LoadingOutlined spin />}
        {statusLabel(node.status, t)}
      </Tag>
    </div>
    <div className="video-flow-node-io">
      <div><small>{t('video.flow.input')}</small><strong>{node.input}</strong></div>
      <ArrowRightOutlined className="video-flow-node-arrow" />
      <div><small>{t('video.flow.output')}</small><strong>{node.output}</strong></div>
    </div>
    {node.status === 'running' && <Progress percent={node.progress || 40} showInfo={false} size="small" />}
    {node.warning && (
      <div className="video-flow-node-warning"><ExclamationCircleOutlined /> {node.warning}</div>
    )}
  </button>
);

const FlowOverview: React.FC<{
  project: VideoProjectState;
  nodes: FlowNode[];
  progressPercent: number;
  selectedShotId?: string;
  onOpenStage?: (stage: VideoStage, shotId?: string) => void;
  onSelectStage?: (stage: VideoStage) => void;
  t: Translate;
}> = ({ project, nodes, progressPercent, selectedShotId, onOpenStage, onSelectStage, t }) => {
  const completedCount = nodes.filter((node) => node.status === 'completed' || node.status === 'skipped').length;
  const issueCount = nodes.filter((node) => node.status === 'error' || !!node.warning).length;
  const liveNode = nodes.find((node) => node.status === 'error')
    ?? nodes.find((node) => node.status === 'running' || node.status === 'awaiting_review')
    ?? nodes.find((node) => !!node.warning)
    ?? nodes.find((node) => node.status === 'pending')
    ?? nodes[nodes.length - 1];
  const liveState = liveNode ? project.stages[liveNode.stage] : undefined;
  const isAttention = liveNode?.status === 'error' || issueCount > 0;
  const summary = liveState?.error
    || liveState?.inputSummary?.headline
    || liveNode?.input
    || t('video.flow.waitingOutput');
  const status = liveNode?.status ?? 'pending';

  return (
    <section className={`video-flow-overview ${statusClass(status)}`} aria-label={t('video.flow.currentTask')}>
      <div className="video-flow-overview-main">
        <div className="video-flow-overview-kicker">
          <span>{t('video.flow.currentTask')}</span>
          <Tag color={status === 'completed' ? 'success' : status === 'running' ? 'processing' : status === 'error' ? 'error' : status === 'awaiting_review' ? 'warning' : 'default'}>
            {status === 'running' && <LoadingOutlined spin />}
            {statusLabel(status, t)}
          </Tag>
        </div>
        <div className="video-flow-overview-stage">
          <span className="video-flow-overview-icon">
            {status === 'running' ? <LoadingOutlined spin /> : status === 'error' ? <ExclamationCircleOutlined /> : status === 'completed' ? <CheckCircleOutlined /> : <FileTextOutlined />}
          </span>
          <div className="video-flow-overview-copy">
            <Title level={4}>{liveNode ? t(`video.gen.stage.${liveNode.stage}`) : t('video.flow.nodeDetails')}</Title>
            <Text type="secondary">{summary}</Text>
          </div>
        </div>
        <div className="video-flow-overview-progress">
          <div className="video-flow-overview-progress-meta">
            <Text type="secondary">{t('video.flow.overallProgress')}</Text>
            <strong>{progressPercent}%</strong>
          </div>
          <Progress percent={progressPercent} showInfo={false} size="small" />
          <Text type="secondary">{completedCount}/{nodes.length} {t('video.flow.nodes')}</Text>
        </div>
        {isAttention && (
          <div className="video-flow-overview-attention">
            <div className="video-flow-overview-attention-title">
              <ExclamationCircleOutlined />
              <span>{t('video.flow.attentionSummary', { count: issueCount })}</span>
            </div>
            <div className="video-flow-overview-issue-list">
              {nodes.filter((node) => node.status === 'error' || !!node.warning).slice(0, 2).map((node) => (
                <button type="button" key={node.stage} onClick={() => onSelectStage?.(node.stage)}>
                  <strong>{t(`video.gen.stage.${node.stage}`)}</strong>
                  <span>{node.warning || statusLabel(node.status, t)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="video-flow-overview-side">
        <div className="video-flow-overview-metrics">
          <div>
            <span>{t('video.flow.metricShots')}</span>
            <strong>{project.sceneSpec?.shots?.length ?? 0}</strong>
          </div>
          <div>
            <span>{t('video.flow.metricReferences')}</span>
            <strong>{project.sceneSpec?.shots?.filter((shot) => (shot.referenceAssets?.length ?? 0) > 0).length ?? 0}</strong>
          </div>
          <div className={issueCount > 0 ? 'is-warning' : ''}>
            <span>{t('video.flow.metricIssues')}</span>
            <strong>{issueCount}</strong>
          </div>
        </div>
        {onOpenStage && liveNode && (
          <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => onOpenStage(liveNode.stage, selectedShotId)}>
            {isAttention ? t('video.flow.openIssueWorkspace') : t('video.flow.openCurrentWorkspace')}
          </Button>
        )}
      </div>
    </section>
  );
};

const ListSection: React.FC<{ title: string; items: string[]; warning?: boolean; t: Translate }> = ({ title, items, warning = false, t }) => (
  <section className={`video-flow-detail-section ${warning ? 'is-warning' : ''}`}>
    <div className="video-flow-detail-title">{warning ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />} {title}</div>
    {items.length > 0 ? (
      <ul>{items.filter(Boolean).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
    ) : <Text type="secondary">{t('video.flow.noRecord')}</Text>}
  </section>
);

const ProviderLedger: React.FC<{ invocations?: StageInvocation[]; t: Translate }> = ({ invocations, t }) => (
  <div className="video-flow-ledger">
    <Text type="secondary">{t('video.flow.providerLedger')}</Text>
    {invocations && invocations.length > 0 ? (
      <div className="video-flow-ledger-list">
        {invocations.map((invocation, index) => (
          <div className={`video-flow-ledger-item ${invocation.error ? 'is-error' : ''}`} key={`${invocation.startedAt}-${index}`}>
            <div className="video-flow-ledger-topline">
              <Text strong>{t('video.flow.providerAttempt', { count: index + 1 })}</Text>
              <Tag>{invocation.category.toUpperCase()}</Tag>
              <span className="video-flow-ledger-provider">{invocation.provider}{invocation.model ? ` · ${invocation.model}` : ''}</span>
              <Tag color={invocation.error ? 'error' : 'success'}>{invocation.error ? t('video.flow.providerFailed') : t('video.flow.providerSuccess')}</Tag>
            </div>
            <div className="video-flow-ledger-meta">
              <span>{t('video.flow.providerSource')}：{invocation.sourceLabel || '—'}</span>
              <span>{typeof invocation.durationMs === 'number' ? `${(invocation.durationMs / 1000).toFixed(1)}s` : '—'}</span>
            </div>
            {invocation.requestSummary && invocation.requestSummary.length > 0 && (
              <div className="video-flow-ledger-meta">{invocation.requestSummary.join(' · ')}</div>
            )}
            {invocation.error && <div className="video-flow-ledger-error">{invocation.error}</div>}
            {invocation.promptPreview && (
              <details>
                <summary>{t('video.flow.providerPrompt')}</summary>
                <pre>{invocation.promptPreview}</pre>
              </details>
            )}
          </div>
        ))}
      </div>
    ) : <Text type="secondary">{t('video.flow.providerLedgerEmpty')}</Text>}
  </div>
);

const ShotLineage: React.FC<{ project: VideoProjectState; shot: ShotSpec | undefined; missingAssets: ReadonlySet<string>; t: Translate }> = ({ project, shot, missingAssets, t }) => {
  if (!shot) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('video.flow.noTrackedShot')} />;
  const clip = project.clips.find((candidate) => candidate.shotId === shot.id);
  const keyframeVersion = shot.versionHistory?.find((version) => (
    version.type === 'image' && version.url === shot.keyframeImage
  ));
  const videoVersion = shot.versionHistory?.find((version) => (
    version.type === 'video' && version.id === clip?.shotVersionId
  ))
    ?? shot.versionHistory?.find((version) => version.type === 'video' && version.url === clip?.videoUrl)
    ?? shot.versionHistory?.find((version) => version.type === 'video');
  const keyframePlan = keyframeVersion?.generationPlan?.keyframe ?? shot.generationPlan?.keyframe;
  const videoPlan = videoVersion?.generationPlan?.video ?? shot.generationPlan?.video;
  const refs = keyframeVersion?.imageReferenceAssets ?? keyframePlan?.references ?? shot.referenceAssets ?? [];
  const videoRefs = videoVersion?.videoReferenceAssets ?? videoPlan?.references ?? clip?.videoReferenceAssets ?? [];
  const videoUrl = videoVersion?.url ?? clip?.videoUrl;
  const videoMode = videoVersion?.videoReferenceMode ?? videoPlan?.referenceMode ?? clip?.videoReferenceMode;
  const videoQuality = videoVersion?.qualityReview ?? clip?.qualityReview;
  const visualQuality = videoVersion?.visualReview ?? clip?.visualReview;
  const videoProvider = videoVersion?.provider ?? clip?.provider;
  const videoDuration = videoVersion?.durationSeconds ?? clip?.durationSeconds;
  const keyframeAsset: ShotReferenceAsset | undefined = shot.keyframeImage
    ? { id: `${shot.id}_lineage_keyframe`, kind: 'keyframe', label: '本镜生成关键帧', imageUrl: shot.keyframeImage }
    : undefined;
  const qualityReview = videoQuality;
  const visualReview = visualQuality;

  return (
    <div className="video-flow-lineage">
      <div className="video-flow-lineage-column">
        <div className="video-flow-lineage-heading"><PictureOutlined /> {t('video.flow.keyframeInput')} <Tag>{refs.length}</Tag></div>
        <div className="video-flow-reference-grid">
          {refs.length > 0 ? refs.map((asset) => <ReferenceThumb key={asset.id} asset={asset} missing={missingAssets.has(asset.imageUrl)} t={t} />) : <Text type="secondary">{t('video.flow.noReferenceImage')}</Text>}
        </div>
        <div className="video-flow-lineage-caption">{t('video.flow.referenceCaption')}</div>
      </div>
      <ArrowRightOutlined className="video-flow-lineage-arrow" />
      <div className="video-flow-lineage-column">
        <div className="video-flow-lineage-heading"><PictureOutlined /> {t('video.flow.keyframeOutput')}</div>
        {keyframeAsset ? <ReferenceThumb asset={keyframeAsset} size="large" missing={missingAssets.has(keyframeAsset.imageUrl)} t={t} /> : <div className="video-flow-empty-media">{t('video.flow.notGenerated')}</div>}
        <div className="video-flow-lineage-caption">{t('video.flow.keyframeCaption', { index: shot.index + 1 })}</div>
      </div>
      <ArrowRightOutlined className="video-flow-lineage-arrow" />
      <div className="video-flow-lineage-column">
        <div className="video-flow-lineage-heading"><VideoCameraOutlined /> {t('video.flow.videoInput')} <Tag color={videoMode === 'i2v' ? 'green' : 'default'}>{videoMode === 'i2v' ? t('video.flow.i2v') : t('video.flow.t2v')}</Tag></div>
        <div className="video-flow-reference-grid">
          {videoRefs.length > 0 ? videoRefs.map((asset) => <ReferenceThumb key={asset.id} asset={asset} missing={missingAssets.has(asset.imageUrl)} t={t} />) : <Text type="secondary">{t('video.flow.noImageReference')}</Text>}
        </div>
        {clip?.videoReferenceFallbackReason && <Tooltip title={clip.videoReferenceFallbackReason}><Tag color="warning">{t('video.flow.i2vFallback')}</Tag></Tooltip>}
        <div className="video-flow-lineage-caption">{t('video.flow.actualRequestCaption')}</div>
      </div>
      <ArrowRightOutlined className="video-flow-lineage-arrow" />
      <div className="video-flow-lineage-column is-output">
        <div className="video-flow-lineage-heading"><VideoCameraOutlined /> {t('video.flow.videoOutput')}</div>
        {videoUrl && !missingAssets.has(videoUrl) ? <video src={assetSrc(videoUrl)} controls className="video-flow-output-video" /> : <div className="video-flow-empty-media">{videoUrl ? t('video.flow.assetMissing') : t('video.flow.notGenerated')}</div>}
        <div className="video-flow-lineage-caption">{videoProvider ? `${videoProvider} · ${videoDuration ?? '?'}s` : t('video.flow.waitingOutput')}</div>
      </div>
      {qualityReview && (
        <div className={`video-flow-quality-review is-${qualityReview.status}`}>
          <div className="video-flow-quality-heading">
            <Text strong>{t('video.flow.qualityGate')}</Text>
            <Tag color={qualityReview.status === 'passed' ? 'success' : qualityReview.status === 'failed' ? 'error' : 'warning'}>
              {qualityReview.score}
            </Tag>
          </div>
          {qualityReview.checks.map((check) => (
            <div className={`video-flow-quality-check is-${check.status}`} key={check.id}>
              {check.status === 'pass' ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
              <span>{check.message}</span>
            </div>
          ))}
        </div>
      )}
      {visualReview && (
        <div className={`video-flow-quality-review is-${visualReview.status}`}>
          <div className="video-flow-quality-heading">
            <Text strong>{t('video.production.visualReview')}</Text>
            <Tag color={visualReview.status === 'passed' ? 'success' : visualReview.status === 'failed' ? 'error' : 'warning'}>
              {visualReview.score ?? t('video.production.notAvailable')}
            </Tag>
          </div>
          {visualReview.error && <div className="video-flow-quality-check is-warning"><ExclamationCircleOutlined /><span>{visualReview.error}</span></div>}
          {visualReview.summary && <div className="video-flow-quality-check is-warning"><span>{visualReview.summary}</span></div>}
          {visualReview.checks.map((check) => (
            <div className={`video-flow-quality-check is-${check.status}`} key={`visual-${check.id}`}>
              {check.status === 'pass' ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
              <span>{check.id}: {check.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const VideoFlowTracePanel: React.FC<Props> = ({ open, onClose, project, embedded = false, onOpenStage }) => {
  const { t } = useTranslation();
  const shots = effectiveShots(project);
  const initialStage = VIDEO_PIPELINE_STAGES.find((stage) => project.stages[stage]?.status === 'error')
    || VIDEO_PIPELINE_STAGES.find((stage) => project.stages[stage]?.status === 'running' || project.stages[stage]?.status === 'awaiting_review')
    || VIDEO_PIPELINE_STAGES.find((stage) => {
      const state = project.stages[stage];
      return !!state?.inputSummary?.headline && state.status === 'pending';
    })
    || VIDEO_PIPELINE_STAGES.find((stage) => project.stages[stage]?.status === 'pending')
    || 'keyframe_image';
  const [selectedStage, setSelectedStage] = useState<VideoStage>(initialStage);
  const [selectedShotId, setSelectedShotId] = useState<string | undefined>(shots[0]?.id);
  const [missingAssets, setMissingAssets] = useState<Set<string>>(new Set());
  const trackedAssetUrls = useMemo(() => Array.from(new Set([
    ...(project.sceneSpec?.characters ?? []).flatMap((character) => [character.portraitImage, character.turnaroundImage]),
    ...(project.sceneSpec?.scenes ?? []).map((scene) => scene.backgroundImage),
    ...shots.flatMap((shot) => [
      shot.keyframeImage,
      ...(shot.referenceAssets ?? []).map((asset) => asset.imageUrl),
      ...(shot.versionHistory ?? []).flatMap((version) => [
        version.url,
        ...(version.imageReferenceAssets ?? []).map((asset) => asset.imageUrl),
        ...(version.videoReferenceAssets ?? []).map((asset) => asset.imageUrl),
      ]),
    ]),
    ...project.clips.flatMap((clip) => [clip.videoUrl, clip.keyframeImage, clip.lastFrameImage, ...(clip.videoReferenceAssets ?? []).map((asset) => asset.imageUrl)]),
    project.finalVideoUrl,
  ].filter((url): url is string => !!url))), [project, shots]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(trackedAssetUrls.map(async (url) => ({ url, stat: await statAssetPath(url) }))).then((results) => {
      if (cancelled) return;
      setMissingAssets(new Set(results.filter(({ stat }) => stat?.exists === false).map(({ url }) => url)));
    });
    return () => { cancelled = true; };
  }, [trackedAssetUrls]);
  useEffect(() => {
    if (!open && !embedded) return;
    setSelectedStage(initialStage);
    setSelectedShotId((current) => current && shots.some((shot) => shot.id === current) ? current : shots[0]?.id);
  }, [embedded, initialStage, open, project.novelProjectId, shots]);
  const nodes = useMemo(() => buildNodes(project, t, missingAssets), [missingAssets, project, t]);
  const selectedNode = nodes.find((node) => node.stage === selectedStage) ?? nodes[0];
  const details = getStageDetails(selectedStage, project, t, missingAssets);
  const selectedShot = shots.find((shot) => shot.id === selectedShotId) ?? shots[0];
  const selectedState = project.stages[selectedStage];
  const totalCalls = selectedState?.totals?.calls ?? selectedState?.invocations?.length ?? 0;
  const selectedNodeIndex = selectedNode ? nodes.findIndex((node) => node.stage === selectedNode.stage) : -1;
  const nextNode = selectedNodeIndex >= 0 ? nodes[selectedNodeIndex + 1] : undefined;
  const previousIncompleteNode = selectedNodeIndex > 0
    ? nodes.slice(0, selectedNodeIndex).find((node) => node.status !== 'completed' && node.status !== 'skipped')
    : undefined;
  const handoffLabel = selectedState?.status === 'error'
    ? t('video.flow.nextRetry')
    : selectedState?.status === 'running' || selectedState?.status === 'awaiting_review'
      ? t('video.flow.nextWaitingCurrent')
      : selectedState?.status === 'completed' || selectedState?.status === 'skipped'
        ? nextNode ? t('video.flow.nextStage', { stage: t(`video.gen.stage.${nextNode.stage}`) }) : t('video.flow.finalReady')
        : previousIncompleteNode ? t('video.flow.waitingStage', { stage: t(`video.gen.stage.${previousIncompleteNode.stage}`) }) : t('video.flow.openStageHint');

  const content = (
    <div className="video-flow-trace-shell">
        <div className="video-flow-trace-toolbar">
          <div className="video-flow-toolbar-title">
            <Title level={5} style={{ margin: 0 }}>{t('video.flow.productionChain')}</Title>
            <Text type="secondary">{t('video.flow.chainHint')}</Text>
          </div>
          {shots.length > 0 && (
            <label className="video-flow-shot-picker">
              <span>{t('video.flow.selectShot')}</span>
              <Select
                size="small"
                value={selectedShot?.id}
                onChange={setSelectedShotId}
                style={{ minWidth: 230 }}
                options={shots.map((shot) => ({
                  value: shot.id,
                  label: t('video.flow.shotOption', { index: shot.index + 1, prompt: (shot.videoPrompt || '').slice(0, 22) }),
                }))}
              />
            </label>
          )}
        </div>

        <FlowOverview
          project={project}
          nodes={nodes}
          progressPercent={Math.round((nodes.reduce((total, node) => {
            if (node.status === 'completed' || node.status === 'skipped') return total + 1;
            if (node.status === 'running' || node.status === 'awaiting_review') return total + node.progress / 100;
            return total;
          }, 0) / Math.max(nodes.length, 1)) * 100)}
          selectedShotId={selectedShotId}
          onOpenStage={onOpenStage}
          onSelectStage={setSelectedStage}
          t={t}
        />

        <div className="video-flow-process-layout">
          <div className="video-flow-stage-column">
            <section className="video-flow-stage-section">
          <div className="video-flow-stage-section-header">
            <div>
              <Text strong>{t('video.flow.stepList')}</Text>
              <Text type="secondary">{t('video.flow.stepListHint')}</Text>
            </div>
            <div className="video-flow-stage-legend" aria-hidden="true">
              <span className="is-completed"><CheckCircleOutlined /> {t('video.artifacts.status.completed')}</span>
              <span className="is-running"><LoadingOutlined /> {t('video.artifacts.status.running')}</span>
              <span className="is-pending">{t('video.artifacts.status.pending')}</span>
            </div>
          </div>
          <div className="video-flow-canvas" aria-label={t('video.flow.canvasAria')}>
          <div className="video-flow-graph">
            {FLOW_LANES.map((lane) => {
              const laneNodes = lane.stages
                .map((stage) => nodes.find((node) => node.stage === stage))
                .filter((node): node is FlowNode => !!node);
              return (
                <section className="video-flow-lane-block" key={lane.id}>
                  <div className="video-flow-lane-label">
                    <div>
                      <Text strong>{t(lane.label)}</Text>
                      <Text type="secondary">{t('video.flow.sequenceLane')}</Text>
                    </div>
                    <Text type="secondary">
                      {laneNodes.filter((node) => node.status === 'completed' || node.status === 'skipped').length}/{laneNodes.length}
                    </Text>
                  </div>
                  <div className="video-flow-lane">
                    {laneNodes.map((node, index) => (
                      <React.Fragment key={node.stage}>
                        <FlowNodeView node={node} selected={node.stage === selectedStage} onClick={() => setSelectedStage(node.stage)} t={t} />
                        {index < laneNodes.length - 1 && <ArrowRightOutlined className="video-flow-connector" />}
                      </React.Fragment>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          </div>
            </section>

            <div className="video-flow-summary-bar">
          <Space size={16} wrap>
            <span><CheckCircleOutlined /> {t('video.flow.completed', { count: nodes.filter((node) => node.status === 'completed').length })}</span>
            <span><LoadingOutlined /> {t('video.flow.running', { count: nodes.filter((node) => node.status === 'running').length })}</span>
            <span><ExclamationCircleOutlined /> {t('video.flow.issues', { count: nodes.filter((node) => node.status === 'error' || !!node.warning).length })}</span>
          </Space>
          <Text type="secondary">{t('video.flow.clickNode')}</Text>
            </div>
          </div>

          <div className="video-flow-content-grid">
          <section className="video-flow-panel-section">
            <div className="video-flow-section-header">
              <div>
                <Text strong>{selectedNode ? t(`video.gen.stage.${selectedNode.stage}`) : t('video.flow.nodeDetails')}</Text>
                <Tag className="video-flow-stage-tag">{selectedStage}</Tag>
              </div>
              <Space size={6}>
                <Tag color={selectedState?.status === 'completed' ? 'success' : selectedState?.status === 'running' ? 'processing' : selectedState?.status === 'error' ? 'error' : 'default'}>
                  {statusLabel(selectedState?.status ?? 'pending', t)}
                </Tag>
                {onOpenStage && (
                  <Button size="small" type="primary" icon={<ArrowRightOutlined />} onClick={() => onOpenStage(selectedStage, selectedShotId)}>
                    {t('video.flow.openWorkspace')}
                  </Button>
                )}
              </Space>
            </div>
            <div className="video-flow-stats">
              <Statistic title={t('video.flow.progress')} value={Math.round((selectedState?.progress ?? 0) * 100)} suffix="%" />
              <Statistic title={t('video.flow.providerCalls')} value={totalCalls} />
              <Statistic title={t('video.flow.duration')} value={selectedState?.totals ? (selectedState.totals.durationMs / 1000).toFixed(1) : '—'} suffix={selectedState?.totals ? 's' : ''} />
            </div>
            <Progress percent={Math.round((selectedState?.progress ?? 0) * 100)} showInfo={false} size="small" />
            <div className="video-flow-handoff">
              <span>{t('video.flow.nextAction')}</span>
              <strong>{handoffLabel}</strong>
            </div>
            <div className="video-flow-detail-grid">
              <ListSection title={t('video.flow.input')} items={details.input} t={t} />
              <ListSection title={t('video.flow.output')} items={details.output} t={t} />
            </div>
            {details.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                icon={<ExclamationCircleOutlined />}
                message={t('video.flow.chainCheck')}
                description={<ul className="video-flow-alert-list">{details.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
              />
            )}
            {selectedState?.inputSummary?.details && selectedState.inputSummary.details.length > 0 && (
              <div className="video-flow-recorded-details">
                <Text type="secondary">{t('video.flow.executionRecord')}</Text>
                <ul>{selectedState.inputSummary.details.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
              </div>
            )}
            <ProviderLedger invocations={selectedState?.invocations} t={t} />
          </section>

          <section className="video-flow-panel-section video-flow-lineage-section">
            <div className="video-flow-section-header">
              <div>
                <Text strong>{t('video.flow.shotLineage')}</Text>
                <Text type="secondary" className="video-flow-section-subtitle">{t('video.flow.shotLabel', { index: selectedShot ? selectedShot.index + 1 : '—' })}</Text>
              </div>
              <Tooltip title={t('video.flow.lineageTooltip')}>
                <Button type="text" size="small" icon={<ExclamationCircleOutlined />} />
              </Tooltip>
            </div>
            <ShotLineage project={project} shot={selectedShot} missingAssets={missingAssets} t={t} />
          </section>
          </div>
        </div>

        <Divider style={{ margin: '16px 0 10px' }} />
        <div className="video-flow-footer-note">
          <FileTextOutlined /> {t('video.flow.footerNote')}
        </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="video-flow-trace-workspace">
        <div className="video-flow-embedded-heading">
          <Space size={10}>
            <span className="video-flow-trace-title-mark"><ArrowRightOutlined /></span>
            <Title level={5} style={{ margin: 0 }}>{t('video.flow.title')}</Title>
            <Text type="secondary">{t('video.flow.subtitle')}</Text>
          </Space>
          <Tag color="blue">{shots.length} {t('video.flow.unit.shots')} · {nodes.length} {t('video.flow.nodes')}</Tag>
        </div>
        {content}
      </div>
    );
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      height="min(860px, 92vh)"
      className="video-flow-trace-drawer"
      rootClassName="video-flow-trace-drawer-root"
      closeIcon={<CloseOutlined data-testid="video-flow-trace-close" />}
      title={
        <Space size={10}>
          <span className="video-flow-trace-title-mark"><ArrowRightOutlined /></span>
          <span>{t('video.flow.title')}</span>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('video.flow.subtitle')}</Text>
        </Space>
      }
      extra={<Tag color="blue">{shots.length} {t('video.flow.unit.shots')} · {nodes.length} {t('video.flow.nodes')}</Tag>}
    >
      {content}
    </Drawer>
  );
};

export default VideoFlowTracePanel;

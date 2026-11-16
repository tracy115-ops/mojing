import type {
  GeneratedClip,
  ShotSpec,
  VideoClipQualityReview,
  VideoQualityCheck,
} from '@/types/video';
import type { VideoControlMode } from '@/types/providers';

export interface VideoQualityGateOptions {
  expectedAspectRatio?: string;
  assetAvailable: boolean;
  requireI2V: boolean;
  requiredControlMode?: VideoControlMode;
  /** Require the exact temporal artifact declared by the production plan. */
  requiredTemporalAuthority?: 'approved_keyframe' | 'previous_tail';
  /** Require the actual previous rendered tail as this shot's temporal input. */
  requirePreviousTail?: boolean;
  requireTailFrame?: boolean;
  reviewedAt?: string;
}

export function evaluateVideoClipQuality(
  shot: ShotSpec,
  clip: GeneratedClip | undefined,
  options: VideoQualityGateOptions,
): VideoClipQualityReview {
  const checks: VideoQualityCheck[] = [];
  checks.push({
    id: 'asset',
    status: clip && options.assetAvailable ? 'pass' : 'fail',
    message: clip && options.assetAvailable ? '视频文件可读取' : '视频文件缺失或不可读取',
  });

  if (options.requireI2V) {
    const modeMatches = options.requiredControlMode
      ? clip?.videoControlMode === options.requiredControlMode
      : clip?.videoReferenceMode === 'i2v';
    checks.push({
      id: 'reference_mode',
      status: modeMatches ? 'pass' : 'fail',
      message: modeMatches
        ? `实际请求使用 ${options.requiredControlMode ?? 'I2V'}`
        : `实际请求未使用 ${options.requiredControlMode ?? 'I2V'}`,
    });
    const sentReferences = clip?.videoReferenceAssets?.filter((asset) => asset.sentToProvider !== false) ?? [];
    checks.push({
      id: 'reference_payload',
      status: sentReferences.length > 0 ? 'pass' : 'fail',
      message: sentReferences.length > 0 ? `Provider 实际收到 ${sentReferences.length} 个参考槽位` : 'Provider 没有收到可追溯参考图',
    });
    if (options.requiredTemporalAuthority) {
      const actualAuthority = clip?.generationContext?.temporalAuthority;
      const matches = actualAuthority === options.requiredTemporalAuthority;
      checks.push({
        id: 'temporal_authority',
        status: matches ? 'pass' : 'fail',
        message: matches
          ? `实际首帧来源为 ${options.requiredTemporalAuthority === 'previous_tail' ? '上一镜尾帧' : '本镜审核关键帧'}`
          : `实际首帧来源不明确或不匹配，期望 ${options.requiredTemporalAuthority === 'previous_tail' ? '上一镜尾帧' : '本镜审核关键帧'}`,
      });
    }
  }

    if (options.requirePreviousTail) {
    const previousTail = clip?.videoReferenceAssets?.find((asset) => asset.kind === 'previous');
    const previousTailRecorded = !!previousTail?.imageUrl;
    const previousTailSent = previousTailRecorded && previousTail?.sentToProvider !== false;
    checks.push({
      id: 'continuity_handoff',
      status: previousTailSent ? 'pass' : 'fail',
      message: previousTailSent
        ? 'The previous rendered tail was sent as the temporal handoff'
        : previousTailRecorded
          ? 'The previous rendered tail was recorded but was not sent to the provider'
          : 'The matching previous shot tail was not recorded as a continuity handoff',
    });
    }

  if (clip) {
    if (clip.importedVideo) {
      const { width, height } = clip.importedVideo;
      const valid = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
      checks.push({ id: 'decoded_picture', status: valid ? 'pass' : 'fail', message: valid ? `已解码视频画面 ${width}×${height}` : '无法验证视频画面尺寸' });
      const [w, h] = (options.expectedAspectRatio ?? '').split(':').map(Number);
      if (valid && w > 0 && h > 0) {
        const matches = Math.abs(width / height - w / h) / (w / h) < 0.03;
        checks.push({ id: 'aspect_ratio', status: matches ? 'pass' : 'warning', message: matches ? `画幅符合 ${options.expectedAspectRatio}` : `原片 ${width}×${height} 与项目 ${options.expectedAspectRatio} 不同，合成时可能缩放或补边` });
      }
    }
    const drift = Math.abs(clip.durationSeconds - shot.durationSeconds);
    checks.push({
      id: 'duration',
      status: drift <= 1 ? 'pass' : 'warning',
      message: drift <= 1
        ? `时长 ${clip.durationSeconds.toFixed(1)}s 符合镜头计划`
        : `计划 ${shot.durationSeconds}s，实际 ${clip.durationSeconds.toFixed(1)}s`,
    });
    if (options.requireTailFrame) {
      checks.push({
        id: 'tail_frame',
        status: clip.lastFrameImage ? 'pass' : 'warning',
        message: clip.lastFrameImage ? '尾帧可用于下一镜连续性约束' : '未提取到尾帧，下一镜无法承接',
      });
    }
  }

  const failed = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const score = Math.max(0, 100 - failed * 35 - warnings * 10);
  return {
    status: failed > 0 ? 'failed' : warnings > 0 ? 'warning' : 'passed',
    score,
    reviewedAt: options.reviewedAt ?? new Date().toISOString(),
    checks,
  };
}

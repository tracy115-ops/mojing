import { parseLLMJson } from '../../novel/llm-json.ts';
import type {
  VideoVisualCheckId,
  VideoVisualQualityCheck,
  VideoVisualQualityReview,
} from '../../../types/video';

export const SHOT_VISUAL_CHECKS: VideoVisualCheckId[] = [
  'subject_count',
  'subject_identity',
  'scene_match',
  'composition',
  'temporal_consistency',
];

export function normalizeVisualReview(
  rawContent: string,
  meta: Pick<VideoVisualQualityReview, 'reviewedAt' | 'provider' | 'model' | 'frameCount'>,
  still = false,
): VideoVisualQualityReview {
  const parsed = parseLLMJson<{
    overallScore?: number;
    overall_score?: number;
    summary?: string;
    checks?: Array<Partial<VideoVisualQualityCheck> & { id?: string }>;
  }>(rawContent);
  if (!parsed || !Array.isArray(parsed.checks)) {
    return unavailableVisualReview(
      meta.reviewedAt,
      'Visual reviewer returned an incomplete JSON report.',
      meta.provider,
      meta.model,
      meta.frameCount,
    );
  }

  const rawById = new Map(parsed.checks.map((check) => [check.id, check]));
  const checkIds = still ? SHOT_VISUAL_CHECKS.filter((id) => id !== 'temporal_consistency') : SHOT_VISUAL_CHECKS;
  const checks = checkIds.map((id) => normalizeCheck(id, rawById.get(id)));
  if (!still && meta.frameCount < 2) {
    const temporal = checks.find((check) => check.id === 'temporal_consistency');
    if (temporal && temporal.status === 'pass') {
      temporal.status = 'warning';
      temporal.score = Math.min(temporal.score, 60);
      temporal.message = 'Only one output frame was available; temporal continuity was not fully inspected.';
    }
  }
  const failed = checks.some((check) => check.status === 'fail');
  const warnings = checks.some((check) => check.status === 'warning');
  const fallbackScore = Math.round(checks.reduce((sum, check) => sum + check.score, 0) / checks.length);
  const requestedScore = Number(parsed.overallScore ?? parsed.overall_score);
  const score = Number.isFinite(requestedScore) ? Math.max(0, Math.min(100, requestedScore)) : fallbackScore;
  return {
    ...meta,
    status: failed || score < 60 ? 'failed' : warnings || score < 80 ? 'warning' : 'passed',
    score,
    checks,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined,
  };
}

export function unavailableVisualReview(
  reviewedAt: string,
  error: string,
  provider?: string,
  model?: string,
  frameCount = 0,
): VideoVisualQualityReview {
  return {
    status: 'unavailable',
    reviewedAt,
    provider,
    model,
    frameCount,
    checks: [],
    error,
  };
}

function normalizeCheck(
  id: VideoVisualCheckId,
  raw: Partial<VideoVisualQualityCheck> | undefined,
): VideoVisualQualityCheck {
  const scoreValue = Number(raw?.score);
  const score = Number.isFinite(scoreValue) ? Math.max(0, Math.min(100, scoreValue)) : 0;
  const status = raw?.status === 'fail' || raw?.status === 'warning' || raw?.status === 'pass'
    ? raw.status
    : score >= 80 ? 'pass' : score >= 60 ? 'warning' : 'fail';
  return {
    id,
    status,
    score,
    message: typeof raw?.message === 'string' && raw.message.trim()
      ? raw.message.trim()
      : 'The visual reviewer did not provide evidence for this check.',
    evidence: typeof raw?.evidence === 'string' ? raw.evidence.trim() : undefined,
  };
}

export interface ShotPlanLike {
  id: string;
  index: number;
  sourceText?: string;
  videoPrompt?: string;
  imagePrompt?: string;
  durationSeconds?: number;
  sceneId?: string;
  location?: string;
  visibleCharacterIds?: string[];
  characterIds?: string[];
  offscreenCharacterIds?: string[];
  characterBinding?: 'explicit' | 'inferred';
  unresolvedCharacterRefs?: string[];
  startState?: string;
  endState?: string;
  transition?: 'cut' | 'continue';
}

export interface ShotPlanEntityLike {
  id: string;
  name: string;
  aliases?: string[];
}

export type ShotPlanIssueCode =
  | 'empty-plan'
  | 'duplicate-shot-id'
  | 'duplicate-shot-index'
  | 'missing-source'
  | 'missing-video-prompt'
  | 'missing-image-prompt'
  | 'invalid-duration'
  | 'visible-offscreen-conflict'
  | 'unresolved-visible-subject'
  | 'implicit-visible-binding'
  | 'missing-scene-binding'
  | 'unknown-scene'
  | 'missing-continuity-start-state';

export interface ShotPlanIssue {
  code: ShotPlanIssueCode;
  shotId?: string;
  detail: string;
}

export interface ShotPlanContractOptions {
  characters?: ShotPlanEntityLike[];
  scenes?: ShotPlanEntityLike[];
  requireAssetBindings?: boolean;
}

export function getShotStillPrompt(shot: ShotPlanLike): string {
  return shot.imagePrompt?.trim() || shot.startState?.trim() || shot.sourceText?.trim() || shot.videoPrompt?.trim() || '';
}

export function validateShotPlanContract(
  shots: ShotPlanLike[],
  options: ShotPlanContractOptions = {},
): ShotPlanIssue[] {
  const issues: ShotPlanIssue[] = [];
  if (shots.length === 0) {
    issues.push({ code: 'empty-plan', detail: 'The storyboard contains no shots.' });
    return issues;
  }

  const ids = new Set<string>();
  const indexes = new Set<number>();
  for (const shot of shots) {
    const shotId = shot.id?.trim() || undefined;
    if (!shotId) {
      issues.push({ code: 'duplicate-shot-id', detail: 'Every shot must have a stable id.' });
    } else if (ids.has(shotId)) {
      issues.push({ code: 'duplicate-shot-id', shotId, detail: `Shot id is duplicated: ${shotId}.` });
    } else {
      ids.add(shotId);
    }

    if (!Number.isInteger(shot.index) || indexes.has(shot.index)) {
      issues.push({
        code: 'duplicate-shot-index',
        shotId,
        detail: `Shot index is missing or duplicated: ${String(shot.index)}.`,
      });
    } else {
      indexes.add(shot.index);
    }

    if (!shot.sourceText?.trim()) {
      issues.push({ code: 'missing-source', shotId, detail: 'Each shot must retain its source segment.' });
    }
    if (!shot.videoPrompt?.trim()) {
      issues.push({ code: 'missing-video-prompt', shotId, detail: 'Each shot must define a motion prompt.' });
    }
    if (!shot.imagePrompt?.trim()) {
      issues.push({ code: 'missing-image-prompt', shotId, detail: 'Each shot must define a still/keyframe prompt.' });
    }
    if (!Number.isFinite(shot.durationSeconds) || (shot.durationSeconds ?? 0) <= 0) {
      issues.push({ code: 'invalid-duration', shotId, detail: 'Each shot must have a positive duration.' });
    }

    const visible = uniqueReferences(shot.visibleCharacterIds ?? shot.characterIds);
    const offscreen = uniqueReferences(shot.offscreenCharacterIds);
    const offscreenSet = new Set(offscreen);
    const overlap = visible.filter((reference) => offscreenSet.has(reference));
    if (overlap.length > 0) {
      issues.push({
        code: 'visible-offscreen-conflict',
        shotId,
        detail: `A subject cannot be both visible and offscreen: ${overlap.join(', ')}.`,
      });
    }

    if (options.requireAssetBindings) {
      const characterRecords = options.characters ?? [];
      if (shot.characterBinding !== 'explicit') {
        issues.push({
          code: 'implicit-visible-binding',
          shotId,
          detail: 'Every shot must explicitly declare its visible subjects before assets are generated.',
        });
      }
      const unresolved = new Set((shot.unresolvedCharacterRefs ?? []).map(normalizeReference));
      const missing = visible.filter((reference) => (
        unresolved.has(normalizeReference(reference))
        || !characterRecords.some((character) => entityMatches(character, reference))
      ));
      if (missing.length > 0) {
        issues.push({
          code: 'unresolved-visible-subject',
          shotId,
          detail: `Visible subjects are not bound to extracted assets: ${missing.join(', ')}.`,
        });
      }

      const scenes = options.scenes ?? [];
      if (scenes.length > 0 && shot.location?.trim() && !shot.sceneId) {
        issues.push({
          code: 'missing-scene-binding',
          shotId,
          detail: 'A shot with a scene location must reference a concrete scene asset.',
        });
      }
      if (shot.sceneId && !scenes.some((scene) => scene.id === shot.sceneId)) {
        issues.push({
          code: 'unknown-scene',
          shotId,
          detail: `Scene asset is not bound: ${shot.sceneId}.`,
        });
      }
    }
  }

  for (let index = 1; index < shots.length; index += 1) {
    const previous = shots[index - 1];
    const current = shots[index];
    if (sameScene(previous, current) && sameReferences(previous, current)
      && current.transition !== 'cut'
      && previous.endState?.trim() && !current.startState?.trim()) {
      issues.push({
        code: 'missing-continuity-start-state',
        shotId: current.id,
        detail: 'A continuous shot must inherit the previous shot end state as its start state.',
      });
    }
  }

  return issues;
}

export function assertShotPlanContract(
  shots: ShotPlanLike[],
  options: ShotPlanContractOptions = {},
): void {
  const issues = validateShotPlanContract(shots, options);
  if (issues.length === 0) return;
  const summary = issues
    .slice(0, 8)
    .map((issue) => `${issue.code}${issue.shotId ? `(${issue.shotId})` : ''}: ${issue.detail}`)
    .join(' | ');
  const suffix = issues.length > 8 ? ` | +${issues.length - 8} more issue(s)` : '';
  throw new Error(`Storyboard contract failed: ${summary}${suffix}`);
}

function sameScene(left: ShotPlanLike, right: ShotPlanLike): boolean {
  if (left.sceneId && right.sceneId) return left.sceneId === right.sceneId;
  const leftLocation = normalizeReference(left.location);
  const rightLocation = normalizeReference(right.location);
  return !!leftLocation && leftLocation === rightLocation;
}

function sameReferences(left: ShotPlanLike, right: ShotPlanLike): boolean {
  const leftRefs = uniqueReferences(left.visibleCharacterIds ?? left.characterIds);
  const rightRefs = uniqueReferences(right.visibleCharacterIds ?? right.characterIds);
  return leftRefs.length === rightRefs.length && leftRefs.every((reference) => rightRefs.includes(reference));
}

function entityMatches(entity: ShotPlanEntityLike, reference: string): boolean {
  const target = normalizeReference(reference);
  return [entity.id, entity.name, ...(entity.aliases ?? [])]
    .some((candidate) => normalizeReference(candidate) === target);
}

function uniqueReferences(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeReference(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s._-]/g, '');
}

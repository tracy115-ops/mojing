// pipeline-runner.ts — 漫画流水线主入口
//
// 三个导出函数(平行 video/pipeline-runner):
//   - runComicPipeline(pid)  从当前 stage 跑到结尾(支持断点续跑)
//   - runSingleStage(pid, stage)  只跑指定 stage,不推进
//   - runFromStage(pid, stage)  从指定 stage 跑到结尾(先 reset)

import { useComicStore } from '@/stores/comicStore';
import { logger } from '@/services/log';
import {
  STAGE_HANDLERS,
  RUNTIME_STAGE_ORDER,
  isStageEnabled,
  isStageLiveCompleted,
  applyStageInput,
  type StageContext,
  type PipelineCallbacks,
} from './stage-handlers';
import type { ComicTrackedStage, ComicSceneSpec } from '@/types/comic';

/** 从 store 重建 StageContext。null = 项目不存在。 */
function buildContextFromStore(
  pid: string,
  callbacks?: PipelineCallbacks,
): { ctx: StageContext; spec: ComicSceneSpec } | null {
  const proj = useComicStore.getState().getProject(pid);
  if (!proj) return null;
  const ctx: StageContext = {
    pid,
    workingSpec: proj.spec,
    sourceText: proj.sourceText ?? '',
    panelCount: proj.panelCount,
    enableCharacterAnchor: proj.options.enableCharacterAnchor,
    characterAnchorLimit: proj.options.characterAnchorLimit,
    style: proj.spec.meta.style ?? proj.style,
    aspectRatio: proj.spec.meta.aspectRatio,
    panelLayout: proj.spec.meta.panelLayout,
    callbacks,
  };
  return { ctx, spec: proj.spec };
}

/**
 * 跑漫画流水线。
 *
 * - 自动跳过已完成(isStageLiveCompleted)的 stage
 * - 自动跳过未启用(isStageEnabled)的 stage
 * - 单个 stage 失败 → 停止后续
 *
 * 返回 true = 全部成功跑完,false = 中途失败或项目不存在。
 */
export async function runComicPipeline(
  pid: string,
  callbacks?: PipelineCallbacks,
): Promise<boolean> {
  void logger.info(`[comic/pipeline] runComicPipeline pid=${pid}`, 'comic');
  const built = buildContextFromStore(pid, callbacks);
  if (!built) {
    void logger.warn(`[comic/pipeline] 项目不存在 pid=${pid}`, 'comic');
    return false;
  }

  let ctx = built.ctx;
  let allOk = true;

  for (const stage of RUNTIME_STAGE_ORDER) {
    const proj = useComicStore.getState().getProject(pid);
    if (!proj) return false;

    if (isStageLiveCompleted(proj, stage)) {
      void logger.info(`[comic/pipeline] ${stage} 已完成,跳过`, 'comic');
      continue;
    }

    if (!isStageEnabled(stage, ctx)) {
      useComicStore.getState().setStageStatus(pid, stage, 'skipped');
      continue;
    }

    const handler = STAGE_HANDLERS[stage];
    if (!handler) continue;

    // 应用用户改过的 input 到 ctx / spec
    ctx = applyStageInput(ctx, stage);

    const result = await handler(ctx);
    if (!result) {
      allOk = false;
      break;
    }
    // 把产物累积到 ctx,供下一 stage 用
    if (result.extractedCharacters) {
      ctx = { ...ctx, workingSpec: { ...ctx.workingSpec, characters: result.extractedCharacters } };
    } else if (result.spec) {
      ctx = { ...ctx, workingSpec: result.spec };
    }
  }

  return allOk;
}

/**
 * 单步重跑:只跑指定 stage,不推进 currentStage,不动后续 stage。
 */
export async function runSingleStage(
  pid: string,
  stage: ComicTrackedStage,
): Promise<boolean> {
  void logger.info(`[comic/pipeline] runSingleStage pid=${pid} stage=${stage}`, 'comic');
  const built = buildContextFromStore(pid);
  if (!built) {
    void logger.warn(`[comic/pipeline] runSingleStage: 项目不存在 pid=${pid}`, 'comic');
    return false;
  }
  const handler = STAGE_HANDLERS[stage];
  if (!handler) {
    void logger.warn(`[comic/pipeline] runSingleStage: stage ${stage} 无 handler`, 'comic');
    return false;
  }
  const ctx = applyStageInput(built.ctx, stage);
  const result = await handler(ctx);
  if (!result) {
    void logger.warn(`[comic/pipeline] runSingleStage: stage ${stage} 执行失败`, 'comic');
    return false;
  }
  useComicStore.getState().setSceneSpec(pid, result.spec);
  return true;
}

/**
 * 从指定 stage 跑到结尾(含该 stage)。
 *
 * - 先 resetStagesFrom(pid, stage) 清掉该 stage 及后续的产物
 * - 重新读 proj 拿 fresh spec
 * - 从该 stage 开始循环跑 RUNTIME_STAGE_ORDER
 */
export async function runFromStage(
  pid: string,
  stage: ComicTrackedStage,
): Promise<boolean> {
  void logger.info(`[comic/pipeline] runFromStage pid=${pid} stage=${stage}`, 'comic');
  const built = buildContextFromStore(pid);
  if (!built) {
    void logger.warn(`[comic/pipeline] runFromStage: 项目不存在 pid=${pid}`, 'comic');
    return false;
  }

  const store = useComicStore.getState();
  store.resetStagesFrom(pid, stage);

  const freshProj = store.getProject(pid);
  if (!freshProj) return false;

  let ctx: StageContext = {
    ...built.ctx,
    workingSpec: freshProj.spec,
  };

  const startIdx = RUNTIME_STAGE_ORDER.indexOf(stage);
  if (startIdx < 0) {
    void logger.warn(
      `[comic/pipeline] runFromStage: stage ${stage} 不在 RUNTIME_STAGE_ORDER`,
      'comic',
    );
    return false;
  }

  let allOk = true;
  for (let i = startIdx; i < RUNTIME_STAGE_ORDER.length; i++) {
    const s = RUNTIME_STAGE_ORDER[i];
    if (!isStageEnabled(s, ctx)) {
      store.setStageStatus(pid, s, 'skipped');
      continue;
    }
    const handler = STAGE_HANDLERS[s];
    if (!handler) continue;

    ctx = applyStageInput(ctx, s);
    const result = await handler(ctx);
    if (!result) {
      allOk = false;
      break;
    }
    if (result.extractedCharacters) {
      ctx = { ...ctx, workingSpec: { ...ctx.workingSpec, characters: result.extractedCharacters } };
    } else if (result.spec) {
      ctx = { ...ctx, workingSpec: result.spec };
    }
  }

  return allOk;
}

// core/types.ts — 跨通道共享的流水线类型 + 回调
// SceneSpec / PipelineOptions 等结构定义在 @/types/video,这里只 re-export + 定义运行时回调。

import type {
  SceneSpec,
  PipelineOptions,
  VideoStage,
  VideoProjectState,
} from '@/types/video';

export interface PipelineCallbacks {
  onStageChange?: (stage: VideoStage) => void;
  onStageProgress?: (stage: VideoStage, progress: number) => void;
  onShotProgress?: (done: number, total: number) => void;
  onError?: (msg: string) => void;
  /** 步 3 提取完成后回调,UI 用于刷新角色预览面板 */
  onExtractionComplete?: (spec: SceneSpec) => void;
}

export type { SceneSpec, PipelineOptions, VideoStage, VideoProjectState };

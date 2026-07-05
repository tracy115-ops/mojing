// ============================================================================
// Comic Generation Types — Phase 1 MVP(3 stage pipeline)
// ============================================================================
//
// Pipeline 3 步(Phase 1):
//   1. character_anchor  角色立绘(可选,复用 video 工坊)
//   2. panel_script      LLM 把主题拆成分镜脚本
//   3. panel_image       每镜出图(带角色 reference)
//
// 三种来源模式(Phase 1 只支持 pure,其他 Phase 2):
//   - pure:    用户直接输入主题 + 角色
//   - extract: 用户粘贴文本(Phase 2)
//   - novel:   从小说项目导入章节(Phase 2)
//
// 设计原则:架构平行 video.ts,便于未来共用 stage-handlers / 单步重跑能力。

import type { AspectRatio } from './video';

// --- Source Mode ---

/** 漫画项目来源模式(对齐 video DirectSourceMode) */
export type ComicSourceMode = 'pure' | 'extract' | 'novel';

// --- Pipeline Stages ---

export type ComicStage =
  | 'idle'
  | 'character_anchor'   // 步 1:角色立绘(可选)
  | 'panel_script'       // 步 2:LLM 拆分镜
  | 'panel_image'        // 步 3:每镜出图
  | 'complete'
  | 'error';

export type ComicStageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'error';

export interface ComicStageState {
  stage: ComicStage;
  status: ComicStageStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** 该步骤输入摘要(UI 第一段展示)。 */
  inputSummary?: ComicStageInputSummary;
  /** 用户可编辑的输入参数(单步重跑时用)。 */
  input?: ComicStageInput;
}

/** 步骤输入摘要(纯展示用)。 */
export interface ComicStageInputSummary {
  /** 一句话描述输入,如 "3 个角色 / 主题:森林里的小红帽" */
  headline?: string;
  /** 详细列表项(可折叠) */
  details?: string[];
  /** 上一步产物引用,如 "6 个分镜" */
  upstreamArtifacts?: string;
}

// --- Stage Input(用户可编辑参数) ---

/** 某个 stage 用户可编辑的输入参数(通用集合,各 stage 用到的字段不同)。 */
export interface ComicStageInput {
  /** 文本类 prompt(panel_script 的主题 / panel_image 的画面描述) */
  prompt?: string;
  /** 随机种子(image 生成时复现或换图用) */
  seed?: number;
  /** 风格:日漫 / 美漫 / 水墨 ... */
  style?: string;
  /** panel_script:期望分镜数 */
  panelCount?: number;
  /** character_anchor:立绘模式 */
  anchorMode?: 'single' | 'turnaround';
}

// --- Core: ComicSceneSpec ---

/**
 * 漫画角色(Phase 1 直接复用 video CharacterAnchor 的子集,
 *  Phase 2 引入 referenceImage / costumeVariants 时再扩展)
 *
 * 注意:命名为 ComicCharacterAnchor 是为了避免与 types/index.ts 里
 * 旧的 ComicCharacter(legacy,projectStore 在用)冲突。
 */
export interface ComicCharacterAnchor {
  id: string;
  name: string;
  /** 完整外貌(gender/age/face/hair/...),用作 anchor prompt 主体 */
  appearance: string;
  /** 性格 / 背景描述(可空) */
  personality?: string;
  gender?: 'male' | 'female' | 'unknown';
  ageGroup?: 'child' | 'teen' | 'young' | 'middle' | 'elder' | 'unknown';
  /** 步 1 产物:单图正面立绘 URL(webview 形式) */
  portraitImage?: string;
  /** 步 1 产物:三视图正/侧/背 URL(横向,可选) */
  turnaroundImage?: string;
  /** 该角色首次出现 panel 的 index */
  firstAppearPanelIndex: number;
}

/** 单个分镜 */
export interface ComicPanelSpec {
  id: string;
  index: number;
  /** 画面描述(角色动作 / 构图 / 场景) — panel_image 的 prompt 主体 */
  description: string;
  /** 对白 / 旁白(Phase 1 仅记录,Phase 2 用于 dialogue_burn) */
  dialogue?: string;
  /** 引用 ComicCharacterAnchor.id */
  characterIds: string[];
  /** 镜头景别(近/中/远/特写)— LLM 决定,影响画面节奏 */
  shotType?: 'close-up' | 'medium' | 'wide' | 'establishing';
  /** 步 3 产物:图片 URL(webview 形式) */
  imageUrl?: string;
  /** 用户改过的 prompt(覆盖 description 拼 prompt) */
  promptOverride?: string;
  /** 用户改过的 seed */
  seed?: number;
}

/** 跨 stage 共享的剧本表示(类似 video SceneSpec) */
export interface ComicSceneSpec {
  characters: ComicCharacterAnchor[];
  panels: ComicPanelSpec[];
  meta: {
    title?: string;
    /** 画风:'manga' | 'western' | 'watercolor' | 'pixel' | 自定义 */
    style?: string;
    aspectRatio: AspectRatio;
    /** 单镜布局:Phase 1 总是 'single' */
    panelLayout: 'single' | 'grid-2' | 'grid-4' | 'manga-row';
    sourceMode: ComicSourceMode;
    /** 'novel' | 'direct'(Phase 1 总是 direct) */
    channel: 'novel' | 'direct';
  };
}

// --- Pipeline Options ---

export interface ComicPipelineOptions {
  /** 步 1:角色立绘(可选,关闭则 panel_image 不带 reference) */
  enableCharacterAnchor: boolean;
  /** 角色立绘上限 */
  characterAnchorLimit: number;
}

/** Phase 1 默认 options(pure 模式) */
export const COMIC_DEFAULT_OPTIONS: ComicPipelineOptions = {
  enableCharacterAnchor: true,
  characterAnchorLimit: 5,
};

// --- Pipeline Stages Order ---

/** Pipeline 实际跟踪状态的 stage(idle/complete/error 是哨兵,不入表) */
export type ComicTrackedStage = Exclude<ComicStage, 'idle' | 'complete' | 'error'>;

/** Pipeline 处理的 stage 顺序(不含 idle/complete/error) */
export const COMIC_PIPELINE_STAGES: ComicTrackedStage[] = [
  'character_anchor',
  'panel_script',
  'panel_image',
];

// --- Project ---

/** 单个漫画项目的完整状态(持久化到 store)。 */
export interface ComicPipelineProject {
  id: string;
  /** Novel 模式才填,关联的小说项目 ID */
  novelProjectId?: string;
  title: string;
  /** 来源模式 */
  sourceMode: ComicSourceMode;
  /** pure 模式:用户输入的主题;extract:粘贴文本;novel:章节内容 */
  sourceText?: string;
  /** 用户在创建时选的画风 */
  style: string;
  /** 用户在创建时选的画幅比例 */
  aspectRatio: AspectRatio;
  /** 用户在创建时选的布局 */
  panelLayout: ComicSceneSpec['meta']['panelLayout'];
  /** 期望分镜数(LLM 在 panel_script 时用) */
  panelCount: number;
  /** Scene spec(随 stage 推进累积) */
  spec: ComicSceneSpec;
  /** Pipeline 选项 */
  options: ComicPipelineOptions;
  /** 每个 stage 的状态 */
  stages: Record<Exclude<ComicStage, 'idle' | 'complete' | 'error'>, ComicStageState>;
  /** 当前 stage(用于 UI 高亮 + resume) */
  currentStage: ComicStage;
  /** 最终产物 URL 数组(Phase 1 = panels[].imageUrl) */
  finalPageUrls: string[];
  createdAt: string;
  updatedAt: string;
}

// --- Stage Input Field Definitions(对齐 video 的 STAGE_INPUT_FIELDS) ---

export interface ComicStageInputFieldDef {
  key: keyof ComicStageInput;
  /** i18n key,如 'comic.pipeline.field.prompt' */
  label: string;
  type: 'text' | 'textarea' | 'number' | 'radio';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 只读展示(改了不会应用到重跑) */
  readOnly?: boolean;
  /** type='radio' 时的可选项 */
  options?: { value: string; labelKey: string }[];
}

/** 各 stage 可编辑的字段配置。 */
export const COMIC_STAGE_INPUT_FIELDS: Partial<
  Record<Exclude<ComicStage, 'idle' | 'complete' | 'error'>, ComicStageInputFieldDef[]>
> = {
  character_anchor: [
    {
      key: 'anchorMode',
      label: 'comic.pipeline.field.anchorMode',
      type: 'radio',
      options: [
        { value: 'single', labelKey: 'comic.pipeline.field.anchorModeSingle' },
        { value: 'turnaround', labelKey: 'comic.pipeline.field.anchorModeTurnaround' },
      ],
    },
    { key: 'prompt', label: 'comic.pipeline.field.prompt', type: 'textarea' },
    { key: 'style', label: 'comic.pipeline.field.style', type: 'text' },
    { key: 'seed', label: 'comic.pipeline.field.seed', type: 'number', min: 0 },
  ],
  panel_script: [
    { key: 'prompt', label: 'comic.pipeline.field.theme', type: 'textarea' },
    { key: 'panelCount', label: 'comic.pipeline.field.panelCount', type: 'number', min: 1, max: 20 },
  ],
  panel_image: [
    { key: 'style', label: 'comic.pipeline.field.style', type: 'text' },
    { key: 'seed', label: 'comic.pipeline.field.seed', type: 'number', min: 0 },
  ],
};

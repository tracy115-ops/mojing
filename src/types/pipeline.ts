// ============================================================================
// DAG Pipeline Types — Execution engine & cross-module SharedContext
// ============================================================================

import type { PriorityTier, StoryPhase } from './narrative';

// --- DAG Node Types ---

export type NodeCategory =
  | 'context'      // 上下文注入
  | 'execution'    // 执行与生成
  | 'validation'   // 校验与监控
  | 'gateway'      // 网关与熔断
  | 'world'        // 世界设定
  | 'review'       // 审稿质检
  | 'planning'     // 规划设计
  | 'props';       // 道具上下文

export type NodeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'success'
  | 'warning'
  | 'error'
  | 'bypassed'
  | 'disabled'
  | 'completed';

export type EdgeCondition =
  | 'on_success'
  | 'on_error'
  | 'on_drift_alert'
  | 'on_no_drift'
  | 'on_breaker_open'
  | 'on_breaker_closed'
  | 'on_review_approved'
  | 'on_review_rejected'
  | 'always';

// --- DAG Definition ---

export interface DAGNode {
  id: string;
  type: string;               // e.g. 'planning', 'outline', 'context-assembly', 'generation', 'review', 'aftermath'
  category: NodeCategory;
  label: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  inputPorts: DAGPort[];
  outputPorts: DAGPort[];
  timeoutMs: number;
  maxRetries: number;
}

export interface DAGPort {
  name: string;
  dataType: 'text' | 'json' | 'score' | 'boolean' | 'list' | 'image' | 'video';
  required: boolean;
  default?: unknown;
  description: string;
}

export interface DAGEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePort?: string;
  targetPort?: string;
  condition: EdgeCondition;
}

export interface DAGDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  nodes: DAGNode[];
  edges: DAGEdge[];
}

// --- DAG Execution Result ---

export interface DAGRunResult {
  dagRunId: string;
  novelId: string;
  status: 'completed' | 'error' | 'partial' | 'cancelled';
  nodeResults: Record<string, DAGNodeResult>;
  totalDurationMs: number;
  errorCount: number;
  startedAt: string;
  completedAt: string;
}

export interface DAGNodeResult {
  nodeId: string;
  status: NodeStatus;
  outputs: Record<string, unknown>;
  durationMs: number;
  error?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
}

// --- Autopilot State Machine ---

export type NovelStage =
  | 'idle'
  | 'global_planning'     // 全局规划（卷+章结构）
  | 'macro_planning'      // 宏观规划
  | 'act_beat_planning'   // 幕级节拍
  | 'chapter_generation'  // 章节生成
  | 'chapter_review'      // 章末审阅
  | 'paused'
  | 'completed'
  | 'error';

export type AutopilotStatus = 'idle' | 'running' | 'paused' | 'error' | 'completed';

export interface AutopilotState {
  novelId: string;
  status: AutopilotStatus;
  currentStage: NovelStage;
  currentChapterNumber: number;
  currentBeatIndex: number;
  targetChapterCount: number;
  targetWordCount: number;
  currentWordCount: number;
  consecutiveFailures: number;
  lastRunAt?: string;
  lastError?: string;
  progress: number;           // 0-1
  currentChapterContent?: string;
}

// --- Circuit Breaker ---

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerState {
  state: BreakerState;
  failureCount: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  lastFailureTime?: string;
}

// --- Novel Generation Workflow State ---

export interface NovelWorkflowState {
  novelId: string;
  autopilot: AutopilotState;
  breaker: CircuitBreakerState;
  storyPhase: import('./narrative').StoryPhaseState;
  chapterResults: Map<number, import('./narrative').ChapterAftermathResult>;
}

// --- Cross-Module SharedContext ---
// Novel engine output that comic/video engines consume

export interface SharedContext {
  novelId: string;
  projectTitle: string;

  // Story metadata
  genre: string;
  style: string;
  language: string;
  storyPhase: StoryPhase;

  // Characters (for visual consistency)
  characters: SharedCharacter[];

  // Scene descriptions (for comic panels / video storyboards)
  scenes: SharedScene[];

  // Current chapter context
  currentChapter: {
    number: number;
    title: string;
    summary: string;
    keyEvents: string[];
    emotionalTone: string;
    locations: string[];
    presentCharacters: string[];
  };

  // Visual reference anchors
  visualAnchors: VisualAnchor[];

  // Timeline for continuity
  timeline: SharedTimelineEvent[];
}

export interface SharedCharacter {
  id: string;
  name: string;
  appearance: string;          // detailed visual description
  currentEmotion: string;
  currentOutfit?: string;
  currentLocation: string;
  referenceImagePrompt: string; // optimized prompt for image generation
}

export interface SharedScene {
  chapterNumber: number;
  sceneIndex: number;
  location: string;
  locationDescription: string;
  atmosphere: string;          // mood/lighting/weather
  timeOfDay: string;
  characters: string[];
  action: string;              // what's happening
  dialogue: SharedDialogue[];
  imagePrompt: string;         // pre-built prompt for image generation
  videoPrompt: string;         // pre-built prompt for video generation
}

export interface SharedDialogue {
  characterId: string;
  characterName: string;
  text: string;
  emotion: string;
  isInternal: boolean;         // internal thought vs spoken
}

export interface VisualAnchor {
  id: string;
  type: 'character' | 'location' | 'item' | 'style';
  name: string;
  description: string;
  referenceImageUrl?: string;
  consistencyRules: string[];  // rules to maintain visual consistency
}

export interface SharedTimelineEvent {
  chapter: number;
  inStoryTime: string;
  event: string;
  significance: string;
}

// --- Pipeline Task (unified task queue for novel→comic→video) ---

export type PipelineTaskType =
  | 'novel.plan'
  | 'novel.generate_chapter'
  | 'novel.review'
  | 'novel.aftermath'
  | 'comic.generate_script'
  | 'comic.generate_panel'
  | 'comic.render_page'
  | 'video.generate_scene_script'
  | 'video.generate_clip'
  | 'video.compose'
  | 'pipeline.translate';     // novel→comic/video script translation

export type PipelineTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PipelineTask {
  id: string;
  type: PipelineTaskType;
  projectId: string;
  status: PipelineTaskStatus;
  priority: number;           // higher = more important
  dependsOn: string[];        // task IDs that must complete first
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  progress: number;           // 0-1
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  providerUsed?: string;      // which API provider was used
  tokenUsage?: { prompt: number; completion: number; total: number };
}

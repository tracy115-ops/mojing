// ============================================================================
// Re-export sub-modules
// ============================================================================

export * from './providers';
export * from './narrative';
export * from './pipeline';

// ============================================================================
// Settings Types
// ============================================================================

export interface AppSettings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  network: NetworkSettings;
  notifications: NotificationSettings;
  shortcuts: ShortcutConfig[];
  creative: CreativeSettings;
}

export interface GeneralSettings {
  language: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  checkUpdates: boolean;
  dataDir: string;
  closeAction: 'ask' | 'tray' | 'exit';
}

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  colorPrimary: string;
  compactMode: boolean;
  sidebarWidth: number;
  sidebarPosition: 'left' | 'right';
  showStatusBar: boolean;
  showBreadcrumb: boolean;
}

export interface NetworkSettings {
  proxyEnabled: boolean;
  proxyHost: string;
  proxyPort: string;
  proxyProtocol: 'HTTP' | 'HTTPS' | 'SOCKS5';
  authEnabled: boolean;
  proxyUsername: string;
  proxyPassword: string;
  noProxy: string;
}

export type NotificationEvent = 'reply_done' | 'error_exit' | 'long_running' | 'waiting_input';

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'telegram' | 'discord' | 'custom_webhook';
  url: string;
  enabled: boolean;
  secret?: string;
  botToken?: string;
  chatId?: string;
  events?: NotificationEvent[];
  messageTemplate?: string;
}

export interface NotificationSettings {
  enabled: boolean;
  channels: NotificationChannel[];
}

export interface ShortcutConfig {
  id: string;
  name: string;
  description: string;
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  action: string;
}

// ============================================================================
// Creative Settings
// ============================================================================

export interface CreativeSettings {
  defaultNovelStyle: string;
  defaultComicStyle: string;
  defaultVideoStyle: string;
  autoSave: boolean;
  autoSaveIntervalSeconds: number;
  exportFormat: string;
  maxConcurrentGenerations: number;
}

// ============================================================================
// Creative Project Types
// ============================================================================

export type CreativeProjectType = 'novel' | 'comic' | 'video';

export type ProjectStatus = 'planning' | 'in_progress' | 'paused' | 'completed' | 'archived';

export interface CreativeProject {
  id: string;
  type: CreativeProjectType;
  title: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  isFavorite: boolean;
  coverImage?: string;
  metadata: NovelMetadata | ComicMetadata | VideoMetadata;
}

// ============================================================================
// Novel Types
// ============================================================================

export interface NovelMetadata {
  genre: string;
  targetWordCount: number;
  currentWordCount: number;
  chapters: NovelChapter[];
  style: string;
  language: string;
  narrativeData?: NarrativeSnapshot;
}

export interface NarrativeSnapshot {
  triples: import('./narrative').RelationshipTriple[];
  anchors: import('./narrative').TimelineAnchor[];
  beats: import('./narrative').CompletedBeat[];
  foreshadowing: import('./narrative').Foreshadowing[];
}

export type ChapterStatus = 'planned' | 'drafting' | 'revising' | 'complete';

export interface NovelChapter {
  id: string;
  title: string;
  outline: string;
  content: string;
  status: ChapterStatus;
  wordCount: number;
  order: number;
}

// ============================================================================
// Comic Types
// ============================================================================

export interface ComicMetadata {
  style: string;
  panelLayout: string;
  pageCount: number;
  characters: ComicCharacter[];
  script?: string;
}

export interface ComicCharacter {
  id: string;
  name: string;
  description: string;
  appearance: string;
  referenceImages: string[];
}

export interface ComicPage {
  id: string;
  pageNumber: number;
  panels: ComicPanel[];
  imageUrl?: string;
  status: 'scripted' | 'sketched' | 'rendered' | 'complete';
}

export interface ComicPanel {
  id: string;
  description: string;
  dialogue?: string;
  imageUrl?: string;
  layout: string;
}

// ============================================================================
// Video Types
// ============================================================================

export interface VideoMetadata {
  duration: number;
  resolution: string;
  style: string;
  scenes: VideoScene[];
  aspectRatio: string;
  fps: number;
}

export interface VideoScene {
  id: string;
  title: string;
  description: string;
  duration: number;
  order: number;
  imageData?: string;
  videoUrl?: string;
  status: 'scripted' | 'storyboarded' | 'generated' | 'complete';
  transition?: string;
}

// ============================================================================
// Generation Types
// ============================================================================

export type GenerationType = 'novel_chapter' | 'novel_outline' | 'comic_panel' | 'comic_page' | 'video_scene' | 'video_clip';

export type GenerationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface GenerationTask {
  id: string;
  type: GenerationType;
  projectId: string;
  status: GenerationStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: string;
}

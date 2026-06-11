// ============================================================================
// Layout Density Constants — PlotPilot-inspired design tokens
// All panel widths, sidebar sizes, paddings, and split ratios in one place
// ============================================================================

// --- Sidebar & Panel Widths ---
export const LAYOUT = {
  /** Project list sidebar */
  projectListWidth: 220,

  /** Chapter list sidebar */
  chapterListWidth: 200,

  /** Narrative workbench default width */
  workbenchDefaultWidth: 460,
  workbenchMinWidth: 320,
  workbenchMaxViewportFraction: 0.7,

  /** Settings panel overlay width */
  settingsPanelWidth: 780,

  // --- Paddings ---
  panelPadding: 10,
  panelPaddingSm: 8,
  panelHeaderPadding: '6px 12px',

  // --- Font Sizes ---
  panelHeaderFontSize: 12,
  panelBodyFontSize: 11,
  panelSmallFontSize: 9,
  metricValueFontSize: 18,
  metricLabelFontSize: 9,

  // --- Borders ---
  borderRadius: 6,
  borderWidth: 1,
  accentBarWidth: 3,

  // --- Icon Sizes ---
  metricIconSize: 24,
  metricIconFontSize: 12,
  statusDotSize: 6,

  // --- Spacing ---
  gapXs: 4,
  gapSm: 6,
  gapMd: 8,
  gapLg: 12,

  // --- Workbench category bar ---
  categoryBarHeight: 36,
  categoryTabPadding: '4px 10px',

  // --- Autopilot bar ---
  autopilotBarPadding: '8px 16px',
} as const;

// --- EChart Theme Colors (for charts) ---
export const CHART_COLORS = {
  primary: '#3b82f6',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  purple: '#8b5cf6',
  pink: '#ec4899',
  cyan: '#06b6d4',
  gray: '#9ca3af',
  series: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'],
} as const;

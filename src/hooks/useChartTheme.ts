// ============================================================================
// Theme-aware ECharts utilities — reads CSS variables at render time
// All chart components should use these instead of hardcoded colors
// ============================================================================

import { useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

/** Read a CSS variable value from :root */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface ChartThemeColors {
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  bgPrimary: string;
  bgSecondary: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  purple: string;
  pink: string;
  cyan: string;
  series: string[];
}

/** Get theme-aware color palette for ECharts */
export function getChartColors(): ChartThemeColors {
  const accent = cssVar('--accent-primary') || '#3b82f6';
  const colors: ChartThemeColors = {
    textPrimary: cssVar('--text-primary') || '#333',
    textSecondary: cssVar('--text-secondary') || '#888',
    textTertiary: cssVar('--text-tertiary') || '#aaa',
    bgPrimary: cssVar('--bg-primary') || '#fff',
    bgSecondary: cssVar('--bg-secondary') || '#f5f5f5',
    border: cssVar('--border-secondary') || '#e5e7eb',
    accent,
    success: cssVar('--accent-success') || '#22c55e',
    warning: cssVar('--accent-warning') || '#f59e0b',
    danger: cssVar('--accent-danger') || '#ef4444',
    purple: '#8b5cf6',
    pink: '#ec4899',
    cyan: '#06b6d4',
    series: [accent, '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'],
  };
  return colors;
}

/** Hook that returns theme-aware chart colors, re-computes on theme change */
export function useChartTheme(): ChartThemeColors {
  const currentTheme = useSettingsStore((s) => s.currentTheme);
  return useMemo(() => getChartColors(), [currentTheme]);
}

/** Common ECharts tooltip style using theme colors */
export function chartTooltipStyle(colors: ChartThemeColors) {
  return {
    backgroundColor: colors.bgPrimary,
    borderColor: colors.border,
    textStyle: { color: colors.textPrimary, fontSize: 12 },
  };
}

/** Common ECharts legend style */
export function chartLegendStyle(colors: ChartThemeColors) {
  return {
    textStyle: { fontSize: 10, color: colors.textSecondary },
    itemWidth: 12,
    itemHeight: 12,
  };
}

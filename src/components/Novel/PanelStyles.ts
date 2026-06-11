// ============================================================================
// Panel Style System — Unified styles for narrative workbench panels
// Inspired by PlotPilot's atomic pp-panel CSS classes
// Usage: import { panelHeader, metricCard, ... } from './PanelStyles'
// ============================================================================

import type { CSSProperties } from 'react';

// --- Panel Header ---
export const panelHeader = (color?: string): CSSProperties => ({
  padding: '6px 12px',
  fontWeight: 600,
  fontSize: 12,
  borderBottom: '1px solid var(--border-secondary)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: color ? color + '06' : 'transparent',
});

// --- Panel Section (collapsible content block) ---
export const panelSection: CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border-secondary)',
};

export const panelSectionHeader = (color?: string): CSSProperties => ({
  fontSize: 11,
  fontWeight: 600,
  color: color || 'var(--text-secondary)',
  marginBottom: 6,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
});

// --- Metric Card (small stat display) ---
export const metricCard = (accentColor?: string): CSSProperties => ({
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border-secondary)',
  background: 'var(--bg-primary, #fff)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const metricLabel: CSSProperties = {
  fontSize: 9,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

export const metricValue = (color?: string): CSSProperties => ({
  fontSize: 18,
  fontWeight: 700,
  color: color || 'var(--text-primary)',
  lineHeight: 1.2,
});

export const metricSub: CSSProperties = {
  fontSize: 9,
  color: 'var(--text-tertiary)',
};

// --- Metric Icon Badge ---
export const metricIcon = (color?: string): CSSProperties => ({
  width: 24,
  height: 24,
  borderRadius: 5,
  background: (color || '#3b82f6') + '14',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: color || '#3b82f6',
  fontSize: 12,
});

// --- Status Chip (inline status indicator) ---
export const statusChip = (color: string): CSSProperties => ({
  fontSize: 9,
  padding: '1px 6px',
  borderRadius: 4,
  color,
  background: color + '14',
  fontWeight: 500,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  border: 'none',
});

// --- Accent Bar (left-colored bar for items) ---
export const accentBar = (color: string): CSSProperties => ({
  borderLeft: `3px solid ${color}`,
  paddingLeft: 10,
});

// --- Row Item (list row with consistent padding) ---
export const rowItem = (hasBorder = true): CSSProperties => ({
  padding: '4px 12px',
  fontSize: 11,
  borderBottom: hasBorder ? '1px solid var(--border-secondary)' : 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
});

// --- Stats Row (horizontal strip of mini metrics) ---
export const statsRow: CSSProperties = {
  display: 'flex',
  gap: 6,
  padding: '6px 12px',
  borderBottom: '1px solid var(--border-secondary)',
  background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
};

export const statItem = (color?: string): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10,
  color: color || 'var(--text-secondary)',
});

// --- Color constants for consistency ---
export const COLORS = {
  protagonist: '#ef4444',
  major: '#f59e0b',
  supporting: '#3b82f6',
  minor: '#9ca3af',
  active: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',
  muted: '#9ca3af',
  purple: '#8b5cf6',
  pink: '#ec4899',
  cyan: '#06b6d4',
};

// --- Urgency color mapping ---
export const urgencyColor = (urgency: string): string => {
  const map: Record<string, string> = {
    critical: '#ef4444',
    high: '#f59e0b',
    medium: '#3b82f6',
    low: '#9ca3af',
  };
  return map[urgency] || '#9ca3af';
};

// --- Importance color mapping ---
export const importanceColor = (importance: string): string => {
  const map: Record<string, string> = {
    protagonist: '#ef4444',
    major: '#f59e0b',
    supporting: '#3b82f6',
    minor: '#9ca3af',
  };
  return map[importance] || '#9ca3af';
};

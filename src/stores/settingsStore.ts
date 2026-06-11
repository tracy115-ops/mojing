import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings, AppearanceSettings, CreativeSettings } from '@/types';

const resolveAppearanceTheme = (theme: 'dark' | 'light' | 'anchor' | 'system'): 'dark' | 'light' | 'anchor' => {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }
  return theme;
};

const DEFAULT_SETTINGS: AppSettings = {
  general: {
    language: 'zh-CN',
    autoStart: false,
    minimizeToTray: true,
    checkUpdates: true,
    dataDir: '',
    closeAction: 'exit',
  },
  appearance: {
    theme: 'dark',
    colorPrimary: '#3b82f6',
    compactMode: false,
    sidebarWidth: 260,
    sidebarPosition: 'left',
    showStatusBar: true,
    showBreadcrumb: true,
  },
  network: {
    proxyEnabled: false,
    proxyHost: '127.0.0.1',
    proxyPort: '7890',
    proxyProtocol: 'HTTP',
    authEnabled: false,
    proxyUsername: '',
    proxyPassword: '',
    noProxy: 'localhost,127.0.0.1',
  },
  notifications: {
    enabled: false,
    channels: [],
  },
  shortcuts: [],
  creative: {
    defaultNovelStyle: 'literary',
    defaultComicStyle: 'manga',
    defaultVideoStyle: 'cinematic',
    autoSave: true,
    autoSaveIntervalSeconds: 30,
    exportFormat: 'markdown',
    maxConcurrentGenerations: 1,
  },
};

const normalizeSettings = (settings?: Partial<AppSettings>): AppSettings => {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    general: { ...DEFAULT_SETTINGS.general, ...settings?.general },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...settings?.appearance },
    network: { ...DEFAULT_SETTINGS.network, ...settings?.network },
    notifications: {
      enabled: settings?.notifications?.enabled ?? DEFAULT_SETTINGS.notifications.enabled,
      channels: settings?.notifications?.channels ?? DEFAULT_SETTINGS.notifications.channels,
    },
    shortcuts: settings?.shortcuts ?? DEFAULT_SETTINGS.shortcuts,
    creative: { ...DEFAULT_SETTINGS.creative, ...settings?.creative },
  };
  return merged;
};

interface SettingsState {
  settings: AppSettings;
  loading: boolean;
  currentTheme: 'dark' | 'light' | 'anchor';

  fetchSettings: () => Promise<void>;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  updateGeneralSettings: (updates: Partial<AppSettings['general']>) => Promise<void>;
  updateAppearanceSettings: (updates: Partial<AppearanceSettings>) => Promise<void>;
  updateNotificationSettings: (updates: Partial<AppSettings['notifications']>) => Promise<void>;
  updateCreativeSettings: (updates: Partial<CreativeSettings>) => Promise<void>;
  setTheme: (theme: 'dark' | 'light' | 'anchor' | 'system') => void;
  resetSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      loading: false,
      currentTheme: 'dark',

      fetchSettings: async () => {
        set({ loading: true });
        try {
          const current = get().settings;
          set({
            settings: normalizeSettings(current),
            currentTheme: resolveAppearanceTheme(current.appearance.theme),
            loading: false,
          });
        } catch (error) {
          console.error('获取设置失败:', error);
          set({
            settings: normalizeSettings(get().settings),
            loading: false,
          });
        }
      },

      updateSettings: async (updates) => {
        const current = get().settings;
        const newSettings = normalizeSettings({
          ...current,
          ...updates,
          general: { ...current.general, ...updates.general },
          appearance: { ...current.appearance, ...updates.appearance },
          network: { ...current.network, ...updates.network },
          notifications: {
            ...current.notifications,
            ...updates.notifications,
            channels: updates.notifications?.channels ?? current.notifications.channels,
          },
          creative: { ...current.creative, ...updates.creative },
        });

        set({
          settings: newSettings,
          currentTheme: resolveAppearanceTheme(newSettings.appearance.theme),
        });

        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('update_settings', {
            settings: { frontend_settings: newSettings },
          });
        } catch {
          // Backend not available yet, settings persisted via localStorage
        }
      },

      updateGeneralSettings: async (updates) => {
        await get().updateSettings({ general: updates as AppSettings['general'] });
      },

      updateAppearanceSettings: async (updates) => {
        await get().updateSettings({
          appearance: updates as AppSettings['appearance'],
        });
      },

      updateNotificationSettings: async (updates) => {
        await get().updateSettings({ notifications: updates } as Partial<AppSettings>);
      },

      updateCreativeSettings: async (updates) => {
        await get().updateSettings({ creative: updates } as Partial<AppSettings>);
      },

      setTheme: (theme: 'dark' | 'light' | 'anchor' | 'system') => {
        const resolvedTheme = resolveAppearanceTheme(theme);
        document.documentElement.setAttribute('data-theme', resolvedTheme);
        set({
          currentTheme: resolvedTheme,
          settings: normalizeSettings({
            ...get().settings,
            appearance: { ...get().settings.appearance, theme },
          }),
        });
      },

      resetSettings: async () => {
        set({ settings: DEFAULT_SETTINGS, currentTheme: 'dark' });
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('update_settings', {
            settings: { frontend_settings: DEFAULT_SETTINGS },
          });
        } catch {
          // Backend not available yet
        }
      },
    }),
    {
      name: 'aiworkstation-settings',
      partialize: (state) => ({
        settings: state.settings,
        currentTheme: state.currentTheme,
      }),
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<SettingsState> | undefined;
        const settings = normalizeSettings(persistedState?.settings);
        return {
          ...current,
          ...persistedState,
          settings,
          currentTheme: resolveAppearanceTheme(settings.appearance.theme),
        };
      },
    },
  ),
);

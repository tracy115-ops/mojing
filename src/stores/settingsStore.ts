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
    promptTemplates: {
      portraitZh: '角色单人全身立绘：{name}，{aesthetic}，完整外貌特征：{appearance}，全身设计锁定：保持面部发型服装款式身材比例一致，自然站姿，纯色简洁背景，工作室光照，从头到脚全身完整可见，单人居中，{artType}，{style}，无文字无水印无签名',
      portraitEn: 'solo, single character portrait of {name}, {aesthetic}, complete character appearance: {appearance}, full-body character design lock, neutral pose, plain simple solid background, studio lighting, full body visible from head to toe, {artType}, {style}, no text, no watermark',
      turnaroundZh: '三视图角色模型板，三屏并列展现3个全身姿态（左侧正面视图，中间侧面视图，右侧背面视图）：{name}，100%保持与参考图0的角色外观一致，角色外貌：{appearance}，并排站立，纯色浅色背景，工作室光照，{artType}，{style}，100%保持正面侧面背面一致，高细节大作，无文字无数字无标签',
      turnaroundEn: '3-panel split view character turnaround sheet, 3 full body views standing side-by-side: front view on the left, side profile view in the middle, back view on the right of {name}, 100% exact identical full-body character design match with reference image 0, simple plain solid light background, studio lighting, {artType}, {style}, 100% identical face and facial features, no text, no watermark',
      sceneZh: '环境空景图：{name}，{description}，纯背景画面，无人物，无人影，仅风景建筑环境，广角视角，电影级构图，三分法，大气光影，{style}，高清细节大作，无文字无水印',
      sceneEn: 'environment establishing shot of {name}, {description}, empty scene, no humans, no people, no character, background scenery only, wide angle, cinematic composition, rule of thirds, atmospheric lighting, {style}, 8k detail, photorealistic, no text, no watermark',
      keyframeZh: '电影级分镜关键帧，{prompt}，{charText}，{location}，{mood}，{camera}，{style}，{quality}，无文字无水印无多余肢体无分屏',
      keyframeEn: 'cinematic movie keyframe storyboard, {prompt}, {charText}, {location}, {mood}, {camera}, {style}, {quality}, no text, no watermark, no fused limbs, no split screen',
      qualityZh: '电影级光影，35mm镜头景深虚化，自然动作，高细节大作构图，清晰无瑕',
      qualityEn: 'cinematic movie lighting, 35mm lens depth of field, natural motion, high detail, masterpiece composition, no artifact, clean focus',
    },
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

// Keep <html data-theme> in sync with currentTheme. setTheme() does this
// inline, but updateSettings() (used by Settings page) doesn't — without this
// bridge, picking "light" / "system" from Settings changes antd algorithm
// but leaves CSS variables on the old theme.
useSettingsStore.subscribe((state) => {
  if (typeof document !== 'undefined' && state.currentTheme) {
    document.documentElement.setAttribute('data-theme', state.currentTheme);
  }
});

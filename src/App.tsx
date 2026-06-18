import React, { lazy, Suspense, useEffect, useMemo } from 'react';
import { ConfigProvider, theme, App as AntApp } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';
import { Toaster } from 'sonner';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { darkTheme, lightTheme, anchorTheme } from '@/styles/themes';
import { useSettingsStore } from '@/stores/settingsStore';
import { ErrorBoundary } from '@/components/Common/ErrorBoundary';
import { logger } from '@/services/log';

const MainLayout = lazy(() => import('@/components/Layout/MainLayout'));

const App: React.FC = () => {
  const currentTheme = useSettingsStore((s) => s.currentTheme);
  const language = useSettingsStore((s) => s.settings.general.language);
  const closeAction = useSettingsStore((s) => s.settings.general.closeAction);
  const colorPrimary = useSettingsStore((s) => s.settings.appearance.colorPrimary);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const isDark = currentTheme === 'dark' || currentTheme === 'anchor';
  const antdLocale = language === 'en-US' ? enUS : zhCN;

  // 诊断:React App 已挂载。如果这行日志没出现,说明 React render 之前就炸了。
  useEffect(() => {
    void logger.info('[boot] App mounted', 'boot');
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // Handle window close request from Rust backend
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const mainWindow = getCurrentWindow();
        unlisten = await listen('close-requested', async () => {
          if (closeAction === 'tray') {
            await mainWindow.hide();
          } else {
            const { exit } = await import('@tauri-apps/plugin-process');
            await exit(0);
          }
        });
      } catch {
        // Not running in Tauri (dev browser), ignore
      }
    })();

    return () => { unlisten?.(); };
  }, [closeAction]);

  // Apply user-selected colorPrimary on top of the static theme presets.
  // The presets (dark.ts / light.ts / anchor.ts) hard-code #3b82f6 in token
  // and several component tokens (Menu/Input/Select/Tabs/Button) — overriding
  // here is the only way the user's color choice actually takes effect.
  const resolvedTheme = useMemo(() => {
    const base = currentTheme === 'anchor' ? anchorTheme : (isDark ? darkTheme : lightTheme);
    const primary = colorPrimary ?? (base.token?.colorPrimary as string | undefined);

    if (!primary) return base;

    const primaryLowAlpha = (alpha: number) => {
      // Convert #rrggbb → rgba(r, g, b, alpha)
      const r = parseInt(primary.slice(1, 3), 16);
      const g = parseInt(primary.slice(3, 5), 16);
      const b = parseInt(primary.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    return {
      ...base,
      token: {
        ...base.token,
        colorPrimary: primary,
      },
      components: {
        ...base.components,
        Menu: {
          ...base.components?.Menu,
          darkItemSelectedBg: primaryLowAlpha(0.15),
        },
        Input: {
          ...base.components?.Input,
          activeBorderColor: primary,
          hoverBorderColor: primaryLowAlpha(0.5),
        },
        Select: {
          ...base.components?.Select,
          optionSelectedBg: primaryLowAlpha(0.15),
        },
        Tabs: {
          ...base.components?.Tabs,
          inkBarColor: primary,
          itemActiveColor: primary,
          itemSelectedColor: primary,
        },
      },
    };
  }, [currentTheme, isDark, colorPrimary]);

  return (
    <ErrorBoundary>
      <Toaster position="top-center" theme={isDark ? 'dark' : 'light'} duration={3000} />
      <StyleProvider>
        <ConfigProvider
          locale={antdLocale}
          theme={{
            token: {
              ...resolvedTheme.token,
              zIndexPopupBase: 11000,
            },
            algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            components: resolvedTheme.components ?? {},
          }}
        >
          <AntApp>
            <Suspense fallback={<div className="app-loading-shell" />}>
              <MainLayout />
            </Suspense>
          </AntApp>
        </ConfigProvider>
      </StyleProvider>
    </ErrorBoundary>
  );
};

export default App;

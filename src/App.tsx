import React, { lazy, Suspense, useEffect } from 'react';
import { ConfigProvider, theme, App as AntApp } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';
import { Toaster } from 'sonner';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { darkTheme, lightTheme, anchorTheme } from '@/styles/themes';
import { useSettingsStore } from '@/stores/settingsStore';

const MainLayout = lazy(() => import('@/components/Layout/MainLayout'));

const App: React.FC = () => {
  const currentTheme = useSettingsStore((s) => s.currentTheme);
  const language = useSettingsStore((s) => s.settings.general.language);
  const closeAction = useSettingsStore((s) => s.settings.general.closeAction);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const isDark = currentTheme === 'dark' || currentTheme === 'anchor';
  const activeTheme = currentTheme === 'anchor' ? anchorTheme : (isDark ? darkTheme : lightTheme);
  const antdLocale = language === 'en-US' ? enUS : zhCN;

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

  return (
    <>
      <Toaster position="top-center" theme={isDark ? 'dark' : 'light'} duration={3000} />
      <StyleProvider>
        <ConfigProvider
          locale={antdLocale}
          theme={{
            token: {
              ...activeTheme.token,
              zIndexPopupBase: 11000,
            },
            algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            components: activeTheme.components ?? {},
          }}
        >
          <AntApp>
            <Suspense fallback={<div className="app-loading-shell" />}>
              <MainLayout />
            </Suspense>
          </AntApp>
        </ConfigProvider>
      </StyleProvider>
    </>
  );
};

export default App;

import React, { lazy, Suspense, useEffect } from 'react';
import { ConfigProvider, theme, App as AntApp } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';
import { Toaster } from 'sonner';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { darkTheme, lightTheme } from '@/styles/themes';
import { useSettingsStore } from '@/stores/settingsStore';

const MainLayout = lazy(() => import('@/components/Layout/MainLayout'));

const App: React.FC = () => {
  const currentTheme = useSettingsStore((s) => s.currentTheme);
  const language = useSettingsStore((s) => s.settings.general.language);
  const fetchSettings = useSettingsStore((s) => s.fetchSettings);
  const isDark = currentTheme !== 'light';
  const activeTheme = isDark ? darkTheme : lightTheme;
  const antdLocale = language === 'en-US' ? enUS : zhCN;

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  return (
    <>
      <Toaster position="top-center" theme={isDark ? 'dark' : 'light'} duration={3000} />
      <StyleProvider layer>
        <ConfigProvider
          locale={antdLocale}
          theme={{
            cssVar: {
              key: `aiws-${isDark ? 'dark' : 'light'}`,
              prefix: 'ant',
            },
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

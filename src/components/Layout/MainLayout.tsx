import React, { useState, useCallback, useEffect } from 'react';
import { Menu, Button, Tooltip } from 'antd';
import {
  BookOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SettingOutlined,
  MinusOutlined,
  BorderOutlined,
  BlockOutlined,
  CloseOutlined,
  SunOutlined,
  MoonOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTranslation } from '@/i18n';
import NovelView from '@/components/Novel/NovelView';
import ComicView from '@/components/Comic/ComicView';
import VideoView from '@/components/Video/VideoView';
import SettingsPanel from '@/components/Settings/SettingsPanel';

type ViewKey = 'novels' | 'comics' | 'videos' | 'settings';

const MainLayout: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewKey>('novels');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { t } = useTranslation();
  const currentTheme = useSettingsStore((s) => s.currentTheme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const settings = useSettingsStore((s) => s.settings);

  const handleWindowAction = useCallback(async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      switch (action) {
        case 'minimize': await win.minimize(); break;
        case 'maximize': {
          const isMax = await win.isMaximized();
          isMax ? await win.unmaximize() : await win.maximize();
          break;
        }
        case 'close': await win.close(); break;
      }
    } catch {
      // Not in Tauri environment
    }
  }, []);

  const cycleTheme = useCallback(() => {
    const current = settings.appearance.theme;
    if (current === 'dark') setTheme('light');
    else if (current === 'light') setTheme('system');
    else setTheme('dark');
  }, [settings.appearance.theme, setTheme]);

  const themeIcon = settings.appearance.theme === 'dark' ? <MoonOutlined />
    : settings.appearance.theme === 'light' ? <SunOutlined />
    : <BlockOutlined />;

  const themeTooltip = settings.appearance.theme === 'dark' ? t('settings.general.theme.dark')
    : settings.appearance.theme === 'light' ? t('settings.general.theme.light')
    : t('settings.general.theme.system');

  const menuItems = [
    { key: 'novels', icon: <BookOutlined />, label: t('sidebar.novels') },
    { key: 'comics', icon: <PictureOutlined />, label: t('sidebar.comics') },
    { key: 'videos', icon: <VideoCameraOutlined />, label: t('sidebar.videos') },
    { type: 'divider' as const },
    { key: 'settings', icon: <SettingOutlined />, label: t('sidebar.settings') },
  ];

  const renderContent = () => {
    switch (activeView) {
      case 'novels': return <NovelView />;
      case 'comics': return <ComicView />;
      case 'videos': return <VideoView />;
      case 'settings': return <SettingsPanel />;
      default: return <NovelView />;
    }
  };

  return (
    <div className="ws-shell">
      {/* TitleBar */}
      <div className="ws-titlebar" data-tauri-drag-region>
        <Tooltip title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} placement="right">
          <Button
            type="text"
            size="small"
            className="ws-titlebar-btn"
            icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          />
        </Tooltip>

        <div className="ws-titlebar-title" data-tauri-drag-region>
          MoJing 墨境
        </div>

        <div style={{ display: 'flex', gap: 2 }}>
          <Tooltip title={themeTooltip}>
            <Button
              type="text"
              size="small"
              className="ws-titlebar-btn"
              icon={themeIcon}
              onClick={cycleTheme}
            />
          </Tooltip>
          <button className="ws-titlebar-btn" onClick={() => handleWindowAction('minimize')}>
            <MinusOutlined style={{ fontSize: 12 }} />
          </button>
          <button className="ws-titlebar-btn" onClick={() => handleWindowAction('maximize')}>
            <BorderOutlined style={{ fontSize: 11 }} />
          </button>
          <button className="ws-titlebar-btn close" onClick={() => handleWindowAction('close')}>
            <CloseOutlined style={{ fontSize: 12 }} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="ws-body">
        {/* Sidebar */}
        <div className={`ws-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="ws-sidebar-nav">
            <Menu
              mode="inline"
              selectedKeys={[activeView]}
              onClick={({ key }) => {
                setActiveView(key as ViewKey);
                if (key === 'settings') {
                  setSettingsOpen(true);
                }
              }}
              items={menuItems}
              inlineCollapsed={sidebarCollapsed}
              style={{ border: 'none', background: 'transparent' }}
              theme={currentTheme === 'dark' ? 'dark' : 'light'}
            />
          </div>
        </div>

        {/* Content */}
        <div className="ws-content">
          {renderContent()}
        </div>
      </div>

      {/* StatusBar */}
      <div className="ws-statusbar">
        <span className="ws-statusbar-item">
          {t(`sidebar.${activeView}`)}
        </span>
        <span className="ws-statusbar-item">
          {t('settings.general.theme')}: {t(`settings.general.theme.${settings.appearance.theme}`)}
        </span>
      </div>
    </div>
  );
};

export default MainLayout;

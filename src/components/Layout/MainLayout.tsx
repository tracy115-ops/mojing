import React, { useState, useCallback } from 'react';
import { Menu, Button, Tooltip, Modal } from 'antd';
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
import { getCurrentWindow } from '@tauri-apps/api/window';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tauriWin = () => getCurrentWindow() as any;
import { useSettingsStore } from '@/stores/settingsStore';
import { useTranslation } from '@/i18n';
import NovelView from '@/components/Novel/NovelView';
import ComicView from '@/components/Comic/ComicView';
import VideoView from '@/components/Video/VideoView';
import SettingsPanel from '@/components/Settings/SettingsPanel';

type ViewKey = 'novels' | 'comics' | 'videos';

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
      const win = tauriWin();
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
      default: return <NovelView />;
    }
  };

  const handleTitlebarMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.ant-btn') || target.closest('.ant-tooltip')) return;
    try {
      await tauriWin().startDragging();
    } catch {
      // Not in Tauri
    }
  }, []);

  return (
    <div className="ws-shell">
      <div className="ws-titlebar" onMouseDown={handleTitlebarMouseDown}>
        <Tooltip title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} placement="right">
          <Button
            type="text"
            size="small"
            className="ws-titlebar-btn"
            icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          />
        </Tooltip>

        <div className="ws-titlebar-title">
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
              selectedKeys={[settingsOpen ? 'settings' : activeView]}
              onClick={({ key }) => {
                if (key === 'settings') {
                  setSettingsOpen(true);
                } else {
                  setSettingsOpen(false);
                  setActiveView(key as ViewKey);
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

      {/* Settings Modal */}
      <Modal
        title={t('settings.title')}
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        footer={null}
        width={780}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
        styles={{
          body: { maxHeight: 'calc(100vh - 200px)', overflow: 'auto' },
        }}
      >
        <SettingsPanel />
      </Modal>

      {/* StatusBar */}
      <div className="ws-statusbar">
        <span className="ws-statusbar-item">
          {settingsOpen ? t('sidebar.settings') : t(`sidebar.${activeView}`)}
        </span>
        <span className="ws-statusbar-item">
          {t('settings.general.theme')}: {t(`settings.general.theme.${settings.appearance.theme}`)}
        </span>
      </div>
    </div>
  );
};

export default MainLayout;

import React, { useState, useCallback } from 'react';
import { Button, Tooltip, Modal, Dropdown } from 'antd';
import {
  BookOutlined,
  PictureOutlined,
  VideoCameraOutlined,
  SettingOutlined,
  MinusOutlined,
  BorderOutlined,
  CloseOutlined,
  SunOutlined,
  MoonOutlined,
  CrownOutlined,
  BlockOutlined,
  PlusOutlined,
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

interface NavTab {
  key: ViewKey | 'settings';
  icon: React.ReactNode;
  label: string;
  color: string;
}

const MainLayout: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewKey>('novels');
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
    else if (current === 'light') setTheme('anchor');
    else if (current === 'anchor') setTheme('system');
    else setTheme('dark');
  }, [settings.appearance.theme, setTheme]);

  const themeIcon = settings.appearance.theme === 'dark' ? <MoonOutlined />
    : settings.appearance.theme === 'light' ? <SunOutlined />
    : settings.appearance.theme === 'anchor' ? <CrownOutlined />
    : <BlockOutlined />;

  const themeTooltip = settings.appearance.theme === 'dark' ? t('settings.general.theme.dark')
    : settings.appearance.theme === 'light' ? t('settings.general.theme.light')
    : settings.appearance.theme === 'anchor' ? t('settings.general.theme.anchor')
    : t('settings.general.theme.system');

  const navTabs: NavTab[] = [
    { key: 'novels', icon: <BookOutlined />, label: t('sidebar.novels'), color: '#3b82f6' },
    { key: 'comics', icon: <PictureOutlined />, label: t('sidebar.comics'), color: '#f59e0b' },
    { key: 'videos', icon: <VideoCameraOutlined />, label: t('sidebar.videos'), color: '#ef4444' },
    { key: 'settings', icon: <SettingOutlined />, label: t('sidebar.settings'), color: '#8b5cf6' },
  ];

  const activeKey = settingsOpen ? 'settings' : activeView;

  const renderContent = () => {
    switch (activeView) {
      case 'novels': return <NovelView />;
      case 'comics': return <ComicView />;
      case 'videos': return <VideoView />;
      default: return <NovelView />;
    }
  };

  const dispatchCreate = useCallback((type: string) => {
    // Switch to the corresponding view and dispatch a custom event
    if (type === 'novel') setActiveView('novels');
    else if (type === 'comic') setActiveView('comics');
    else if (type === 'video') setActiveView('videos');
    setSettingsOpen(false);
    window.dispatchEvent(new CustomEvent('mojing:create-project', { detail: { type } }));
  }, []);

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
      {/* Titlebar with integrated horizontal nav */}
      <div className="ws-titlebar" onMouseDown={handleTitlebarMouseDown}>
        {/* Nav tabs — integrated into titlebar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
          {navTabs.map((tab) => {
            const isActive = activeKey === tab.key;
            return (
              <button
                key={tab.key}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.key === 'settings') {
                    setSettingsOpen(true);
                  } else {
                    setSettingsOpen(false);
                    setActiveView(tab.key as ViewKey);
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '4px 12px', fontSize: 12,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? tab.color : 'var(--text-secondary)',
                  background: isActive ? tab.color + '10' : 'transparent',
                  border: 'none',
                  borderBottom: isActive ? `2px solid ${tab.color}` : '2px solid transparent',
                  borderRadius: '4px 4px 0 0',
                  cursor: 'pointer', transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* New project — dropdown before window controls */}
        <div style={{ display: 'flex', alignItems: 'center', marginRight: 2 }}>
          <Dropdown
            menu={{
              items: [
                { key: 'novel', icon: <BookOutlined />, label: t('sidebar.novels'), onClick: () => dispatchCreate('novel') },
                { key: 'comic', icon: <PictureOutlined />, label: t('sidebar.comics'), onClick: () => dispatchCreate('comic') },
                { key: 'video', icon: <VideoCameraOutlined />, label: t('sidebar.videos'), onClick: () => dispatchCreate('video') },
              ],
            }}
            trigger={['click']}
          >
            <Tooltip title={t('project.new')}>
              <button
                className="ws-titlebar-btn"
                onClick={(e) => e.stopPropagation()}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <PlusOutlined style={{ fontSize: 13 }} />
              </button>
            </Tooltip>
          </Dropdown>
        </div>

        {/* Window controls */}
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
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

      {/* Body — no sidebar, content takes full width */}
      <div className="ws-body">
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

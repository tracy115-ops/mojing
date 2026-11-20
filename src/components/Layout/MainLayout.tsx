import React, { lazy, Suspense, useState, useCallback, useEffect } from 'react';
import { Button, Tooltip, Modal, Spin } from 'antd';
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
} from '@ant-design/icons';
import { getCurrentWindow } from '@tauri-apps/api/window';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tauriWin = () => getCurrentWindow() as any;
import { useSettingsStore } from '@/stores/settingsStore';
import { useTranslation } from '@/i18n';
import { CustomerServiceOutlined } from '@ant-design/icons';

const NovelView = lazy(() => import('@/components/Novel/NovelView'));
const ComicView = lazy(() => import('@/components/Comic/ComicView'));
const VideoView = lazy(() => import('@/components/VideoStudio/StudioWorkspace'));
const MusicView = lazy(() => import('@/components/Music/MusicView'));
const SettingsPanel = lazy(() => import('@/components/Settings/SettingsPanel'));

type ViewKey = 'novels' | 'comics' | 'videos' | 'music';

interface NavTab {
  key: ViewKey | 'settings';
  icon: React.ReactNode;
  label: string;
  color: string;
}

const MainLayout: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewKey>('novels');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string>();
  const { t } = useTranslation();
  const currentTheme = useSettingsStore((s) => s.currentTheme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    const handler = (event: Event) => {
      setSettingsTab((event as CustomEvent<{ tab?: string }>).detail?.tab);
      setSettingsOpen(true);
    };
    window.addEventListener('mojing:open-settings', handler);
    return () => window.removeEventListener('mojing:open-settings', handler);
  }, []);

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

  const loadingView = (
    <div className="ws-view-loading">
      <Spin tip={t('common.loading')} />
    </div>
  );

  const navTabs: NavTab[] = [
    { key: 'novels', icon: <BookOutlined />, label: t('sidebar.novels'), color: '#3b82f6' },
    { key: 'comics', icon: <PictureOutlined />, label: t('sidebar.comics'), color: '#f59e0b' },
    { key: 'videos', icon: <VideoCameraOutlined />, label: t('sidebar.videos'), color: '#ef4444' },
    { key: 'music', icon: <CustomerServiceOutlined />, label: t('sidebar.music'), color: '#10b981' },
    { key: 'settings', icon: <SettingOutlined />, label: t('sidebar.settings'), color: '#8b5cf6' },
  ];

  const activeKey = settingsOpen ? 'settings' : activeView;

  const renderContent = () => {
    switch (activeView) {
      case 'novels': return <NovelView />;
      case 'comics': return <ComicView />;
      case 'videos': return <VideoView />;
      case 'music': return <MusicView />;
      default: return <NovelView />;
    }
  };

  const handleTitlebarMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target)) return;
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
        <div className="ws-titlebar-nav" style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
          {navTabs.map((tab) => {
            const isActive = activeKey === tab.key;
            return (
              <button
                key={tab.key}
                className="ws-nav-tab"
                aria-label={tab.label}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.key === 'settings') {
                    setSettingsTab(undefined);
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
                  <span className="ws-nav-label">{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Window controls */}
        <div className="ws-titlebar-window-controls" style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
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
          <Suspense fallback={loadingView}>{renderContent()}</Suspense>
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
        <Suspense fallback={loadingView}><SettingsPanel key={settingsTab} defaultTab={settingsTab} /></Suspense>
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

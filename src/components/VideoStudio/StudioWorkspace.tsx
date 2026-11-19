import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, Button, Spin, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, ApartmentOutlined, BorderOutlined, BuildOutlined, FileImageOutlined, FolderOpenOutlined, HistoryOutlined, PictureOutlined, PlaySquareOutlined, RobotOutlined, SettingOutlined, ShoppingOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import type { StudioPage } from '@/types/video-studio';
import './StudioWorkspace.css';

const Projects = lazy(() => import('@/components/Video/VideoView'));
const Creator = lazy(() => import('./StudioCreator'));
const Canvas = lazy(() => import('./StudioCanvas'));
const World = lazy(() => import('./WorldEngine'));
const Library = lazy(() => import('./StudioLibrary'));
const Tasks = lazy(() => import('./StudioTasks'));
const Recipes = lazy(() => import('./StudioRecipes'));
const Plugins = lazy(() => import('./StudioPlugins'));
const Commerce = lazy(() => import('./StudioCommerce'));

const navigation: Array<{ page: StudioPage; icon: React.ReactNode; group: number }> = [
  { page: 'home', icon: <AppstoreOutlined />, group: 0 }, { page: 'projects', icon: <VideoCameraOutlined />, group: 0 },
  { page: 'canvas', icon: <ApartmentOutlined />, group: 0 }, { page: 'world', icon: <BuildOutlined />, group: 0 },
  { page: 'image', icon: <FileImageOutlined />, group: 1 }, { page: 'video', icon: <PlaySquareOutlined />, group: 1 },
  { page: 'commerce', icon: <ShoppingOutlined />, group: 1 },
  { page: 'assets', icon: <FolderOpenOutlined />, group: 2 }, { page: 'tasks', icon: <HistoryOutlined />, group: 2 },
  { page: 'skills', icon: <RobotOutlined />, group: 2 }, { page: 'plugins', icon: <SettingOutlined />, group: 2 },
];

const navigationGroupLabels: Record<number, string> = {
  0: '项目与场景',
  1: '生成工具',
  2: '素材与设置',
};

export default function StudioWorkspace() {
  const { t } = useTranslation();
  const hydrated = useVideoStudioStore((state) => state.hydrated);
  const hydrationError = useVideoStudioStore((state) => state.storageError);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    const handler = (event: Event) => setSaveError(String((event as CustomEvent).detail));
    window.addEventListener('mojing:studio-storage-error', handler);
    return () => window.removeEventListener('mojing:studio-storage-error', handler);
  }, []);
  const page = useVideoStudioStore((state) => state.page);
  const setPage = useVideoStudioStore((state) => state.setPage);
  const pending = useVideoStudioStore((state) => state.jobs.filter((job) => job.status === 'running' || job.status === 'queued').length);
  if (!hydrated) return <div className="video-studio-loading"><Spin /></div>;
  const renderPage = () => {
    switch (page) {
      case 'projects': return <Projects />;
      case 'canvas': return <Canvas />;
      case 'world': return <World />;
      case 'assets': return <Library />;
      case 'tasks': return <Tasks />;
      case 'skills': return <Recipes />;
      case 'plugins': return <Plugins />;
      case 'commerce': return <Commerce />;
      default: return <Creator key={page} initialKind={page === 'image' ? 'image' : 'video'} home={page === 'home'} />;
    }
  };
  return <div className={`video-studio-shell ${page === 'projects' ? 'is-project' : ''}`} data-testid="video-studio-workspace">
    <nav className="video-studio-nav" aria-label={t('studio.title')}>
      <div className="video-studio-brand"><BorderOutlined /><strong>{t('studio.title')}</strong></div>
      {navigation.map((item, index) => <React.Fragment key={item.page}>
        {(index === 0 || item.group !== navigation[index - 1].group) && <>{index > 0 && <div className="video-studio-nav-divider" />}<div className="video-studio-nav-group-label">{navigationGroupLabels[item.group]}</div></>}
        <Tooltip title={t(`studio.page.${item.page}`)} placement="right">
          <button type="button" data-testid={`studio-nav-${item.page}`} aria-label={t(`studio.page.${item.page}`)} aria-current={page === item.page ? 'page' : undefined} className={page === item.page ? 'is-active' : ''} onClick={() => setPage(item.page)}>
            {item.icon}<span>{t(`studio.page.${item.page}`)}</span>{item.page === 'tasks' && pending > 0 && <small>{pending}</small>}
          </button>
        </Tooltip>
      </React.Fragment>)}
    </nav>
    <section className={`video-studio-main is-${page}`}>
      {(hydrationError || saveError) && <Alert type="error" showIcon message={t('studio.storage.failed')} description={hydrationError || saveError} />}
      {page !== 'projects' && <header className="video-studio-page-heading">
        <div><Typography.Title level={3}>{t(`studio.page.${page}`)}</Typography.Title><Typography.Text type="secondary">{t(`studio.subtitle.${page}`)}</Typography.Text></div>
        {(page === 'home' || page === 'image' || page === 'video') && <Button icon={<PictureOutlined />} onClick={() => setPage('assets')}>{t('studio.page.assets')}</Button>}
      </header>}
      <Suspense fallback={<div className="video-studio-loading"><Spin /></div>}>{renderPage()}</Suspense>
    </section>
  </div>;
}

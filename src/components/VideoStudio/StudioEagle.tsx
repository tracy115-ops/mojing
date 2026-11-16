import { useState } from 'react';
import { Alert, Button, Empty, Input, Select, Space, Spin, Tag, Tree, Typography, message } from 'antd';
import { FolderOutlined, FileOutlined } from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { eagleBase, eagleRequest, importEagleItem, uploadToEagle, type EagleFolder, type EagleItem, type EagleLibrary } from '@/services/video-studio/eagle';
import './StudioEagle.css';

const foldersAsTree = (folders: EagleFolder[]): DataNode[] => folders.map((folder) => ({ key: folder.id, title: folder.name, icon: <FolderOutlined />, children: foldersAsTree(folder.children ?? []) }));
export default function StudioEagle() {
  const { t } = useTranslation();
  const store = useVideoStudioStore();
  const [base, setBase] = useState(store.eagleBaseUrl), [library, setLibrary] = useState<EagleLibrary>(), [items, setItems] = useState<EagleItem[]>([]);
  const [folder, setFolder] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(0), [folderName, setFolderName] = useState(''), [assetId, setAssetId] = useState<string>();
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('');
  const load = async (folderId = folder, keyword = search, offsetPage = 0) => {
    setLoading(true); setError('');
    try {
      const normalized = eagleBase(base);
      const query = new URLSearchParams({ limit: '40', offset: String(offsetPage * 40), ...(folderId ? { folders: folderId } : {}), ...(keyword.trim() ? { keyword: keyword.trim() } : {}) });
      const [info, files] = await Promise.all([eagleRequest<EagleLibrary>(normalized, '/api/library/info'), eagleRequest<EagleItem[]>(normalized, `/api/item/list?${query}`)]);
      if (!info.library?.path || !Array.isArray(info.folders) || !Array.isArray(files)) throw new Error(t('studio.eagle.invalid'));
      setLibrary(info); setItems(files.filter((item) => !item.isDeleted)); setPage(offsetPage); setFolder(folderId);
      useVideoStudioStore.setState({ eagleBaseUrl: normalized });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setItems([]); }
    finally { setLoading(false); }
  };
  const importItem = async (item: EagleItem) => {
    if (!library) return;
    setWorking(true);
    try { store.addAsset(await importEagleItem(base, library, item)); message.success(t('studio.imported')); }
    catch (reason) { const text = reason instanceof Error ? reason.message : String(reason); message.error(text === 'EAGLE_DESKTOP_REQUIRED' ? t('studio.eagle.desktop') : text); }
    finally { setWorking(false); }
  };
  const createFolder = async () => {
    if (!folderName.trim()) return;
    setWorking(true);
    try { await eagleRequest(base, '/api/folder/create', { folderName: folderName.trim(), ...(folder ? { parent: folder } : {}) }); setFolderName(''); await load(); }
    catch (reason) { message.error(String(reason)); }
    finally { setWorking(false); }
  };
  const upload = async () => {
    const asset = store.assets.find((item) => item.id === assetId); if (!asset) return;
    setWorking(true);
    try { await uploadToEagle(base, asset, folder); message.success(t('studio.eagle.uploaded')); await load(); }
    catch (reason) { message.error(String(reason)); }
    finally { setWorking(false); }
  };
  return <div className="studio-eagle" data-testid="studio-eagle"><Typography.Paragraph type="secondary">{t('studio.eagle.hint')}</Typography.Paragraph><div className="video-studio-toolbar"><Input aria-label={t('studio.eagle.address')} value={base} onChange={(event) => setBase(event.target.value)} /><Button type="primary" loading={loading} onClick={() => void load()}>{t('studio.eagle.connect')}</Button>{library && <Tag>{library.library.name}</Tag>}</div>{error && <Alert type="error" showIcon message={t('studio.eagle.failed')} description={error} />}
    {library && <><div className="video-studio-toolbar"><Input.Search aria-label={t('studio.search')} placeholder={t('studio.search')} value={search} onChange={(event) => setSearch(event.target.value)} onSearch={() => void load()} /><Input aria-label={t('studio.eagle.folderName')} placeholder={t('studio.eagle.folderName')} value={folderName} onChange={(event) => setFolderName(event.target.value)} /><Button disabled={!folderName.trim() || working} onClick={() => void createFolder()}>{t('studio.eagle.newFolder')}</Button><Select aria-label={t('studio.eagle.studioAsset')} placeholder={t('studio.eagle.studioAsset')} value={assetId} onChange={setAssetId} options={store.assets.filter((asset) => ['image', 'video', 'audio'].includes(asset.kind)).map((asset) => ({ value: asset.id, label: asset.name }))} /><Button disabled={!assetId} loading={working} onClick={() => void upload()}>{t('studio.eagle.upload')}</Button></div>
      <div className="studio-eagle-body"><aside><Button type={!folder ? 'primary' : 'default'} onClick={() => void load('', search)}>{t('studio.all')}</Button><Tree showIcon selectedKeys={folder ? [folder] : []} treeData={foldersAsTree(library.folders)} onSelect={(keys) => void load(String(keys[0] ?? ''), search)} /></aside><section><Spin spinning={loading}>{!items.length ? <Empty description={t('studio.empty')} /> : <div className="video-studio-grid">{items.map((item) => <article className="video-studio-card" key={item.id}><FileOutlined /><Typography.Text strong>{item.name}</Typography.Text><Space wrap><Tag>{item.ext}</Tag>{item.width && item.height && <Typography.Text type="secondary">{item.width} × {item.height}</Typography.Text>}</Space><Button disabled={working} onClick={() => void importItem(item)}>{t('studio.eagle.import')}</Button></article>)}</div>}</Spin><Space className="studio-eagle-pagination"><Button disabled={!page || loading} onClick={() => void load(folder, search, page - 1)}>{t('studio.eagle.previous')}</Button><Tag>{page + 1}</Tag><Button disabled={items.length < 40 || loading} onClick={() => void load(folder, search, page + 1)}>{t('studio.eagle.next')}</Button></Space></section></div>
    </>}
  </div>;
}

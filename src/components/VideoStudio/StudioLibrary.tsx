import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Popconfirm, Select, Space, Tag, Upload, Typography, message } from 'antd';
import { DeleteOutlined, FolderAddOutlined, FolderOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { collectProjectStudioAssets, type ProjectStudioAsset } from '@/services/video-studio/project-assets';
import { createStudioCanvas, studioId, studioNow } from '@/services/video-studio/document';
import { downloadStudioFile, importStudioFile } from '@/services/video-studio/generation';
import { embedAssets } from '@/services/video-studio/bundle';
import { ASSET_BUNDLE_MAX_BYTES, ASSET_BUNDLE_MAX_COUNT, assetBundleFolders, parseAssetBundle, sortedAssetFolders } from '@/services/video-studio/asset-bundle';
import { assetFolderPath, folderDescendants, normalizeAssetTags, referencedStudioAssets } from '@/services/video-studio/library';
import { readAsDataUri } from '@/services/video/asset-store';
import { providerRouter } from '@/services/providers';
import type { StudioAsset, StudioAssetFolder } from '@/types/video-studio';
import StudioMedia from './StudioMedia';
import StudioLinkImport from './StudioLinkImport';
import StudioImageEditor from './StudioImageEditor';
import StudioProjectTransfer from './StudioProjectTransfer';
import StudioVideoTranscode from './StudioVideoTranscode';
import StudioUploadModal from './StudioUploadModal';
import { modelReadableMediaUrl } from '@/services/video-studio/upload-contract';
import './StudioLibrary.css';

const categories: StudioAsset['category'][] = ['character', 'scene', 'prop', 'reference', 'output'];

export default function StudioLibrary() {
  const { t } = useTranslation(), studio = useVideoStudioStore();
  const projects = useVideoStore((state) => state.projects), projectList = useProjectStore((state) => state.projects);
  const [search, setSearch] = useState(''), [kind, setKind] = useState('all'), [category, setCategory] = useState('all'), [tag, setTag] = useState<string>();
  const [scope, setScope] = useState('all'), [selection, setSelection] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ProjectStudioAsset>(), [editing, setEditing] = useState<ProjectStudioAsset>();
  const [uploadId, setUploadId] = useState<string>();
  const [folderForm, setFolderForm] = useState<StudioAssetFolder>();
  const [organizing, setOrganizing] = useState(false), [targetFolder, setTargetFolder] = useState('keep'), [targetCategory, setTargetCategory] = useState('keep');
  const [tags, setTags] = useState<string[]>([]), [tagAction, setTagAction] = useState('add'), [rename, setRename] = useState('');
  const projectAssets = useMemo(() => collectProjectStudioAssets(projects, Object.fromEntries(projectList.map((project) => [project.id, project.title]))), [projects, projectList]);
  const folders = sortedAssetFolders(studio.assetFolders), currentFolder = scope.startsWith('folder:') ? scope.slice(7) : undefined;
  const trash = scope === 'trash', folderIds = currentFolder ? folderDescendants(folders, currentFolder) : [];
  const source: ProjectStudioAsset[] = trash ? studio.trashedAssets : scope === 'projects' ? projectAssets : scope === 'all' ? [...studio.assets, ...projectAssets] : studio.assets;
  const assets = source.filter((asset) => (!currentFolder || !!asset.folderId && folderIds.includes(asset.folderId)) && (scope !== 'unfiled' || !asset.folderId) && (kind === 'all' || kind === asset.kind) && (category === 'all' || category === asset.category) && (!tag || asset.tags?.includes(tag)) && `${asset.name} ${asset.text ?? ''} ${(asset.tags ?? []).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const selectedAssets = source.filter((asset) => selection.includes(asset.id) && !asset.projectId);
  const selectableIds = assets.filter((asset) => !asset.projectId).map((asset) => asset.id);
  const tagOptions = [...new Set(studio.assets.flatMap((asset) => asset.tags ?? []))].sort().map((value) => ({ value, label: value }));
  const references = referencedStudioAssets(studio);
  useEffect(() => setSelection([]), [scope, search, kind, category, tag]);
  useEffect(() => { if (currentFolder && !studio.assetFolders.some((folder) => folder.id === currentFolder)) setScope('all'); }, [currentFolder, studio.assetFolders]);

  const placeImported = (asset: StudioAsset) => { if (currentFolder) studio.organizeAssets([asset.id], { folderId: currentFolder }); };
  const retain = (asset: ProjectStudioAsset) => {
    if (!asset.projectId) return asset;
    const copy = { ...asset, id: studioId(), folderId: currentFolder, createdAt: studioNow() };
    delete copy.projectId; studio.addAsset(copy); return copy;
  };
  const addToCanvas = (asset: ProjectStudioAsset) => {
    const saved = retain(asset), canvas = studio.canvases.find((item) => item.id === studio.activeCanvasId) ?? createStudioCanvas(t('studio.canvas.new'));
    studio.saveCanvas({ ...canvas, nodes: [...canvas.nodes, { id: studioId(), name: saved.name, kind: saved.kind, prompt: saved.text ?? '', assetId: saved.id, x: 100 + canvas.nodes.length % 3 * 300, y: 100 + Math.floor(canvas.nodes.length / 3) * 300 }], updatedAt: studioNow() });
    studio.setPage('canvas');
  };
  const recycle = (ids: string[]) => {
    const result = useVideoStudioStore.getState().trashAssets(ids);
    setSelection(result.blocked);
    if (result.blocked.length) message.warning(t('studio.library.protected', { moved: result.changed.length, blocked: result.blocked.length }));
    else message.success(t('studio.library.recycled', { count: result.changed.length }));
  };
  const reuseInVideo = (asset: ProjectStudioAsset) => {
    try {
      const caps = providerRouter.getVideoCapabilities('clip');
      if (asset.kind === 'audio' || asset.kind === 'video') {
        if (!caps.references[asset.kind]?.maxCount) { message.warning(t('studio.media.unsupported')); return; }
        const saved = retain(asset);
        studio.setDraft({ kind: 'video', controlMode: 'reference', referenceAssetIds: [], firstFrameAssetId: undefined, lastFrameAssetId: undefined, audioReferenceAssetIds: asset.kind === 'audio' ? [saved.id] : [], videoReferenceAssetIds: asset.kind === 'video' ? [saved.id] : [] });
        studio.setPage('video'); return;
      }
      if (!caps.references.supportsSubjectReferences && !caps.references.supportsFirstFrame) { message.warning(t('studio.creator.noReferenceSupport')); return; }
      const saved = retain(asset);
      studio.setDraft({ kind: 'video', controlMode: caps.references.supportsSubjectReferences ? 'reference' : 'keyframe', referenceAssetIds: caps.references.supportsSubjectReferences ? [saved.id] : [], firstFrameAssetId: caps.references.supportsSubjectReferences ? undefined : saved.id, lastFrameAssetId: undefined, audioReferenceAssetIds: [], videoReferenceAssetIds: [] });
      studio.setPage('video');
    } catch (error) { message.error(String(error)); }
  };
  const download = async (asset: ProjectStudioAsset) => {
    try {
      if (asset.kind === 'text') { downloadStudioFile(asset.text ?? '', `${asset.name}.txt`, 'text/plain'); return; }
      if (!asset.url) return;
      const blob = await (await fetch(await readAsDataUri(asset.url))).blob();
      const ext = asset.kind === 'model' ? 'glb' : blob.type.split('/')[1]?.replace('jpeg', 'jpg') || (asset.kind === 'image' ? 'png' : asset.kind === 'video' ? 'mp4' : 'mp3');
      downloadStudioFile(blob, `${asset.name.replace(/[<>:"/\\|?*]/g, '_')}.${ext}`);
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  const exportPackage = async () => {
    if (!selectedAssets.length || selectedAssets.length > ASSET_BUNDLE_MAX_COUNT) { message.warning(t('studio.library.packageLimit')); return; }
    setBusy(true);
    try {
      const assets = await embedAssets(new Set(selectedAssets.map((asset) => asset.id)), selectedAssets);
      const json = JSON.stringify({ format: 'mojing.assets/1', assets, folders: assetBundleFolders(assets, folders) });
      const blob = new Blob([json], { type: 'application/json' });
      if (blob.size > ASSET_BUNDLE_MAX_BYTES) throw new Error(t('studio.library.packageLimit'));
      downloadStudioFile(blob, `studio-${Date.now()}.assets.json`);
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); } finally { setBusy(false); }
  };
  const importPackage = async (file: File) => {
    setBusy(true);
    try {
      if (file.size > ASSET_BUNDLE_MAX_BYTES) throw new Error(t('studio.library.packageLimit'));
      const parsed = parseAssetBundle(JSON.parse(await file.text()));
      const root = { id: studioId(), name: `${t('studio.library.packageFolder')} ${new Date().toLocaleTimeString()}` };
      useVideoStudioStore.setState((state) => ({ assetFolders: [...state.assetFolders, root, ...parsed.folders.map((folder) => ({ ...folder, parentId: folder.parentId ?? root.id }))], assets: [...state.assets, ...parsed.assets.map((asset) => ({ ...asset, folderId: asset.folderId ?? root.id }))] }));
      setScope(`folder:${root.id}`); message.success(t('studio.imported'));
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); } finally { setBusy(false); }
  };
  const openOrganize = (ids: string[]) => {
    setSelection(ids); setTargetFolder('keep'); setTargetCategory('keep'); setTags([]); setTagAction('add');
    setRename(ids.length === 1 ? studio.assets.find((asset) => asset.id === ids[0])?.name ?? '' : ''); setOrganizing(true);
  };
  const organize = () => {
    studio.organizeAssets(selection, { ...(targetFolder !== 'keep' ? { folderId: targetFolder === 'unfiled' ? undefined : targetFolder } : {}), ...(targetCategory !== 'keep' ? { category: targetCategory as StudioAsset['category'] } : {}), ...(tags.length ? tagAction === 'add' ? { addTags: tags } : { removeTags: tags } : {}) });
    if (selection.length === 1 && rename.trim()) studio.updateAsset(selection[0], { name: rename.trim().slice(0, 200) });
    setOrganizing(false); message.success(t('studio.saved'));
  };
  return <div className="video-studio-content studio-library" data-testid="studio-assets">
    <div className="studio-library-layout">
      <aside className="studio-library-folders" aria-label={t('studio.library.folders')}>
        <Button icon={<FolderAddOutlined />} onClick={() => setFolderForm({ id: studioId(), name: '', parentId: currentFolder })}>{t('studio.library.newFolder')}</Button>
        {(['all', 'unfiled', 'projects', 'trash'] as const).map((value) => <button type="button" key={value} data-library-scope={value} className={scope === value ? 'is-active' : ''} onClick={() => setScope(value)}>{value === 'trash' ? <DeleteOutlined /> : <FolderOutlined />}<span>{t(`studio.library.scope.${value}`)}</span><small>{value === 'trash' ? studio.trashedAssets.length : value === 'projects' ? projectAssets.length : value === 'unfiled' ? studio.assets.filter((asset) => !asset.folderId).length : studio.assets.length + projectAssets.length}</small></button>)}
        <div className="studio-library-folder-list">{folders.map((folder) => <button type="button" key={folder.id} data-folder-id={folder.id} style={{ paddingInlineStart: 8 + Math.min(4, assetFolderPath(folders, folder.id).split(' / ').length - 1) * 12 }} title={assetFolderPath(folders, folder.id)} className={currentFolder === folder.id ? 'is-active' : ''} onClick={() => setScope(`folder:${folder.id}`)}><FolderOutlined /><span>{folder.name}</span><small>{studio.assets.filter((asset) => folderDescendants(folders, folder.id).includes(asset.folderId ?? '')).length}</small></button>)}</div>
      </aside>
      <section className="studio-library-main">
        <div className="studio-library-heading"><Typography.Text strong>{currentFolder ? assetFolderPath(folders, currentFolder) : t(`studio.library.scope.${scope}`)}</Typography.Text><Typography.Text type="secondary">{t('studio.library.results', { count: assets.length })}</Typography.Text>{currentFolder && <><Button size="small" onClick={() => setFolderForm({ ...folders.find((folder) => folder.id === currentFolder)! })}>{t('studio.library.editFolder')}</Button><Popconfirm title={t('studio.library.removeFolderHint')} onConfirm={() => { studio.removeAssetFolder(currentFolder); setScope('all'); }}><Button size="small" danger>{t('studio.library.removeFolder')}</Button></Popconfirm></>}</div>
        <div className="video-studio-toolbar">
          {!trash && <><StudioLinkImport onImport={placeImported} /><Upload multiple accept="image/*,video/*,audio/*,.txt,.md,.json,.glb" showUploadList={false} beforeUpload={(file) => { void importStudioFile(file).then(placeImported).catch((error) => message.error(String(error))); return false; }}><Button icon={<UploadOutlined />}>{t('studio.asset.upload')}</Button></Upload><Upload accept=".assets.json,.json" showUploadList={false} beforeUpload={(file) => { void importPackage(file); return false; }} disabled={busy}><Button disabled={busy}>{t('studio.library.importPackage')}</Button></Upload></>}
          <Input.Search aria-label={t('studio.search')} allowClear placeholder={t('studio.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
          <Select aria-label={t('studio.library.kind')} value={kind} onChange={setKind} options={['all', 'image', 'video', 'audio', 'text', 'model'].map((value) => ({ value, label: t(value === 'all' ? 'studio.all' : `studio.kind.${value}`) }))} />
          <Select aria-label={t('studio.asset.category')} value={category} onChange={setCategory} options={['all', ...categories].map((value) => ({ value, label: t(value === 'all' ? 'studio.all' : `studio.category.${value}`) }))} />
          <Select aria-label={t('studio.library.tagFilter')} allowClear placeholder={t('studio.library.tagFilter')} value={tag} onChange={setTag} options={tagOptions} />
        </div>
        <div className="studio-library-batch"><Checkbox checked={!!selectableIds.length && selectableIds.every((id) => selection.includes(id))} indeterminate={selectableIds.some((id) => selection.includes(id)) && !selectableIds.every((id) => selection.includes(id))} onChange={(event) => setSelection(event.target.checked ? selectableIds : [])}>{t('studio.library.selectVisible')}</Checkbox><span>{t('studio.library.selected', { count: selectedAssets.length })}</span>
          {trash ? <><Button disabled={!selectedAssets.length} onClick={() => { studio.restoreAssets(selection); setSelection([]); }}>{t('studio.library.restore')}</Button><Popconfirm title={t('studio.library.purgeHint')} onConfirm={() => { studio.purgeAssets(selection); setSelection([]); }}><Button danger disabled={!selectedAssets.length}>{t('studio.library.purge')}</Button></Popconfirm></> : <><Button disabled={!selectedAssets.length} onClick={() => openOrganize(selection)}>{t('studio.library.organize')}</Button><Button loading={busy} disabled={!selectedAssets.length || busy} onClick={() => void exportPackage()}>{t('studio.library.exportPackage')}</Button><Popconfirm title={t('studio.library.recycleConfirm')} onConfirm={() => recycle(selection)}><Button danger disabled={!selectedAssets.length}>{t('studio.library.recycle')}</Button></Popconfirm></>}
        </div>
        {trash && <Alert type="info" showIcon message={t('studio.library.trashHint')} />}
        {scope === 'projects' && <Alert type="info" message={t('studio.library.projectHint')} />}
        {!assets.length ? <Empty description={t('studio.empty')} /> : <div className="video-studio-grid">{assets.map((asset) => <article className={`video-studio-card ${selection.includes(asset.id) ? 'is-selected' : ''}`} data-asset-id={asset.id} key={asset.id}>
          <div className="studio-library-card-top"><Checkbox aria-label={`${t('studio.library.select')} ${asset.name}`} checked={selection.includes(asset.id)} disabled={!!asset.projectId} onChange={(event) => setSelection(event.target.checked ? [...new Set([...selection, asset.id])] : selection.filter((id) => id !== asset.id))} />{asset.projectId ? <Tag>{t('studio.asset.project')}</Tag> : !trash && references.has(asset.id) ? <Tag>{t('studio.library.inUse')}</Tag> : null}</div>
          <StudioMedia asset={asset} />{asset.storage === 'remote' && <Typography.Text type="warning" title={asset.storageError}>{t('studio.asset.remote')}</Typography.Text>}<Typography.Text strong ellipsis title={asset.name}>{asset.name}</Typography.Text>
          {asset.cloudUpload && <Tag color={modelReadableMediaUrl(asset, '') ? 'success' : 'warning'} title={new Date(asset.cloudUpload.expiresAt).toLocaleString()}>{t(modelReadableMediaUrl(asset, '') ? 'studio.upload.available' : 'studio.upload.expired')}</Tag>}
          <Space wrap><Tag>{t(`studio.kind.${asset.kind}`)}</Tag><Tag>{t(`studio.category.${asset.category}`)}</Tag>{asset.editResult ? <Tag color="success">{t('studio.edit.mask.result')}</Tag> : studio.jobs.some((job) => job.rawOutputAssetId === asset.id) && <Tag>{t('studio.edit.mask.candidate')}</Tag>}{asset.tags?.map((value) => <Tag key={value}>{value}</Tag>)}</Space>
          {asset.folderId && <Typography.Text type="secondary" ellipsis>{assetFolderPath(folders, asset.folderId)}</Typography.Text>}
          {!asset.projectId && !trash && <Select size="small" aria-label={t('studio.asset.category')} value={asset.category} onChange={(value) => studio.updateAsset(asset.id, { category: value })} options={categories.map((value) => ({ value, label: t(`studio.category.${value}`) }))} />}
          <div className="video-studio-card-actions"><Button size="small" onClick={() => setPreview(asset)}>{t('studio.open')}</Button>{trash ? <Button size="small" onClick={() => studio.restoreAssets([asset.id])}>{t('studio.library.restore')}</Button> : <><Button size="small" icon={<PlusOutlined />} onClick={() => addToCanvas(asset)}>{t('studio.asset.canvas')}</Button>{['image', 'audio', 'video'].includes(asset.kind) && <Button size="small" onClick={() => reuseInVideo(asset)}>{t('studio.asset.reuse')}</Button>}{asset.kind === 'image' && <Button size="small" onClick={() => setEditing(asset)}>{t('studio.edit.title')}</Button>}{['image', 'audio', 'video'].includes(asset.kind) && <Button size="small" onClick={() => setUploadId(retain(asset).id)}>{t('studio.upload.title')}</Button>}<StudioProjectTransfer asset={asset} />{asset.kind === 'video' && <StudioVideoTranscode asset={asset} />}{asset.projectId ? <><Button size="small" onClick={() => { retain(asset); message.success(t('studio.saved')); }}>{t('studio.library.copy')}</Button><Button size="small" onClick={() => { useVideoStore.getState().setActivePipelineId(asset.projectId); useProjectStore.getState().setActiveProject(asset.projectId!); studio.setPage('projects'); }}>{t('studio.asset.openProject')}</Button></> : <><Button size="small" onClick={() => openOrganize([asset.id])}>{t('studio.library.organize')}</Button><Popconfirm title={t('studio.library.recycleConfirm')} onConfirm={() => recycle([asset.id])}><Button size="small" danger>{t('studio.library.recycle')}</Button></Popconfirm></>}</>}</div>
        </article>)}</div>}
      </section>
    </div>
    <Modal className="studio-library-folder-modal" open={!!folderForm} title={t('studio.library.editFolder')} onCancel={() => setFolderForm(undefined)} onOk={() => { if (folderForm && studio.saveAssetFolder(folderForm)) { setScope(`folder:${folderForm.id}`); setFolderForm(undefined); } else message.warning(t('studio.library.invalidFolder')); }} okButtonProps={{ disabled: !folderForm?.name.trim() }} destroyOnClose><Space direction="vertical" className="studio-media-form"><Input aria-label={t('studio.library.folderName')} maxLength={80} value={folderForm?.name ?? ''} onChange={(event) => folderForm && setFolderForm({ ...folderForm, name: event.target.value })} /><Select aria-label={t('studio.library.parentFolder')} allowClear placeholder={t('studio.library.rootFolder')} value={folderForm?.parentId} onChange={(parentId) => folderForm && setFolderForm({ ...folderForm, parentId })} options={folders.filter((folder) => !folderForm || !folderDescendants(folders, folderForm.id).includes(folder.id)).map((folder) => ({ value: folder.id, label: assetFolderPath(folders, folder.id) }))} /></Space></Modal>
    <Modal className="studio-library-organize-modal" open={organizing} title={t('studio.library.organize')} onCancel={() => setOrganizing(false)} onOk={organize} destroyOnClose><Space direction="vertical" className="studio-media-form">{selection.length === 1 && <Input aria-label={t('studio.rename')} maxLength={200} value={rename} onChange={(event) => setRename(event.target.value)} />}<Select aria-label={t('studio.library.moveTo')} value={targetFolder} onChange={setTargetFolder} options={[{ value: 'keep', label: t('studio.library.keepFolder') }, { value: 'unfiled', label: t('studio.library.scope.unfiled') }, ...folders.map((folder) => ({ value: folder.id, label: assetFolderPath(folders, folder.id) }))]} /><Select aria-label={t('studio.asset.category')} value={targetCategory} onChange={setTargetCategory} options={[{ value: 'keep', label: t('studio.library.keepCategory') }, ...categories.map((value) => ({ value, label: t(`studio.category.${value}`) }))]} /><Select aria-label={t('studio.library.tagAction')} value={tagAction} onChange={setTagAction} options={[{ value: 'add', label: t('studio.library.addTags') }, { value: 'remove', label: t('studio.library.removeTags') }]} /><Select aria-label={t('studio.library.tags')} mode="tags" value={tags} onChange={(value) => setTags(normalizeAssetTags(value))} options={tagOptions} tokenSeparators={[',', '，']} placeholder={t('studio.library.tags')} /></Space></Modal>
    {editing && <StudioImageEditor asset={editing} onClose={() => setEditing(undefined)} />}
    {uploadId && <StudioUploadModal assetId={uploadId} kind={studio.assets.find(asset => asset.id === uploadId)?.kind as 'image' | 'audio' | 'video'} onClose={() => setUploadId(undefined)} />}
    <Modal open={!!preview} onCancel={() => setPreview(undefined)} width={900} title={preview?.name} footer={preview ? <Button onClick={() => void download(preview)}>{t('studio.asset.download')}</Button> : null} destroyOnClose><StudioMedia asset={preview} /></Modal>
  </div>;
}

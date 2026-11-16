import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Empty, Input, InputNumber, Modal, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import type { TableColumnsType } from 'antd';
import { AppstoreOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PictureOutlined, PlusOutlined, TableOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';
import { providerRouter } from '@/services/providers';
import { resolveLocalPath, toWebviewUrl } from '@/services/video/asset-store';
import { getShotProductionReadiness } from '@/services/video/core/shot-production-contract';
import { getVideoParameter, normalizeNumberForParameter } from '@/services/video/core/video-capability-utils';
import type { ShotSpec, VideoProjectState } from '@/types/video';
import type { GenerationParameterSpec } from '@/types/providers';
import type { ImageGenerationCapabilities, VideoGenerationCapabilities } from '@/types/providers';
import './StoryboardSheet.css';

const { Text } = Typography;

interface Props {
  project: VideoProjectState;
  disabled?: boolean;
  onUpdateShot: (shotId: string, patch: Partial<ShotSpec>) => void;
  onOpenShot: (shotId: string) => void;
  onAddShot: () => void;
  onDuplicateShot: (shot: ShotSpec) => void;
  onDeleteShot: (shotId: string) => void;
}

const CAMERA_OPTIONS = ['static', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'tracking', 'orbit'];

const StoryboardSheet: React.FC<Props> = ({ project, disabled, onUpdateShot, onOpenShot, onAddShot, onDuplicateShot, onDeleteShot }) => {
  const { t } = useTranslation();
  const activeEndpoint = useProviderStore((state) => state.getActiveEndpoint('video'));
  const activeImageEndpoint = useProviderStore((state) => state.getActiveEndpoint('image'));
  const [view, setView] = useState('table');
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [selected, setSelected] = useState<React.Key[]>([]);
  const [batchVideoModel, setBatchVideoModel] = useState<string>(), [batchImageModel, setBatchImageModel] = useState<string>(), [batchSize, setBatchSize] = useState<string>(), [previewShotId, setPreviewShotId] = useState<string>();
  const shots = project.sceneSpec?.shots ?? [];
  useEffect(() => { setSelected([]); setPreviewShotId(undefined); }, [project.novelProjectId]);
  const totalSeconds = shots.reduce((total, shot) => total + (shot.durationSeconds || 0), 0);
  const clipFor = (shot: ShotSpec) => project.clips.find((clip) => clip.shotId === shot.id);
  const stateFor = (shot: ShotSpec) => getShotProductionReadiness(shot, clipFor(shot), true).state;
  const imageUrl = (value: string) => toWebviewUrl(resolveLocalPath(value));
  const stateColor = (shot: ShotSpec) => stateFor(shot) === 'approved' ? 'success'
    : stateFor(shot) === 'rejected' ? 'error' : clipFor(shot)?.videoUrl ? 'processing' : 'default';
  const visibleShots = shots.filter((shot) => (status === 'all' || stateFor(shot) === status) && `${shot.sourceText} ${shot.videoPrompt} ${shot.location} ${(shot.visibleCharacterIds ?? shot.characterIds ?? []).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  let videoCapabilities: VideoGenerationCapabilities | undefined, imageCapabilities: ImageGenerationCapabilities | undefined;
  try { videoCapabilities = providerRouter.getVideoCapabilities('clip', batchVideoModel, project.executionBinding?.video?.endpointId ?? activeEndpoint?.id); } catch { /* Drafts can be edited before configuring a provider. */ }
  try { imageCapabilities = providerRouter.getImageCapabilities('storyboard', batchImageModel, project.executionBinding?.image?.endpointId ?? activeImageEndpoint?.id); } catch { /* Drafts can be edited before configuring a provider. */ }
  const applyBatch = () => {
    for (const shot of shots.filter((item) => selected.includes(item.id))) {
      const patch: Partial<ShotSpec> = {};
      if (batchVideoModel) { patch.videoParameters = { model: batchVideoModel }; patch.durationSeconds = normalizeNumberForParameter(shot.durationSeconds, getVideoParameter(videoCapabilities, 'durationSeconds'), 5) as ShotSpec['durationSeconds']; }
      if (batchImageModel || batchSize) patch.imageParameters = { ...(batchImageModel ? { model: batchImageModel } : shot.imageParameters), ...(batchSize ? { size: batchSize } : {}) };
      onUpdateShot(shot.id, patch);
    }
    message.success(t('studio.shots.batchApplied'));
  };

  // Commit on blur so reviewing a long shot list never invalidates assets on every keystroke.
  const field = (shot: ShotSpec, key: 'videoPrompt' | 'startState' | 'endState' | 'location' | 'cameraMovement', label: string, rows = 2) => (
    <Input.TextArea
      key={`${shot.id}:${key}:${shot[key] ?? ''}`}
      aria-label={`${t('video.production.shotNumber', { number: shot.index + 1 })} ${label}`}
      placeholder={label}
      defaultValue={shot[key] ?? ''}
      autoSize={{ minRows: rows, maxRows: 5 }}
      disabled={disabled}
      onBlur={(event) => {
        const value = event.target.value.trim();
        if (value !== (shot[key] ?? '')) onUpdateShot(shot.id, { [key]: value });
      }}
    />
  );

  const frames = (shot: ShotSpec) => (
    <button type="button" className="storyboard-sheet-frames" onClick={() => onOpenShot(shot.id)} aria-label={t('video.storyboard.openShot', { number: shot.index + 1 })}>
      <span>
        {shot.keyframeImage ? <img loading="lazy" src={imageUrl(shot.keyframeImage)} alt={t('video.production.keyframe')} /> : <PictureOutlined />}
        <small>{t('video.production.keyframe')}</small>
      </span>
      <span>
        {clipFor(shot)?.lastFrameImage ? <img loading="lazy" src={imageUrl(clipFor(shot)!.lastFrameImage!)} alt={t('video.storyboard.tailFrame')} /> : <PictureOutlined />}
        <small>{clipFor(shot)?.videoUrl ? t('video.storyboard.tailFrame') : t('video.storyboard.notGenerated')}</small>
      </span>
    </button>
  );

  const columns: TableColumnsType<ShotSpec> = [
    {
      title: t('video.storyboard.frames'), key: 'frames', width: 190,
      render: (_, shot) => <div className="storyboard-sheet-fields">
        <Text strong>{t('video.production.shotNumber', { number: shot.index + 1 })}</Text>
        {frames(shot)}
        <Tag color={stateColor(shot)}>{t(`video.production.state.${stateFor(shot)}`)}</Tag>
      </div>,
    },
    {
      title: t('video.storyboard.actionDialogue'), key: 'action', width: 280,
      render: (_, shot) => <div className="storyboard-sheet-fields">
        {field(shot, 'videoPrompt', t('video.storyboard.action'), 3)}
        <Select mode="multiple" size="small" maxTagCount={2} aria-label={t('studio.shots.characters')} placeholder={t('studio.shots.characters')} value={shot.visibleCharacterIds ?? shot.characterIds ?? []} disabled={disabled} onChange={(ids) => onUpdateShot(shot.id, { visibleCharacterIds: ids, characterIds: ids, characterBinding: 'explicit' })} options={(project.sceneSpec?.characters ?? []).map((character) => ({ value: character.id, label: character.name }))} />
        <Tooltip title={shot.sourceText}><Text type="secondary" ellipsis>{shot.sourceText}</Text></Tooltip>
        {shot.dialogue?.length ? shot.dialogue.map((line, index) => <Text className="storyboard-sheet-dialogue" key={index}>{line.speaker}: {line.text}</Text>) : shot.narration ? <Text className="storyboard-sheet-dialogue">{shot.narration}</Text> : null}
      </div>,
    },
    {
      title: t('video.storyboard.direction'), key: 'direction', width: 225,
      render: (_, shot) => <div className="storyboard-sheet-fields">
        <Select
          size="small" aria-label={t('video.storyboard.camera')} value={shot.cameraMovement || undefined} placeholder={t('video.storyboard.camera')}
          disabled={disabled} onChange={(cameraMovement) => onUpdateShot(shot.id, { cameraMovement })}
          options={[
            ...CAMERA_OPTIONS.map((value) => ({ value, label: t(`video.storyboard.camera.${value}`) })),
            ...(shot.cameraMovement && !CAMERA_OPTIONS.includes(shot.cameraMovement) ? [{ value: shot.cameraMovement, label: shot.cameraMovement }] : []),
          ]}
        />
        {field(shot, 'startState', t('video.storyboard.startState'), 1)}
        {field(shot, 'endState', t('video.storyboard.endState'), 1)}
      </div>,
    },
    {
      title: t('video.storyboard.timing'), key: 'timing', width: 175,
      render: (_, shot) => {
        let parameter: GenerationParameterSpec | undefined;
        try {
          const model = typeof shot.videoParameters?.model === 'string' ? shot.videoParameters.model : project.executionBinding?.video?.model;
          parameter = getVideoParameter(providerRouter.getVideoCapabilities('clip', model, project.executionBinding?.video?.endpointId ?? activeEndpoint?.id), 'durationSeconds');
        } catch { /* A draft remains editable before a provider is configured. */ }
        const changeDuration = (value: number | null) => {
          if (value === null) return;
          onUpdateShot(shot.id, { durationSeconds: normalizeNumberForParameter(value, parameter, 5) as ShotSpec['durationSeconds'] });
        };
        return <div className="storyboard-sheet-fields">
          {parameter?.allowedValues?.length ? <Select size="small" value={shot.durationSeconds} disabled={disabled} onChange={changeDuration} options={parameter.allowedValues.map((value) => ({ value, label: `${value}s` }))} /> : (
            <InputNumber size="small" aria-label={t('video.production.duration')} min={parameter?.min ?? 1} max={parameter?.max} step={parameter?.type === 'integer' ? 1 : 0.5} value={shot.durationSeconds} disabled={disabled} suffix="s" onChange={changeDuration} />
          )}
          <Select<'auto' | 'cut' | 'continue'> size="small" aria-label={t('video.storyboard.transition')} value={shot.transition ?? 'auto'} disabled={disabled} onChange={(transition) => onUpdateShot(shot.id, { transition: transition === 'auto' ? undefined : transition })} options={[
            { value: 'auto', label: t('video.storyboard.auto') },
            { value: 'cut', label: t('video.storyboard.cut') },
            { value: 'continue', label: t('video.storyboard.continue'), disabled: shot.index === 0 },
          ]} />
          {field(shot, 'location', t('video.storyboard.location'), 1)}
          <Select allowClear size="small" aria-label={t('studio.shots.scene')} placeholder={t('studio.shots.scene')} value={shot.sceneId} disabled={disabled} onChange={(sceneId) => onUpdateShot(shot.id, { sceneId })} options={(project.sceneSpec?.scenes ?? []).map((scene) => ({ value: scene.id, label: scene.name }))} />
        </div>;
      },
    },
    {
      title: t('video.storyboard.operations'), key: 'operations', width: 115,
      render: (_, shot) => <Space direction="vertical" size={6}>
        <Button size="small" icon={<EditOutlined />} onClick={() => onOpenShot(shot.id)}>{t('video.storyboard.refine')}</Button>
        <Space size={0}>
          <Tooltip title={t('video.storyboard.duplicate')}><Button size="small" type="text" aria-label={t('video.storyboard.duplicate')} icon={<CopyOutlined />} disabled={disabled} onClick={() => onDuplicateShot(shot)} /></Tooltip>
          <Tooltip title={t('common.delete')}><Button size="small" type="text" danger aria-label={t('common.delete')} icon={<DeleteOutlined />} disabled={disabled || shots.length <= 1} onClick={() => onDeleteShot(shot.id)} /></Tooltip>
        </Space>
      </Space>,
    },
  ];

  return (
    <section className="storyboard-sheet" data-testid="video-storyboard-sheet">
      <header className="storyboard-sheet-toolbar">
        <div><Text strong>{t('video.storyboard.title')}</Text><Text type="secondary">{t('video.storyboard.summary', { count: shots.length, seconds: Math.round(totalSeconds * 10) / 10 })}</Text></div>
        <Space wrap>
          <Segmented size="small" value={view} onChange={(value) => setView(String(value))} options={[
            { value: 'table', label: t('video.storyboard.table'), icon: <TableOutlined /> },
            { value: 'wall', label: t('video.storyboard.wall'), icon: <AppstoreOutlined /> },
          ]} />
          <Button size="small" icon={<PlusOutlined />} disabled={disabled} onClick={onAddShot}>{t('video.production.addShot')}</Button>
        </Space>
      </header>
      <Text className="storyboard-sheet-hint" type="secondary">{t('video.storyboard.hint')}</Text>
      <div className="storyboard-sheet-filters"><Input.Search allowClear placeholder={t('studio.search')} value={search} onChange={(event) => setSearch(event.target.value)} /><Select aria-label={t('studio.shots.filterState')} value={status} onChange={setStatus} options={[{ value: 'all', label: t('studio.all') }, ...[...new Set(shots.map(stateFor))].map((state) => ({ value: state, label: t(`video.production.state.${state}`) }))]} /><Checkbox checked={!!visibleShots.length && visibleShots.every((shot) => selected.includes(shot.id))} indeterminate={visibleShots.some((shot) => selected.includes(shot.id)) && !visibleShots.every((shot) => selected.includes(shot.id))} disabled={disabled} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visibleShots.map((shot) => shot.id)])] : selected.filter((id) => !visibleShots.some((shot) => shot.id === id)))}>{t('studio.shots.selectVisible')}</Checkbox></div>
      {selected.length > 0 && <div className="storyboard-sheet-batch"><Text>{t('studio.shots.selected', { count: selected.length })}</Text><Select allowClear aria-label={t('studio.shots.videoModel')} placeholder={t('studio.shots.videoModel')} value={batchVideoModel} onChange={setBatchVideoModel} options={videoCapabilities?.availableModels?.map((value) => ({ value, label: value })) ?? []} /><Select allowClear aria-label={t('studio.shots.imageModel')} placeholder={t('studio.shots.imageModel')} value={batchImageModel} onChange={(model) => { setBatchImageModel(model); setBatchSize(undefined); }} options={imageCapabilities?.availableModels?.map((value) => ({ value, label: value })) ?? []} />{imageCapabilities?.parameters.some((spec) => spec.key === 'size' && spec.enumValues?.includes('2K')) && <Select allowClear aria-label={t('video.production.imageSize')} placeholder={t('video.production.imageSize')} value={batchSize} onChange={setBatchSize} options={imageCapabilities.parameters.find((spec) => spec.key === 'size')?.enumValues?.map((value) => ({ value, label: value }))} />}<Button disabled={disabled || !batchVideoModel && !batchImageModel && !batchSize} onClick={applyBatch}>{t('studio.shots.apply')}</Button><Button type="text" onClick={() => setSelected([])}>{t('studio.cancel')}</Button></div>}
      {!shots.length ? <Empty description={t('video.production.noShotsDescription')} /> : view === 'table' ? (
        <Table size="small" rowKey="id" columns={columns} dataSource={visibleShots} rowSelection={{ selectedRowKeys: selected, onChange: setSelected, getCheckboxProps: () => ({ disabled }) }} pagination={false} scroll={{ x: 1025 }} />
      ) : (
        <div className="storyboard-sheet-wall" data-testid="video-storyboard-wall">
          {visibleShots.map((shot) => <article key={shot.id} className="storyboard-sheet-card">
            <div className="storyboard-sheet-card-heading"><Checkbox checked={selected.includes(shot.id)} disabled={disabled} onChange={(event) => setSelected(event.target.checked ? [...selected, shot.id] : selected.filter((id) => id !== shot.id))}><Text strong>{t('video.production.shotNumber', { number: shot.index + 1 })}</Text></Checkbox><Text type="secondary">{shot.durationSeconds}s</Text></div>
            {frames(shot)}
            <Tag color={stateColor(shot)}>{t(`video.production.state.${stateFor(shot)}`)}</Tag>
            <Text className="storyboard-sheet-card-action">{shot.videoPrompt || shot.sourceText || t('video.production.emptyShot')}</Text>
            <Text type="secondary">{shot.location || t('video.storyboard.location')} · {t(`video.storyboard.${shot.transition ?? 'auto'}`)}</Text>
            {clipFor(shot)?.videoUrl && <Button block size="small" icon={<PictureOutlined />} onClick={() => setPreviewShotId(shot.id)}>{t('studio.shots.previewVideo')}</Button>}
            <Button block size="small" onClick={() => onOpenShot(shot.id)}>{t('video.storyboard.refine')}</Button>
          </article>)}
        </div>
      )}
      <Modal open={!!previewShotId} title={t('studio.shots.previewVideo')} onCancel={() => setPreviewShotId(undefined)} footer={null} width={900} destroyOnClose>{previewShotId && <video controls autoPlay className="storyboard-sheet-video-preview" src={imageUrl(project.clips.find((clip) => clip.shotId === previewShotId)?.videoUrl || '')} />}</Modal>
    </section>
  );
};

export default StoryboardSheet;

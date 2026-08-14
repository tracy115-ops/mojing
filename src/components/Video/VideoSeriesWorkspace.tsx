import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import type { CreativeProject, VideoMetadata } from '@/types';
import type { CharacterAnchor, CostumeVariant, SceneAnchor } from '@/types/video';
import { providerRouter } from '@/services/providers';
import { useVideoStore } from '@/stores/videoStore';
import { readAsDataUri, saveAsset } from '@/services/video/asset-store';

const { Text, Title, Paragraph } = Typography;

interface CharacterFormValues {
  name: string;
  aliases?: string;
  appearance: string;
  voiceRef?: string;
}

interface SceneFormValues {
  name: string;
  aliases?: string;
  description: string;
}

interface CostumeFormValues {
  id: string;
  description: string;
}

interface EpisodeContinuityFormValues {
  episodeContinuity?: string;
  episodeEndingSummary?: string;
}

interface VideoSeriesWorkspaceProps {
  series: CreativeProject;
  episodes: CreativeProject[];
  onUpdateCharacters: (characters: CharacterAnchor[]) => void;
  onUpdateScenes: (scenes: SceneAnchor[]) => void;
  onUpdateStyleGuide: (styleGuide: string) => void;
  onUpdateEpisodeContinuity: (episodeId: string, values: EpisodeContinuityFormValues) => void;
  onSyncEpisodeAssets: (episodeId: string) => Promise<boolean>;
  onCreateEpisode: () => void;
  onOpenEpisode: (id: string) => void;
}

function makeCharacterId(): string {
  return `series_char_${crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`;
}

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const VideoSeriesWorkspace: React.FC<VideoSeriesWorkspaceProps> = ({
  series,
  episodes,
  onUpdateCharacters,
  onUpdateScenes,
  onUpdateStyleGuide,
  onUpdateEpisodeContinuity,
  onSyncEpisodeAssets,
  onCreateEpisode,
  onOpenEpisode,
}) => {
  const { t } = useTranslation();
  const [form] = Form.useForm<CharacterFormValues>();
  const [sceneForm] = Form.useForm<SceneFormValues>();
  const [costumeForm] = Form.useForm<CostumeFormValues>();
  const [episodeContinuityForm] = Form.useForm<EpisodeContinuityFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CharacterAnchor | undefined>();
  const [portraitImage, setPortraitImage] = useState<string | undefined>();
  const [turnaroundImage, setTurnaroundImage] = useState<string | undefined>();
  const [generating, setGenerating] = useState<'portrait' | 'turnaround' | undefined>();
  const [costumeVariants, setCostumeVariants] = useState<CostumeVariant[]>([]);
  const [costumeModalOpen, setCostumeModalOpen] = useState(false);
  const [editingCostumeId, setEditingCostumeId] = useState<string | undefined>();
  const [costumeImage, setCostumeImage] = useState<string | undefined>();
  const [costumeGenerating, setCostumeGenerating] = useState(false);
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [editingScene, setEditingScene] = useState<SceneAnchor | undefined>();
  const [sceneImage, setSceneImage] = useState<string | undefined>();
  const [sceneGenerating, setSceneGenerating] = useState(false);
  const [continuityModalOpen, setContinuityModalOpen] = useState(false);
  const [editingEpisode, setEditingEpisode] = useState<CreativeProject | undefined>();
  const [summarizingEnding, setSummarizingEnding] = useState(false);
  const [syncingEpisodeId, setSyncingEpisodeId] = useState<string | undefined>();
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const costumeFileInput = useRef<HTMLInputElement | null>(null);
  const sceneFileInput = useRef<HTMLInputElement | null>(null);
  const metadata = series.metadata as VideoMetadata;
  const characters = metadata.seriesCharacters ?? [];
  const scenes = metadata.seriesScenes ?? [];

  const sortedEpisodes = useMemo(
    () => [...episodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [episodes],
  );

  const openCharacterModal = (character?: CharacterAnchor) => {
    setEditing(character);
    setPortraitImage(character?.portraitImage);
    setTurnaroundImage(character?.turnaroundImage);
    setCostumeVariants(character?.costumeVariants?.map((variant) => ({ ...variant })) ?? []);
    form.setFieldsValue({
      name: character?.name ?? '',
      aliases: character?.aliases?.join(', ') ?? '',
      appearance: character?.appearance ?? '',
      voiceRef: character?.voiceRef ?? '',
    });
    setModalOpen(true);
  };

  const openCostumeModal = (variant?: CostumeVariant) => {
    setEditingCostumeId(variant?.id);
    setCostumeImage(variant?.portraitImage);
    costumeForm.setFieldsValue({ id: variant?.id ?? '', description: variant?.description ?? '' });
    setCostumeModalOpen(true);
  };

  const saveCostumeImage = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error(t('video.series.imageOnly'));
      return;
    }
    setCostumeImage(await saveAsset(series.id, 'portrait', await readFileAsDataUri(file), 'series_costume'));
  };

  const generateCostumeImage = async () => {
    const [character, costume] = await Promise.all([
      form.validateFields(['name', 'appearance']),
      costumeForm.validateFields(['description']),
    ]);
    if (!portraitImage) {
      message.warning(t('video.series.costumeNeedsPortrait'));
      return;
    }
    setCostumeGenerating(true);
    try {
      const response = await providerRouter.generateImage({
        taskType: 'character',
        prompt: `${character.appearance}, ${character.name}, wearing ${costume.description}, full body character design portrait, front view, preserve the exact face, hairstyle, age, and body proportions from the reference, clean neutral background`,
        width: 768,
        height: 1152,
        style: metadata.style,
        referenceImages: [await readAsDataUri(portraitImage)],
      });
      setCostumeImage(await saveAsset(series.id, 'portrait', response.imageData, `series_${character.name}_costume`));
      message.success(t('video.series.imageGenerated'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('video.series.imageGenerateFailed'));
    } finally {
      setCostumeGenerating(false);
    }
  };

  const saveCostume = async () => {
    const values = await costumeForm.validateFields();
    const id = values.id.trim();
    if (costumeVariants.some((variant) => variant.id === id && variant.id !== editingCostumeId)) {
      costumeForm.setFields([{ name: 'id', errors: [t('video.series.costumeIdDuplicate')] }]);
      return;
    }
    const next: CostumeVariant = { id, description: values.description.trim(), portraitImage: costumeImage };
    setCostumeVariants((variants) => editingCostumeId
      ? variants.map((variant) => variant.id === editingCostumeId ? next : variant)
      : [...variants, next]);
    setCostumeModalOpen(false);
  };

  const saveImage = async (file: File, kind: 'portrait' | 'turnaround') => {
    if (!file.type.startsWith('image/')) {
      message.error(t('video.series.imageOnly'));
      return;
    }
    const dataUri = await readFileAsDataUri(file);
    const saved = await saveAsset(series.id, 'portrait', dataUri, `series_${kind}`);
    if (kind === 'portrait') setPortraitImage(saved);
    else setTurnaroundImage(saved);
  };

  const generateImage = async (kind: 'portrait' | 'turnaround') => {
    const values = await form.validateFields(['name', 'appearance']);
    setGenerating(kind);
    try {
      const isTurnaround = kind === 'turnaround';
      const referenceImages = isTurnaround && portraitImage
        ? [await readAsDataUri(portraitImage)]
        : undefined;
      if (isTurnaround && !portraitImage) {
        message.warning(t('video.series.turnaroundNeedsPortrait'));
        return;
      }
      const response = await providerRouter.generateImage({
        taskType: 'character',
        prompt: isTurnaround
          ? `${values.appearance}, ${values.name}, character turnaround sheet, front view, side view, back view, consistent facial features, clean neutral background`
          : `${values.appearance}, ${values.name}, full body character design portrait, front view, clean neutral background, consistent proportions`,
        width: isTurnaround ? 1536 : 768,
        height: isTurnaround ? 1024 : 1152,
        style: metadata.style,
        referenceImages,
      });
      const saved = await saveAsset(series.id, 'portrait', response.imageData, `series_${values.name}_${kind}`);
      if (isTurnaround) setTurnaroundImage(saved);
      else setPortraitImage(saved);
      message.success(t('video.series.imageGenerated'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('video.series.imageGenerateFailed'));
    } finally {
      setGenerating(undefined);
    }
  };

  const saveCharacter = async () => {
    const values = await form.validateFields();
    const next: CharacterAnchor = {
      id: editing?.id ?? makeCharacterId(),
      name: values.name.trim(),
      aliases: values.aliases?.split(',').map((value) => value.trim()).filter(Boolean),
      appearance: values.appearance.trim(),
      voiceRef: values.voiceRef?.trim() || undefined,
      portraitImage,
      turnaroundImage,
      costumeVariants,
      firstAppearShotIndex: 0,
    };
    onUpdateCharacters(editing
      ? characters.map((character) => character.id === editing.id ? next : character)
      : [...characters, next]);
    setModalOpen(false);
    message.success(t('video.series.characterSaved'));
  };

  const deleteCharacter = (id: string) => {
    onUpdateCharacters(characters.filter((character) => character.id !== id));
  };

  const openSceneModal = (scene?: SceneAnchor) => {
    setEditingScene(scene);
    setSceneImage(scene?.backgroundImage);
    sceneForm.setFieldsValue({
      name: scene?.name ?? '',
      aliases: scene?.aliases?.join(', ') ?? '',
      description: scene?.description ?? '',
    });
    setSceneModalOpen(true);
  };

  const saveSceneImage = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error(t('video.series.imageOnly'));
      return;
    }
    setSceneImage(await saveAsset(series.id, 'background', await readFileAsDataUri(file), 'series_scene'));
  };

  const generateSceneImage = async () => {
    const values = await sceneForm.validateFields(['name', 'description']);
    setSceneGenerating(true);
    try {
      const response = await providerRouter.generateImage({
        taskType: 'scene',
        prompt: `${values.name}, ${values.description}, empty environment establishing shot, no people, consistent production design`,
        width: 1280,
        height: 720,
        style: metadata.style,
      });
      setSceneImage(await saveAsset(series.id, 'background', response.imageData, `series_scene_${values.name}`));
      message.success(t('video.series.imageGenerated'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('video.series.imageGenerateFailed'));
    } finally {
      setSceneGenerating(false);
    }
  };

  const saveScene = async () => {
    const values = await sceneForm.validateFields();
    const next: SceneAnchor = {
      id: editingScene?.id ?? `series_scene_${crypto.randomUUID?.() ?? Date.now()}`,
      name: values.name.trim(),
      aliases: values.aliases?.split(',').map((value) => value.trim()).filter(Boolean),
      description: values.description.trim(),
      backgroundImage: sceneImage,
      firstAppearShotIndex: 0,
    };
    onUpdateScenes(editingScene ? scenes.map((scene) => scene.id === editingScene.id ? next : scene) : [...scenes, next]);
    setSceneModalOpen(false);
    message.success(t('video.series.sceneSaved'));
  };

  const openEpisodeContinuityModal = (episode: CreativeProject) => {
    const episodeMetadata = episode.metadata as VideoMetadata;
    setEditingEpisode(episode);
    episodeContinuityForm.setFieldsValue({
      episodeContinuity: episodeMetadata.episodeContinuity ?? '',
      episodeEndingSummary: episodeMetadata.episodeEndingSummary ?? '',
    });
    setContinuityModalOpen(true);
  };

  const saveEpisodeContinuity = async () => {
    if (!editingEpisode) return;
    const values = await episodeContinuityForm.validateFields();
    onUpdateEpisodeContinuity(editingEpisode.id, {
      episodeContinuity: values.episodeContinuity?.trim() || undefined,
      episodeEndingSummary: values.episodeEndingSummary?.trim() || undefined,
    });
    setContinuityModalOpen(false);
    message.success(t('video.series.episodeContinuitySaved'));
  };

  const generateEpisodeEnding = async () => {
    if (!editingEpisode) return;
    const spec = useVideoStore.getState().getProject(editingEpisode.id)?.sceneSpec;
    if (!spec?.shots.length) { message.warning(t('video.series.endingNeedsStoryboard')); return; }
    setSummarizingEnding(true);
    try {
      const text = spec.shots.map((shot) => shot.sourceText ?? shot.videoPrompt).join('\n').slice(0, 8000);
      const response = await providerRouter.generate({ taskType: 'review', systemPrompt: 'Summarize the ending state of this episode in concise Chinese: character status, relationships, location, unresolved event. Output plain text only.', userPrompt: text, temperature: 0.2, maxTokens: 300 });
      episodeContinuityForm.setFieldValue('episodeEndingSummary', response.content.trim());
    } catch (error) { message.error(error instanceof Error ? error.message : t('video.series.endingGenerateFailed')); }
    finally { setSummarizingEnding(false); }
  };

  const syncEpisodeAssets = async (episodeId: string) => {
    setSyncingEpisodeId(episodeId);
    try {
      const started = await onSyncEpisodeAssets(episodeId);
      if (started) message.success(t('video.series.assetsSynced'));
      else message.warning(t('video.series.assetsSyncUnavailable'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('video.series.assetsSyncFailed'));
    } finally {
      setSyncingEpisodeId(undefined);
    }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--bg-layout)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>{series.title}</Title>
            <Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
              {series.description || t('video.series.descriptionFallback')}
            </Paragraph>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateEpisode}>
            {t('video.series.newEpisode')}
          </Button>
        </div>

        <Alert
          type="info"
          showIcon
          message={t('video.series.consistencyTitle')}
          description={t('video.series.consistencyHint')}
          style={{ marginBottom: 16 }}
        />

        <Card
          title={<Space><UserOutlined />{t('video.series.characterLibrary')}<Tag>{characters.length}</Tag></Space>}
          extra={<Button type="link" icon={<PlusOutlined />} onClick={() => openCharacterModal()}>{t('video.series.addCharacter')}</Button>}
          style={{ marginBottom: 16 }}
        >
          {characters.length === 0 ? (
            <Empty description={t('video.series.characterEmpty')} image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Button icon={<PlusOutlined />} onClick={() => openCharacterModal()}>{t('video.series.addCharacter')}</Button>
            </Empty>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {characters.map((character) => (
                <Card key={character.id} size="small" styles={{ body: { padding: 10 } }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ width: 58, height: 76, flex: '0 0 auto', borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
                      {character.portraitImage ? (
                        <Image preview src={character.portraitImage} width="100%" height="100%" style={{ objectFit: 'cover' }} />
                      ) : <UserOutlined style={{ margin: 20, color: 'var(--text-tertiary)' }} />}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <Text strong ellipsis style={{ display: 'block' }}>{character.name}</Text>
                      <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{character.appearance}</Text>
                      <div style={{ marginTop: 6 }}>
                        {character.turnaroundImage && <Tag color="success">{t('video.series.turnaround')}</Tag>}
                        {character.costumeVariants?.length ? <Tag color="cyan">{t('video.series.costumesCount', { count: character.costumeVariants.length })}</Tag> : null}
                        {!character.portraitImage && <Tag color="warning">{t('video.series.noPortrait')}</Tag>}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 8 }}>
                    <Tooltip title={t('common.edit')}><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openCharacterModal(character)} /></Tooltip>
                    <Popconfirm title={t('video.series.deleteCharacterConfirm')} onConfirm={() => deleteCharacter(character.id)} okText={t('common.confirm')} cancelText={t('common.cancel')}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Card>

        <Card
          title={t('video.series.visualGuide')}
          style={{ marginBottom: 16 }}
        >
          <Input.TextArea
            defaultValue={metadata.seriesStyleGuide}
            rows={2}
            placeholder={t('video.series.visualGuidePlaceholder')}
            onBlur={(event) => onUpdateStyleGuide(event.target.value.trim())}
          />
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>{t('video.series.visualGuideHint')}</Text>
        </Card>

        <Card
          title={<Space><PictureOutlined />{t('video.series.sceneLibrary')}<Tag>{scenes.length}</Tag></Space>}
          extra={<Button type="link" icon={<PlusOutlined />} onClick={() => openSceneModal()}>{t('video.series.addScene')}</Button>}
          style={{ marginBottom: 16 }}
        >
          {scenes.length === 0 ? (
            <Empty description={t('video.series.sceneEmpty')} image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Button icon={<PlusOutlined />} onClick={() => openSceneModal()}>{t('video.series.addScene')}</Button>
            </Empty>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {scenes.map((scene) => (
                <Card key={scene.id} size="small" styles={{ body: { padding: 10 } }}>
                  <div style={{ height: 100, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', marginBottom: 8 }}>
                    {scene.backgroundImage ? <Image preview src={scene.backgroundImage} width="100%" height="100%" style={{ objectFit: 'cover' }} /> : <PictureOutlined style={{ margin: 38, color: 'var(--text-tertiary)' }} />}
                  </div>
                  <Text strong ellipsis style={{ display: 'block' }}>{scene.name}</Text>
                  <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{scene.description}</Text>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 8 }}>
                    <Tooltip title={t('common.edit')}><Button size="small" type="text" icon={<EditOutlined />} onClick={() => openSceneModal(scene)} /></Tooltip>
                    <Popconfirm title={t('video.series.deleteSceneConfirm')} onConfirm={() => onUpdateScenes(scenes.filter((item) => item.id !== scene.id))} okText={t('common.confirm')} cancelText={t('common.cancel')}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Card>

        <Card
          title={<Space><PlayCircleOutlined />{t('video.series.episodes')}<Tag>{episodes.length}</Tag></Space>}
          extra={<Button type="link" icon={<PlusOutlined />} onClick={onCreateEpisode}>{t('video.series.newEpisode')}</Button>}
        >
          {sortedEpisodes.length === 0 ? (
            <Empty description={t('video.series.episodeEmpty')} image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Button type="primary" onClick={onCreateEpisode}>{t('video.series.newEpisode')}</Button>
            </Empty>
          ) : (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {sortedEpisodes.map((episode, index) => {
                const episodeMetadata = episode.metadata as VideoMetadata;
                return (
                <Card key={episode.id} size="small" hoverable onClick={() => onOpenEpisode(episode.id)} style={{ cursor: 'pointer' }} styles={{ body: { padding: '10px 12px' } }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Tag color="processing">{t('video.series.episodeNumber', { number: index + 1 })}</Tag>
                    {episodeMetadata.previousEpisodeId && <Tag color="purple">{t('video.series.continuesPrevious')}</Tag>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text strong ellipsis>{episode.title}</Text>
                      {episode.description && <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>{episode.description}</Text>}
                    </div>
                    <Button size="small" type="text" onClick={(event) => { event.stopPropagation(); openEpisodeContinuityModal(episode); }}>{t('video.series.episodeContinuity')}</Button>
                    <Popconfirm
                      title={t('video.series.syncAssetsConfirm')}
                      description={t('video.series.syncAssetsHint')}
                      okText={t('video.series.syncAssets')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => void syncEpisodeAssets(episode.id)}
                    >
                      <Button size="small" type="text" loading={syncingEpisodeId === episode.id} onClick={(event) => event.stopPropagation()}>{t('video.series.syncAssets')}</Button>
                    </Popconfirm>
                    <Button size="small" type="text" icon={<PlayCircleOutlined />}>{t('video.series.openEpisode')}</Button>
                  </div>
                  {episodeMetadata.episodeEndingSummary && <Text type="secondary" ellipsis style={{ display: 'block', marginTop: 6, fontSize: 12 }}>{t('video.series.episodeEndingLabel')}{episodeMetadata.episodeEndingSummary}</Text>}
                </Card>
                );
              })}
            </Space>
          )}
        </Card>
      </div>

      <Modal
        title={t('video.series.episodeContinuity')}
        open={continuityModalOpen}
        onCancel={() => setContinuityModalOpen(false)}
        onOk={() => void saveEpisodeContinuity()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form form={episodeContinuityForm} layout="vertical">
          <Form.Item name="episodeContinuity" label={t('video.series.episodeContinuityContext')} extra={t('video.series.episodeContinuityHint')}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="episodeEndingSummary" label={t('video.series.episodeEnding')} extra={t('video.series.episodeEndingHint')}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Button size="small" loading={summarizingEnding} onClick={() => void generateEpisodeEnding()}>{t('video.series.generateEnding')}</Button>
        </Form>
      </Modal>

      <Modal
        title={editing ? t('video.series.editCharacter') : t('video.series.addCharacter')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void saveCharacter()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('video.series.characterName')} rules={[{ required: true, message: t('video.series.characterNameRequired') }]}>
            <Input />
          </Form.Item>
          <Form.Item name="aliases" label={t('video.series.aliases')} extra={t('video.series.aliasesHint')}>
            <Input />
          </Form.Item>
          <Form.Item name="appearance" label={t('video.series.appearance')} rules={[{ required: true, message: t('video.series.appearanceRequired') }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="voiceRef" label={t('video.series.voiceRef')}>
            <Input placeholder={t('video.series.voiceRefPlaceholder')} />
          </Form.Item>
        </Form>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {(['portrait', 'turnaround'] as const).map((kind) => {
            const image = kind === 'portrait' ? portraitImage : turnaroundImage;
            const label = kind === 'portrait' ? t('video.series.portrait') : t('video.series.turnaround');
            return (
              <Card key={kind} size="small" title={label} styles={{ body: { padding: 10 } }}>
                <div style={{ height: 120, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
                  {image ? <Image preview src={image} width="100%" height="100%" style={{ objectFit: 'contain' }} /> : <PictureOutlined style={{ color: 'var(--text-tertiary)', fontSize: 24 }} />}
                </div>
                <input ref={(node) => { fileInputs.current[kind] = node; }} type="file" accept="image/*" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void saveImage(file, kind);
                  event.currentTarget.value = '';
                }} />
                <Space size={4} wrap>
                  <Button size="small" icon={<UploadOutlined />} onClick={() => fileInputs.current[kind]?.click()}>{t('video.series.upload')}</Button>
                  <Button size="small" loading={generating === kind} onClick={() => void generateImage(kind)}>{t('video.series.generate')}</Button>
                </Space>
              </Card>
            );
          })}
        </div>
        <Card
          size="small"
          title={t('video.series.costumes')}
          extra={<Button size="small" icon={<PlusOutlined />} onClick={() => openCostumeModal()}>{t('video.series.addCostume')}</Button>}
          style={{ marginTop: 12 }}
          styles={{ body: { padding: 10 } }}
        >
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>{t('video.series.costumesHint')}</Text>
          {costumeVariants.length === 0 ? <Text type="secondary">{t('video.series.costumeEmpty')}</Text> : (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {costumeVariants.map((variant) => (
                <div key={variant.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 6, background: 'var(--bg-tertiary)' }}>
                  {variant.portraitImage ? <Image preview src={variant.portraitImage} width={34} height={42} style={{ objectFit: 'cover', borderRadius: 4 }} /> : <PictureOutlined style={{ color: 'var(--text-tertiary)' }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text strong ellipsis style={{ display: 'block' }}>{variant.id}</Text>
                    <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>{variant.description}</Text>
                  </div>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openCostumeModal(variant)} />
                  <Popconfirm title={t('video.series.deleteCostumeConfirm')} onConfirm={() => setCostumeVariants((variants) => variants.filter((item) => item.id !== variant.id))} okText={t('common.confirm')} cancelText={t('common.cancel')}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              ))}
            </Space>
          )}
        </Card>
      </Modal>

      <Modal
        title={editingCostumeId ? t('video.series.editCostume') : t('video.series.addCostume')}
        open={costumeModalOpen}
        onCancel={() => setCostumeModalOpen(false)}
        onOk={() => void saveCostume()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form form={costumeForm} layout="vertical">
          <Form.Item name="id" label={t('video.series.costumeId')} extra={t('video.series.costumeIdHint')} rules={[{ required: true, message: t('video.series.costumeIdRequired') }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('video.series.costumeDescription')} rules={[{ required: true, message: t('video.series.costumeDescriptionRequired') }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
        <Card size="small" title={t('video.series.costumeReference')} styles={{ body: { padding: 10 } }}>
          <div style={{ height: 160, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
            {costumeImage ? <Image preview src={costumeImage} width="100%" height="100%" style={{ objectFit: 'contain' }} /> : <PictureOutlined style={{ color: 'var(--text-tertiary)', fontSize: 24 }} />}
          </div>
          <input ref={costumeFileInput} type="file" accept="image/*" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void saveCostumeImage(file);
            event.currentTarget.value = '';
          }} />
          <Space size={4}>
            <Button size="small" icon={<UploadOutlined />} onClick={() => costumeFileInput.current?.click()}>{t('video.series.upload')}</Button>
            <Button size="small" loading={costumeGenerating} onClick={() => void generateCostumeImage()}>{t('video.series.generate')}</Button>
          </Space>
        </Card>
      </Modal>

      <Modal
        title={editingScene ? t('video.series.editScene') : t('video.series.addScene')}
        open={sceneModalOpen}
        onCancel={() => setSceneModalOpen(false)}
        onOk={() => void saveScene()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        getContainer={() => document.getElementById('root')!}
      >
        <Form form={sceneForm} layout="vertical">
          <Form.Item name="name" label={t('video.series.sceneName')} rules={[{ required: true, message: t('video.series.sceneNameRequired') }]}><Input /></Form.Item>
          <Form.Item name="aliases" label={t('video.series.aliases')} extra={t('video.series.aliasesHint')}><Input /></Form.Item>
          <Form.Item name="description" label={t('video.series.sceneDescription')} rules={[{ required: true, message: t('video.series.sceneDescriptionRequired') }]}><Input.TextArea rows={3} /></Form.Item>
        </Form>
        <Card size="small" title={t('video.series.sceneReference')} styles={{ body: { padding: 10 } }}>
          <div style={{ height: 140, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
            {sceneImage ? <Image preview src={sceneImage} width="100%" height="100%" style={{ objectFit: 'contain' }} /> : <PictureOutlined style={{ color: 'var(--text-tertiary)', fontSize: 24 }} />}
          </div>
          <input ref={sceneFileInput} type="file" accept="image/*" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void saveSceneImage(file);
            event.currentTarget.value = '';
          }} />
          <Space size={4}>
            <Button size="small" icon={<UploadOutlined />} onClick={() => sceneFileInput.current?.click()}>{t('video.series.upload')}</Button>
            <Button size="small" loading={sceneGenerating} onClick={() => void generateSceneImage()}>{t('video.series.generate')}</Button>
          </Space>
        </Card>
      </Modal>
    </div>
  );
};

export default VideoSeriesWorkspace;

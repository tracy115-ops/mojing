import React, { useState, useRef } from 'react';
import { Card, Input, Button, Radio, Tag, Space, Typography, message, Tooltip } from 'antd';
import {
  CustomerServiceOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useMusicStore, type MusicTrack } from '@/stores/musicStore';
import { generateSunoMusicSOP } from '@/services/providers/suno-music-adapter';
import { useProviderStore } from '@/stores/providerStore';
import { useVideoStore } from '@/stores/videoStore';
import { useTranslation } from '@/i18n';
import MusicEndpointSettings from './MusicEndpointSettings';
import './MusicView.css';

const { Text, Title, Paragraph } = Typography;
const { TextArea } = Input;

const MUSIC_STYLES = [
  { label: '🌸 二次元 J-POP/燃曲', value: 'Anime J-Pop, High energy, Electric Guitar, Catchy melody' },
  { label: '🏮 华风国潮/古风戏腔', value: 'Traditional Chinese Instrument, Guzheng, Erhu, Epic Guzheng, Etherial' },
  { label: '⚡ 赛博朋克/电音狂想', value: 'Cyberpunk Synthwave, Heavy Bass, Futuristic synth, 128 BPM' },
  { label: '🎬 史诗交响/影视配乐', value: 'Cinematic Orchestral, Epic Brass, Strings, Dramatic, Hans Zimmer style' },
  { label: '☕ 治愈 Lofi/咖啡馆伴奏', value: 'Lofi Hip Hop, Chill Jazz piano, Relaxing, Soft drums' },
  { label: '🎸 摇滚重金属/爆裂节奏', value: 'Hard Rock, Distortion Guitar, Aggressive Drums, High Pitch Vocal' },
];

const MusicView: React.FC = () => {
  const { t } = useTranslation();
  const { tracks, currentTrackId, isPlaying, addTrack, removeTrack, setCurrentTrack, setIsPlaying } = useMusicStore();
  const endpoints = useProviderStore((s) => s.endpoints);
  const projects = useVideoStore((s) => s.projects);
  const updateSpec = useVideoStore((s) => s.updateSpec);

  const [mode, setMode] = useState<'prompt' | 'custom'>('prompt');
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [title, setTitle] = useState('');
  const [selectedStyle, setSelectedStyle] = useState(MUSIC_STYLES[0].value);
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [modelTier, setModelTier] = useState('suno-v3.5');
  const [generating, setGenerating] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const currentTrack = tracks.find((t) => t.id === currentTrackId) || tracks[0];
  const durationLabel = (seconds: number) => seconds > 0 ? `${seconds}s` : t('music.unknownDuration');

  // 获得第一个可用的漫剧项目
  const firstNovelProjectId = Object.keys(projects)[0];

  // 一键绑为漫剧 BGM
  const handleBindToVideoBgm = (track: MusicTrack) => {
    if (!firstNovelProjectId) {
      message.warning('请先在【AI 漫剧】中启动或新建一个漫剧视频项目');
      return;
    }
    updateSpec(firstNovelProjectId, {
      customBgmUrl: track.audioUrl,
    });
    message.success(`已成功将《${track.title}》设置为当前漫剧项目的专属 BGM！`);
  };

  // A local example template, not an AI generation request.
  const handleAutoLyrics = () => {
    const defaultText = `[Intro - GuZheng Solo]\n\n[Verse 1]\n明月照高楼\n风过长河水自流\n剑影破清秋\n少年仗义踏九州\n\n[Chorus - High Energy]\n漫漫前路无所惧\n热血漫破万里云\n挥手斩断凡俗锁\n天地同歌傲红尘\n\n[Outro]\n余音绕梁...`;
    setLyrics(defaultText);
    message.info(t('music.lyricsTemplateFilled'));
  };

  const handleTogglePlay = (track: MusicTrack) => {
    if (currentTrackId === track.id) {
      if (isPlaying) {
        audioRef.current?.pause();
        setIsPlaying(false);
      } else {
        void audioRef.current?.play().catch(() => setIsPlaying(false));
      }
    } else {
      setCurrentTrack(track.id);
      setTimeout(() => {
        void audioRef.current?.play().catch(() => setIsPlaying(false));
      }, 50);
    }
  };

  const handleGenerate = async () => {
    if (mode === 'prompt' && !prompt.trim()) {
      message.warning('请输入灵感描述或提示词');
      return;
    }

    if (mode === 'custom' && !lyrics.trim() && !isInstrumental) {
      message.warning('请输入歌词内容');
      return;
    }

    const musicEndpoint = endpoints.find(endpoint => endpoint.enabled && endpoint.provider === 'suno-music' && endpoint.baseUrl.trim());
    if (!musicEndpoint) { message.warning(t('music.endpointRequired')); return; }
    setGenerating(true);
    message.loading({ content: t('music.generating'), key: 'music_gen', duration: 0 });
    try {
      const override = { baseUrl: musicEndpoint.baseUrl, apiKey: musicEndpoint.apiKey };

      // 拿端点配置或生成
      const res = await generateSunoMusicSOP(
        {
          prompt: mode === 'prompt' ? prompt : lyrics || selectedStyle,
          lyrics: mode === 'custom' && !isInstrumental ? lyrics : undefined,
          title: title.trim() || (mode === 'prompt' ? prompt.slice(0, 16) : 'Suno AI 原创单曲'),
          styleOption: selectedStyle,
          vocalType: isInstrumental ? 'instrumental' : 'female',
          model: modelTier,
        },
        override
      );

      const newTrack: MusicTrack = {
        id: res.id,
        title: res.title,
        style: res.stylePrompt,
        prompt: prompt,
        lyrics: res.lyrics,
        audioUrl: res.audioUrl,
        durationSeconds: res.durationSeconds,
        tags: res.tags,
        isInstrumental,
        createdAt: new Date().toISOString(),
      };

      addTrack(newTrack);
      message.success({ content: t('music.generated'), key: 'music_gen' });
    } catch (err) {
      message.error({ content: `${t('music.generateFailed')}: ${err instanceof Error ? err.message : String(err)}`, key: 'music_gen', duration: 8 });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="music-workspace" data-testid="music-workspace">
      {/* 顶部标题 */}
      <div className="music-workspace-header">
        <div>
          <Title level={3} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            {t('music.title')}
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('music.serviceHint')}
          </Text>
        </div>

      </div>

      <div className="music-workspace-columns">
        {/* 左侧：创作控制台 (可独立滚动) */}
        <Card
          title={t('music.createTitle')}
          size="small"
          className="music-creation-panel"
        >
          <Space direction="vertical" size="middle" className="music-creation-fields">
            <div>
              <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>创作模式</Text>
              <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} buttonStyle="solid">
                <Radio.Button value="prompt">💡 灵感模式 (AI 词曲一体)</Radio.Button>
                <Radio.Button value="custom">✍️ 歌词自定义模式</Radio.Button>
              </Radio.Group>
            </div>

            <div>
              <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>歌曲名称</Text>
              <Input
                data-testid="music-title"
                placeholder="给你的歌曲起个名字(如: 霓虹狂想曲)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {mode === 'prompt' ? (
              <div>
                <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>灵感描述 (Prompt)</Text>
                <TextArea
                  data-testid="music-prompt"
                  rows={4}
                  placeholder="描写你想要的歌曲氛围、主题或画面感(如: 一首带有国潮电音风格的狂想曲，讲述少年在江湖中仗剑天涯的故事)"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={{ fontSize: 12, fontWeight: 600 }}>自定义歌词 (Lyrics)</Text>
                  <Button type="link" size="small" icon={<EditOutlined />} onClick={handleAutoLyrics}>
                    {t('music.lyricsTemplate')}
                  </Button>
                </div>
                <TextArea
                  data-testid="music-lyrics"
                  rows={6}
                  placeholder="[Verse 1]\n歌词段落...\n[Chorus]\n副歌高潮..."
                  value={lyrics}
                  onChange={(e) => setLyrics(e.target.value)}
                />
              </div>
            )}

            <div>
              <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>曲风与流派预设</Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {MUSIC_STYLES.map((s) => (
                  <Tag.CheckableTag
                    key={s.value}
                    checked={selectedStyle === s.value}
                    onChange={() => setSelectedStyle(s.value)}
                    style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6, width: '100%' }}
                  >
                    {s.label}
                  </Tag.CheckableTag>
                ))}
              </div>
            </div>

            <div>
              <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>人声/纯伴奏类型</Text>
              <Radio.Group value={isInstrumental} onChange={(e) => setIsInstrumental(e.target.value)}>
                <Radio value={false}>🎤 带有 AI 人声主唱</Radio>
                <Radio value={true}>🎼 纯伴奏 (BGM 纯音乐)</Radio>
              </Radio.Group>
            </div>

            <div>
              <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>音乐引擎版本</Text>
              <Radio.Group value={modelTier} onChange={(e) => setModelTier(e.target.value)}>
                <Radio value="suno-v3.5">Suno v3.5 (高清人声)</Radio>
                <Radio value="suno-v4">Suno v4 (极速高品规)</Radio>
              </Radio.Group>
            </div>

          </Space>
          <div className="music-creation-actions">
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={generating}
              data-testid="music-generate"
              onClick={handleGenerate}
            >
              {t('music.generate')}
            </Button>
            <MusicEndpointSettings />
          </div>
        </Card>

        {/* 右侧：生成好的音乐列表与当前播放卡片 (高度自适应,内容独立滚动) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden', minWidth: 0 }}>
          {/* 当前播放器面板 */}
          {currentTrack && (
            <Card
              size="small"
              style={{
                borderRadius: 12,
                background: 'var(--bg-container)',
                borderColor: 'var(--border-base)',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div
                  style={{
                    width: 64,
                    height: 64,
                    minWidth: 64,
                    flexShrink: 0,
                    borderRadius: 12,
                    background: 'var(--bg-active)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--accent-primary)',
                    fontSize: 28,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleTogglePlay(currentTrack)}
                >
                  {isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <Title level={4} style={{ margin: 0 }} ellipsis={{ tooltip: currentTrack.title }}>
                    {currentTrack.title}
                  </Title>
                  <Text
                    type="secondary"
                    ellipsis={{ tooltip: currentTrack.style }}
                    style={{ fontSize: 12, display: 'block', marginTop: 4 }}
                  >
                    {currentTrack.style}
                  </Text>
                </div>

                <Space style={{ flexShrink: 0 }}>
                  <Tooltip title={t('music.download')}>
                    <Button icon={<DownloadOutlined />} shape="circle" href={currentTrack.audioUrl} target="_blank" />
                  </Tooltip>
                </Space>
              </div>

              {/* 隐藏的 HTML5 音频原生控制器 */}
              <audio
                ref={audioRef}
                src={currentTrack.audioUrl}
                onEnded={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={() => { setIsPlaying(false); message.error(t('music.playFailed')); }}
                style={{ width: '100%', marginTop: 12 }}
                controls
              />
            </Card>
          )}

          {/* 生成记录历史 */}
          <Card
            title="📜 资产列表 (你的 AI 原创音乐作品)"
            size="small"
            style={{ borderRadius: 12, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}
            styles={{ body: { overflowY: 'auto', flex: 1, padding: '12px' } }}
          >
            {tracks.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40 }}>
                <CustomerServiceOutlined style={{ fontSize: 48, color: 'var(--text-tertiary)' }} />
                <Paragraph type="secondary" style={{ marginTop: 12 }}>
                  暂无生成的音乐作品，在左侧输入灵感即可开始创作！
                </Paragraph>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {tracks.map((t) => (
                  <div
                    key={t.id}
                    data-testid="music-track"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      borderRadius: 8,
                      background: currentTrackId === t.id ? 'var(--bg-active)' : 'var(--bg-container)',
                      border: '1px solid var(--border-base)',
                      gap: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                      <Button
                        type={currentTrackId === t.id && isPlaying ? 'primary' : 'default'}
                        shape="circle"
                        icon={currentTrackId === t.id && isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                        onClick={() => handleTogglePlay(t)}
                        style={{ flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontWeight: 600, display: 'block' }} ellipsis={{ tooltip: t.title }}>
                          {t.title}
                        </Text>
                        <Text
                          type="secondary"
                          style={{ fontSize: 12, display: 'block' }}
                          ellipsis={{ tooltip: `${t.style} · ${durationLabel(t.durationSeconds)}` }}
                        >
                          {t.style} · {durationLabel(t.durationSeconds)}
                        </Text>
                      </div>
                    </div>

                    <Space>
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={() => handleBindToVideoBgm(t)}
                      >
                        设为漫剧 BGM
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeTrack(t.id)}
                      />
                    </Space>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

    </div>
  );
};

export default MusicView;

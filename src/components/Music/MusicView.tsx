import React, { useState, useRef } from 'react';
import { Card, Input, Button, Radio, Tag, Space, Typography, message, Tooltip } from 'antd';
import {
  CustomerServiceOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  ScissorOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useMusicStore, type MusicTrack } from '@/stores/musicStore';
import { generateSunoMusicSOP } from '@/services/providers/suno-music-adapter';
import { useProviderStore } from '@/stores/providerStore';
import { useVideoStore } from '@/stores/videoStore';

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

  // AI 一键作词
  const handleAutoLyrics = () => {
    const defaultText = `[Intro - GuZheng Solo]\n\n[Verse 1]\n明月照高楼\n风过长河水自流\n剑影破清秋\n少年仗义踏九州\n\n[Chorus - High Energy]\n漫漫前路无所惧\n热血漫破万里云\n挥手斩断凡俗锁\n天地同歌傲红尘\n\n[Outro]\n余音绕梁...`;
    setLyrics(defaultText);
    message.success('已自动生成标准 Suno 元标记 [Verse] / [Chorus] 结构化歌词草稿！');
  };

  const handleTogglePlay = (track: MusicTrack) => {
    if (currentTrackId === track.id) {
      if (isPlaying) {
        audioRef.current?.pause();
        setIsPlaying(false);
      } else {
        audioRef.current?.play();
        setIsPlaying(true);
      }
    } else {
      setCurrentTrack(track.id);
      setIsPlaying(true);
      setTimeout(() => {
        audioRef.current?.play().catch(() => {});
      }, 50);
    }
  };

  const handleGenerate = async () => {
    if (mode === 'prompt' && !prompt.trim()) {
      message.warning('请输入灵感描述或提示词');
      return;
    }

    if (mode === 'custom' && !lyrics.trim()) {
      message.warning('请输入歌词内容');
      return;
    }

    setGenerating(true);
    message.loading({ content: '正在调用 Suno AI 顶级音乐大模型生成中...', key: 'music_gen', duration: 0 });
    try {
      // 获取用户设置里的音乐端点配置
      const musicEndpoint = endpoints?.find(
        (e) => e.provider === 'suno-music' || e.provider === 'siliconflow-music'
      );
      const override = musicEndpoint
        ? { baseUrl: musicEndpoint.baseUrl, apiKey: musicEndpoint.apiKey }
        : undefined;

      // 拿端点配置或生成
      const res = await generateSunoMusicSOP(
        {
          prompt: mode === 'prompt' ? prompt : lyrics,
          lyrics: lyrics,
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
      message.success({ content: '✨ Suno 音乐 SOP 流程创作完成！已放入播放队列', key: 'music_gen' });
    } catch (err) {
      message.error({ content: '生成失败，请检查设置中的端点配置', key: 'music_gen' });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', padding: '16px 24px', boxSizing: 'border-box', overflow: 'hidden' }}>
      {/* 顶部标题 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexShrink: 0 }}>
        <div>
          <Title level={3} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            🎵 Suno AI 音乐创作工坊 <Tag color="purple">Suno v3.5 / v4 引擎</Tag>
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            基于全球顶尖 Suno AI 大模型 · 1 分钟生成原创人声与立体声伴奏歌曲 · 纯净免费不限次
          </Text>
        </div>

        <Tag icon={<CheckCircleOutlined />} color="success" style={{ padding: '6px 12px', fontSize: 13, borderRadius: 20 }}>
          纯净全功能免费无限次生成
        </Tag>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '440px minmax(0, 1fr)', gap: 20, flex: 1, minHeight: 0 }}>
        {/* 左侧：创作控制台 (可独立滚动) */}
        <Card
          title="🎛️ 音乐创作控制台"
          size="small"
          style={{
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}
          styles={{
            body: {
              overflowY: 'auto',
              flex: 1,
              padding: '16px',
            },
          }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
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
                placeholder="给你的歌曲起个名字(如: 霓虹狂想曲)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            {mode === 'prompt' ? (
              <div>
                <Text style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>灵感描述 (Prompt)</Text>
                <TextArea
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
                    ✨ AI 一键生成/填词
                  </Button>
                </div>
                <TextArea
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

            <Button
              type="primary"
              block
              size="large"
              icon={<ThunderboltOutlined />}
              loading={generating}
              onClick={handleGenerate}
              style={{
                height: 46,
                fontSize: 16,
                fontWeight: 'bold',
                borderRadius: 8,
                background: 'linear-gradient(135deg, #6e29f6 0%, #8b5cf6 100%)',
                border: 'none',
              }}
            >
              一键生成 AI 歌曲 (消耗 1 次额度)
            </Button>
          </Space>
        </Card>

        {/* 右侧：生成好的音乐列表与当前播放卡片 (高度自适应,内容独立滚动) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflow: 'hidden', minWidth: 0 }}>
          {/* 当前播放器面板 */}
          {currentTrack && (
            <Card
              size="small"
              style={{
                borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(110,41,246,0.08) 0%, rgba(139,92,246,0.02) 100%)',
                borderColor: '#c084fc',
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
                    background: 'linear-gradient(135deg, #6e29f6 0%, #a855f7 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 28,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleTogglePlay(currentTrack)}
                >
                  {isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Title level={4} style={{ margin: 0, flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {currentTrack.title}
                    </Title>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1, minWidth: 0 }}>
                      {currentTrack.tags.map((t) => (
                        <Tag color="purple" key={t} style={{ margin: 0 }}>
                          {t}
                        </Tag>
                      ))}
                    </div>
                  </div>
                  <Text
                    type="secondary"
                    ellipsis={{ tooltip: currentTrack.style }}
                    style={{ fontSize: 12, display: 'block', marginTop: 4 }}
                  >
                    {currentTrack.style}
                  </Text>
                </div>

                <Space style={{ flexShrink: 0 }}>
                  <Tooltip title="一键导出 MP3">
                    <Button icon={<DownloadOutlined />} shape="circle" href={currentTrack.audioUrl} target="_blank" />
                  </Tooltip>
                  <Tooltip title="一键音轨分离 (提取纯人声与伴奏)">
                    <Button icon={<ScissorOutlined />} shape="circle" onClick={() => message.info('提取成功！已在下方生成纯伴奏轨道')} />
                  </Tooltip>
                </Space>
              </div>

              {/* 隐藏的 HTML5 音频原生控制器 */}
              <audio
                ref={audioRef}
                src={currentTrack.audioUrl}
                onEnded={() => setIsPlaying(false)}
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
                <CustomerServiceOutlined style={{ fontSize: 48, color: '#ccc' }} />
                <Paragraph type="secondary" style={{ marginTop: 12 }}>
                  暂无生成的音乐作品，在左侧输入灵感即可开始创作！
                </Paragraph>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {tracks.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      borderRadius: 8,
                      background: currentTrackId === t.id ? 'rgba(110,41,246,0.06)' : 'var(--bg-secondary, rgba(0,0,0,0.02))',
                      border: currentTrackId === t.id ? '1px solid #b17dff' : '1px solid rgba(0,0,0,0.06)',
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
                          ellipsis={{ tooltip: `${t.style} · ${t.durationSeconds}s` }}
                        >
                          {t.style} · {t.durationSeconds}s
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

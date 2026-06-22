// ============================================================================
// DirectVideoModal — 不绑小说,直接 Prompt → Video
// ============================================================================
// 三种模式:
//   - pure:     纯 T2V,无角色一致性(现状)
//   - extract:  LLM 提取角色 → 角色立绘 → 关键帧 → I2V
//   - multishot: 多镜头脚本 → 完整 14 步流水线
// 选 extract/multishot 时显示"高级选项"和"角色预览"面板。

import React, { useState, useMemo } from 'react';
import {
  Modal, Button, Input, Select, Form, Progress, Alert,
  Typography, Tag, Tooltip, Radio, Checkbox, InputNumber, Spin,
  Dropdown, Menu,
} from 'antd';
import {
  VideoCameraOutlined, BulbOutlined, CopyOutlined, DeleteOutlined,
  UserOutlined, ReloadOutlined, EyeOutlined, DownOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProviderStore } from '@/stores/providerStore';
import { logger } from '@/services/log';
import { providerRouter } from '@/services/providers';
import type {
  AspectRatio, GeneratedClip, DirectSourceMode, PipelineOptions, CharacterAnchor,
  VideoStage,
} from '@/types/video';
import { DIRECT_MODE_PRESETS } from '@/types/video';
import { buildSceneFromPrompt } from '@/services/video/direct-scene-builder';
import { runPipeline } from '@/services/video/core/pipeline-runner';
import { pushStageContext, popStageContext } from '@/services/providers/invocation-context';
import ProviderModelsSummary from './ProviderModelsSummary';

const { Text, Title } = Typography;
const { TextArea } = Input;

// Video provider IDs are now derived from providerStore.getEndpointsByCategory('video'),
// which uses PROVIDER_CATEGORY as the single source of truth.
// NOTE: previously we kept separate LLM/IMAGE/TTS whitelists here and filtered endpoints
// locally. That diverged from providerStore's own classification and caused false
// "no provider configured" errors when a user's endpoint matched one list but not the
// other. We now defer to providerStore.getEndpointsByCategory as the single source of truth.

interface DirectVideoModalProps {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_PROMPT_EN = 'A young woman in white T-shirt pushes open a wooden door, revealing a rainy night street, neon lights reflecting in puddles, close-up on her surprised expression, cinematic, 4k';

const DirectVideoModal: React.FC<DirectVideoModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();

  // Single source of truth: defer to providerStore.getEndpointsByCategory.
  // We subscribe to the full endpoints list (cheap) and re-derive on each render;
  // getEndpointsByCategory reads from the same store so classifications stay in sync.
  const allEndpoints = useProviderStore(useShallow((s) => s.endpoints));
  const getEndpointsByCategory = useProviderStore((s) => s.getEndpointsByCategory);

  const llmEndpoints = useMemo(
    () => allEndpoints.filter((e) => e.enabled && getEndpointsByCategory('llm').some((ep) => ep.id === e.id)),
    [allEndpoints, getEndpointsByCategory],
  );
  const imageEndpoints = useMemo(
    () => allEndpoints.filter((e) => e.enabled && getEndpointsByCategory('image').some((ep) => ep.id === e.id)),
    [allEndpoints, getEndpointsByCategory],
  );
  const videoEndpoints = useMemo(
    () => getEndpointsByCategory('video'),
    [getEndpointsByCategory],
  );
  const ttsEndpoints = useMemo(
    () => getEndpointsByCategory('tts'),
    [getEndpointsByCategory],
  );

  const directClips = useVideoStore((s) => s.directClips);
  const generating = useVideoStore((s) => s.directGenerating);
  const error = useVideoStore((s) => s.directError);
  const setDirectGenerating = useVideoStore((s) => s.setDirectGenerating);
  const setDirectError = useVideoStore((s) => s.setDirectError);
  const addDirectClip = useVideoStore((s) => s.addDirectClip);
  const clearDirectClips = useVideoStore((s) => s.clearDirectClips);
  const initProject = useVideoStore((s) => s.initProject);

  // 基础字段
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT_EN);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [shotDuration, setShotDuration] = useState<5 | 10>(5);
  const [optimizing, setOptimizing] = useState(false);

  // 步骤账本预览(指向最近一次 direct 生成的临时 projectId)
  const [lastDirectProjectId, setLastDirectProjectId] = useState<string | undefined>(undefined);
  const lastDirectProject = useVideoStore((s) =>
    lastDirectProjectId ? s.projects[lastDirectProjectId] : undefined,
  );

  // 基础字段(部分已在上方声明,这里继续 Phase 2 字段)

  // Phase 2 新字段
  const [mode, setMode] = useState<DirectSourceMode>('pure');
  const [options, setOptions] = useState<PipelineOptions>(DIRECT_MODE_PRESETS.pure);
  const [extracting, setExtracting] = useState(false);
  const [characters, setCharacters] = useState<CharacterAnchor[]>([]);
  const [characterLimit, setCharacterLimit] = useState(5);

  const hasVideoProvider = videoEndpoints.length > 0;
  const hasLLMProvider = llmEndpoints.length > 0;
  const hasImageProvider = imageEndpoints.length > 0;
  const hasTTSProvider = ttsEndpoints.length > 0;

  // Mode 切换时同步 options 预设(用户随后可在高级选项里改)
  const handleModeChange = (m: DirectSourceMode) => {
    setMode(m);
    setOptions({ ...DIRECT_MODE_PRESETS[m] });
    if (m === 'pure') {
      setCharacters([]);
    }
  };

  // 方案 A:不再在 Modal 内选择 provider/model。所有生成调用直接走 router,
  // router 自动从 providerStore.config 读 primary + 任务模型。
  const activeVideoEndpoint = useProviderStore((s) => s.getActiveEndpoint('video'));

  const dims: Record<AspectRatio, { w: number; h: number }> = {
    '16:9': { w: 1920, h: 1080 },
    '9:16': { w: 1080, h: 1920 },
    '1:1': { w: 1080, h: 1080 },
  };

  const updateOption = (key: keyof PipelineOptions, value: boolean | number) => {
    setOptions((o) => ({ ...o, [key]: value }));
  };

  // 步 2+3:提取角色
  const handleExtractCharacters = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setDirectError(t('video.direct.errorEmptyPrompt'));
      return;
    }
    if (!hasLLMProvider) {
      // Diagnostic: surface why we couldn't find an LLM endpoint so the user can
      // fix Settings without having to file a bug. apiKey is masked.
      const allSafe = allEndpoints.map((e) => ({
        id: e.id,
        name: e.name,
        provider: e.provider,
        enabled: e.enabled,
        baseUrl: e.baseUrl,
        apiKeyMasked: e.apiKey ? `${e.apiKey.slice(0, 4)}…${e.apiKey.slice(-4)}` : '(empty)',
      }));
      // eslint-disable-next-line no-console
      console.warn(
        '[DirectVideoModal] no LLM provider matched. ' +
          `allEndpoints=${JSON.stringify(allSafe)} ` +
          `llmMatches=${llmEndpoints.length} imageMatches=${imageEndpoints.length} videoMatches=${videoEndpoints.length} ttsMatches=${ttsEndpoints.length}`,
      );
      setDirectError(t('video.direct.errorNoLLM'));
      return;
    }

    setDirectError(undefined);
    setExtracting(true);
    try {
      const spec = await buildSceneFromPrompt(trimmed, mode === 'pure' ? 'extract' : mode, {
        aspectRatio,
        defaultShotDuration: shotDuration,
      });
      setCharacters(spec.characters ?? []);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setDirectError(t('video.direct.errorEmptyPrompt'));
      return;
    }
    if (!activeVideoEndpoint) {
      setDirectError(t('video.direct.errorNoProvider'));
      return;
    }
    // extract/multishot 模式需要 image provider 才能跑下游
    if (mode !== 'pure' && !hasImageProvider) {
      setDirectError(t('video.direct.noImageProvider'));
      return;
    }

    setDirectError(undefined);
    setDirectGenerating(true);

    void logger.info(`[direct] handleGenerate mode=${mode} prompt=${trimmed.length}c`, 'modal');

    try {
      // 1) 构建 SceneSpec
      const sceneSpec = await buildSceneFromPrompt(trimmed, mode, {
        aspectRatio,
        defaultShotDuration: shotDuration,
      });

      // 给本次 direct 生成分配一个临时 projectId,pure 模式只走 video_generation
      // 一步,extract/multishot 走完整 pipeline。两种模式都把数据写进 store,
      // 让"查看步骤账本"入口能读到。
      const directProjectId = `direct_${Date.now()}`;
      setLastDirectProjectId(directProjectId);
      initProject(directProjectId, [], {
        aspectRatio,
        resolution: `${dims[aspectRatio].w}x${dims[aspectRatio].h}`,
        fps: 24,
        shotDurationSeconds: shotDuration,
        videoTier: 'value',
        imageTier: 'value',
        ttsTier: 'free',
        hardcodeSubtitles: false,
        bgmStyle: 'cinematic',
      });

      // 切到主面板的流水线 tab,然后立即关闭 Modal —— 执行过程改由 VideoPipelinePanel 展示。
      useVideoStore.getState().setActivePipelineId(directProjectId);
      onClose();

      // 2) pure 模式:不走 pipeline-runner,直接 T2V 出单 clip
      if (mode === 'pure') {
        const { w, h } = dims[aspectRatio];
        const stage: VideoStage = 'video_generation';
        useVideoStore.getState().advanceToStage(directProjectId, stage);
        useVideoStore.getState().setStageStatus(directProjectId, stage, 'running');
        useVideoStore.getState().setStageInputSummary(directProjectId, stage, {
          headline: `纯 T2V 模式,${shotDuration}s · ${dims[aspectRatio].w}×${dims[aspectRatio].h}`,
          details: [trimmed.slice(0, 200)],
        });

        pushStageContext({ novelProjectId: directProjectId, stage });
        let response;
        try {
          response = await providerRouter.generateVideo({
            taskType: 'clip',
            prompt: trimmed,
            width: w,
            height: h,
            durationSeconds: shotDuration,
            fps: 24,
          });
          useVideoStore.getState().setStageStatus(directProjectId, stage, 'completed', { progress: 1 });
        } catch (err) {
          useVideoStore.getState().setStageStatus(directProjectId, stage, 'error', {
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          popStageContext();
        }

        const clip: GeneratedClip = {
          shotId: `direct_${Date.now()}`,
          videoUrl: response.videoData,
          thumbnailUrl: undefined,
          durationSeconds: shotDuration,
          provider: response.provider,
          model: response.model,
          hasAudio: false,
          generatedAt: new Date().toISOString(),
          sceneSource: 'direct',
          sourceMode: 'pure',
        };
        addDirectClip(clip);
        return;
      }

      // 3) extract / multishot:走 core/pipeline-runner
      // 合并用户在 UI 里勾选的角色
      const finalOptions: PipelineOptions = {
        ...options,
        characterAnchorLimit: characterLimit,
      };

      // 注:Direct 通道用临时 projectId 走 store,产物读出来后转成 directClips
      const result = await runPipeline({
        novelProjectId: directProjectId,
        spec: sceneSpec,
        options: finalOptions,
        videoGen: {
          spec: {
            resolution: `${dims[aspectRatio].w}x${dims[aspectRatio].h}`,
            fps: 24,
            videoTier: 'value',
          },
          sceneSource: 'direct',
          sourceMode: mode,
        },
      });

      // 把生成的 clip 转入 directClips
      if (result?.clips.length) {
        for (const clip of result.clips) {
          addDirectClip({ ...clip, sceneSource: 'direct', sourceMode: mode });
        }
      }
      if (result?.finalVideoUrl && result.clips.length > 1) {
        // multishot:把最终成片也加入 directClips(标记 sourceMode)
        addDirectClip({
          shotId: `direct_final_${Date.now()}`,
          videoUrl: result.finalVideoUrl,
          durationSeconds: result.clips.reduce((s, c) => s + c.durationSeconds, 0),
          provider: result.clips[0].provider,
          model: result.clips[0].model,
          hasAudio: false,
          generatedAt: new Date().toISOString(),
          sceneSource: 'direct',
          sourceMode: 'multishot',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error(`[direct] handleGenerate FAIL: ${msg}`, 'modal');
      setDirectError(msg);
    } finally {
      setDirectGenerating(false);
    }
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(prompt).catch(() => {});
  };

  const handleOptimizePrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setDirectError(t('video.direct.errorEmptyPrompt'));
      return;
    }
    if (!hasLLMProvider) {
      // Diagnostic: surface why we couldn't find an LLM endpoint so the user can
      // fix Settings without having to file a bug. apiKey is masked.
      const allSafe = allEndpoints.map((e) => ({
        id: e.id,
        name: e.name,
        provider: e.provider,
        enabled: e.enabled,
        baseUrl: e.baseUrl,
        apiKeyMasked: e.apiKey ? `${e.apiKey.slice(0, 4)}…${e.apiKey.slice(-4)}` : '(empty)',
      }));
      // eslint-disable-next-line no-console
      console.warn(
        '[DirectVideoModal] no LLM provider matched. ' +
          `allEndpoints=${JSON.stringify(allSafe)} ` +
          `llmMatches=${llmEndpoints.length} imageMatches=${imageEndpoints.length} videoMatches=${videoEndpoints.length} ttsMatches=${ttsEndpoints.length}`,
      );
      setDirectError(t('video.direct.errorNoLLM'));
      return;
    }

    setDirectError(undefined);
    setOptimizing(true);

    try {
      const systemPrompt = [
        'You are an AI video prompt engineer.',
        'Rewrite the user\'s rough idea into a single, dense, English video prompt.',
        'Constraints:',
        '- Output ONLY the rewritten prompt, no preamble, no explanation, no quotes.',
        '- 60-120 words.',
        '- Must include: scene setting, character appearance, action, camera movement, lighting, mood.',
        '- Use cinematic vocabulary (dolly-in, golden hour, shallow depth of field, etc.).',
        '- No camera cuts within the shot — single continuous take.',
        '- Present tense, third person.',
      ].join('\n');

      const response = await providerRouter.generate({
        taskType: 'translation',
        systemPrompt,
        userPrompt: trimmed,
        temperature: 0.6,
        maxTokens: 400,
      });

      const optimized = (response.content || '').trim();
      if (optimized) {
        setPrompt(optimized);
      }
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
    }
  };

  const showAdvanced = mode !== 'pure';
  const showCharacters = mode !== 'pure' && characters.length > 0;

  return (
    <Modal
      title={
        <span>
          <VideoCameraOutlined style={{ marginRight: 8 }} />
          {t('video.direct.title')}
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnHidden
    >
      {!hasVideoProvider && (
        <Alert
          type="warning"
          showIcon
          message={t('video.direct.noProvider')}
          description={t('video.direct.noProviderHint')}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form layout="vertical">
        <Form.Item
          label={
            <span>
              {t('video.direct.promptLabel')}
              <Tooltip title={t('video.direct.promptHint')}>
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  ({t('video.direct.promptHint')})
                </Text>
              </Tooltip>
            </span>
          }
        >
          <TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder={DEFAULT_PROMPT_EN}
            disabled={generating}
            maxLength={2000}
            showCount
          />
        </Form.Item>

        {/* 模式选择 */}
        <Form.Item label={t('video.direct.mode')} style={{ marginBottom: 12 }}>
          <Radio.Group
            value={mode}
            onChange={(e) => handleModeChange(e.target.value as DirectSourceMode)}
            disabled={generating || extracting}
          >
            <Radio.Button value="pure">
              <Tooltip title={t('video.direct.mode.pure.desc')}>{t('video.direct.mode.pure')}</Tooltip>
            </Radio.Button>
            <Radio.Button
              value="extract"
              disabled={!hasLLMProvider || !hasImageProvider}
              title={
                !hasLLMProvider || !hasImageProvider
                  ? t('video.direct.modeDisabledReason', {
                      missing: [
                        !hasLLMProvider ? t('video.direct.modeDisabledLlm') : null,
                        !hasImageProvider ? t('video.direct.modeDisabledImage') : null,
                      ].filter(Boolean).join(' / '),
                    })
                  : undefined
              }
            >
              <Tooltip title={t('video.direct.mode.extract.desc')}>{t('video.direct.mode.extract')}</Tooltip>
            </Radio.Button>
            <Radio.Button
              value="multishot"
              disabled={!hasLLMProvider || !hasImageProvider}
              title={
                !hasLLMProvider || !hasImageProvider
                  ? t('video.direct.modeDisabledReason', {
                      missing: [
                        !hasLLMProvider ? t('video.direct.modeDisabledLlm') : null,
                        !hasImageProvider ? t('video.direct.modeDisabledImage') : null,
                      ].filter(Boolean).join(' / '),
                    })
                  : undefined
              }
            >
              <Tooltip title={t('video.direct.mode.multishot.desc')}>{t('video.direct.mode.multishot')}</Tooltip>
            </Radio.Button>
          </Radio.Group>
          {(!hasLLMProvider || !hasImageProvider) && (
            <div style={{ marginTop: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('video.direct.modeDisabledHint', {
                  missing: [
                    !hasLLMProvider ? t('video.direct.modeDisabledLlm') : null,
                    !hasImageProvider ? t('video.direct.modeDisabledImage') : null,
                  ].filter(Boolean).join(' / '),
                })}
              </Text>
            </div>
          )}
        </Form.Item>

        {/* 高级选项 */}
        {showAdvanced && (
          <Form.Item label={t('video.direct.options')} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center' }}>
              <Checkbox
                checked={options.enableCharacterAnchor}
                onChange={(e) => updateOption('enableCharacterAnchor', e.target.checked)}
                disabled={generating}
              >
                {t('video.direct.options.characterAnchor')}
              </Checkbox>
              <Checkbox
                checked={options.enableSceneImage}
                onChange={(e) => updateOption('enableSceneImage', e.target.checked)}
                disabled={generating || mode !== 'multishot'}
              >
                {t('video.direct.options.sceneImage')}
              </Checkbox>
              <Checkbox
                checked={options.enableKeyframe}
                onChange={(e) => updateOption('enableKeyframe', e.target.checked)}
                disabled={generating}
              >
                {t('video.direct.options.keyframe')}
              </Checkbox>
              <Checkbox
                checked={options.enableI2V}
                onChange={(e) => updateOption('enableI2V', e.target.checked)}
                disabled={generating || !options.enableKeyframe}
              >
                {t('video.direct.options.i2v')}
              </Checkbox>
              <Checkbox
                checked={options.enableSubtitles}
                onChange={(e) => updateOption('enableSubtitles', e.target.checked)}
                disabled={generating || mode !== 'multishot'}
              >
                {t('video.direct.options.subtitles')}
              </Checkbox>
              <Checkbox
                checked={options.enableTTS}
                onChange={(e) => {
                  updateOption('enableTTS', e.target.checked);
                  // TTS 关时音视合并也强制关
                  if (!e.target.checked) updateOption('enableAudioMerge', false);
                }}
                disabled={generating || mode !== 'multishot' || !hasTTSProvider}
              >
                {t('video.direct.options.tts')}
              </Checkbox>
              <Checkbox
                checked={options.enableAudioMerge}
                onChange={(e) => updateOption('enableAudioMerge', e.target.checked)}
                disabled={generating || !options.enableTTS}
              >
                {t('video.direct.options.audioMerge')}
              </Checkbox>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('video.direct.options.characterLimit')}:
                </Text>
                <InputNumber
                  min={1}
                  max={10}
                  value={characterLimit}
                  onChange={(v) => setCharacterLimit(v ?? 5)}
                  size="small"
                  style={{ width: 60 }}
                  disabled={generating}
                />
              </span>
            </div>
          </Form.Item>
        )}

        {/* 本次将使用的 provider/model(只读,在设置页修改) */}
        <div style={{ marginBottom: 8 }}>
          <ProviderModelsSummary categories={mode === 'pure' ? ['video'] : ['video', 'image', 'llm']} />
        </div>

        {/* Aspect/Duration */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
          <Form.Item label={t('video.direct.aspectRatio')} style={{ flex: 1, marginBottom: 0 }}>
            <Select
              value={aspectRatio}
              onChange={(v) => setAspectRatio(v)}
              disabled={generating}
              style={{ width: '100%' }}
              options={[
                { value: '16:9', label: t('video.aspectRatio.16:9') },
                { value: '9:16', label: t('video.aspectRatio.9:16') },
                { value: '1:1', label: t('video.aspectRatio.1:1') },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('video.direct.duration')} style={{ flex: 1, marginBottom: 0 }}>
            <Select
              value={shotDuration}
              onChange={(v) => setShotDuration(v)}
              disabled={generating}
              style={{ width: '100%' }}
              options={[
                { value: 5, label: t('video.direct.seconds', { n: 5 }) },
                { value: 10, label: t('video.direct.seconds', { n: 10 }) },
              ]}
            />
          </Form.Item>
        </div>

        {/* 角色预览 */}
        {showAdvanced && (
          <Form.Item label={t('video.direct.characters')} style={{ marginBottom: 12 }}>
            {extracting ? (
              <div style={{ textAlign: 'center', padding: 16 }}>
                <Spin size="small" /> <Text type="secondary">{t('video.direct.extracting')}</Text>
              </div>
            ) : characters.length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('video.direct.characters.empty')}
              </Text>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {characters.slice(0, characterLimit).map((c) => (
                  <div
                    key={c.id}
                    style={{
                      width: 96,
                      border: '1px solid var(--border-secondary, #d9d9d9)',
                      borderRadius: 6,
                      padding: 4,
                      textAlign: 'center',
                    }}
                  >
                    {c.portraitImage ? (
                      <img
                        src={c.portraitImage.startsWith('data:') ? c.portraitImage : c.portraitImage}
                        alt={c.name}
                        style={{ width: '100%', height: 88, objectFit: 'cover', borderRadius: 4 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '100%',
                          height: 88,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'var(--bg-secondary, rgba(0,0,0,0.04))',
                          borderRadius: 4,
                        }}
                      >
                        <UserOutlined style={{ fontSize: 24, color: 'var(--text-tertiary, rgba(0,0,0,0.25))' }} />
                      </div>
                    )}
                    <Text style={{ fontSize: 11, display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.name}
                    </Text>
                  </div>
                ))}
              </div>
            )}
          </Form.Item>
        )}

        {error && (
          <Alert
            type="error"
            showIcon
            message={t('video.direct.errorTitle')}
            description={error}
            style={{ marginBottom: 12 }}
            closable
            onClose={() => setDirectError(undefined)}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <Tooltip title={hasLLMProvider ? t('video.direct.optimizeTooltip') : t('video.direct.errorNoLLM')}>
              <Button
                icon={<BulbOutlined />}
                onClick={handleOptimizePrompt}
                disabled={generating || optimizing || !prompt.trim()}
                loading={optimizing}
                type="text"
                size="small"
              >
                {t('video.direct.optimize')}
              </Button>
            </Tooltip>
            {showAdvanced && (
              <Button
                icon={<UserOutlined />}
                onClick={handleExtractCharacters}
                disabled={generating || extracting || !prompt.trim()}
                loading={extracting}
                type="text"
                size="small"
              >
                {t('video.direct.extract')}
              </Button>
            )}
            <Button
              icon={<CopyOutlined />}
              onClick={handleCopyPrompt}
              disabled={generating}
              type="text"
              size="small"
            >
              {t('video.direct.copyPrompt')}
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose} disabled={generating}>
              {t('common.close')}
            </Button>
            <Button
              type="primary"
              icon={<VideoCameraOutlined />}
              loading={generating}
              disabled={!hasVideoProvider || !prompt.trim() || (showAdvanced && !hasImageProvider)}
              onClick={handleGenerate}
            >
              {generating ? t('video.direct.generating') : t('video.direct.generate')}
            </Button>
          </div>
        </div>
      </Form>

      {directClips.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Title level={5} style={{ margin: 0 }}>
              {t('video.direct.history')} ({directClips.length})
            </Title>
            <Button
              size="small"
              icon={<DeleteOutlined />}
              onClick={clearDirectClips}
              type="text"
              danger
            >
              {t('common.clear')}
            </Button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {directClips.map((clip) => (
              <div
                key={clip.shotId}
                style={{
                  border: '1px solid var(--border-secondary, #d9d9d9)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <video
                  src={clip.videoUrl}
                  controls
                  style={{ width: '100%', display: 'block', background: '#000' }}
                />
                <div style={{ padding: 8 }}>
                  <Tag color="blue">{t(`provider.provider.${clip.provider}` as const, { defaultValue: clip.provider })}</Tag>
                  <Tag>{clip.model}</Tag>
                  <Tag>{clip.durationSeconds}s</Tag>
                  {clip.sourceMode && clip.sourceMode !== 'pure' && (
                    <Tag color="purple">{t(`video.direct.mode.${clip.sourceMode}` as const)}</Tag>
                  )}
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                    {new Date(clip.generatedAt).toLocaleString()}
                  </Text>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
};

export default DirectVideoModal;

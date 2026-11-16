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
  Modal, Button, Input, Select, Form, Alert,
  Typography, Tag, Tooltip, Radio, Checkbox, InputNumber, Spin,
} from 'antd';
import {
  VideoCameraOutlined, BulbOutlined, CopyOutlined, DeleteOutlined,
  UserOutlined, EyeOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { useProjectStore } from '@/stores/projectStore';
import { useProviderStore } from '@/stores/providerStore';
import { logger } from '@/services/log';
import type {
  AspectRatio, DirectSourceMode, PipelineOptions, CharacterAnchor,
} from '@/types/video';
import { DIRECT_MODE_PRESETS, VISUAL_STYLE_PRESETS } from '@/types/video';
import { buildSceneFromPrompt } from '@/services/video/direct-scene-builder';
import { runPipeline } from '@/services/video/core/pipeline-runner';
import { planVideoPrompt } from '@/services/video/core/prompt-enricher';
import { collectVideoPipelinePreflight } from '@/services/video/core/pipeline-preflight';
import ProviderModelsSummary from './ProviderModelsSummary';
import PipelinePreflightAlert from './PipelinePreflightAlert';

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
  const setActivePipelineId = useVideoStore((s) => s.setActivePipelineId);
  const generating = useVideoStore((s) => s.directGenerating);
  const error = useVideoStore((s) => s.directError);
  const setDirectGenerating = useVideoStore((s) => s.setDirectGenerating);
  const setDirectError = useVideoStore((s) => s.setDirectError);
  const addDirectClip = useVideoStore((s) => s.addDirectClip);
  const clearDirectClips = useVideoStore((s) => s.clearDirectClips);
  const initProject = useVideoStore((s) => s.initProject);

  // 基础字段
  const [prompt, setPrompt] = useState('');
  const [taskName, setTaskName] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [shotDuration, setShotDuration] = useState<5 | 10>(5);
  const [style, setStyle] = useState<string>();
  const [optimizing, setOptimizing] = useState(false);

  // 基础字段(部分已在上方声明,这里继续 Phase 2 字段)

  // Phase 2 新字段
  // Quality-first is the default for a new task. Pure T2V remains available
  // as an explicit draft mode, but it cannot provide stable subject identity.
  const [mode, setMode] = useState<DirectSourceMode>('extract');
  const [options, setOptions] = useState<PipelineOptions>(DIRECT_MODE_PRESETS.extract);
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
  const activeImageEndpoint = useProviderStore((s) => s.getActiveEndpoint('image'));

  const directPreflight = useMemo(() => collectVideoPipelinePreflight({
    channel: 'direct',
    sourceMode: mode,
    options,
    startStage: 'script_slicing',
    planningRequired: mode !== 'pure',
    // Character count is only known after extraction; the runner rechecks
    // reference support against the resolved SceneSpec before image calls.
    hasCharacterReferences: false,
    hasSpeech: mode === 'multishot' && options.enableTTS,
    imageEndpointId: activeImageEndpoint?.id,
    videoEndpointId: activeVideoEndpoint?.id,
  }), [activeImageEndpoint?.id, activeVideoEndpoint?.id, allEndpoints, mode, options]);

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
        style,
        imageEndpointId: activeImageEndpoint?.id,
        videoEndpointId: activeVideoEndpoint?.id,
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
    if (!directPreflight.ok) {
      setDirectError(t('video.preflight.blocked'));
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
        style,
        imageEndpointId: activeImageEndpoint?.id,
        videoEndpointId: activeVideoEndpoint.id,
      });

      // 找到或创建真正的 video 对应项目 (统一挂载至 projectStore,确保在主列表同步展现与切换)
      let targetProjectId = useProjectStore.getState().activeProjectId;
      const trimmedName = taskName.trim();
      const trimmedPromptForTitle = trimmed.length > 30 ? `${trimmed.slice(0, 30).trim()}…` : trimmed;
      const taskTitle = trimmedName || trimmedPromptForTitle;

      if (!targetProjectId) {
        const newProj = useProjectStore.getState().createProject('video', taskTitle, trimmed.slice(0, 100), {
          style: style || 'cinematic',
          resolution: `${dims[aspectRatio].w}x${dims[aspectRatio].h}`,
          aspectRatio,
          fps: 24,
        });
        targetProjectId = newProj.id;
      }

      initProject(targetProjectId, [], {
        aspectRatio,
        resolution: `${dims[aspectRatio].w}x${dims[aspectRatio].h}`,
        fps: 24,
        shotDurationSeconds: shotDuration,
        videoTier: 'value',
        imageTier: 'value',
        ttsTier: 'free',
        hardcodeSubtitles: false,
        bgmStyle: style || 'cinematic',
      }, taskTitle);

      // 切到主面板并激活对应项目,不再切空
      useVideoStore.getState().setPipelineOptions(targetProjectId, {
        ...options,
        characterAnchorLimit: characterLimit,
      });
      useVideoStore.getState().setSceneSpec(targetProjectId, sceneSpec);

      useProjectStore.getState().setActiveProject(targetProjectId);
      useVideoStore.getState().setActivePipelineId(targetProjectId);
      onClose();

      const finalOptions: PipelineOptions = {
        ...options,
        characterAnchorLimit: characterLimit,
      };

      // 注:走 targetProjectId 的 store 流程
      const result = await runPipeline({
        novelProjectId: targetProjectId,
        spec: sceneSpec,
        options: finalOptions,
        videoGen: {
          spec: {
            resolution: `${dims[aspectRatio].w}x${dims[aspectRatio].h}`,
            fps: 24,
            videoTier: 'value',
          },
          endpointId: activeVideoEndpoint.id,
          imageEndpointId: activeImageEndpoint?.id,
          sceneSource: 'direct',
          sourceMode: mode,
        },
      });

      // 把生成的 clip 转入 directClips
      if (result?.clips.length) {
        for (const clip of result.clips) {
          addDirectClip({
            ...clip,
            sceneSource: 'direct',
            sourceMode: mode,
            directProjectId: targetProjectId,
          });
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
          directProjectId: targetProjectId,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logger.error(`[direct] handleGenerate FAIL: ${msg}`, 'modal');
      setDirectError(msg);
    } finally {
      setDirectGenerating(false);
      setTaskName('');
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
      const plan = await planVideoPrompt({
        shot: { sourceText: trimmed, videoPrompt: trimmed },
        style,
        requestedAspectRatio: aspectRatio,
        durationSeconds: shotDuration,
        endpointId: activeVideoEndpoint?.id,
      });
      if (plan.prompt.trim()) setPrompt(plan.prompt);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setOptimizing(false);
    }
  };

  const showAdvanced = mode !== 'pure';

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
      styles={{ body: { maxHeight: '75vh', overflowY: 'auto', paddingRight: 8 } }}
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
              {t('video.direct.taskNameLabel')}
              <Tooltip title={t('video.direct.taskNameHint')}>
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  ({t('video.direct.taskNameHint')})
                </Text>
              </Tooltip>
            </span>
          }
        >
          <Input
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder={t('video.direct.taskNamePlaceholder')}
            disabled={generating}
            maxLength={60}
            allowClear
          />
        </Form.Item>

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
            placeholder={t('video.direct.promptHint')}
            disabled={generating}
            maxLength={2000}
            showCount
          />
        </Form.Item>

        {/* 画面风格与画质预设 */}
        <Form.Item label={t('video.style')} style={{ marginBottom: 12 }}>
          <Select
            placeholder={t('video.direct.stylePlaceholder')}
            value={style}
            allowClear
            onChange={(styleId) => setStyle(styleId)}
            options={VISUAL_STYLE_PRESETS.map((preset) => ({
              value: preset.id,
              label: preset.name,
            }))}
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
        <div style={{ marginBottom: 12 }}>
          <PipelinePreflightAlert result={directPreflight} />
        </div>

        {/* Aspect/Duration */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 8 }}>
          <Form.Item label={t('video.direct.aspectRatio')} style={{ marginBottom: 0 }}>
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
          <Form.Item label={t('video.direct.duration')} style={{ marginBottom: 0 }}>
            <Select
              value={shotDuration}
              onChange={(v) => setShotDuration(v)}
              disabled={generating}
              style={{ width: '100%' }}
              options={[
                { value: 5, label: t('video.direct.seconds', { n: 5 }) },
                { value: 10, label: t('video.direct.seconds', { n: 10 }) },
                { value: 15, label: '15 秒 (长镜头)' },
              ]}
            />
          </Form.Item>
          <Form.Item label="成片目标总时长" style={{ marginBottom: 0 }}>
            <Select
              defaultValue={15}
              disabled={generating}
              style={{ width: '100%' }}
              options={[
                { value: 5, label: '5 秒 (单镜头精特写)' },
                { value: 15, label: '15 秒 (3镜头连贯短片)' },
                { value: 30, label: '30 秒 (6镜头宣传短片)' },
                { value: 60, label: '60 秒 (12镜头连续剧)' },
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
              disabled={!hasVideoProvider || !prompt.trim() || !directPreflight.ok}
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
          {/* 按 directProjectId 分组展示,让用户清楚哪个产物属于哪次任务。
              之前是扁平列表,多次任务的产物混在一起。
              每组顶部带「查看执行过程」按钮,跳到对应 pipeline tab。 */}
          {(() => {
            const groups = new Map<string, typeof directClips>();
            for (const clip of directClips) {
              const key = clip.directProjectId ?? '_legacy';
              const arr = groups.get(key) ?? [];
              arr.push(clip);
              groups.set(key, arr);
            }
            const entries = Array.from(groups.entries()).sort(([a], [b]) => b.localeCompare(a));
            return entries.map(([pid, clips]) => {
              const isLegacy = pid === '_legacy';
              const ts = isLegacy ? NaN : Number(pid.replace(/^direct_/, ''));
              const timeLabel = Number.isFinite(ts)
                ? new Date(ts).toLocaleString()
                : t('video.direct.history');
              return (
                <div
                  key={pid}
                  style={{
                    marginBottom: 16,
                    border: '1px solid var(--border-secondary, #d9d9d9)',
                    borderRadius: 8,
                    padding: 8,
                  }}
                >
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}>
                    <Text strong style={{ fontSize: 12 }}>
                      {timeLabel} · {clips.length} 个产物
                    </Text>
                    {!isLegacy && (
                      <Button
                        size="small"
                        type="link"
                        icon={<EyeOutlined />}
                        onClick={() => {
                          setActivePipelineId(pid);
                          onClose();
                        }}
                      >
                        {t('video.pipeline.viewExecution')}
                      </Button>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                    {clips.map((clip) => (
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
              );
            });
          })()}
        </div>
      )}
    </Modal>
  );
};

export default DirectVideoModal;

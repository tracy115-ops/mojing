// StageInputEditor — 单步重跑的输入参数编辑器
//
// 根据 STAGE_INPUT_FIELDS[stage] 渲染表单,用户改值 → setStageInput 写入 store。
// 重跑按钮调 runSingleStage / runFromStage。

import React, { useState, useEffect, useRef } from 'react';
import { Typography, Input, InputNumber, Button, Space, Popconfirm, Alert, message, Radio } from 'antd';
import { ReloadOutlined, ForwardOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStore } from '@/stores/videoStore';
import { STAGE_INPUT_FIELDS, VIDEO_PIPELINE_STAGES } from '@/types/video';
import type { VideoStage, StageInput, VideoProjectState } from '@/types/video';
import { runSingleStage, runFromStage } from '@/services/video/core/pipeline-runner';
import { populateStageInput } from '@/services/video/core/stage-handlers';

const { Text } = Typography;

interface StageInputEditorProps {
  stage: VideoStage;
  project: VideoProjectState;
}

/** 该 stage 的前置依赖(跑这步前必须已完成的 stage)。
 *  只列真正必要的上游,严格白名单,避免误报。 */
function getStageDeps(stage: VideoStage): VideoStage[] {
  switch (stage) {
    case 'character_anchor':
      return []; // 第一个 runtime stage,无前置依赖
    case 'voice_assignment':
      return ['character_anchor'];
    case 'scene_image':
      return []; // 独立分支,和 character_anchor 并行
    case 'tts':
      return ['voice_assignment'];
    case 'keyframe_image':
      return ['character_anchor', 'scene_image'];
    case 'video_generation':
      return ['keyframe_image'];
    case 'audio_merge':
      return ['video_generation', 'tts'];
    case 'composing':
      return ['audio_merge'];
    default:
      return [];
  }
}

/** 该 stage 之后的所有 runtime stage(用于「重跑及后续」提示 N 步)。 */
function getDownstreamCount(stage: VideoStage): number {
  const order = ['character_anchor', 'voice_assignment', 'scene_image', 'tts', 'keyframe_image', 'video_generation', 'audio_merge', 'composing'] as const;
  const idx = order.indexOf(stage as typeof order[number]);
  if (idx < 0) return 0;
  return order.length - idx - 1;
}

const StageInputEditor: React.FC<StageInputEditorProps> = ({ stage, project }) => {
  const { t } = useTranslation();
  const setStageInput = useVideoStore((s) => s.setStageInput);
  const fields = STAGE_INPUT_FIELDS[stage] ?? [];
  const stageState = project.stages[stage];
  const input = stageState?.input ?? {};
  const isRunning = stageState?.status === 'running';
  const [rerunning, setRerunning] = useState(false);

  // 懒回填:对已经跑过的 stage,如果 input 字段为空(老项目或回填前未触发),
  // 主动调 populateStageInput 把实际值塞进去,让 UI 显示真实参数。
  const backfillRan = useRef(false);
  useEffect(() => {
    if (backfillRan.current) return;
    if (!project.sceneSpec) return;
    if (fields.length === 0) return;
    const status = project.stages[stage]?.status;
    if (status !== 'completed' && status !== 'error') return;
    const hasAny = fields.some((f) => input[f.key] !== undefined && input[f.key] !== '');
    if (hasAny) return;
    backfillRan.current = true;
    populateStageInput(project.novelProjectId, stage, project.sceneSpec);
  }, [project, stage, fields, input]);

  // 检查依赖是否满足。
  // 防御性过滤:deps 里不应该出现 stage 自己或后面的 stage(配置错误时兜底)。
  const order = ['character_anchor', 'voice_assignment', 'scene_image', 'tts', 'keyframe_image', 'video_generation', 'audio_merge', 'composing'] as const;
  const stageIdx = order.indexOf(stage as typeof order[number]);
  const deps = getStageDeps(stage).filter((dep) => {
    const depIdx = order.indexOf(dep as typeof order[number]);
    return depIdx >= 0 && depIdx < stageIdx;
  });
  const missingDeps = deps.filter((dep) => {
    const ds = project.stages[dep];
    return !ds || (ds.status !== 'completed' && ds.status !== 'skipped');
  });
  const depMissing = missingDeps.length > 0;

  const downstreamCount = getDownstreamCount(stage);

  const handleRerunSingle = async () => {
    if (rerunning || depMissing) return;
    setRerunning(true);
    try {
      const ok = await runSingleStage(project.novelProjectId, stage);
      if (ok) {
        message.success(t('video.pipeline.rerunDone'));
      } else {
        message.error(t('video.pipeline.rerunFailed'));
      }
    } finally {
      setRerunning(false);
    }
  };

  const handleRerunFrom = async () => {
    if (rerunning || depMissing) return;
    setRerunning(true);
    try {
      const ok = await runFromStage(project.novelProjectId, stage);
      if (ok) {
        message.success(t('video.pipeline.rerunDone'));
      } else {
        message.warning(t('video.pipeline.rerunPartialFail'));
      }
    } finally {
      setRerunning(false);
    }
  };

  if (fields.length === 0) {
    // 该 stage 没有可编辑字段,但还能纯重跑(用现有参数)
    return (
      <div style={{ marginTop: 8 }}>
        {depMissing && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8, fontSize: 12 }}
            message={t('video.pipeline.depMissing', {
              stage: missingDeps.map((d) => t(`video.gen.stage.${d}`)).join(', '),
            })}
          />
        )}
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={rerunning}
            disabled={isRunning || depMissing}
            onClick={handleRerunSingle}
          >
            {t('video.pipeline.rerunSingle')}
          </Button>
          {downstreamCount > 0 && (
            <Popconfirm
              title={t('video.pipeline.rerunConfirm', { n: downstreamCount + 1 })}
              onConfirm={handleRerunFrom}
              disabled={isRunning || depMissing}
            >
              <Button
                size="small"
                icon={<ForwardOutlined />}
                loading={rerunning}
                disabled={isRunning || depMissing}
              >
                {t('video.pipeline.rerunFromHere')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <Text type="secondary" style={{ fontSize: 11, fontWeight: 600 }}>
        {t('video.pipeline.inputSection')}
      </Text>
      <div style={{
        marginTop: 6,
        padding: 8,
        background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
        borderRadius: 4,
        border: '1px solid var(--border-secondary)',
      }}>
        {stage === 'character_anchor' && (
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 6, fontWeight: 600 }}>
              👤 独立角色生成控制面板 (共 {project.sceneSpec?.characters?.length ?? 0} 个独立实体):
            </Text>
            {(project.sceneSpec?.characters ?? []).map((char) => {
              const charPrompts = (input as any)?.characterPrompts || {};
              const currentPrompt = charPrompts[char.id] ?? char.appearance;
              return (
                <div
                  key={char.id}
                  style={{
                    padding: 8,
                    marginBottom: 6,
                    background: 'var(--bg-primary, #fff)',
                    borderRadius: 4,
                    border: '1px solid var(--border-secondary)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text strong style={{ fontSize: 12, color: '#1890ff' }}>
                      👤 角色: {char.name}
                    </Text>
                  </div>
                  <Input.TextArea
                    rows={2}
                    size="small"
                    value={currentPrompt}
                    placeholder={`输入 ${char.name} 的独立专属外观 Prompt...`}
                    onChange={(e) => {
                      const updatedPrompts = { ...charPrompts, [char.id]: e.target.value };
                      setStageInput(project.novelProjectId, stage, { characterPrompts: updatedPrompts } as any);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
        {stage === 'composing' && (
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
              🎼 BGM 背景音乐氛围挂载:
            </Text>
            <Radio.Group
              defaultValue="epic"
              size="small"
              onChange={(e) => setStageInput(project.novelProjectId, stage, { bgmStyle: e.target.value } as any)}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
            >
              <Radio.Button value="none">无 BGM</Radio.Button>
              <Radio.Button value="epic">🎻 史诗交响</Radio.Button>
              <Radio.Button value="piano">🎹 治愈钢琴</Radio.Button>
              <Radio.Button value="cyber">⚡ 赛博朋克</Radio.Button>
              <Radio.Button value="oriental">🏮 华风古韵</Radio.Button>
            </Radio.Group>
          </div>
        )}
        {fields.map((f) => {
          const value = input[f.key];
          const label = t(f.label);
          const readOnly = !!f.readOnly;
          const disabled = isRunning || rerunning || readOnly;
          return (
            <div key={f.key} style={{ marginBottom: 6 }}>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                {label}{readOnly && <Text type="secondary" style={{ fontSize: 10, marginLeft: 4 }}>(只读)</Text>}
              </Text>
              {f.type === 'textarea' ? (
                <Input.TextArea
                  value={value ?? ''}
                  onChange={(e) => setStageInput(project.novelProjectId, stage, { [f.key]: e.target.value } as Partial<StageInput>)}
                  rows={2}
                  disabled={disabled}
                  readOnly={readOnly}
                  placeholder={f.placeholder}
                />
              ) : f.type === 'number' ? (
                <InputNumber
                  value={typeof value === 'number' ? value : undefined}
                  onChange={(v) => setStageInput(project.novelProjectId, stage, { [f.key]: v ?? undefined } as Partial<StageInput>)}
                  disabled={disabled}
                  readOnly={readOnly}
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  style={{ width: '100%' }}
                  placeholder={f.placeholder}
                />
              ) : f.type === 'radio' ? (
                <Radio.Group
                  value={typeof value === 'string' ? value : (f.options?.[0]?.value ?? '')}
                  onChange={(e) => setStageInput(project.novelProjectId, stage, { [f.key]: e.target.value } as Partial<StageInput>)}
                  disabled={disabled}
                  size="small"
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
                >
                  {(f.options ?? []).map((opt) => (
                    <Radio.Button key={opt.value} value={opt.value} style={{ fontSize: 11 }}>
                      {t(opt.labelKey)}
                    </Radio.Button>
                  ))}
                </Radio.Group>
              ) : (
                <Input
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) => setStageInput(project.novelProjectId, stage, { [f.key]: e.target.value } as Partial<StageInput>)}
                  disabled={disabled}
                  readOnly={readOnly}
                  placeholder={f.placeholder}
                />
              )}
            </div>
          );
        })}
      </div>

      {depMissing && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8, fontSize: 12 }}
          message={t('video.pipeline.depMissing', {
            stage: missingDeps.map((d) => t(`video.gen.stage.${d}`)).join(', '),
          })}
        />
      )}

      <Space style={{ marginTop: 8 }}>
        <Button
          size="small"
          type="primary"
          icon={<ReloadOutlined />}
          loading={rerunning}
          disabled={isRunning || depMissing}
          onClick={handleRerunSingle}
        >
          {t('video.pipeline.rerunSingle')}
        </Button>
        {downstreamCount > 0 && (
          <Popconfirm
            title={t('video.pipeline.rerunConfirm', { n: downstreamCount + 1 })}
            onConfirm={handleRerunFrom}
            disabled={isRunning || depMissing}
          >
            <Button
              size="small"
              icon={<ForwardOutlined />}
              loading={rerunning}
              disabled={isRunning || depMissing}
            >
              {t('video.pipeline.rerunFromHere')}
            </Button>
          </Popconfirm>
        )}
      </Space>
    </div>
  );
};

export default StageInputEditor;

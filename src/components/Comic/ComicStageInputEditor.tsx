// ComicStageInputEditor — 漫画单步重跑的输入参数编辑器
//
// 平行 video/StageInputEditor:
//   - 根据 COMIC_STAGE_INPUT_FIELDS[stage] 渲染表单(textarea/number/radio/text)
//   - 改值 → comicStore.setStageInput
//   - 「仅此步」runSingleStage / 「重跑及后续」runFromStage
//   - 依赖检查:character_anchor 无前置;panel_script 无前置;panel_image 依赖 panel_script

import React, { useState } from 'react';
import { Typography, Input, InputNumber, Button, Space, Popconfirm, Alert, message, Radio } from 'antd';
import { ReloadOutlined, ForwardOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useComicStore } from '@/stores/comicStore';
import { COMIC_STAGE_INPUT_FIELDS, COMIC_PIPELINE_STAGES } from '@/types/comic';
import type { ComicTrackedStage, ComicStageInput, ComicPipelineProject } from '@/types/comic';
import { runSingleStage, runFromStage } from '@/services/comic/core/pipeline-runner';
import { getStageInputDefaults } from '@/services/comic/core/stage-handlers';

const { Text } = Typography;

interface ComicStageInputEditorProps {
  stage: ComicTrackedStage;
  project: ComicPipelineProject;
}

function getStageDeps(stage: ComicTrackedStage): ComicTrackedStage[] {
  switch (stage) {
    case 'character_anchor':
      return [];
    case 'panel_script':
      return [];
    case 'panel_image':
      return ['panel_script'];
    default:
      return [];
  }
}

function getDownstreamCount(stage: ComicTrackedStage): number {
  const idx = COMIC_PIPELINE_STAGES.indexOf(stage);
  if (idx < 0) return 0;
  return COMIC_PIPELINE_STAGES.length - idx - 1;
}

const ComicStageInputEditor: React.FC<ComicStageInputEditorProps> = ({ stage, project }) => {
  const { t } = useTranslation();
  const setStageInput = useComicStore((s) => s.setStageInput);
  const fields = COMIC_STAGE_INPUT_FIELDS[stage] ?? [];
  const stageState = project.stages[stage];
  const input = stageState?.input;
  const defaults = getStageInputDefaults(stage, {
    workingSpec: project.spec,
    sourceText: project.sourceText ?? '',
    panelCount: project.panelCount,
    style: project.spec.meta.style ?? project.style,
  });
  const isRunning = stageState?.status === 'running';
  const [rerunning, setRerunning] = useState(false);

  // 依赖检查
  const stageIdx = COMIC_PIPELINE_STAGES.indexOf(stage);
  const deps = getStageDeps(stage).filter((dep) => {
    const depIdx = COMIC_PIPELINE_STAGES.indexOf(dep);
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
      const ok = await runSingleStage(project.id, stage);
      if (ok) message.success(t('comic.pipeline.rerunSingleDone'));
      else message.error(t('comic.pipeline.rerunFailed'));
    } finally {
      setRerunning(false);
    }
  };

  const handleRerunFrom = async () => {
    if (rerunning || depMissing) return;
    setRerunning(true);
    try {
      const ok = await runFromStage(project.id, stage);
      if (ok) message.success(t('comic.pipeline.rerunFromDone'));
      else message.error(t('comic.pipeline.rerunFailed'));
    } finally {
      setRerunning(false);
    }
  };

  if (fields.length === 0) {
    return (
      <div style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {t('comic.pipeline.noInputs')}
        </Text>
        {depMissing && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8, fontSize: 12 }}
            message={t('comic.pipeline.depMissing', {
              stage: missingDeps.map((d) => t(`comic.pipeline.${d}`)).join(', '),
            })}
          />
        )}
        <Space style={{ marginTop: 8 }}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={rerunning}
            disabled={isRunning || depMissing}
            onClick={handleRerunSingle}
          >
            {t('comic.pipeline.rerunSingle')}
          </Button>
          {downstreamCount > 0 && (
            <Popconfirm
              title={t('comic.pipeline.rerunConfirm', { n: downstreamCount + 1 })}
              onConfirm={handleRerunFrom}
              disabled={isRunning || depMissing}
            >
              <Button
                size="small"
                icon={<ForwardOutlined />}
                loading={rerunning}
                disabled={isRunning || depMissing}
              >
                {t('comic.pipeline.rerunFromHere')}
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
        {t('comic.pipeline.inputSection')}
      </Text>
      <div
        style={{
          marginTop: 6,
          padding: 8,
          background: 'var(--bg-secondary, rgba(0,0,0,0.02))',
          borderRadius: 4,
          border: '1px solid var(--border-secondary)',
        }}
      >
        {fields.map((f) => {
          const value = input?.[f.key] ?? defaults[f.key];
          const label = t(f.label);
          const readOnly = !!f.readOnly;
          const disabled = isRunning || rerunning || readOnly;
          return (
            <div key={f.key} style={{ marginBottom: 6 }}>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 2 }}>
                {label}
                {readOnly && (
                  <Text type="secondary" style={{ fontSize: 10, marginLeft: 4 }}>
                    ({t('comic.pipeline.readonly')})
                  </Text>
                )}
              </Text>
              {f.type === 'textarea' ? (
                <Input.TextArea
                  aria-label={label}
                  value={value ?? ''}
                  onChange={(e) =>
                    setStageInput(project.id, stage, {
                      [f.key]: e.target.value,
                    } as Partial<ComicStageInput>)
                  }
                  rows={3}
                  disabled={disabled}
                  readOnly={readOnly}
                  placeholder={f.placeholder}
                />
              ) : f.type === 'number' ? (
                <InputNumber
                  aria-label={label}
                  value={typeof value === 'number' ? value : undefined}
                  onChange={(v) =>
                    setStageInput(project.id, stage, {
                      [f.key]: v ?? undefined,
                    } as Partial<ComicStageInput>)
                  }
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
                  aria-label={label}
                  value={typeof value === 'string' ? value : (f.options?.[0]?.value ?? '')}
                  onChange={(e) =>
                    setStageInput(project.id, stage, {
                      [f.key]: e.target.value,
                    } as Partial<ComicStageInput>)
                  }
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
                  aria-label={label}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(e) =>
                    setStageInput(project.id, stage, {
                      [f.key]: e.target.value,
                    } as Partial<ComicStageInput>)
                  }
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
          message={t('comic.pipeline.depMissing', {
            stage: missingDeps.map((d) => t(`comic.pipeline.${d}`)).join(', '),
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
          {t('comic.pipeline.rerunSingle')}
        </Button>
        {downstreamCount > 0 && (
          <Popconfirm
            title={t('comic.pipeline.rerunConfirm', { n: downstreamCount + 1 })}
            onConfirm={handleRerunFrom}
            disabled={isRunning || depMissing}
          >
            <Button
              size="small"
              icon={<ForwardOutlined />}
              loading={rerunning}
              disabled={isRunning || depMissing}
            >
              {t('comic.pipeline.rerunFromHere')}
            </Button>
          </Popconfirm>
        )}
      </Space>
    </div>
  );
};

export default ComicStageInputEditor;

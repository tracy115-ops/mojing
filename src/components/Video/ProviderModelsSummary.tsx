// ============================================================================
// ProviderModelsSummary — 只读展示当前设置页配置的主 provider + 任务模型
// ----------------------------------------------------------------------------
// 方案 A:Modal 不再有 provider/model selector。用户想换 provider/model,去设置页改。
// 这里显示"本次执行将使用什么",让用户在启动前确认配置正确。
// ============================================================================

import React from 'react';
import { Card, Tag, Typography } from 'antd';
import { useTranslation } from '@/i18n';
import { useProviderStore } from '@/stores/providerStore';

const { Text } = Typography;

interface Props {
  /** 显示哪些类别。默认全部 (video/image/llm)。 */
  categories?: ('video' | 'image' | 'llm')[];
  /** 模型字段名(默认从每类的核心任务读) */
  modelFields?: { video?: string; image?: string; llm?: string };
}

const DEFAULT_MODEL_FIELDS = {
  video: 'clip',
  image: 'scene',
  llm: 'defaultModel',
};

const ProviderModelsSummary: React.FC<Props> = ({
  categories = ['video', 'image', 'llm'],
  modelFields = DEFAULT_MODEL_FIELDS,
}) => {
  const { t } = useTranslation();

  const videoEndpoint = useProviderStore((s) => s.getActiveEndpoint('video'));
  const videoModel = useProviderStore((s) => {
    const field = modelFields.video ?? 'clip';
    return ((s.config.video.models as Record<string, string>)[field]) || s.config.video.defaultModel || '';
  });
  const imageEndpoint = useProviderStore((s) => s.getActiveEndpoint('image'));
  const imageModel = useProviderStore((s) => {
    const field = modelFields.image ?? 'scene';
    return ((s.config.image.models as Record<string, string>)[field]) || s.config.image.defaultModel || '';
  });
  const llmEndpoint = useProviderStore((s) => s.getActiveEndpoint('llm'));
  const llmModel = useProviderStore((s) => {
    const field = modelFields.llm ?? 'defaultModel';
    if (field === 'defaultModel') return s.config.llm.defaultModel || '';
    return ((s.config.llm.models as Record<string, string>)[field]) || s.config.llm.defaultModel || '';
  });

  const rows: { cat: 'video' | 'image' | 'llm'; endpoint?: ReturnType<typeof useProviderStore.getState>['endpoints'][number]; model: string }[] = [];
  if (categories.includes('video')) rows.push({ cat: 'video', endpoint: videoEndpoint, model: videoModel });
  if (categories.includes('image')) rows.push({ cat: 'image', endpoint: imageEndpoint, model: imageModel });
  if (categories.includes('llm')) rows.push({ cat: 'llm', endpoint: llmEndpoint, model: llmModel });

  const labelKey: Record<'video' | 'image' | 'llm', string> = {
    video: 'video.gen.summaryVideo',
    image: 'video.gen.summaryImage',
    llm: 'video.gen.summaryLLM',
  };

  return (
    <Card
      size="small"
      style={{ background: 'var(--bg-secondary, rgba(0,0,0,0.02))' }}
      bodyStyle={{ padding: '8px 12px' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map((r) => {
          const epName = r.endpoint?.name;
          const epProvider = r.endpoint?.provider;
          return (
            <div
              key={r.cat}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
            >
              <Text type="secondary" style={{ flexShrink: 0, width: 60 }}>
                {t(labelKey[r.cat])}:
              </Text>
              {epName ? (
                <>
                  <Tag color="blue" style={{ fontSize: 10 }}>
                    {t(`provider.provider.${epProvider}` as const, { defaultValue: String(epProvider) })}
                  </Tag>
                  <Text style={{ fontSize: 12 }}>{epName}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>·</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {r.model || t('video.gen.summaryModelDefault')}
                  </Text>
                </>
              ) : (
                <Text type="danger" style={{ fontSize: 11 }}>
                  {t('video.gen.summaryNoProvider')}
                </Text>
              )}
            </div>
          );
        })}
        <Text type="secondary" style={{ fontSize: 10, marginTop: 2 }}>
          {t('video.gen.summaryHint')}
        </Text>
      </div>
    </Card>
  );
};

export default ProviderModelsSummary;

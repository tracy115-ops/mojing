import React from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { PictureOutlined, SettingOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import type {
  PipelinePreflightIssue,
  PipelinePreflightResult,
  ProviderPreflightCategory,
} from '@/services/video/core/pipeline-preflight-rules';

const { Text } = Typography;

interface PipelinePreflightAlertProps {
  result: PipelinePreflightResult;
  additionalBlocking?: string[];
  additionalWarnings?: string[];
  showSettingsButton?: boolean;
  onOpenShots?: () => void;
}

const CATEGORIES: ProviderPreflightCategory[] = ['llm', 'image', 'video', 'tts'];

const PipelinePreflightAlert: React.FC<PipelinePreflightAlertProps> = ({
  result,
  additionalBlocking = [],
  additionalWarnings = [],
  showSettingsButton = true,
  onOpenShots,
}) => {
  const { t } = useTranslation();
  const blocking = [...additionalBlocking, ...result.blocking.map((issue) => formatPipelinePreflightIssue(issue, t))];
  const warnings = [...additionalWarnings, ...result.warnings.map((issue) => formatPipelinePreflightIssue(issue, t))];
  const hasIssues = blocking.length > 0 || warnings.length > 0;
  const requiresShotReference = result.blocking.some((issue) => issue.code === 'multi-subject-reference-unsupported');

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 8,
      }}>
        {CATEGORIES.map((category) => {
          const provider = result.providers[category];
          const required = result.requiredCategories.includes(category);
          return (
            <div
              key={category}
              style={{
                minWidth: 0,
                padding: '8px 10px',
                border: '1px solid var(--border-secondary)',
                borderRadius: 6,
                background: 'var(--bg-tertiary)',
                opacity: required ? 1 : 0.62,
              }}
            >
              <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                {t(`video.preflight.category.${category}`)}{required ? '' : ` · ${t('video.preflight.notRequired')}`}
              </Text>
              <Text strong ellipsis style={{ display: 'block', marginTop: 2 }}>
                {provider?.provider && provider.model
                  ? `${provider.provider} / ${provider.model}`
                  : provider?.endpointName || t('video.preflight.unconfigured')}
              </Text>
            </div>
          );
        })}
      </div>

      {blocking.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={t('video.preflight.blocked')}
          description={<IssueList items={blocking} />}
          action={requiresShotReference && onOpenShots
            ? (
              <Button size="small" icon={<PictureOutlined />} onClick={onOpenShots}>
                {t('video.preflight.openShots')}
              </Button>
            )
            : showSettingsButton
              ? (
                <Button size="small" icon={<SettingOutlined />} onClick={openSettings}>
                  {t('video.preflight.openSettings')}
                </Button>
              )
              : undefined}
        />
      )}
      {warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('video.preflight.review')}
          description={<IssueList items={warnings} />}
        />
      )}
      {!hasIssues && (
        <Alert type="success" showIcon message={t('video.preflight.ready')} />
      )}
    </Space>
  );
};

const IssueList: React.FC<{ items: string[] }> = ({ items }) => (
  <ul style={{ margin: 0, paddingLeft: 18 }}>
    {items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
  </ul>
);

export function formatPipelinePreflightIssue(
  issue: PipelinePreflightIssue,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const provider = issue.provider || t('video.preflight.unknownProvider');
  const model = issue.model || t('video.preflight.unknownModel');
  const endpoint = issue.endpointName || issue.endpointId;
  switch (issue.code) {
    case 'missing-endpoint':
      return t('video.preflight.missingEndpoint', {
        category: t(`video.preflight.category.${issue.category}`),
        endpoint: endpoint || t('video.preflight.activeEndpoint'),
      });
    case 'adapter-unavailable':
      return t('video.preflight.adapterUnavailable', { category: t(`video.preflight.category.${issue.category}`), provider, model });
    case 'invalid-model':
      return t('video.preflight.invalidModel', { category: t(`video.preflight.category.${issue.category}`), provider, model, detail: issue.detail || '' });
    case 'i2v-first-frame-unsupported':
      return t('video.preflight.i2vFirstFrameUnsupported', { provider, model });
    case 'reference-unsupported':
      return issue.detail === 'character-reference'
        ? t('video.preflight.characterReferenceUnsupported', { provider, model })
        : t('video.preflight.referenceUnsupported', { provider, model });
    case 'multi-subject-reference-unsupported':
      return t('video.preflight.multiSubjectReferenceUnsupported', { provider, model });
    case 'reference-mode-unavailable':
      return issue.detail === 't2v-selected'
        ? t('video.preflight.t2vSelected', { provider, model })
        : t('video.preflight.referenceModeUnavailable', { provider, model });
    case 'visual-review-unavailable':
      return t('video.preflight.visualReviewUnavailable', { provider, model });
    default:
      return `${provider} / ${model}`;
  }
}

function openSettings(): void {
  window.dispatchEvent(new CustomEvent('mojing:open-settings'));
}

export default PipelinePreflightAlert;

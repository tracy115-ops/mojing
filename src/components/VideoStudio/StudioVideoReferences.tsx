import { Alert, Button, Select, Space, Switch, Typography, Upload, message } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';
import { useVideoStudioStore } from '@/stores/videoStudioStore';
import { importStudioFile } from '@/services/video-studio/generation';
import type { StudioGenerationInput } from '@/types/video-studio';
import type { VideoGenerationCapabilities } from '@/types/providers';
import StudioLinkImport from './StudioLinkImport';
import { StudioReferenceUpload } from './StudioUploadModal';
import { modelReadableMediaUrl } from '@/services/video-studio/upload-contract';

export default function StudioVideoReferences({ input, capabilities, onChange }: { input: Partial<StudioGenerationInput>; capabilities: VideoGenerationCapabilities; onChange: (patch: Partial<StudioGenerationInput>) => void }) {
  const { t } = useTranslation(), assets = useVideoStudioStore((state) => state.assets);
  return <div className="studio-video-references video-studio-fields" data-testid="studio-video-references">
    {(['audio', 'video'] as const).map((kind) => {
      const key = kind === 'audio' ? 'audioReferenceAssetIds' : 'videoReferenceAssetIds', rule = capabilities.references[kind], ids = input[key] ?? [];
      if (!rule?.maxCount && !ids.length) return null;
      const select = (next: string[]) => {
        if (next.length > (rule?.maxCount ?? 0)) { message.warning(t('studio.media.limit', { count: rule?.maxCount ?? 0 })); return; }
        onChange({ [key]: next, controlMode: 'reference', firstFrameAssetId: undefined, lastFrameAssetId: undefined });
      };
      return <div className="span-all studio-media-field" key={kind}>
        <Typography.Text strong>{t(`studio.media.${kind}References`)}</Typography.Text>
        {rule?.maxCount ? <>
          <Select mode="multiple" allowClear aria-label={t(`studio.media.${kind}References`)} placeholder={t(`studio.media.${kind}References`)} maxTagCount={2} value={ids} onChange={select} options={assets.filter((asset) => asset.kind === kind).map((asset) => ({ value: asset.id, label: `${asset.name}${asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(1)}s` : ''}`, disabled: !ids.includes(asset.id) && rule.transport === 'public_url' && !modelReadableMediaUrl(asset, capabilities.provider) }))} />
          <Typography.Text type="secondary">{t('studio.media.rules', { count: rule.maxCount, min: rule.minSeconds, max: rule.maxTotalSeconds })}{rule.transport === 'public_url' ? ` ${t('studio.media.urlRequired')}` : ''}</Typography.Text>
          <Space wrap><StudioLinkImport kind={kind} onImport={(asset) => select([...ids, asset.id])} />{rule.transport === 'public_url' ? <StudioReferenceUpload kind={kind} onUploaded={asset => select([...new Set([...ids, asset.id])])} /> : <Upload accept={rule.mimeTypes.join(',')} showUploadList={false} beforeUpload={(file) => { void importStudioFile(file).then((asset) => select([...ids, asset.id])).catch((error) => message.error(String(error))); return false; }}><Button size="small" icon={<UploadOutlined />}>{t('studio.asset.upload')}</Button></Upload>}</Space>
        </> : <Alert type="warning" message={t('studio.media.unsupported')} action={<Button size="small" onClick={() => onChange({ [key]: [] })}>{t('studio.media.clear')}</Button>} />}
      </div>;
    })}
    {capabilities.references.audioRequiresVisual && (input.audioReferenceAssetIds?.length ?? 0) > 0 && <Typography.Text type="secondary" className="span-all">{t('studio.media.audioNeedsVisual')}</Typography.Text>}
    {capabilities.parameters.some((spec) => spec.key === 'generateAudio') && <label className="span-all studio-media-audio-switch">{t('studio.media.generateAudio')}<Switch checked={input.generateAudio ?? false} onChange={(generateAudio) => onChange({ generateAudio })} /></label>}
  </div>;
}

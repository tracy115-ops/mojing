import { lazy, Suspense, useState } from 'react';
import { Alert, Button, Select, Space, Spin, Tabs, Upload, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useProviderStore, getEndpointCategory, PROVIDER_CATEGORY } from '@/stores/providerStore';
import { downloadStudioFile } from '@/services/video-studio/generation';
import type { ApiEndpoint } from '@/types/providers';

const ProviderSettings = lazy(() => import('@/components/Settings/ProviderSettings'));
const Eagle = lazy(() => import('./StudioEagle'));
const UploadSettings = lazy(() => import('./StudioUploadSettings'));
export default function StudioPlugins() {
  const { t } = useTranslation();
  const store = useProviderStore();
  const [endpointId, setEndpointId] = useState<string>();
  const exportProfile = () => {
    const endpoint = store.getEndpoint(endpointId ?? '');
    if (!endpoint) return;
    const address = new URL(endpoint.baseUrl);
    if (address.username || address.password || address.search || address.hash) { message.error(t('studio.plugin.privateUrl')); return; }
    // Export an explicit allowlist: API keys and custom auth headers never enter shareable profiles.
    const profile = { format: 'mojing.provider-profile/1', name: endpoint.name, provider: endpoint.provider, category: getEndpointCategory(endpoint), baseUrl: endpoint.baseUrl, models: endpoint.models ?? [], generationCapabilities: endpoint.generationCapabilities };
    downloadStudioFile(JSON.stringify(profile, null, 2), `${endpoint.name}.provider.json`);
  };
  const importProfile = async (file: File) => {
    try {
      const profile = JSON.parse(await file.text());
      if (profile.format !== 'mojing.provider-profile/1' || typeof profile.name !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDER_CATEGORY, profile.provider) || !['llm', 'image', 'video', 'tts'].includes(profile.category) || !Array.isArray(profile.models) || profile.models.some((model: unknown) => typeof model !== 'string')) throw new Error(t('studio.plugin.invalid'));
      const parsed = new URL(profile.baseUrl);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search) throw new Error(t('studio.plugin.invalid'));
      store.addEndpoint({ name: profile.name, provider: profile.provider, category: profile.category, baseUrl: profile.baseUrl, models: profile.models, generationCapabilities: profile.generationCapabilities as ApiEndpoint['generationCapabilities'], apiKey: '', enabled: false });
      message.success(t('studio.imported'));
    } catch (error) { message.error(`${t('studio.failed')}: ${String(error)}`); }
  };
  return <div className="video-studio-content" data-testid="studio-plugins"><Tabs items={[{ key: 'models', label: t('studio.plugin.models'), children: <><Alert type="info" showIcon message={t('studio.plugin.profileHint')} /><div className="video-studio-toolbar" style={{ marginTop: 16 }}><Upload accept=".json" showUploadList={false} beforeUpload={(file) => { void importProfile(file); return false; }}><Button>{t('studio.plugin.import')}</Button></Upload><Space><Select aria-label={t('studio.creator.endpoint')} value={endpointId} onChange={setEndpointId} options={store.endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name }))} /><Button disabled={!endpointId} onClick={exportProfile}>{t('studio.plugin.export')}</Button></Space></div><Suspense fallback={<Spin />}><ProviderSettings /></Suspense></> }, { key: 'upload', label: t('studio.upload.settings'), children: <Suspense fallback={<Spin />}><UploadSettings /></Suspense> }, { key: 'eagle', label: t('studio.eagle.title'), children: <Suspense fallback={<Spin />}><Eagle /></Suspense> }]} /></div>;
}

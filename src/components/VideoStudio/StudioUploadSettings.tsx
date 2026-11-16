import { useState } from 'react';
import { Alert, Button, Input, Select, Space, Typography, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useStudioUploadStore } from '@/stores/studioUploadStore';
import { validateS3Config } from '@/services/video-studio/upload-contract';
import './StudioUpload.css';

export default function StudioUploadSettings() {
  const { t } = useTranslation(), store = useStudioUploadStore();
  const [config, setConfig] = useState(store.config), [credentials, setCredentials] = useState(store.credentials);
  return <section className="studio-upload-settings" data-testid="studio-upload-settings">
    <Alert type="info" message={t('studio.upload.settingsHint')} />
    <div className="studio-upload-config-grid">
      {(['endpoint','region','bucket','prefix'] as const).map(key => <label key={key}>{t(`studio.upload.config.${key}`)}<Input aria-label={t(`studio.upload.config.${key}`)} value={config[key]} onChange={event => setConfig({ ...config, [key]: event.target.value })} placeholder={key === 'endpoint' ? 'https://s3.us-east-1.amazonaws.com' : undefined} /></label>)}
      <label>{t('studio.upload.config.style')}<Select aria-label={t('studio.upload.config.style')} value={config.pathStyle ? 'path' : 'host'} onChange={value => setConfig({ ...config, pathStyle: value === 'path' })} options={['path','host'].map(value => ({ value, label: t(`studio.upload.config.${value}`) }))} /></label>
      <label>{t('studio.upload.config.expiry')}<Select aria-label={t('studio.upload.config.expiry')} value={config.urlLifetimeHours} onChange={urlLifetimeHours => setConfig({ ...config, urlLifetimeHours })} options={[1,6,24,72,168].map(value => ({ value, label: t('studio.upload.hours', { count: value }) }))} /></label>
      <label>{t('studio.upload.config.accessKey')}<Input aria-label={t('studio.upload.config.accessKey')} autoComplete="off" value={credentials.accessKeyId} onChange={event => setCredentials({ ...credentials, accessKeyId: event.target.value })} /></label>
      <label>{t('studio.upload.config.secretKey')}<Input.Password aria-label={t('studio.upload.config.secretKey')} autoComplete="new-password" value={credentials.secretAccessKey} onChange={event => setCredentials({ ...credentials, secretAccessKey: event.target.value })} /></label>
      <label className="span-all">{t('studio.upload.config.token')}<Input.Password aria-label={t('studio.upload.config.token')} autoComplete="new-password" value={credentials.sessionToken} onChange={event => setCredentials({ ...credentials, sessionToken: event.target.value })} /></label>
    </div>
    <Typography.Paragraph type="secondary">{t('studio.upload.sessionHint')}</Typography.Paragraph>
    <Space wrap><Button type="primary" data-testid="studio-save-upload-settings" onClick={() => {
      try { const target = validateS3Config(config); if (!credentials.accessKeyId.trim() || !credentials.secretAccessKey) throw new Error(); store.configure(target, { ...credentials, accessKeyId: credentials.accessKeyId.trim() }); message.success(t('studio.saved')); }
      catch { message.error(t('studio.upload.error.config')); }
    }}>{t('studio.upload.saveSettings')}</Button><Button onClick={() => { store.clearCredentials(); setCredentials({ accessKeyId: '', secretAccessKey: '', sessionToken: '' }); }}>{t('studio.upload.clearCredentials')}</Button></Space>
  </section>;
}

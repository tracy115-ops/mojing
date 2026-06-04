import React, { Suspense } from 'react';
import { Card, Tabs, Form, Select, Switch, InputNumber, Input, Button, Divider, Space, message } from 'antd';
import { useTranslation } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AppSettings } from '@/types';

const ProviderSettings = React.lazy(() => import('./ProviderSettings'));

const SettingsPanel: React.FC = () => {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const updateGeneralSettings = useSettingsStore((s) => s.updateGeneralSettings);
  const updateAppearanceSettings = useSettingsStore((s) => s.updateAppearanceSettings);
  const updateCreativeSettings = useSettingsStore((s) => s.updateCreativeSettings);
  const resetSettings = useSettingsStore((s) => s.resetSettings);

  const [messageApi, contextHolder] = message.useMessage();

  const handleReset = async () => {
    await resetSettings();
    messageApi.success(t('message.settingsReset'));
  };

  const tabItems = [
    {
      key: 'general',
      label: t('settings.nav.general'),
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label={t('settings.general.language')}>
            <Select
              value={settings.general.language}
              onChange={(val) => updateGeneralSettings({ language: val })}
              options={[
                { value: 'zh-CN', label: t('settings.general.language.zh-CN') },
                { value: 'en-US', label: t('settings.general.language.en-US') },
              ]}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item label={t('settings.general.autoStart')}>
            <Switch
              checked={settings.general.autoStart}
              onChange={(val) => updateGeneralSettings({ autoStart: val })}
            />
          </Form.Item>
          <Form.Item label={t('settings.general.minimizeToTray')}>
            <Switch
              checked={settings.general.minimizeToTray}
              onChange={(val) => updateGeneralSettings({ minimizeToTray: val })}
            />
          </Form.Item>
          <Form.Item label={t('settings.general.checkUpdates')}>
            <Switch
              checked={settings.general.checkUpdates}
              onChange={(val) => updateGeneralSettings({ checkUpdates: val })}
            />
          </Form.Item>
          <Form.Item label={t('settings.general.closeAction')}>
            <Select
              value={settings.general.closeAction}
              onChange={(val) => updateGeneralSettings({ closeAction: val as AppSettings['general']['closeAction'] })}
              options={[
                { value: 'ask', label: t('settings.general.closeAction.ask') },
                { value: 'tray', label: t('settings.general.closeAction.tray') },
                { value: 'exit', label: t('settings.general.closeAction.exit') },
              ]}
              style={{ width: 200 }}
            />
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'appearance',
      label: t('settings.nav.appearance'),
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label={t('settings.general.theme')}>
            <Select
              value={settings.appearance.theme}
              onChange={(val) => updateAppearanceSettings({ theme: val as AppSettings['appearance']['theme'] })}
              options={[
                { value: 'dark', label: t('settings.general.theme.dark') },
                { value: 'light', label: t('settings.general.theme.light') },
                { value: 'system', label: t('settings.general.theme.system') },
              ]}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item label={t('settings.appearance.colorPrimary')}>
            <Select
              value={settings.appearance.colorPrimary}
              onChange={(val) => updateAppearanceSettings({ colorPrimary: val })}
              options={[
                { value: '#3b82f6', label: t('settings.appearance.color.blue') },
                { value: '#8b5cf6', label: t('settings.appearance.color.purple') },
                { value: '#22c55e', label: t('settings.appearance.color.green') },
                { value: '#f59e0b', label: t('settings.appearance.color.orange') },
                { value: '#ef4444', label: t('settings.appearance.color.red') },
                { value: '#06b6d4', label: t('settings.appearance.color.cyan') },
              ]}
              style={{ width: 200 }}
            />
          </Form.Item>
          <Form.Item label={t('settings.appearance.compactMode')}>
            <Switch
              checked={settings.appearance.compactMode}
              onChange={(val) => updateAppearanceSettings({ compactMode: val })}
            />
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'network',
      label: t('settings.nav.network'),
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label={t('settings.network.enableProxy')}>
            <Switch
              checked={settings.network.proxyEnabled}
              onChange={(val) => updateSettings({ network: { ...settings.network, proxyEnabled: val } })}
            />
          </Form.Item>
          {settings.network.proxyEnabled && (
            <>
              <Form.Item label={t('settings.network.proxyProtocol')}>
                <Select
                  value={settings.network.proxyProtocol}
                  onChange={(val) => updateSettings({ network: { ...settings.network, proxyProtocol: val as AppSettings['network']['proxyProtocol'] } })}
                  options={[
                    { value: 'HTTP', label: 'HTTP' },
                    { value: 'HTTPS', label: 'HTTPS' },
                    { value: 'SOCKS5', label: 'SOCKS5' },
                  ]}
                  style={{ width: 200 }}
                />
              </Form.Item>
              <Form.Item label={t('settings.network.proxyAddress')}>
                <Input
                  value={`${settings.network.proxyHost}:${settings.network.proxyPort}`}
                  onChange={(e) => {
                    const [host, port] = e.target.value.split(':');
                    updateSettings({
                      network: { ...settings.network, proxyHost: host || '', proxyPort: port || '' },
                    });
                  }}
                  placeholder="127.0.0.1:7890"
                  style={{ width: 300 }}
                />
              </Form.Item>
            </>
          )}
        </Form>
      ),
    },
    {
      key: 'creative',
      label: t('settings.nav.creative'),
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label={t('settings.creative.autoSave')}>
            <Switch
              checked={settings.creative.autoSave}
              onChange={(val) => updateCreativeSettings({ autoSave: val })}
            />
          </Form.Item>
          {settings.creative.autoSave && (
            <Form.Item label={t('settings.creative.autoSaveInterval')}>
              <InputNumber
                value={settings.creative.autoSaveIntervalSeconds}
                onChange={(val) => updateCreativeSettings({ autoSaveIntervalSeconds: val ?? 30 })}
                min={5}
                max={300}
                style={{ width: 120 }}
              />
            </Form.Item>
          )}
          <Form.Item label={t('settings.creative.maxConcurrent')}>
            <InputNumber
              value={settings.creative.maxConcurrentGenerations}
              onChange={(val) => updateCreativeSettings({ maxConcurrentGenerations: val ?? 1 })}
              min={1}
              max={5}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item label={t('settings.creative.exportFormat')}>
            <Select
              value={settings.creative.exportFormat}
              onChange={(val) => updateCreativeSettings({ exportFormat: val })}
              options={[
                { value: 'markdown', label: 'Markdown' },
                { value: 'docx', label: 'Word (.docx)' },
                { value: 'pdf', label: 'PDF' },
                { value: 'epub', label: 'EPUB' },
              ]}
              style={{ width: 200 }}
            />
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'providers',
      label: t('settings.nav.providers'),
      children: (
        <Suspense fallback={<div>{t('common.loading')}</div>}>
          <ProviderSettings />
        </Suspense>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      {contextHolder}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--text-primary)' }}>{t('settings.title')}</h2>
        <Button size="small" onClick={handleReset}>
          {t('settings.general.resetDefaults')}
        </Button>
      </div>
      <Card size="small" style={{ background: 'var(--bg-container)', border: '1px solid var(--border-secondary)' }}>
        <Tabs items={tabItems} />
      </Card>
    </div>
  );
};

export default SettingsPanel;

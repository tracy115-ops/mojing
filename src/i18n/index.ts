import { useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

export type Locale = 'zh-CN' | 'en-US';

const translations: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    params[key] !== undefined ? String(params[key]) : `{${key}}`,
  );
}

function translate(locale: string, key: string, params?: Record<string, string | number>): string {
  const messages = translations[locale] ?? translations['zh-CN'];
  const value = messages[key];
  if (!value) return key;
  return interpolate(value, params);
}

export function useTranslation() {
  const locale = useSettingsStore((s) => s.settings.general.language) as Locale;
  return useMemo(
    () => ({
      t: (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
      locale,
    }),
    [locale],
  );
}

export function t(key: string, params?: Record<string, string | number>): string {
  const locale = useSettingsStore.getState().settings.general.language;
  return translate(locale, key, params);
}

export { zhCN, enUS };

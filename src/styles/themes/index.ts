import darkTheme from './dark';
import lightTheme from './light';

export { darkTheme, lightTheme };

export type ThemeMode = 'dark' | 'light';

export function getThemeConfig(mode: ThemeMode) {
  return mode === 'dark' ? darkTheme : lightTheme;
}

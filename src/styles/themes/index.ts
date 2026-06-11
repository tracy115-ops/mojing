import darkTheme from './dark';
import lightTheme from './light';
import anchorTheme from './anchor';

export { darkTheme, lightTheme, anchorTheme };

export type ThemeMode = 'dark' | 'light' | 'anchor';

export function getThemeConfig(mode: ThemeMode) {
  if (mode === 'anchor') return anchorTheme;
  return mode === 'dark' ? darkTheme : lightTheme;
}

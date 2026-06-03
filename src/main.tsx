import ReactDOM from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import './styles/style-layers.css';
import './styles/global.css';

const readInitialTheme = (): 'dark' | 'light' => {
  try {
    const raw = window.localStorage.getItem('aiworkstation-settings');
    if (!raw) return 'dark';
    const persisted = JSON.parse(raw) as {
      state?: {
        currentTheme?: 'dark' | 'light';
        settings?: {
          appearance?: {
            theme?: 'dark' | 'light' | 'system';
          };
        };
      };
    };
    const appearanceTheme = persisted.state?.settings?.appearance?.theme;
    if (appearanceTheme === 'dark' || appearanceTheme === 'light') return appearanceTheme;
    if (appearanceTheme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return persisted.state?.currentTheme ?? 'dark';
  } catch {
    return 'dark';
  }
};

document.documentElement.setAttribute('data-theme', readInitialTheme());

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<div className="app-loading-shell" />);
void import('./App').then(({ default: App }) => {
  root.render(<App />);
});

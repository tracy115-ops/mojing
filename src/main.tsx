import '@ant-design/v5-patch-for-react-19';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { installGlobalLogCapture } from './services/log';

// Install before any app code runs so we capture boot errors too.
installGlobalLogCapture();

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
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

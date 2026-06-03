import { toast as sonnerToast } from 'sonner';

const isDarkMode = (): boolean => {
  try {
    const raw = window.localStorage.getItem('aiworkstation-settings');
    if (!raw) return true;
    const parsed = JSON.parse(raw) as {
      state?: { currentTheme?: 'dark' | 'light' };
    };
    return parsed.state?.currentTheme !== 'light';
  } catch {
    return true;
  }
};

export const toast = {
  success: (message: string, duration?: number) =>
    sonnerToast.success(message, { duration: duration ?? 3000 }),

  error: (message: string, duration?: number) =>
    sonnerToast.error(message, { duration: duration ?? 4000 }),

  info: (message: string, duration?: number) =>
    sonnerToast.info(message, { duration: duration ?? 3000 }),

  warning: (message: string, duration?: number) =>
    sonnerToast.warning(message, { duration: duration ?? 4000 }),

  loading: (message: string) =>
    sonnerToast.loading(message),
};

export { isDarkMode };

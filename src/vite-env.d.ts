/// <reference types="vite/client" />

declare module '@tauri-apps/api/core' {
  interface InvokeArgs {
    [key: string]: unknown;
  }
  function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T>;
}

declare module '@tauri-apps/api/event' {
  type EventCallback<T = unknown> = (event: Event<T>) => void;
  interface Event<T = unknown> {
    id: number;
    event: string;
    payload: T;
  }
  function listen<T = unknown>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;
  function once<T = unknown>(event: string, handler: EventCallback<T>): Promise<UnlistenFn>;
  function emit(event: string, payload?: unknown): Promise<void>;
  type UnlistenFn = () => void;
}

declare module '@tauri-apps/api/window' {
  function getCurrentWindow(): Window;
  function getAllWindows(): Promise<Window[]>;
  interface Window {
    label: string;
    close(): Promise<void>;
    hide(): Promise<void>;
    show(): Promise<void>;
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    isMinimized(): Promise<boolean>;
    setTitle(title: string): Promise<void>;
    setSize(size: { width: number; height: number }): Promise<void>;
    center(): Promise<void>;
    onCloseRequested(handler: (event: unknown) => void): Promise<UnlistenFn>;
  }
}

declare module '@tauri-apps/plugin-shell' {
  function open(path: string): Promise<void>;
}

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

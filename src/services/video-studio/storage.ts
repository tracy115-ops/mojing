import type { StateStorage } from 'zustand/middleware';

const STORAGE_OPERATION_TIMEOUT_MS = 3000;
let connection: Promise<IDBDatabase> | undefined;

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(`${label} timed out after ${STORAGE_OPERATION_TIMEOUT_MS}ms`));
    }, STORAGE_OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => { globalThis.clearTimeout(timer); resolve(value); },
      (error) => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('mojing-video-studio', 1);
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      connection = undefined;
      if (!settled) {
        settled = true;
        reject(new Error(`Opening video workspace storage timed out after ${STORAGE_OPERATION_TIMEOUT_MS}ms`));
      }
    }, STORAGE_OPERATION_TIMEOUT_MS);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      callback();
    };
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace');
    };
    request.onblocked = () => {
      connection = undefined;
      finish(() => reject(new Error('Video workspace storage is blocked by another window')));
    };
    request.onsuccess = () => finish(() => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = undefined;
      };
      resolve(db);
    });
    request.onerror = () => {
      connection = undefined;
      finish(() => reject(request.error ?? new Error('Unable to open video workspace storage')));
    };
  });
  return connection;
}
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return withTimeout(new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', mode);
    const request = operation(tx.objectStore('workspace'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Workspace save interrupted'));
  }), `Video workspace ${mode} transaction`);
}
export const videoStudioStorage: StateStorage = {
  getItem: async (key) => (await transaction('readonly', (store) => store.get(key))) ?? null,
  setItem: async (key, value) => {
    try { await transaction('readwrite', (store) => store.put(value, key)); }
    catch (error) { window.dispatchEvent(new CustomEvent('mojing:studio-storage-error', { detail: String(error) })); }
  },
  removeItem: async (key) => { await transaction('readwrite', (store) => store.delete(key)); },
};

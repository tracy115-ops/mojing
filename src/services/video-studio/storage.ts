import type { StateStorage } from 'zustand/middleware';

let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('mojing-video-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
  });
  return connection;
}
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', mode);
    const request = operation(tx.objectStore('workspace'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Workspace save interrupted'));
  });
}
export const videoStudioStorage: StateStorage = {
  getItem: async (key) => (await transaction('readonly', (store) => store.get(key))) ?? null,
  setItem: async (key, value) => {
    try { await transaction('readwrite', (store) => store.put(value, key)); }
    catch (error) { window.dispatchEvent(new CustomEvent('mojing:studio-storage-error', { detail: String(error) })); }
  },
  removeItem: async (key) => { await transaction('readwrite', (store) => store.delete(key)); },
};

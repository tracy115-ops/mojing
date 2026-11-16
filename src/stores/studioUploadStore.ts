import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { S3Credentials, S3StorageConfig } from '@/types/studio-upload';
import { defaultS3Config } from '@/services/video-studio/upload-contract';

interface UploadSettings {
  config: S3StorageConfig;
  credentials: S3Credentials;
  configure: (config: S3StorageConfig, credentials: S3Credentials) => void;
  clearCredentials: () => void;
}
export const useStudioUploadStore = create<UploadSettings>()(persist(set => ({
  config: defaultS3Config(), credentials: { accessKeyId: '', secretAccessKey: '' },
  configure: (config, credentials) => set({ config: structuredClone(config), credentials: { ...credentials } }),
  clearCredentials: () => set({ credentials: { accessKeyId: '', secretAccessKey: '' } }),
}), { name: 'studio-media-upload-settings', partialize: ({ config }) => ({ config }) }));

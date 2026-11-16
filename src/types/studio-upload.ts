export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  prefix: string;
  urlLifetimeHours: number;
}
export interface S3Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export interface StudioCloudMedia {
  target: S3StorageConfig;
  objectKey: string;
  url: string;
  expiresAt: string;
  uploadedAt: string;
  sha256: string;
  sizeBytes: number;
}
export interface StudioUploadTask {
  id: string;
  assetId: string;
  name: string;
  target: S3StorageConfig;
  objectKey: string;
  status: 'uploading' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stage: 'read' | 'put' | 'verify';
  attempt: number;
  createdAt: string;
  finishedAt?: string;
  sourceFingerprint: string;
  sourceSha256?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  metadata?: { width?: number; height?: number; durationSeconds?: number };
  putConfirmed?: boolean;
  error?: string;
}

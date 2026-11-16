import type { S3Credentials, S3StorageConfig } from '../../types/studio-upload.ts';
import { validateS3Config } from './upload-contract.ts';

const utf8 = (value: string) => new TextEncoder().encode(value);
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
export const sha256 = async (value: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', value));
async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, utf8(value)));
}
/** AWS Signature V4 query authentication, using the S3 UNSIGNED-PAYLOAD contract. */
export async function presignS3(config: S3StorageConfig, credentials: S3Credentials, objectKey: string, method: 'GET' | 'PUT' | 'HEAD', options: { now?: Date; expires?: number; headers?: Record<string, string> } = {}): Promise<string> {
  config = validateS3Config(config);
  if (!credentials.accessKeyId || !credentials.secretAccessKey || /[\r\n]/.test(credentials.accessKeyId + credentials.secretAccessKey + (credentials.sessionToken ?? ''))) throw new Error('credentials');
  if (!objectKey || objectKey.startsWith('/') || objectKey.split('/').some(part => part === '.' || part === '..') || utf8(objectKey).length > 1024) throw new Error('Invalid S3 object key');
  const expires = options.expires ?? 900;
  if (!Number.isInteger(expires) || expires < 1 || expires > 604800) throw new Error('Invalid S3 signature lifetime');
  const url = new URL(config.endpoint);
  if (!config.pathStyle) url.hostname = config.bucket + '.' + url.hostname;
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + (config.pathStyle ? encode(config.bucket) + '/' : '') + objectKey.split('/').map(encode).join('/');
  const date = (options.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0,8), scope = `${day}/${config.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: url.host };
  for (const [key,value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort(), signedHeaders = names.join(';');
  const query: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`, 'X-Amz-Date': date, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': signedHeaders, ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}) };
  const canonicalQuery = Object.entries(query).map(([key,value]) => [encode(key),encode(value)]).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(pair => pair.join('=')).join('&');
  const canonical = [method, url.pathname, canonicalQuery, names.map(name => `${name}:${headers[name]}\n`).join(''), signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const signingKey = await hmac(await hmac(await hmac(await hmac(utf8('AWS4' + credentials.secretAccessKey), day), config.region), 's3'), 'aws4_request');
  const signature = hex((await hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha256(utf8(canonical))}`)).buffer as ArrayBuffer);
  return `${url.href}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import type { OpenInput, OpenResult, PutInput, PutResult, StorageBackend } from './types';
import { StorageError } from './types';

export interface WebDAVConfig {
  baseUrl: string;
  username: string;
  password: string;
  bearerToken: string;
  rootPath: string;
}

function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizePath(value = ''): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

function splitPath(value = ''): string[] {
  const normalized = normalizePath(value);
  return normalized ? normalized.split('/') : [];
}

function encodeSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function normalizeToken(value: string | undefined): string {
  return String(value || '').trim().replace(/^Bearer\s+/i, '');
}

export function getWebDAVConfig(env: Env): WebDAVConfig {
  return {
    baseUrl: normalizeBaseUrl(env.WEBDAV_BASE_URL),
    username: String(env.WEBDAV_USERNAME || '').trim(),
    password: String(env.WEBDAV_PASSWORD || ''),
    bearerToken: normalizeToken(env.WEBDAV_BEARER_TOKEN || env.WEBDAV_TOKEN),
    rootPath: normalizePath(env.WEBDAV_ROOT_PATH),
  };
}

function hasBasicAuth(config: WebDAVConfig): boolean {
  return Boolean(config.username);
}

function hasBearerAuth(config: WebDAVConfig): boolean {
  return Boolean(config.bearerToken);
}

function authMode(config: WebDAVConfig): 'bearer' | 'basic' | 'none' {
  if (hasBearerAuth(config)) return 'bearer';
  if (hasBasicAuth(config)) return 'basic';
  return 'none';
}

export function hasWebDAVConfig(env: Env): boolean {
  const config = getWebDAVConfig(env);
  return Boolean(config.baseUrl) && authMode(config) !== 'none';
}

function buildAuthHeaders(config: WebDAVConfig, extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  const mode = authMode(config);
  if (mode === 'bearer') {
    headers.set('Authorization', `Bearer ${config.bearerToken}`);
  } else if (mode === 'basic') {
    headers.set('Authorization', `Basic ${btoa(`${config.username}:${config.password}`)}`);
  }
  return headers;
}

function buildAuthOverrideHeaders(
  config: WebDAVConfig,
  mode: 'bearer' | 'basic' | 'none',
  extra: HeadersInit = {}
): Headers {
  const headers = new Headers(extra);
  if (mode === 'bearer' && hasBearerAuth(config)) {
    headers.set('Authorization', `Bearer ${config.bearerToken}`);
  } else if (mode === 'basic' && hasBasicAuth(config)) {
    headers.set('Authorization', `Basic ${btoa(`${config.username}:${config.password}`)}`);
  } else {
    headers.delete('Authorization');
  }
  return headers;
}

function authModes(config: WebDAVConfig): Array<'bearer' | 'basic' | 'none'> {
  const modes: Array<'bearer' | 'basic' | 'none'> = [];
  const add = (mode: 'bearer' | 'basic' | 'none') => {
    if (!modes.includes(mode)) modes.push(mode);
  };
  add(authMode(config));
  add('bearer');
  add('basic');
  add('none');
  return modes;
}

function buildStoragePath(config: WebDAVConfig, storagePath: string): string {
  return encodeSegments([...splitPath(config.rootPath), ...splitPath(storagePath)]);
}

function buildUrl(config: WebDAVConfig, storagePath: string): string {
  const relative = buildStoragePath(config, storagePath);
  return relative ? `${config.baseUrl}/${relative}` : config.baseUrl;
}

async function decodeErrorText(response: Response): Promise<string> {
  try {
    return String((await response.text()) || '').slice(0, 500);
  } catch {
    return '';
  }
}

async function ensureCollectionPath(config: WebDAVConfig, storagePath: string): Promise<void> {
  const directorySegments = [
    ...splitPath(config.rootPath),
    ...splitPath(storagePath).slice(0, -1),
  ];
  if (directorySegments.length === 0) return;

  for (let index = 0; index < directorySegments.length; index += 1) {
    const encoded = encodeSegments(directorySegments.slice(0, index + 1));
    const candidates = [...new Set([`${config.baseUrl}/${encoded}`, `${config.baseUrl}/${encoded}/`])];
    let success = false;
    let lastResponse: Response | null = null;

    for (const url of candidates) {
      const response = await fetch(url, {
        method: 'MKCOL',
        headers: buildAuthHeaders(config),
      });
      if ([200, 201, 204, 301, 302, 405].includes(response.status)) {
        success = true;
        break;
      }
      lastResponse = response;
    }

    if (!success) {
      const detail = lastResponse ? await decodeErrorText(lastResponse) : '';
      throw new StorageError(
        'UPSTREAM',
        `WebDAV MKCOL failed (${lastResponse?.status ?? 'N/A'}): ${detail || 'Unknown error'}`,
        lastResponse?.status || 502
      );
    }
  }
}

export async function checkWebDAVConnection(
  env: Env
): Promise<{ connected: boolean; configured: boolean; message: string }> {
  if (!hasWebDAVConfig(env)) {
    return { connected: false, configured: false, message: 'Not configured' };
  }

  const config = getWebDAVConfig(env);
  const rootCandidates = [...new Set([config.baseUrl, `${config.baseUrl}/`])];
  const propfindBody = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<d:propfind xmlns:d="DAV:">',
    '  <d:prop><d:displayname /></d:prop>',
    '</d:propfind>',
  ].join('');

  let lastDetail = '';
  let lastStatus: number | undefined;

  try {
    for (const mode of authModes(config)) {
      for (const rootUrl of rootCandidates) {
        const optionsResponse = await fetch(rootUrl, {
          method: 'OPTIONS',
          headers: buildAuthOverrideHeaders(config, mode, { Depth: '0' }),
          signal: AbortSignal.timeout(8000),
        });
        if (optionsResponse.ok) {
          return { connected: true, configured: true, message: 'Connected' };
        }
        if (![400, 401, 403, 405].includes(optionsResponse.status)) {
          lastStatus = optionsResponse.status;
          lastDetail = await decodeErrorText(optionsResponse);
        }

        const propfindResponse = await fetch(rootUrl, {
          method: 'PROPFIND',
          headers: buildAuthOverrideHeaders(config, mode, {
            Depth: '0',
            'Content-Type': 'application/xml; charset=utf-8',
          }),
          body: propfindBody,
          signal: AbortSignal.timeout(8000),
        });
        if (propfindResponse.ok || propfindResponse.status === 207) {
          return { connected: true, configured: true, message: 'Connected' };
        }
        lastStatus = propfindResponse.status;
        lastDetail = await decodeErrorText(propfindResponse);
      }
    }
  } catch (error) {
    return {
      connected: false,
      configured: true,
      message: error instanceof Error ? error.message : 'Connection failed',
    };
  }

  return {
    connected: false,
    configured: true,
    message: lastDetail || `WebDAV connection failed${lastStatus ? ` (${lastStatus})` : ''}`,
  };
}

export function createWebDAVBackend(env: Env): StorageBackend {
  const config = getWebDAVConfig(env);

  return {
    type: 'webdav',
    caps: {
      range: true,
      maxBytes: 100 * 1024 * 1024,
      streamUp: false,
    },

    async put(input: PutInput): Promise<PutResult> {
      if (!config.baseUrl) {
        throw new StorageError('NOT_CONFIGURED', 'WebDAV base URL is not configured.');
      }
      if (authMode(config) === 'none') {
        throw new StorageError('NOT_CONFIGURED', 'WebDAV authentication is not configured.');
      }

      const storagePath = normalizePath(input.folderPath || '');
      const objectPath = storagePath ? `${storagePath}/${input.id}` : input.id;
      const buffer =
        input.body instanceof ArrayBuffer
          ? input.body
          : await new Response(input.body).arrayBuffer();

      await ensureCollectionPath(config, objectPath);

      const response = await fetch(buildUrl(config, objectPath), {
        method: 'PUT',
        headers: buildAuthHeaders(config, {
          'Content-Type': input.contentType || 'application/octet-stream',
          'Content-Length': String(buffer.byteLength),
        }),
        body: buffer,
      });

      if (!response.ok && ![201, 204].includes(response.status)) {
        const detail = await decodeErrorText(response);
        throw new StorageError(
          'UPSTREAM',
          `WebDAV upload failed (${response.status}): ${detail || 'Unknown error'}`,
          response.status
        );
      }

      return {
        storageKey: objectPath,
        meta: {
          webdavPath: objectPath,
          webdavEtag: response.headers.get('etag') || undefined,
        },
      };
    },

    async open(input: OpenInput): Promise<OpenResult> {
      if (!config.baseUrl) {
        throw new StorageError('NOT_CONFIGURED', 'WebDAV base URL is not configured.');
      }
      if (authMode(config) === 'none') {
        throw new StorageError('NOT_CONFIGURED', 'WebDAV authentication is not configured.');
      }

      const metadata = input.record.metadata as FileMetadata;
      const storagePath = String(metadata.webdavPath || input.record.storageKey || '');
      if (!storagePath) {
        throw new StorageError('NOT_FOUND', 'WebDAV path is missing from metadata.', 404);
      }

      const headers: Record<string, string> = {};
      if (input.range) headers.Range = input.range;

      let firstFailure: { status: number; detail: string } | null = null;

      for (const mode of authModes(config)) {
        const response = await fetch(buildUrl(config, storagePath), {
          method: input.method,
          headers: buildAuthOverrideHeaders(config, mode, headers),
        });

        if (response.ok || response.status === 206) {
          return {
            status: response.status,
            headers: response.headers,
            body: input.method === 'HEAD' ? null : response.body,
          };
        }
        if (response.status === 404) {
          throw new StorageError('NOT_FOUND', 'WebDAV file not found.', 404);
        }
        if (!firstFailure) {
          firstFailure = { status: response.status, detail: await decodeErrorText(response) };
        }
        if (![400, 401, 403].includes(response.status)) {
          const detail = await decodeErrorText(response);
          throw new StorageError(
            'UPSTREAM',
            `WebDAV download failed (${response.status}): ${detail || 'Unknown error'}`,
            response.status
          );
        }
      }

      throw new StorageError(
        'AUTH',
        `WebDAV download failed (${firstFailure?.status ?? 'N/A'}): ${firstFailure?.detail || 'Unknown error'}`,
        firstFailure?.status || 502
      );
    },

    async remove(record): Promise<void> {
      if (!config.baseUrl || authMode(config) === 'none') return;
      const metadata = record.metadata as FileMetadata;
      const storagePath = String(metadata.webdavPath || record.storageKey || '');
      if (!storagePath) return;

      const response = await fetch(buildUrl(config, storagePath), {
        method: 'DELETE',
        headers: buildAuthHeaders(config),
      });
      if (response.ok || response.status === 404) return;

      const detail = await decodeErrorText(response);
      throw new StorageError(
        'UPSTREAM',
        `WebDAV delete failed (${response.status}): ${detail || 'Unknown error'}`,
        response.status
      );
    },

    async check(): Promise<{ connected: boolean; message: string }> {
      const result = await checkWebDAVConnection(env);
      return { connected: result.connected, message: result.message };
    },
  };
}

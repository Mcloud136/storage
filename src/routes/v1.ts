import { Hono } from 'hono';
import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import type { ApiTokenRecord } from '../lib/api-token';
import {
  checkTokenRateLimit,
  checkTokenSourceHost,
  checkTokenUploadPolicy,
  getIdempotentResponse,
  parseBearerToken,
  saveIdempotentResponse,
  verifyApiToken,
} from '../lib/api-token';
import { apiError, json, buildFileHeaders } from '../lib/http';
import {
  findStoredFile,
  listAllFileRecords,
  normalizeFolderPath,
  updateMetadata,
} from '../lib/file-store';
import { getMimeType } from '../lib/media';
import { randomString, sha256Hex } from '../lib/crypto';
import { createBackend, isBackendConfigured, SUPPORTED_STORAGE_MODES } from '../backends';
import { StorageError } from '../backends/types';
import { uploadSource, UploadError, type WaitUntilContext } from '../services/upload';
import { fetchRemoteStrict, RemoteFetchError } from '../lib/ssrf';
import { getFileExtension, guessExtensionFromMimeType, parseSignedTelegramFileId } from '../lib/telegram';import { createPaste, deletePaste, getPaste, listPastes, pastePublic } from '../lib/paste';

type V1Env = {
  Bindings: Env;
  Variables: { apiToken: ApiTokenRecord };
};

export const v1Routes = new Hono<V1Env>();

const MB = 1024 * 1024;

function safeDecodeFileName(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return String(value || '').trim();
  }
}

function maxBytesForStorage(storageMode: string): number {
  if (storageMode === 'telegram') return 20 * MB;
  if (storageMode === 'huggingface') return 35 * MB;
  return 50 * MB;
}

function allowedOrigins(env: Env): string[] {
  return String(env.API_CORS_ORIGINS || '')
    .split(/[\s,]+/)
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, Range, Idempotency-Key, X-KVault-Client, X-Paste-Password',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, Idempotency-Replayed',
    'Access-Control-Max-Age': '86400',
  });

  const origin = String(request.headers.get('Origin') || '').trim();
  if (!origin) return headers;
  const whitelist = allowedOrigins(env);
  if (whitelist.includes('*')) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (whitelist.includes(origin.replace(/\/+$/, ''))) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function applyCors(c: { res?: Response }, headers: Headers): void {
  if (!c.res) return;
  for (const [key, value] of headers) {
    c.res.headers.set(key, value);
  }
}

function requiredScope(method: string, pathname: string): string {
  const methodUpper = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const path = pathname.replace(/\/+$/, '') || '/';

  if (methodUpper === 'GET' && path === '/api/v1/capabilities') return '';
  if (methodUpper === 'GET' && path === '/api/v1/me') return '@me';
  if (methodUpper === 'POST' && path === '/api/v1/upload') return 'upload';
  if (methodUpper === 'POST' && path === '/api/v1/import') return 'upload';
  if (methodUpper === 'GET' && path === '/api/v1/files') return 'read';
  if (methodUpper === 'GET' && /^\/api\/v1\/file\/[^/]+$/.test(path)) return 'read';
  if (methodUpper === 'GET' && /^\/api\/v1\/file\/[^/]+\/info$/.test(path)) return 'read';
  if (methodUpper === 'DELETE' && /^\/api\/v1\/file\/[^/]+$/.test(path)) return 'delete';
  if (methodUpper === 'POST' && path === '/api/v1/paste') return 'paste';
  if (methodUpper === 'GET' && path === '/api/v1/pastes') return 'read';
  if (methodUpper === 'GET' && /^\/api\/v1\/paste\/[^/]+$/.test(path)) return 'read';
  if (methodUpper === 'DELETE' && /^\/api\/v1\/paste\/[^/]+$/.test(path)) return 'delete';
  return '@me';
}

v1Routes.use('*', async (c, next) => {
  const headers = corsHeaders(c.req.raw, c.env);
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  const pathname = new URL(c.req.url).pathname;
  const scope = requiredScope(c.req.method, pathname);

  if (!scope) {
    await next();
    applyCors(c, headers);
    return;
  }

  const tokenValue = parseBearerToken(c.req.raw);
  const result = await verifyApiToken(c.env, tokenValue, scope);
  if (!result.ok) {
    return apiError(result.code, result.message, result.status);
  }

  const rate = await checkTokenRateLimit(c.env, result.record);
  if (!rate.ok) {
    return apiError(rate.code || 'RATE_LIMITED', rate.message || 'Rate limited.', rate.status || 429);
  }

  c.set('apiToken', result.record);
  await next();
  applyCors(c, headers);
});

v1Routes.get('/capabilities', (c) => {
  const storages = SUPPORTED_STORAGE_MODES.filter((type) => isBackendConfigured(type, c.env));
  return json({
    success: true,
    data: {
      apiVersion: 'v1',
      upload: true,
      importFromUrl: true,
      maxUploadSize: 50 * MB,
      storageLimits: {
        telegram: 20 * MB,
        huggingface: 35 * MB,
        webdav: 50 * MB,
        github: 50 * MB,
      },
      storages,
      imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp'],
    },
  });
});

v1Routes.get('/me', (c) => {
  const token = c.get('apiToken');
  return json({
    success: true,
    data: {
      id: token.id,
      name: token.name,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      policies: token.policies,
      createdAt: token.createdAt,
      tokenPreview: token.tokenPreview,
    },
  });
});

function publicFile(
  requestUrl: string,
  kvKey: string,
  metadata: FileMetadata,
  storageType: string,
  env: Env
) {
  const src = `/file/${kvKey}`;
  const base = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const url = base ? `${base}${src}` : new URL(src, requestUrl).toString();
  const fileName = metadata.fileName || kvKey;
  return {
    id: kvKey,
    src,
    url,
    fileName,
    fileSize: Number(metadata.fileSize || 0),
    mime: getMimeType(fileName),
    storage: storageType,
    uploadedAt: Number(metadata.TimeStamp || Date.now()),
    shareSlug: metadata.shareSlug || null,
  };
}

function errorStatus(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof RemoteFetchError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof UploadError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof StorageError) {
    const status =
      error.code === 'TOO_LARGE'
        ? 413
        : error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'NOT_CONFIGURED'
            ? 400
            : 502;
    return { status, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: 'UPLOAD_FAILED',
    message: error instanceof Error ? error.message : 'Upload failed.',
  };
}

async function applyShareMetadata(
  env: Env,
  kvKey: string,
  body: Record<string, unknown>
): Promise<FileMetadata | null> {
  const record = await env.img_url.getWithMetadata<FileMetadata>(kvKey);
  if (!record?.metadata) return null;
  const metadata: FileMetadata = { ...record.metadata };

  const password = String(body.password || '');
  if (password) {
    const salt = randomString(12);
    metadata.sharePasswordSalt = salt;
    metadata.sharePasswordHash = await sha256Hex(`${salt}:${password}`);
  }

  const expiresIn = Number(body.expires_in ?? body.expiresIn ?? 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    metadata.shareExpiresAt = Date.now() + Math.floor(expiresIn) * 1000;
  }

  const maxDownloads = Number(body.max_downloads ?? body.maxDownloads ?? 0);
  if (Number.isFinite(maxDownloads) && maxDownloads > 0) {
    metadata.shareMaxDownloads = Math.floor(maxDownloads);
    metadata.shareDownloadCount = Number(metadata.shareDownloadCount || 0);
  }

  const rawSlug = String(body.slug || '')
    .trim()
    .toLowerCase();
  if (rawSlug && /^[a-z0-9_-]{1,64}$/.test(rawSlug)) {
    const existing = await env.img_url.get(`share_slug:${rawSlug}`);
    if (existing && existing !== kvKey) {
      throw new Error('短链 slug 已被占用。');
    }
    metadata.shareSlug = rawSlug;
    await env.img_url.put(`share_slug:${rawSlug}`, kvKey, {
      metadata: { fileId: kvKey, updatedAt: Date.now() },
    });
  }

  await updateMetadata(env.img_url, kvKey, metadata);
  return metadata;
}

async function handleUpload(c: any, body: Record<string, unknown>): Promise<Response> {
  const env = c.env as Env;
  const token = c.get('apiToken') as ApiTokenRecord;
  const idempotencyKey = String(c.req.header('Idempotency-Key') || '').trim().slice(0, 200);

  const replay = await getIdempotentResponse(env, token.id, idempotencyKey);
  if (replay) {
    return json(replay.body, replay.status, { 'Idempotency-Replayed': 'true' });
  }

  const file = body.file as File | undefined;
  if (!file) return apiError('FILE_REQUIRED', 'Multipart field "file" is required.', 400);

  const storageMode = String(body.storageMode || body.storage || 'telegram').toLowerCase();
  const folderPath = normalizeFolderPath(String(body.folderPath || body.folder || ''));
  const policy = checkTokenUploadPolicy(token, {
    storage: storageMode,
    mime: file.type,
    sizeBytes: file.size,
    folderPath,
  });
  if (!policy.ok) return apiError(policy.code || 'POLICY_DENIED', policy.message || 'Denied.', policy.status || 403);

  let context: WaitUntilContext | null = null;
  try {
    context = c.executionCtx as unknown as WaitUntilContext;
  } catch {
    context = null;
  }

  try {
    const result = await uploadSource({
      env,
      source: {
        fileName: file.name || 'upload.bin',
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        buffer: await file.arrayBuffer(),
      },
      storageMode,
      folderPath,
      origin: new URL(c.req.url).origin,
      ctx: context,
    });

    const metadata =
      (await applyShareMetadata(env, result.kvKey, body)) || {
        fileName: file.name,
        fileSize: file.size,
        TimeStamp: Date.now(),
      };
    const payload = {
      success: true,
      file: publicFile(c.req.url, result.kvKey, metadata, result.storageType, env),
    };
    await saveIdempotentResponse(env, token.id, idempotencyKey, 200, payload);
    return json(payload);
  } catch (error) {
    const mapped = errorStatus(error);
    return apiError(mapped.code, mapped.message, mapped.status);
  }
}

v1Routes.post('/upload', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return apiError('INVALID_BODY', 'Invalid multipart body.', 400);
  }
  const body: Record<string, unknown> = {
    file: form.get('file'),
    storage: form.get('storage'),
    storageMode: form.get('storageMode'),
    folderPath: form.get('folderPath'),
    password: form.get('password'),
    expires_in: form.get('expires_in'),
    max_downloads: form.get('max_downloads'),
    slug: form.get('slug'),
  };
  return handleUpload(c, body);
});

v1Routes.post('/import', async (c) => {
  const env = c.env;
  const token = c.get('apiToken');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const idempotencyKey = String(c.req.header('Idempotency-Key') || '').trim().slice(0, 200);
  const replay = await getIdempotentResponse(env, token.id, idempotencyKey);
  if (replay) {
    return json(replay.body, replay.status, { 'Idempotency-Replayed': 'true' });
  }

  const url = String(body.url || '').trim();
  if (!url) return apiError('URL_REQUIRED', 'url is required.', 400);
  const storageMode = String(body.storage || body.storageMode || 'telegram').toLowerCase();
  const folderPath = normalizeFolderPath(String(body.folderPath || ''));
  const policy = checkTokenUploadPolicy(token, {
    storage: storageMode,
    sizeBytes: 0,
    folderPath,
  });
  if (!policy.ok) return apiError(policy.code || 'POLICY_DENIED', policy.message || 'Denied.', policy.status || 403);

  const storageLimit = maxBytesForStorage(storageMode);
  const maxBytes = Math.min(token.policies?.maxFileSize || storageLimit, storageLimit);
  try {
    const fetched = await fetchRemoteStrict(url, maxBytes);
    const sourceCheck = checkTokenSourceHost(token, fetched.finalUrl);
    if (!sourceCheck.ok) {
      return apiError(sourceCheck.code || 'POLICY_SOURCE_DENIED', sourceCheck.message || 'Denied.', sourceCheck.status || 403);
    }
    const finalUrl = new URL(fetched.finalUrl);
    let fileName = safeDecodeFileName(finalUrl.pathname.split('/').pop() || '');
    if (!fileName) fileName = `url_${Date.now()}`;
    if (!fileName.includes('.')) {
      fileName = `${fileName}.${guessExtensionFromMimeType(fetched.contentType, 'bin')}`;
    }

    let context: WaitUntilContext | null = null;
    try {
      context = c.executionCtx as unknown as WaitUntilContext;
    } catch {
      context = null;
    }

    const result = await uploadSource({
      env,
      source: {
        fileName,
        contentType: fetched.contentType || 'application/octet-stream',
        size: fetched.buffer.byteLength,
        buffer: fetched.buffer,
      },
      storageMode,
      folderPath,
      origin: new URL(c.req.url).origin,
      ctx: context,
    });

    const metadata =
      (await applyShareMetadata(env, result.kvKey, body)) || {
        fileName,
        fileSize: fetched.buffer.byteLength,
        TimeStamp: Date.now(),
      };
    const payload = {
      success: true,
      file: publicFile(c.req.url, result.kvKey, metadata, result.storageType, env),
    };
    await saveIdempotentResponse(env, token.id, idempotencyKey, 200, payload);
    return json(payload);
  } catch (error) {
    const mapped = errorStatus(error);
    return apiError(mapped.code, mapped.message, mapped.status);
  }
});

v1Routes.get('/files', async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  const storage = String(url.searchParams.get('storage') || 'all').toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(url.searchParams.get('cursor') || '0', 10) || 0, 0);

  let files = await listAllFileRecords(env.img_url);
  if (storage !== 'all') files = files.filter((file) => file.storageType === storage);
  files.sort((a, b) => Number(b.metadata.TimeStamp || 0) - Number(a.metadata.TimeStamp || 0));

  const page = files.slice(offset, offset + limit);
  const next = offset + limit < files.length ? offset + limit : null;

  return json({
    success: true,
    files: page.map((file) =>
      publicFile(c.req.url, file.kvKey, file.metadata, file.storageType, env)
    ),
    pagination: {
      cursor: next == null ? null : String(next),
      listComplete: next == null,
      pageCount: page.length,
      total: files.length,
    },
  });
});

v1Routes.get('/file/:id/info', async (c) => {
  const found = await findStoredFile(c.env, c.req.param('id'));
  if (!found) return apiError('FILE_NOT_FOUND', 'File not found.', 404);
  return json({
    success: true,
    file: publicFile(c.req.url, found.kvKey, found.metadata, found.storageType, c.env),
  });
});

v1Routes.get('/file/:id', async (c) => {
  const env = c.env;
  const id = c.req.param('id');
  const signed = await parseSignedTelegramFileId(id, env);

  let record;
  if (signed) {
    record = {
      id: signed.fileId,
      storageType: 'telegram',
      storageKey: `${signed.fileId}.${signed.fileExtension}`,
      metadata: {
        storageType: 'telegram',
        telegramFileId: signed.fileId,
        fileName: signed.fileName || `${signed.fileId}.${signed.fileExtension}`,
        fileSize: signed.fileSize,
      } as FileMetadata,
    };
  } else {
    const found = await findStoredFile(env, id);
    if (!found) return apiError('FILE_NOT_FOUND', 'File not found.', 404);
    record = {
      id: found.kvKey,
      storageType: found.storageType,
      storageKey: found.kvKey,
      metadata: found.metadata,
    };
  }

  try {
    const backend = createBackend(record.storageType, env);
    const result = await backend.open({
      record,
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      range: c.req.header('Range') || null,
    });
    const headers = buildFileHeaders(
      String(record.metadata.fileName || record.id),
      getMimeType(String(record.metadata.fileName || record.id))
    );
    const length = result.headers.get('Content-Length');
    const contentRange = result.headers.get('Content-Range');
    if (length) headers.set('Content-Length', length);
    if (contentRange) headers.set('Content-Range', contentRange);
    return new Response(c.req.method === 'HEAD' ? null : result.body, {
      status: result.status,
      headers,
    });
  } catch (error) {
    const mapped = errorStatus(error);
    return apiError(mapped.code, mapped.message, mapped.status);
  }
});

v1Routes.delete('/file/:id', async (c) => {
  const env = c.env;
  const found = await findStoredFile(env, c.req.param('id'));
  if (!found) return apiError('FILE_NOT_FOUND', 'File not found.', 404);

  try {
    const backend = createBackend(found.storageType, env);
    await backend.remove({
      id: found.kvKey,
      storageType: found.storageType,
      storageKey: found.kvKey,
      metadata: found.metadata,
    });
  } catch {
    // Best-effort remote deletion; metadata is still removed.
  }
  await env.img_url.delete(found.kvKey);
  return json({ success: true });
});

v1Routes.post('/paste', async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const expiresIn = Number(body.expires_in ?? body.expiresIn ?? 0);
  try {
    const created = await createPaste(env, {
      content: String(body.content || ''),
      language: String(body.language || 'text'),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      password: String(body.password || ''),
    });
    return json(
      {
        success: true,
        paste: {
          id: created.id,
          url: new URL(`/api/v1/paste/${created.id}`, c.req.url).toString(),
          createdAt: created.record.createdAt,
          expiresAt: created.record.expiresAt,
          size: created.record.size,
        },
      },
      201
    );
  } catch (error) {
    return apiError('PASTE_CREATE_FAILED', error instanceof Error ? error.message : 'Paste failed.', 400);
  }
});

v1Routes.get('/pastes', async (c) => {
  const pastes = await listPastes(c.env);
  return json({
    success: true,
    pastes: pastes.map((paste) => ({
      id: paste.id,
      language: paste.language,
      size: paste.size,
      createdAt: paste.createdAt,
      expiresAt: paste.expiresAt,
      hasPassword: Boolean(paste.passwordHash),
    })),
  });
});

v1Routes.get('/paste/:id', async (c) => {
  const password =
    new URL(c.req.url).searchParams.get('password') ||
    c.req.header('X-Paste-Password') ||
    '';
  const result = await getPaste(c.env, c.req.param('id'), password);
  if (!result.record) {
    return apiError('PASTE_NOT_AVAILABLE', result.error || 'Paste not available.', result.status || 404);
  }
  return json({ success: true, paste: pastePublic(result.record) });
});

v1Routes.delete('/paste/:id', async (c) => {
  await deletePaste(c.env, c.req.param('id'));
  return json({ success: true });
});

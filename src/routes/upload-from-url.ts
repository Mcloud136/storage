import { Hono } from 'hono';
import type { Env } from '../env';
import { isAdminRequest } from '../lib/auth';
import { checkGuestUpload, incrementGuestCount } from '../lib/guest';
import { json } from '../lib/http';
import { fetchRemoteStrict, RemoteFetchError } from '../lib/ssrf';
import { guessExtensionFromMimeType } from '../lib/telegram';
import { StorageError } from '../backends/types';
import { uploadSource, UploadError, type WaitUntilContext } from '../services/upload';

const MB = 1024 * 1024;

export const uploadFromUrlRoutes = new Hono<{ Bindings: Env }>();

function maxBytesFor(storageMode: string): number {
  if (storageMode === 'telegram') return 20 * MB;
  if (storageMode === 'huggingface') return 35 * MB;
  return 50 * MB;
}

function safeDecodeFileName(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return String(value || '').trim();
  }
}

function statusForError(error: unknown): number {
  if (error instanceof RemoteFetchError) return error.status;
  if (error instanceof UploadError) return error.status;
  if (error instanceof StorageError) {
    if (error.code === 'NOT_FOUND') return 404;
    if (error.code === 'TOO_LARGE') return 413;
    if (error.code === 'NOT_CONFIGURED') return 400;
    return 502;
  }
  return 500;
}

uploadFromUrlRoutes.post('/api/upload-from-url', async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = String(body.url || '').trim();
  const storageMode = String(body.storageMode || 'telegram').toLowerCase();
  const folderPath = String(body.folderPath || body.folder || '');

  if (!url) {
    return json({ error: '请输入 URL' }, 400);
  }

  const isAdmin = await isAdminRequest(c.req.raw, env);

  if (!isAdmin) {
    const guestCheck = await checkGuestUpload(c.req.raw, env, 0);
    if (!guestCheck.allowed) {
      return json({ error: guestCheck.reason }, guestCheck.status || 403);
    }
  }

  let fetched: { buffer: ArrayBuffer; contentType: string; finalUrl: string };
  try {
    fetched = await fetchRemoteStrict(url, maxBytesFor(storageMode));
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Remote fetch failed' },
      statusForError(error)
    );
  }

  if (!isAdmin) {
    const guestSizeCheck = await checkGuestUpload(c.req.raw, env, fetched.buffer.byteLength);
    if (!guestSizeCheck.allowed) {
      return json({ error: guestSizeCheck.reason }, guestSizeCheck.status || 413);
    }
  }

  const finalUrl = new URL(fetched.finalUrl);
  let fileName = safeDecodeFileName(finalUrl.pathname.split('/').pop() || '');
  if (!fileName) {
    fileName = `url_${Date.now()}`;
  }
  if (!fileName.includes('.')) {
    fileName = `${fileName}.${guessExtensionFromMimeType(fetched.contentType, 'bin')}`;
  }

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

    if (!isAdmin) {
      await incrementGuestCount(c.req.raw, env);
    }

    return json([{ src: result.src }]);
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Upload failed',
        code: error instanceof UploadError || error instanceof StorageError ? error.code : 'UPLOAD_FAILED',
      },
      statusForError(error)
    );
  }
});

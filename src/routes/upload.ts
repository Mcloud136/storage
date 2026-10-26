import { Hono } from 'hono';
import type { Env } from '../env';
import { isAdminRequest } from '../lib/auth';
import { checkGuestUpload, incrementGuestCount } from '../lib/guest';
import { json } from '../lib/http';
import { StorageError } from '../backends/types';
import { uploadSource, UploadError, type WaitUntilContext } from '../services/upload';

export const uploadRoutes = new Hono<{ Bindings: Env }>();

function statusForError(error: unknown): number {
  if (error instanceof UploadError) return error.status;
  if (error instanceof StorageError) {
    if (error.code === 'NOT_FOUND') return 404;
    if (error.code === 'TOO_LARGE') return 413;
    if (error.code === 'NOT_CONFIGURED') return 400;
    return 502;
  }
  return 500;
}

uploadRoutes.post('/upload', async (c) => {
  const env = c.env;

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return json({ error: 'Invalid multipart body.' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ error: '未选择上传文件' }, 400);
  }

  const storageMode = String(form.get('storageMode') || 'telegram').toLowerCase();
  const folderPath = String(form.get('folderPath') || '');
  const isAdmin = await isAdminRequest(c.req.raw, env);

  if (!isAdmin) {
    const guestCheck = await checkGuestUpload(c.req.raw, env, file.size);
    if (!guestCheck.allowed) {
      return json({ error: guestCheck.reason }, guestCheck.status || 403);
    }
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

    if (!isAdmin) {
      await incrementGuestCount(c.req.raw, env);
    }

    return json([{ src: result.src }]);
  } catch (error) {
    const status = statusForError(error);
    const code = error instanceof UploadError || error instanceof StorageError ? error.code : 'UPLOAD_FAILED';
    return json(
      {
        error: error instanceof Error ? error.message : 'Upload failed',
        code,
      },
      status
    );
  }
});

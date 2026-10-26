import { Hono } from 'hono';
import type { Env } from '../env';
import { requireAdmin } from '../lib/auth';
import { json } from '../lib/http';
import { StorageError } from '../backends/types';
import { uploadSource, UploadError, type WaitUntilContext } from '../services/upload';

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const TELEGRAM_WEB_UPLOAD_LIMIT = 20 * 1024 * 1024;

interface ChunkTask {
  uploadId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  storageMode: string;
  folderPath: string;
  createdAt: number;
  status: string;
}

export const chunkedRoutes = new Hono<{ Bindings: Env }>();

function taskKey(uploadId: string): string {
  return `upload:${uploadId}`;
}

function chunkKey(uploadId: string, index: number): string {
  return `chunk:${uploadId}:${index}`;
}

function newUploadId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function errorStatus(error: unknown): number {
  if (error instanceof UploadError) return error.status;
  if (error instanceof StorageError) {
    if (error.code === 'TOO_LARGE') return 413;
    if (error.code === 'NOT_CONFIGURED') return 400;
    return 502;
  }
  return 500;
}

function errorCode(error: unknown): string {
  if (error instanceof UploadError || error instanceof StorageError) return error.code;
  return 'UPLOAD_FAILED';
}

chunkedRoutes.post('/api/chunked-upload/init', async (c) => {
  const env = c.env;
  const unauthorized = await requireAdmin(c.req.raw, env);
  if (unauthorized) return unauthorized;

  if (!env.img_url) {
    return json({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const fileName = String(body.fileName || '');
  const fileSize = Number(body.fileSize || 0);
  const fileType = String(body.fileType || 'application/octet-stream');
  const totalChunks = Number(body.totalChunks || 0);
  const storageMode = String(body.storageMode || 'telegram').toLowerCase();
  const folderPath = String(body.folderPath || body.folder || '');

  if (!fileName || !fileSize || !totalChunks) {
    return json({ error: '缺少必要参数' }, 400);
  }

  if (
    storageMode !== 'telegram' &&
    storageMode !== 'webdav' &&
    storageMode !== 'huggingface' &&
    storageMode !== 'github'
  ) {
    return json({ error: `Storage backend "${storageMode}" is not implemented in v2 M3.` }, 501);
  }

  if (fileSize > MAX_FILE_SIZE) {
    return json({ error: `文件大小超过限制 (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)`, code: 'FILE_TOO_LARGE' }, 413);
  }
  if (storageMode === 'telegram' && fileSize > TELEGRAM_WEB_UPLOAD_LIMIT) {
    return json(
      {
        error: 'Cloudflare Pages 上的 Telegram 网页上传仅适合 20MB 以内文件。更大的文件请切换到 WebDAV/GitHub。',
        code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      },
      400
    );
  }
  if (storageMode === 'huggingface' && fileSize > 35 * 1024 * 1024) {
    return json(
      { error: 'HuggingFace 普通上传链路限制为 35MB。', code: 'HUGGINGFACE_FILE_TOO_LARGE' },
      413
    );
  }

  const uploadId = newUploadId();
  const task: ChunkTask = {
    uploadId,
    fileName,
    fileSize,
    fileType,
    totalChunks: Math.max(1, Math.floor(totalChunks)),
    storageMode,
    folderPath,
    createdAt: Date.now(),
    status: 'pending',
  };

  await env.img_url.put(taskKey(uploadId), JSON.stringify(task), { expirationTtl: 3600 });

  return json({
    success: true,
    uploadId,
    chunkSize: CHUNK_SIZE,
    chunkBackend: 'kv',
  });
});

chunkedRoutes.post('/api/chunked-upload/chunk', async (c) => {
  const env = c.env;
  const unauthorized = await requireAdmin(c.req.raw, env);
  if (unauthorized) return unauthorized;

  if (!env.img_url) {
    return json({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return json({ error: 'Invalid multipart body.' }, 400);
  }

  const uploadId = String(form.get('uploadId') || '');
  const chunkIndex = Number(form.get('chunkIndex'));
  const chunk = form.get('chunk');

  if (!uploadId || Number.isNaN(chunkIndex) || !(chunk instanceof File)) {
    return json({ error: '缺少必要参数' }, 400);
  }

  const task = await env.img_url.get<ChunkTask>(taskKey(uploadId), { type: 'json' });
  if (!task) {
    return json({ error: '上传任务不存在或已过期' }, 404);
  }
  if (chunkIndex < 0 || chunkIndex >= task.totalChunks) {
    return json({ error: '分片索引超出范围' }, 400);
  }

  const buffer = await chunk.arrayBuffer();
  await env.img_url.put(chunkKey(uploadId, chunkIndex), buffer, { expirationTtl: 3600 });

  return json({ success: true, chunkIndex });
});

chunkedRoutes.post('/api/chunked-upload/complete', async (c) => {
  const env = c.env;
  const unauthorized = await requireAdmin(c.req.raw, env);
  if (unauthorized) return unauthorized;

  if (!env.img_url) {
    return json({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const uploadId = String(body.uploadId || '');
  if (!uploadId) {
    return json({ error: '缺少 uploadId' }, 400);
  }

  const task = await env.img_url.get<ChunkTask>(taskKey(uploadId), { type: 'json' });
  if (!task) {
    return json({ error: '上传任务不存在或已过期' }, 404);
  }

  const chunks: ArrayBuffer[] = [];
  let totalLength = 0;
  for (let index = 0; index < task.totalChunks; index += 1) {
    const buffer = await env.img_url.get(chunkKey(uploadId, index), { type: 'arrayBuffer' });
    if (!buffer) {
      return json(
        {
          error: '分片不完整',
          missingChunks: Array.from({ length: task.totalChunks }, (_, item) => item).filter(
            (item) => item >= index
          ),
        },
        400
      );
    }
    chunks.push(buffer);
    totalLength += buffer.byteLength;
  }

  if (totalLength === 0) {
    return json({ error: '分片内容为空' }, 400);
  }

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
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
        fileName: task.fileName,
        contentType: task.fileType,
        size: output.byteLength,
        buffer: output.buffer,
      },
      storageMode: task.storageMode,
      folderPath: task.folderPath,
      origin: new URL(c.req.url).origin,
      ctx: context,
    });

    for (let index = 0; index < task.totalChunks; index += 1) {
      await env.img_url.delete(chunkKey(uploadId, index));
    }
    await env.img_url.delete(taskKey(uploadId));

    return json({ success: true, src: result.src });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : '合并分片失败',
        code: errorCode(error),
      },
      errorStatus(error)
    );
  }
});

import { Hono } from 'hono';
import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import { getFileExtension } from '../lib/telegram';
import { requireAdmin } from '../lib/auth';
import { json } from '../lib/http';
import { StorageError } from '../backends/types';
import {
  commitHuggingFaceLfs,
  completeHuggingFaceMultipart,
  planHuggingFaceDirectUpload,
  type HfLfsPart,
} from '../backends/huggingface-lfs';
import { normalizeFolderPath, uploadSource, UploadError, type WaitUntilContext } from '../services/upload';

const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const TELEGRAM_WEB_UPLOAD_LIMIT = 20 * 1024 * 1024;
const HF_DIRECT_THRESHOLD = 20 * 1024 * 1024;
const HF_DIRECT_MAX = 5 * 1024 * 1024 * 1024;

interface HfDirectTask {
  kind: 'multipart' | 'single' | 'exists';
  path: string;
  publicId: string;
  kvKey: string;
  oid: string;
  size: number;
  partSize: number;
  parts: HfLfsPart[];
  completionUrl?: string;
  singleUrl?: string;
}

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
  mode?: 'kv' | 'hf-direct';
  hf?: HfDirectTask;
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

function newPublicId(fileName: string, contentType: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `hf_${Date.now()}_${suffix}.${getFileExtension(fileName, contentType)}`;
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

function readEtags(value: unknown): Map<number, string> {
  const result = new Map<number, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const partNumber = Number(record.partNumber ?? record.part);
      const etag = String(record.etag ?? '').trim();
      if (Number.isInteger(partNumber) && partNumber > 0 && etag) result.set(partNumber, etag);
    }
    return result;
  }
  if (value && typeof value === 'object') {
    for (const [key, etag] of Object.entries(value as Record<string, unknown>)) {
      const partNumber = Number(key);
      const text = String(etag ?? '').trim();
      if (Number.isInteger(partNumber) && partNumber > 0 && text) result.set(partNumber, text);
    }
  }
  return result;
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

  if (!fileName || !fileSize) {
    return json({ error: '缺少必要参数' }, 400);
  }

  if (
    storageMode !== 'telegram' &&
    storageMode !== 'webdav' &&
    storageMode !== 'huggingface' &&
    storageMode !== 'github'
  ) {
    return json({ error: `Storage backend "${storageMode}" is not implemented.` }, 501);
  }

  if (storageMode === 'telegram' && fileSize > TELEGRAM_WEB_UPLOAD_LIMIT) {
    return json(
      {
        error: 'Telegram 云端 Bot API 的下载上限为 20MB；更大的文件请使用 HuggingFace 或 WebDAV。',
        code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      },
      400
    );
  }

  if (storageMode === 'huggingface' && fileSize > HF_DIRECT_THRESHOLD) {
    if (fileSize > HF_DIRECT_MAX) {
      return json({ error: `HuggingFace 直传上限为 ${HF_DIRECT_MAX / 1024 / 1024}MB。`, code: 'FILE_TOO_LARGE' }, 413);
    }

    const fileHash = String(body.fileHash || '').trim().toLowerCase();
    const sampleBase64 = String(body.sample || '').trim();
    if (!/^[a-f0-9]{64}$/.test(fileHash) || !sampleBase64) {
      return json(
        { error: 'HuggingFace 大文件直传需要 fileHash 和 sample。', code: 'HF_FINGERPRINT_REQUIRED' },
        400
      );
    }

    const normalizedFolder = normalizeFolderPath(folderPath);
    const publicId = newPublicId(fileName, fileType);
    const path = normalizedFolder ? `${normalizedFolder}/${publicId}` : publicId;

    let plan: Awaited<ReturnType<typeof planHuggingFaceDirectUpload>>;
    try {
      plan = await planHuggingFaceDirectUpload(env, {
        path,
        size: fileSize,
        oid: fileHash,
        sampleBase64,
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'HuggingFace 直传初始化失败', code: errorCode(error) },
        errorStatus(error)
      );
    }

    if (plan.mode === 'regular' && fileSize > 35 * 1024 * 1024) {
      return json(
        { error: 'HuggingFace 未将该文件判定为 LFS，超过 35MB 无法安全上传。', code: 'HF_LFS_REQUIRED' },
        413
      );
    }

    if (plan.mode !== 'regular') {
      const uploadId = newUploadId();
      const kvKey = `hf:${publicId}`;
      const hf: HfDirectTask = {
        kind: plan.mode,
        path,
        publicId,
        kvKey,
        oid: plan.oid,
        size: plan.size,
        partSize: plan.mode === 'multipart' ? plan.partSize : plan.size,
        parts: plan.mode === 'multipart' ? plan.parts : [],
        ...(plan.mode === 'multipart' ? { completionUrl: plan.completionUrl } : {}),
        ...(plan.mode === 'single' ? { singleUrl: plan.uploadUrl } : {}),
      };
      const task: ChunkTask = {
        uploadId,
        fileName,
        fileSize,
        fileType,
        totalChunks: plan.mode === 'multipart' ? plan.parts.length : 1,
        storageMode,
        folderPath: normalizedFolder,
        createdAt: Date.now(),
        status: 'pending',
        mode: 'hf-direct',
        hf,
      };

      await env.img_url.put(taskKey(uploadId), JSON.stringify(task), { expirationTtl: 3600 });

      return json({
        success: true,
        uploadId,
        mode: 'hf-direct',
        uploadKind: plan.mode,
        partSize: hf.partSize,
        parts: hf.parts,
        singleUrl: hf.singleUrl || null,
        totalParts: hf.parts.length,
      });
    }
  }

  if (fileSize > MAX_FILE_SIZE) {
    return json({ error: `文件大小超过限制 (最大 ${MAX_FILE_SIZE / 1024 / 1024}MB)`, code: 'FILE_TOO_LARGE' }, 413);
  }
  if (!totalChunks) {
    return json({ error: '缺少必要参数' }, 400);
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

  if (task.mode === 'hf-direct') {
    const hf = task.hf;
    if (!hf || hf.kind !== 'multipart') {
      return json({ error: '该 HuggingFace 任务不需要分片。' }, 400);
    }
    const part = hf.parts[chunkIndex];
    if (!part) {
      return json({ error: '分片索引超出范围' }, 400);
    }
    const buffer = await chunk.arrayBuffer();
    const response = await fetch(part.url, { method: 'PUT', body: buffer });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return json(
        { error: `HuggingFace 分片 ${part.partNumber} 上传失败：${text || response.status}`, code: 'UPSTREAM' },
        502
      );
    }
    const etag = response.headers.get('ETag');
    if (!etag) {
      return json({ error: 'HuggingFace 分片上传未返回 ETag。', code: 'UPSTREAM' }, 502);
    }
    return json({ success: true, chunkIndex, partNumber: part.partNumber, etag });
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

  if (task.mode === 'hf-direct') {
    const hf = task.hf;
    if (!hf) {
      return json({ error: '上传任务状态异常' }, 500);
    }

    try {
      if (hf.kind === 'multipart') {
        if (!hf.completionUrl) {
          return json({ error: '上传任务缺少合并地址' }, 500);
        }
        const etags = readEtags(body.etags);
        const missing = hf.parts
          .map((part) => part.partNumber)
          .filter((partNumber) => !etags.has(partNumber));
        if (missing.length) {
          return json({ error: `分片不完整，缺少 ETag：${missing.join(',')}`, code: 'MISSING_ETAGS' }, 400);
        }
        await completeHuggingFaceMultipart(env, {
          oid: hf.oid,
          completionUrl: hf.completionUrl,
          parts: hf.parts.map((part) => ({
            partNumber: part.partNumber,
            etag: etags.get(part.partNumber) || '',
          })),
        });
      }

      const commitOid = await commitHuggingFaceLfs(env, {
        path: hf.path,
        oid: hf.oid,
        size: hf.size,
        fileName: task.fileName,
      });

      const metadata: FileMetadata = {
        TimeStamp: Date.now(),
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName: task.fileName,
        fileSize: task.fileSize,
        storageType: 'huggingface',
        ...(task.folderPath ? { folderPath: task.folderPath } : {}),
        hfPath: hf.path,
        ...(commitOid ? { hfCommit: commitOid } : {}),
      };
      await env.img_url.put(hf.kvKey, '', { metadata });
      await env.img_url.delete(taskKey(uploadId));

      return json({ success: true, src: `/file/${hf.kvKey}` });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'HuggingFace 提交失败', code: errorCode(error) },
        errorStatus(error)
      );
    }
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

import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import {
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  deleteTelegramMessage,
  getFileExtension,
  getTelegramBotInfo,
  getTelegramChatId,
  getTelegramFilePath,
  getTelegramToken,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
  type TelegramApiResult,
} from '../lib/telegram';
import type { OpenInput, OpenResult, PutInput, PutResult, StorageBackend } from './types';
import { StorageError } from './types';

const MAX_TELEGRAM_BYTES = 20 * 1024 * 1024;
const FILE_PATH_TTL_MS = 50 * 60 * 1000;
const FILE_PATH_CACHE_LIMIT = 500;

const filePathCache = new Map<string, { path: string; expiresAt: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCachedTelegramFilePath(env: Env, fileId: string): Promise<string | null> {
  const now = Date.now();
  const cached = filePathCache.get(fileId);
  if (cached && cached.expiresAt > now) {
    return cached.path;
  }
  if (cached) filePathCache.delete(fileId);

  const path = await getTelegramFilePath(env, fileId);
  if (!path) return null;

  if (filePathCache.size >= FILE_PATH_CACHE_LIMIT) {
    const oldest = filePathCache.keys().next().value;
    if (oldest) filePathCache.delete(oldest);
  }
  filePathCache.set(fileId, { path, expiresAt: now + FILE_PATH_TTL_MS });
  return path;
}

async function sendWithRetry(
  env: Env,
  method: string,
  field: string,
  buffer: ArrayBuffer,
  fileName: string,
  contentType: string,
  attempt = 0
): Promise<{ ok: boolean; status: number; data: TelegramApiResult }> {
  const formData = new FormData();
  formData.set('chat_id', getTelegramChatId(env));
  formData.set(
    field,
    new File([buffer], fileName, { type: contentType || 'application/octet-stream' }),
    fileName
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response: Response;
  try {
    response = await fetch(buildTelegramBotApiUrl(env, method), {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      return sendWithRetry(env, method, field, buffer, fileName, contentType, attempt + 1);
    }
    throw new StorageError('TIMEOUT', 'Telegram upload timed out.', 504);
  } finally {
    clearTimeout(timeout);
  }

  const data = (await response.json().catch(() => ({}))) as TelegramApiResult;

  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number(data.parameters?.retry_after || 5);
    await sleep(Math.max(retryAfter, 1) * 1000);
    return sendWithRetry(env, method, field, buffer, fileName, contentType, attempt + 1);
  }

  if ((!response.ok || !data.ok) && method === 'sendAudio' && attempt < 3) {
    return sendWithRetry(env, 'sendDocument', 'document', buffer, fileName, contentType, attempt + 1);
  }

  return { ok: response.ok && Boolean(data.ok), status: response.status, data };
}

export function createTelegramBackend(env: Env): StorageBackend {
  return {
    type: 'telegram',
    caps: {
      range: true,
      maxBytes: MAX_TELEGRAM_BYTES,
      streamUp: false,
    },

    async put(input: PutInput): Promise<PutResult> {
      if (!getTelegramToken(env) || !getTelegramChatId(env)) {
        throw new StorageError('NOT_CONFIGURED', 'Telegram bot token or chat id is not configured.');
      }

      const buffer =
        input.body instanceof ArrayBuffer
          ? input.body
          : await new Response(input.body).arrayBuffer();
      const extension = getFileExtension(input.fileName, input.contentType);
      const normalizedName = input.fileName || `upload.${extension}`;
      const { method, field } = getTelegramUploadMethodAndField(input.contentType);

      const result = await sendWithRetry(
        env,
        method,
        field,
        buffer,
        normalizedName,
        input.contentType
      );

      if (result.status === 413) {
        throw new StorageError('TOO_LARGE', 'Telegram rejected the file as too large.', 413);
      }

      const fileId = pickTelegramFileId(result.data);
      if (!result.ok || !fileId) {
        throw new StorageError(
          'UPSTREAM',
          result.data.description || 'Telegram did not return a file id.',
          result.status
        );
      }

      return {
        storageKey: `${fileId}.${extension}`,
        meta: {
          telegramFileId: fileId,
          telegramMessageId: result.data.result?.message_id,
        },
      };
    },

    async open(input: OpenInput): Promise<OpenResult> {
      const metadata = input.record.metadata as FileMetadata;
      const fileId = String(
        metadata.telegramFileId || input.record.storageKey.split('.')[0] || ''
      );
      if (!fileId) {
        throw new StorageError('NOT_FOUND', 'Telegram file id is missing from metadata.', 404);
      }

      const path = await getCachedTelegramFilePath(env, fileId);
      if (!path) {
        throw new StorageError('UPSTREAM', 'Failed to resolve the Telegram file path.', 502);
      }

      const headers = new Headers();
      if (input.range) headers.set('Range', input.range);

      const upstream = await fetch(buildTelegramFileUrl(env, path), {
        method: input.method,
        headers,
      });

      if (upstream.status === 404) {
        throw new StorageError('NOT_FOUND', 'Telegram file not found.', 404);
      }
      if (!upstream.ok && upstream.status !== 206) {
        throw new StorageError('UPSTREAM', 'Telegram file download failed.', upstream.status);
      }

      return {
        status: upstream.status,
        headers: upstream.headers,
        body: input.method === 'HEAD' ? null : upstream.body,
      };
    },

    async remove(record): Promise<void> {
      const metadata = record.metadata as FileMetadata;
      const messageId = Number(metadata.telegramMessageId || 0);
      if (!messageId) return;
      await deleteTelegramMessage(env, getTelegramChatId(env), messageId);
    },

    async check(): Promise<{ connected: boolean; message: string }> {
      const info = await getTelegramBotInfo(env);
      return { connected: info.connected, message: info.message };
    },
  };
}

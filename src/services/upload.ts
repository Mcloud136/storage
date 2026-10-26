import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import type { StorageBackend } from '../backends/types';
import { createBackend, isBackendConfigured, isSupportedStorageMode, normalizeStorageMode } from '../backends';
import {
  buildTelegramDirectLink,
  createSignedTelegramFileId,
  getFileExtension,
  getTelegramChatId,
  sendTelegramUploadNotice,
  shouldNotifyTelegramUpload,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
} from '../lib/telegram';

export class UploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
  }
}

export interface UploadSource {
  fileName: string;
  contentType: string;
  size: number;
  buffer: ArrayBuffer;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface UploadOptions {
  env: Env;
  source: UploadSource;
  storageMode: string;
  folderPath?: string;
  origin?: string;
  ctx?: WaitUntilContext | null;
  backendFactory?: (type: string, env: Env) => StorageBackend;
}

export interface UploadResult {
  src: string;
  kvKey: string;
  publicId: string;
  storageType: string;
}

const LIMITS: Record<string, number> = {
  telegram: 20 * 1024 * 1024,
  webdav: 100 * 1024 * 1024,
  huggingface: 35 * 1024 * 1024,
  github: 100 * 1024 * 1024,
};

export function normalizeFolderPath(value: string | undefined): string {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      segments.pop();
      continue;
    }
    segments.push(piece);
  }
  return segments.join('/');
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now()}_${suffix}`;
}

function commonMetadata(
  source: UploadSource,
  storageType: string,
  folderPath: string
): FileMetadata {
  return {
    TimeStamp: Date.now(),
    ListType: 'None',
    Label: 'None',
    liked: false,
    fileName: source.fileName,
    fileSize: source.size,
    storageType,
    ...(folderPath ? { folderPath } : {}),
  };
}

async function writeMetadata(env: Env, kvKey: string, metadata: FileMetadata): Promise<void> {
  if (!env.img_url) return;
  await env.img_url.put(kvKey, '', { metadata });
}

export async function uploadSource(options: UploadOptions): Promise<UploadResult> {
  const {
    env,
    source,
    storageMode,
    folderPath = '',
    origin = '',
    ctx = null,
    backendFactory = createBackend,
  } = options;

  const normalizedMode = normalizeStorageMode(storageMode);
  if (!isSupportedStorageMode(normalizedMode)) {
    throw new UploadError(
      501,
      'STORAGE_NOT_IMPLEMENTED',
      `Storage backend "${normalizedMode || 'unknown'}" is not implemented in v2 M2.`
    );
  }

  if (!isBackendConfigured(normalizedMode, env)) {
    throw new UploadError(400, 'STORAGE_NOT_CONFIGURED', `${normalizedMode} is not configured.`);
  }

  const limit = LIMITS[normalizedMode];
  if (limit && source.size > limit) {
    throw new UploadError(
      413,
      'FILE_TOO_LARGE',
      `${normalizedMode} uploads are limited to ${Math.floor(limit / 1024 / 1024)}MB.`
    );
  }

  if (!source.size) {
    throw new UploadError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
  }

  const normalizedFolder = normalizeFolderPath(folderPath);
  const backend = backendFactory(normalizedMode, env);
  const contentType = source.contentType || 'application/octet-stream';
  const extension = getFileExtension(source.fileName, contentType);

  if (normalizedMode === 'telegram') {
    const putResult = await backend.put({
      id: randomId('tg'),
      fileName: source.fileName,
      contentType,
      body: source.buffer,
      size: source.size,
      folderPath: normalizedFolder,
    });

    const fileId = String(putResult.meta.telegramFileId || '').trim();
    const messageId = Number(putResult.meta.telegramMessageId || 0) || undefined;
    if (!fileId) {
      throw new UploadError(502, 'UPSTREAM', 'Telegram did not return a file id.');
    }

    const useSigned = shouldUseSignedTelegramLinks(env);
    const publicId = useSigned
      ? await createSignedTelegramFileId(
          {
            fileId,
            fileExtension: extension,
            fileName: source.fileName,
            mimeType: contentType,
            fileSize: source.size,
            messageId,
          },
          env
        )
      : putResult.storageKey;

    const kvKey = putResult.storageKey;
    const metadata: FileMetadata = {
      ...commonMetadata(source, 'telegram', normalizedFolder),
      telegramFileId: fileId,
      telegramMessageId: messageId,
      signedLink: useSigned,
    };

    if (shouldWriteTelegramMetadata(env)) {
      await writeMetadata(env, kvKey, metadata);
    }

    if (shouldNotifyTelegramUpload(env) && getTelegramChatId(env)) {
      const directLink = buildTelegramDirectLink(env, publicId, origin);
      const notice = sendTelegramUploadNotice(
        {
          chatId: getTelegramChatId(env),
          replyToMessageId: messageId,
          directLink,
          fileId,
          messageId,
          fileName: source.fileName,
          fileSize: source.size,
        },
        env
      ).catch(() => undefined);

      if (ctx) {
        ctx.waitUntil(notice);
      } else {
        await notice;
      }
    }

    return {
      src: `/file/${publicId}`,
      kvKey,
      publicId,
      storageType: 'telegram',
    };
  }

  const prefix =
    normalizedMode === 'webdav' ? 'wd' : normalizedMode === 'huggingface' ? 'hf' : 'github';
  const publicId = `${randomId(prefix)}.${extension}`;
  const putResult = await backend.put({
    id: publicId,
    fileName: source.fileName,
    contentType,
    body: source.buffer,
    size: source.size,
    folderPath: normalizedFolder,
  });

  const kvPrefix = normalizedMode === 'huggingface' ? 'hf' : normalizedMode;
  const kvKey = `${kvPrefix}:${publicId}`;
  const metadata: FileMetadata = {
    ...commonMetadata(source, normalizedMode, normalizedFolder),
    ...putResult.meta,
  };

  await writeMetadata(env, kvKey, metadata);

  return {
    src: `/file/${kvKey}`,
    kvKey,
    publicId,
    storageType: normalizedMode,
  };
}

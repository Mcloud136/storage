import { Hono } from 'hono';
import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import { getRecordWithKey } from '../core/kv';
import { inferStorageType } from '../core/keys';
import { createBackend } from '../backends';
import { StorageError } from '../backends/types';
import { buildFileHeaders, fileCorsHeaders, fileError } from '../lib/http';
import {
  blockRedirect,
  getMimeType,
  shouldBlock,
  shouldWhitelistDeny,
  whitelistRedirect,
} from '../lib/media';
import { parseSignedTelegramFileId } from '../lib/telegram';
import {
  incrementShareDownloadCount,
  shouldCountAsDownload,
  verifyShareAccess,
  type ShareAccess,
} from '../lib/share';

export const fileRoutes = new Hono<{ Bindings: Env }>();

function statusForStorageError(error: StorageError): number {
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'TOO_LARGE') return 413;
  if (error.code === 'NOT_CONFIGURED') return 501;
  return 502;
}

fileRoutes.on(['GET', 'HEAD', 'OPTIONS'], '/file/:id', async (c) => {
  const env = c.env;
  const method = c.req.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: fileCorsHeaders() });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return fileError('Method not allowed', 405);
  }

  const id = c.req.param('id');
  if (!id) {
    return fileError('Missing file id', 400);
  }

  const requestUrl = new URL(c.req.url);
  const range = c.req.header('Range') || null;

  let record: {
    id: string;
    storageType: string;
    storageKey: string;
    metadata: FileMetadata;
  };
  let kvKey: string;
  let shareAccess: ShareAccess | null = null;
  let fileName: string;
  let mimeType: string;
  let storageType: string;

  const signed = await parseSignedTelegramFileId(id, env);

  if (signed) {
    fileName = signed.fileName || `${signed.fileId}.${signed.fileExtension}`;
    mimeType = signed.mimeType || getMimeType(fileName);
    storageType = 'telegram';
    kvKey = `${signed.fileId}.${signed.fileExtension}`;
    record = {
      id: signed.fileId,
      storageType,
      storageKey: kvKey,
      metadata: {
        TimeStamp: signed.timestamp,
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName,
        fileSize: signed.fileSize,
        storageType: 'telegram',
        telegramFileId: signed.fileId,
        telegramMessageId: signed.messageId || undefined,
        signedLink: true,
      },
    };
  } else {
    if (!env.img_url) {
      return fileError('KV storage not available', 500);
    }

    const resolved = await getRecordWithKey(env.img_url, id);
    if (!resolved.record?.metadata) {
      return fileError('File not found', 404);
    }

    kvKey = resolved.kvKey;
    const metadata = resolved.record.metadata;
    shareAccess = await verifyShareAccess(c.req.raw, metadata, kvKey);
    if (shareAccess.response) {
      return shareAccess.response;
    }

    if (shouldBlock(metadata)) {
      return blockRedirect(requestUrl, c.req.raw);
    }
    if (shouldWhitelistDeny(env, metadata)) {
      return whitelistRedirect(requestUrl);
    }

    storageType = inferStorageType(kvKey, metadata);
    fileName = metadata.fileName || id;
    mimeType = getMimeType(fileName);
    record = {
      id: kvKey,
      storageType,
      storageKey: kvKey,
      metadata,
    };
  }

  try {
    const backend = createBackend(storageType, env);
    const openResult = await backend.open({
      record,
      method,
      range,
    });

    const headers = buildFileHeaders(fileName, mimeType);
    const contentLength = openResult.headers.get('Content-Length');
    const contentRange = openResult.headers.get('Content-Range');
    if (contentLength) headers.set('Content-Length', contentLength);
    if (contentRange) headers.set('Content-Range', contentRange);

    if (
      shareAccess?.trackDownload &&
      shareAccess.kvKey &&
      shareAccess.metadata &&
      shouldCountAsDownload(method, openResult.status) &&
      env.img_url
    ) {
      const update = incrementShareDownloadCount(
        env.img_url,
        shareAccess.kvKey,
        shareAccess.metadata
      ).catch(() => undefined);
      try {
        c.executionCtx.waitUntil(update);
      } catch {
        // Tests and non-Workers contexts may not expose executionCtx.
      }
    }

    return new Response(method === 'HEAD' ? null : openResult.body, {
      status: openResult.status,
      headers,
    });
  } catch (error) {
    if (error instanceof StorageError) {
      return fileError(error.message, statusForStorageError(error));
    }
    return fileError(error instanceof Error ? error.message : 'File proxy error', 502);
  }
});

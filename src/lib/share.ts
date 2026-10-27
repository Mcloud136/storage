import type { FileMetadata } from '../core/keys';
import { fileError } from './http';
import { verifyPassword } from './crypto';

export interface ShareAccess {
  response: Response | null;
  trackDownload?: boolean;
  kvKey?: string;
  metadata?: FileMetadata;
}

function getSharePassword(request: Request): string {
  const url = new URL(request.url);
  return String(
    url.searchParams.get('password') ||
      request.headers.get('X-File-Password') ||
      request.headers.get('X-Share-Password') ||
      ''
  );
}

export async function verifyShareAccess(
  request: Request,
  metadata: FileMetadata = {},
  kvKey = ''
): Promise<ShareAccess> {
  const expiresAt = Number(metadata.shareExpiresAt || 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
    return { response: fileError('File link has expired', 410) };
  }

  const maxDownloads = Number(metadata.shareMaxDownloads || 0);
  const currentDownloads = Number(metadata.shareDownloadCount || 0);
  if (Number.isFinite(maxDownloads) && maxDownloads > 0 && currentDownloads >= maxDownloads) {
    return { response: fileError('File download limit reached', 410) };
  }

  if (metadata.sharePasswordHash) {
    const providedPassword = getSharePassword(request);
    if (!providedPassword) {
      return { response: fileError('File password required', 401) };
    }
    const valid = await verifyPassword(
      providedPassword,
      String(metadata.sharePasswordHash || ''),
      String(metadata.sharePasswordSalt || '')
    );
    if (!valid) {
      return { response: fileError('File password invalid', 403) };
    }
  }

  return {
    response: null,
    trackDownload: Number.isFinite(maxDownloads) && maxDownloads > 0,
    kvKey,
    metadata,
  };
}

export function shouldCountAsDownload(method: string, status: number): boolean {
  return String(method || '').toUpperCase() === 'GET' && (status === 200 || status === 206);
}

export async function incrementShareDownloadCount(
  kv: KVNamespace,
  kvKey: string,
  metadata: FileMetadata
): Promise<void> {
  if (!kv || !kvKey || !metadata) return;
  const nextMetadata = {
    ...metadata,
    shareDownloadCount: Number(metadata.shareDownloadCount || 0) + 1,
  };
  await kv.put(kvKey, '', { metadata: nextMetadata });
}

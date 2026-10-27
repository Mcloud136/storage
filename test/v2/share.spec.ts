import { describe, expect, it } from 'vitest';
import type { FileMetadata } from '../../src/core/keys';
import { verifyShareAccess } from '../../src/lib/share';
import { hashPassword } from '../../src/lib/crypto';

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function request(url = 'https://example.com/file/test'): Request {
  return new Request(url);
}

describe('share access', () => {
  it('allows unrestricted files', async () => {
    const result = await verifyShareAccess(request(), {}, 'k');
    expect(result.response).toBeNull();
    expect(result.trackDownload).toBe(false);
  });

  it('rejects expired links', async () => {
    const metadata: FileMetadata = { shareExpiresAt: Date.now() - 1000 };
    const result = await verifyShareAccess(request(), metadata, 'k');
    expect(result.response?.status).toBe(410);
  });

  it('rejects files over the download limit', async () => {
    const metadata: FileMetadata = { shareMaxDownloads: 2, shareDownloadCount: 2 };
    const result = await verifyShareAccess(request(), metadata, 'k');
    expect(result.response?.status).toBe(410);
  });

  it('validates PBKDF2 share passwords', async () => {
    const metadata: FileMetadata = { sharePasswordHash: await hashPassword('secret') };
    const missing = await verifyShareAccess(request(), metadata, 'k');
    expect(missing.response?.status).toBe(401);
    const wrong = await verifyShareAccess(request('https://example.com/file/test?password=nope'), metadata, 'k');
    expect(wrong.response?.status).toBe(403);
    const correct = await verifyShareAccess(request('https://example.com/file/test?password=secret'), metadata, 'k');
    expect(correct.response).toBeNull();
  });

  it('requires and validates a legacy password', async () => {
    const salt = 'salt123';
    const metadata: FileMetadata = {
      sharePasswordSalt: salt,
      sharePasswordHash: await sha256Hex(`${salt}:secret`),
    };

    const missing = await verifyShareAccess(request(), metadata, 'k');
    expect(missing.response?.status).toBe(401);

    const wrong = await verifyShareAccess(request('https://example.com/file/test?password=nope'), metadata, 'k');
    expect(wrong.response?.status).toBe(403);

    const correct = await verifyShareAccess(request('https://example.com/file/test?password=secret'), metadata, 'k');
    expect(correct.response).toBeNull();
  });
});

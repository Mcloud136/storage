import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { FileMetadata } from '../../src/core/keys';

const BASE = 'https://example.com';

async function loginCookie(): Promise<string> {
  const response = await exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
  });
  return (response.headers.get('Set-Cookie') || '').split(';')[0];
}

describe('manage API', () => {
  it('lists files, toggles flags, renames and moves folders', async () => {
    const key = `webdav:manage_${Date.now()}.txt`;
    await env.img_url.put(key, '', {
      metadata: {
        fileName: 'manage.txt',
        fileSize: 3,
        TimeStamp: Date.now(),
        storageType: 'webdav',
        webdavPath: 'manage.txt',
        ListType: 'None',
      },
    });

    const cookie = await loginCookie();
    const list = await exports.default.fetch(`${BASE}/api/manage/list?storage=all`, {
      headers: { Cookie: cookie },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { keys: Array<{ name: string }> };
    expect(listBody.keys.some((item) => item.name === key)).toBe(true);

    const like = await exports.default.fetch(`${BASE}/api/manage/toggleLike/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(like.status).toBe(200);

    const rename = await exports.default.fetch(
      `${BASE}/api/manage/editName/${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ newName: 'renamed.txt' }),
      }
    );
    expect(rename.status).toBe(200);

    const block = await exports.default.fetch(`${BASE}/api/manage/block/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(block.status).toBe(200);

    const moved = await exports.default.fetch(`${BASE}/api/manage/files/move-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ids: [key], targetFolderPath: 'demo' }),
    });
    expect(moved.status).toBe(200);

    const stored = await env.img_url.getWithMetadata<FileMetadata>(key);
    expect(stored?.metadata?.liked).toBe(true);
    expect(stored?.metadata?.fileName).toBe('renamed.txt');
    expect(stored?.metadata?.ListType).toBe('Block');
    expect(stored?.metadata?.folderPath).toBe('demo');
  });
});

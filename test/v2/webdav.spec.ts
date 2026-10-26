import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { createWebDAVBackend } from '../../src/backends/webdav';

const env = {
  WEBDAV_BASE_URL: 'https://dav.example.com/dav',
  WEBDAV_USERNAME: 'user',
  WEBDAV_PASSWORD: 'pass',
  WEBDAV_ROOT_PATH: 'root',
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebDAV backend', () => {
  it('creates collections and uploads with basic auth', async () => {
    const calls: Array<{ url: string; method: string; auth: string | null }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        calls.push({
          url,
          method,
          auth: new Headers(init?.headers).get('Authorization'),
        });

        if (method === 'MKCOL') return new Response(null, { status: 201 });
        if (method === 'PUT') {
          return new Response(null, { status: 201, headers: { etag: '"abc"' } });
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const backend = createWebDAVBackend(env);
    const result = await backend.put({
      id: 'wd_1.txt',
      fileName: 'a.txt',
      contentType: 'text/plain',
      body: new TextEncoder().encode('hi').buffer as ArrayBuffer,
      size: 2,
      folderPath: 'uploads',
    });

    expect(result.storageKey).toBe('uploads/wd_1.txt');
    expect(result.meta.webdavEtag).toBe('"abc"');
    expect(calls.some((call) => call.method === 'MKCOL' && call.url.includes('/root/uploads'))).toBe(true);
    expect(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/root/uploads/wd_1.txt'))).toBe(true);
    expect(calls[0]?.auth?.startsWith('Basic ')).toBe(true);
  });

  it('returns ranged download responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('hello', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-4/5',
            'Content-Length': '5',
          },
        });
      })
    );

    const backend = createWebDAVBackend(env);
    const result = await backend.open({
      record: {
        id: 'webdav:wd_1.txt',
        storageType: 'webdav',
        storageKey: 'uploads/wd_1.txt',
        metadata: { webdavPath: 'uploads/wd_1.txt' },
      },
      method: 'GET',
      range: 'bytes=0-4',
    });

    expect(result.status).toBe(206);
    expect(await new Response(result.body).text()).toBe('hello');
  });

  it('treats 404 as not found and deletes best-effort', async () => {
    let deleteCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: any, init?: any) => {
        if (String(init?.method || '').toUpperCase() === 'GET') {
          return new Response('missing', { status: 404 });
        }
        deleteCalled = true;
        return new Response(null, { status: 204 });
      })
    );

    const backend = createWebDAVBackend(env);
    await expect(
      backend.open({
        record: {
          id: 'webdav:missing',
          storageType: 'webdav',
          storageKey: 'missing',
          metadata: { webdavPath: 'missing' },
        },
        method: 'GET',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await backend.remove({
      id: 'webdav:missing',
      storageType: 'webdav',
      storageKey: 'missing',
      metadata: { webdavPath: 'missing' },
    });
    expect(deleteCalled).toBe(true);
  });
});

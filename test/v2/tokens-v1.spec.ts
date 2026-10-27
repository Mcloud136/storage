import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = 'https://example.com';

async function loginCookie(): Promise<string> {
  const response = await exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('Set-Cookie') || '').split(';')[0];
}

async function createToken(scopes: string[], cookie: string): Promise<string> {
  const response = await exports.default.fetch(`${BASE}/api/admin/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: `test-${Date.now()}`, scopes, expiresAt: null }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { token: string };
  return body.token;
}

describe('API tokens and v1', () => {
  it('requires a bearer token except for capabilities', async () => {
    const capabilities = await exports.default.fetch(`${BASE}/api/v1/capabilities`);
    expect(capabilities.status).toBe(200);

    const meWithoutToken = await exports.default.fetch(`${BASE}/api/v1/me`);
    expect(meWithoutToken.status).toBe(401);
  });

  it('creates, introspects, rotates and deletes a token', async () => {
    const cookie = await loginCookie();
    const token = await createToken(['read', 'paste'], cookie);

    const me = await exports.default.fetch(`${BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { scopes: string[] } };
    expect(meBody.data.scopes).toContain('read');

    const id = token.split('_')[1];
    const rotated = await exports.default.fetch(`${BASE}/api/admin/tokens/${id}/rotate`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { token: string };
    expect(rotatedBody.token).not.toBe(token);

    const oldToken = await exports.default.fetch(`${BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(oldToken.status).toBe(401);

    const newToken = await exports.default.fetch(`${BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${rotatedBody.token}` },
    });
    expect(newToken.status).toBe(200);

    const deleted = await exports.default.fetch(`${BASE}/api/admin/tokens/${id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await exports.default.fetch(`${BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${rotatedBody.token}` },
    });
    expect(afterDelete.status).toBe(401);
  });

  it('creates and reads a paste through v1', async () => {
    const cookie = await loginCookie();
    const token = await createToken(['paste', 'read', 'delete'], cookie);

    const created = await exports.default.fetch(`${BASE}/api/v1/paste`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'hello paste', language: 'text' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { paste: { id: string } };

    const read = await exports.default.fetch(`${BASE}/api/v1/paste/${createdBody.paste.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { paste: { content: string } };
    expect(readBody.paste.content).toBe('hello paste');
  });

  it('requires read scope for HEAD requests', async () => {
    const cookie = await loginCookie();
    const token = await createToken(['upload'], cookie);
    const response = await exports.default.fetch(`${BASE}/api/v1/file/anything`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it('enforces token rate-limit policies', async () => {
    const cookie = await loginCookie();
    const created = await exports.default.fetch(`${BASE}/api/admin/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: `rate-${Date.now()}`,
        scopes: ['read'],
        expiresAt: null,
        policies: { rateLimit: { windowMs: 60000, max: 1 } },
      }),
    });
    expect(created.status).toBe(201);
    const token = ((await created.json()) as { token: string }).token;

    const first = await exports.default.fetch(`${BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);

    const second = await exports.default.fetch(`${BASE}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(429);
  });

  it('uploads and serves bytes through v1', async () => {
    const cookie = await loginCookie();
    const token = await createToken(['upload', 'read', 'delete'], cookie);
    const telegramFileId = `V1FILE${Date.now()}`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes('/sendDocument')) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: 7, document: { file_id: telegramFileId } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/getFile')) {
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: 'documents/v1.txt' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/file/bot')) {
          return new Response('v1-content', { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const form = new FormData();
    form.set('file', new File(['v1-content'], 'v1.txt', { type: 'text/plain' }));
    form.set('storage', 'telegram');

    const upload = await exports.default.fetch(`${BASE}/api/v1/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploadBody = (await upload.json()) as { file: { id: string } };

    const download = await exports.default.fetch(
      `${BASE}/api/v1/file/${encodeURIComponent(uploadBody.file.id)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('v1-content');
  });
});

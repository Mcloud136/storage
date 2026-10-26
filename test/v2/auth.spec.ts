import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { isAuthRequired, requireAdmin } from '../../src/lib/auth';

const BASE = 'https://example.com';

async function loginCookie(): Promise<string> {
  const response = await exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('Set-Cookie') || '';
  expect(setCookie).toContain('k_vault_session=');
  return setCookie.split(';')[0];
}

describe('auth and session', () => {
  it('reports authRequired and guest config', async () => {
    const response = await exports.default.fetch(`${BASE}/api/auth/check`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      authRequired: boolean;
      authenticated: boolean;
      guestUpload: { enabled: boolean };
    };
    expect(body.authRequired).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.guestUpload.enabled).toBe(false);
  });

  it('logs in and accepts the session cookie', async () => {
    const cookie = await loginCookie();
    const response = await exports.default.fetch(`${BASE}/api/auth/check`, {
      headers: { Cookie: cookie },
    });
    const body = (await response.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const response = await exports.default.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    expect(response.status).toBe(401);
  });

  it('redirects /api/manage/login to admin.html', async () => {
    const response = await exports.default.fetch(`${BASE}/api/manage/login`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('/admin.html');
  });

  it('protects ui-config writes and uploads when guest upload is disabled', async () => {
    const withoutLogin = await exports.default.fetch(`${BASE}/api/ui-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { cardOpacity: 50 } }),
    });
    expect(withoutLogin.status).toBe(401);

    const cookie = await loginCookie();
    const withLogin = await exports.default.fetch(`${BASE}/api/ui-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ config: { baseColor: '#123456', cardOpacity: 50 } }),
    });
    expect(withLogin.status).toBe(200);

    const form = new FormData();
    form.set('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
    const upload = await exports.default.fetch(`${BASE}/upload`, {
      method: 'POST',
      body: form,
    });
    expect(upload.status).toBe(401);
  });

  it('fails closed when admin credentials are not configured', async () => {
    const env = {} as Env;
    expect(isAuthRequired(env)).toBe(false);
    const response = await requireAdmin(new Request(`${BASE}/api/manage/list`), env);
    expect(response?.status).toBe(503);
  });
});

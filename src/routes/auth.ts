import { Hono } from 'hono';
import type { Env } from '../env';
import {
  checkAuthentication,
  clearSessionCookies,
  createSession,
  deleteSession,
  isAuthRequired,
  isSecureRequest,
  sessionCookie,
  verifyCredentials,
} from '../lib/auth';
import { getGuestConfig } from '../lib/guest';
import { json } from '../lib/http';

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get('/api/auth/check', async (c) => {
  const env = c.env;
  const guestUpload = getGuestConfig(env);
  const authRequired = isAuthRequired(env);

  if (!authRequired) {
    return json({
      authenticated: false,
      authRequired: false,
      message: '无需登录',
      guestUpload,
    });
  }

  const result = await checkAuthentication(c.req.raw, env);
  return json({
    authenticated: result.authenticated,
    authRequired: true,
    reason: result.reason,
    guestUpload,
  });
});

authRoutes.get('/api/auth/login', (c) => {
  return json({ authRequired: isAuthRequired(c.env) });
});

authRoutes.post('/api/auth/login', async (c) => {
  const env = c.env;

  if (!isAuthRequired(env)) {
    return json(
      {
        success: false,
        error: 'ADMIN_NOT_CONFIGURED',
        message: '管理员账号未配置，请先设置 BASIC_USER 与 BASIC_PASS。',
      },
      503
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const username = String(body.username ?? body.user ?? '').trim();
  const password = String(body.password ?? body.pass ?? '');

  if (!username || password === '') {
    return json({ success: false, message: 'Missing username or password.' }, 400);
  }

  if (!verifyCredentials(username, password, env)) {
    return json({ success: false, message: '用户名或密码错误' }, 401);
  }

  const { token } = await createSession(env, username);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('Set-Cookie', sessionCookie(token, isSecureRequest(c.req.raw)));

  return new Response(JSON.stringify({ success: true, message: '登录成功' }), { headers });
});

authRoutes.post('/api/auth/logout', async (c) => {
  const env = c.env;
  await deleteSession(c.req.raw, env);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const cookie of clearSessionCookies(isSecureRequest(c.req.raw))) {
    headers.append('Set-Cookie', cookie);
  }

  return new Response(JSON.stringify({ success: true, message: '已退出登录' }), { headers });
});

authRoutes.get('/api/manage/login', (c) => {
  return c.redirect(new URL('/admin.html', c.req.url).toString(), 302);
});

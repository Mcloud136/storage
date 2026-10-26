import { Hono } from 'hono';
import type { Env } from '../env';
import { requireAdmin } from '../lib/auth';
import { apiError, json } from '../lib/http';
import {
  createApiToken,
  deleteApiToken,
  listApiTokens,
  parseTokenExpiry,
  rotateApiToken,
  TokenError,
  updateApiToken,
} from '../lib/api-token';

export const adminTokenRoutes = new Hono<{ Bindings: Env }>();

function tokenError(error: unknown): Response {
  if (error instanceof TokenError) {
    return apiError(error.code, error.message, error.status);
  }
  return apiError(
    'TOKEN_ERROR',
    error instanceof Error ? error.message : 'Token operation failed.',
    500
  );
}

adminTokenRoutes.get('/api/admin/tokens', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  const tokens = await listApiTokens(c.env);
  return json({ success: true, tokens });
});

adminTokenRoutes.post('/api/admin/tokens', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const created = await createApiToken(c.env, {
      name: String(body.name || ''),
      scopes: body.scopes,
      expiresAt: parseTokenExpiry(body.expiresAt),
      policies: body.policies,
    });
    return json({ success: true, token: created.token, tokens: await listApiTokens(c.env) }, 201);
  } catch (error) {
    return tokenError(error);
  }
});

adminTokenRoutes.patch('/api/admin/tokens/:id', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const token = await updateApiToken(c.env, id, {
      enabled: body.enabled,
      name: body.name,
      policies: body.policies,
    });
    return json({ success: true, token });
  } catch (error) {
    return tokenError(error);
  }
});

adminTokenRoutes.delete('/api/admin/tokens/:id', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  try {
    await deleteApiToken(c.env, c.req.param('id'));
    return json({ success: true });
  } catch (error) {
    return tokenError(error);
  }
});

adminTokenRoutes.post('/api/admin/tokens/:id/rotate', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  try {
    const result = await rotateApiToken(c.env, c.req.param('id'));
    return json({ success: true, token: result.token, tokens: await listApiTokens(c.env) });
  } catch (error) {
    return tokenError(error);
  }
});

adminTokenRoutes.get('/api/admin/audit-logs', async (c) => {
  const unauthorized = await requireAdmin(c.req.raw, c.env);
  if (unauthorized) return unauthorized;

  const prefix = 'audit:';
  const page = await c.env.img_url.list({ prefix, limit: 100 });
  const logs = await Promise.all(
    page.keys.map(async (key) => {
      const value = await c.env.img_url.get<Record<string, unknown>>(key.name, { type: 'json' });
      return value ? { key: key.name, ...value } : null;
    })
  );
  return json({ success: true, logs: logs.filter(Boolean) });
});

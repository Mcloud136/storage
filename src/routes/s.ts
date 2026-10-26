import { Hono } from 'hono';
import type { Env } from '../env';

const SHARE_SLUG_PREFIX = 'share_slug:';

function normalizeSlug(raw: string): string {
  const value = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(value) ? value : '';
}

export const shareRoutes = new Hono<{ Bindings: Env }>();

shareRoutes.get('/s/:slug', async (c) => {
  const env = c.env;
  const rawSlug = c.req.param('slug');
  if (!rawSlug) {
    return new Response('Not found', { status: 404 });
  }

  let targetId = '';
  const slug = normalizeSlug(rawSlug);

  if (slug && env.img_url) {
    const mapped = await env.img_url.get(`${SHARE_SLUG_PREFIX}${slug}`);
    if (mapped) targetId = String(mapped);
  }

  if (!targetId) {
    targetId = rawSlug;
  }

  const redirectUrl = new URL(`/file/${encodeURIComponent(targetId)}`, c.req.url);
  const sourceUrl = new URL(c.req.url);
  sourceUrl.searchParams.forEach((value, key) => {
    redirectUrl.searchParams.set(key, value);
  });

  return c.redirect(redirectUrl.toString(), 302);
});

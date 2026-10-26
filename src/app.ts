import { Hono } from 'hono';
import type { Env } from './env';
import { healthRoutes } from './routes/health';

const app = new Hono<{ Bindings: Env }>();

app.route('/', healthRoutes);

// Match the legacy Pages behavior: GET/HEAD /upload renders the upload page,
// while POST /upload will be implemented in M2.
app.on(['GET', 'HEAD'], '/upload', (c) => {
  const assetUrl = new URL('/index.html', c.req.url).toString();
  const assetRequest = new Request(assetUrl, {
    method: c.req.method,
    headers: c.req.raw.headers,
  });
  return c.env.ASSETS.fetch(assetRequest);
});

app.all('/api/*', (c) =>
  c.json(
    {
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'This v2 route is not implemented yet.',
      },
    },
    501
  )
);

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json(
      {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Not found.',
        },
      },
      404
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;

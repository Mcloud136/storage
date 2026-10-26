import { Hono } from 'hono';
import type { Env } from './env';
import { authRoutes } from './routes/auth';
import { bingRoutes } from './routes/bing';
import { chunkedRoutes } from './routes/chunked';
import { fileRoutes } from './routes/file';
import { fileInfoRoutes } from './routes/file-info';
import { healthRoutes } from './routes/health';
import { shareRoutes } from './routes/s';
import { statusRoutes } from './routes/status';
import { uiConfigRoutes } from './routes/ui-config';
import { uploadRoutes } from './routes/upload';
import { uploadFromUrlRoutes } from './routes/upload-from-url';

const app = new Hono<{ Bindings: Env }>();

app.route('/', healthRoutes);
app.route('/', authRoutes);
app.route('/', statusRoutes);
app.route('/', uiConfigRoutes);
app.route('/', fileInfoRoutes);
app.route('/', shareRoutes);
app.route('/', bingRoutes);
app.route('/', chunkedRoutes);
app.route('/', uploadRoutes);
app.route('/', uploadFromUrlRoutes);
app.route('/', fileRoutes);

// Match the legacy Pages behavior: GET/HEAD /upload renders the upload page,
// while POST /upload is handled by uploadRoutes above.
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

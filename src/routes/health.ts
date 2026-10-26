import { Hono } from 'hono';
import type { Env } from '../env';

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'mcloud-storage-v2',
    version: '0.1.0',
  })
);

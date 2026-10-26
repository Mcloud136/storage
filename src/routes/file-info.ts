import { Hono } from 'hono';
import type { Env } from '../env';
import { getRecordWithKey } from '../core/kv';
import { inferStorageType } from '../core/keys';
import { apiError, json } from '../lib/http';

export const fileInfoRoutes = new Hono<{ Bindings: Env }>();

fileInfoRoutes.get('/api/file-info/:id', async (c) => {
  const env = c.env;
  const id = c.req.param('id');

  if (!env.img_url) {
    return apiError('KV_BINDING_MISSING', 'KV binding img_url is not configured.', 500);
  }

  const resolved = await getRecordWithKey(env.img_url, id);
  const metadata = resolved.record?.metadata;
  if (!metadata) {
    return json({ error: 'File not found' }, 404);
  }

  return json({
    success: true,
    fileName: metadata.fileName || id,
    originalName: metadata.fileName || null,
    fileSize: Number(metadata.fileSize || 0),
    uploadTime: metadata.TimeStamp || null,
    storageType: inferStorageType(resolved.kvKey, metadata),
    listType: metadata.ListType || 'None',
    label: metadata.Label || 'None',
    liked: Boolean(metadata.liked),
  });
});

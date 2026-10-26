import { Hono } from 'hono';
import type { Env } from '../env';
import { isAuthRequired } from '../lib/auth';
import { getGuestConfig } from '../lib/guest';
import { json } from '../lib/http';
import { getTelegramApiBase, getTelegramBotInfo, getTelegramChatId, getTelegramToken } from '../lib/telegram';
import { checkWebDAVConnection } from '../backends/webdav';

const MB = 1024 * 1024;
const DIRECT_UPLOAD_THRESHOLD = 20 * MB;
const CHUNK_UPLOAD_LIMIT = 100 * MB;

export const statusRoutes = new Hono<{ Bindings: Env }>();

function defaultStatus(layer = 'direct') {
  return {
    connected: false,
    enabled: false,
    configured: false,
    layer,
    message: 'Not configured',
  };
}

function uploadLimits() {
  return {
    telegram: {
      maxBytes: DIRECT_UPLOAD_THRESHOLD,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: false,
      message:
        'Cloudflare Pages 上的 Telegram 网页上传限制为 20MB。较大的浏览器上传请使用 WebDAV，或直接把文件发到 Telegram 后使用 Webhook 回链。',
    },
    r2: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    s3: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    discord: {
      maxBytes: 25 * MB,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'Discord 上传上限受服务器加成影响，v2 暂未实现。',
    },
    huggingface: {
      maxBytes: 35 * MB,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    webdav: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    github: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
  };
}

statusRoutes.get('/api/status', async (c) => {
  const env = c.env;
  const status: Record<string, unknown> = {
    telegram: defaultStatus(),
    kv: defaultStatus(),
    r2: { ...defaultStatus(), message: 'Not implemented in v2 M2' },
    s3: { ...defaultStatus(), message: 'Not implemented in v2 M2' },
    discord: { ...defaultStatus(), message: 'Not implemented in v2 M2' },
    huggingface: { ...defaultStatus(), message: 'Not implemented in v2 M2' },
    webdav: defaultStatus('mounted'),
    github: { ...defaultStatus(), message: 'Not implemented in v2 M2' },
    auth: {
      enabled: isAuthRequired(env),
      message: isAuthRequired(env) ? 'Enabled' : 'Disabled',
    },
    guestUpload: getGuestConfig(env),
    uploadLimits: uploadLimits(),
    capabilities: [
      { type: 'telegram', label: 'Telegram', layer: 'direct' },
      { type: 'webdav', label: 'WebDAV', layer: 'mounted' },
    ],
  };

  if (getTelegramToken(env) && getTelegramChatId(env)) {
    const info = await getTelegramBotInfo(env);
    status.telegram = {
      connected: info.connected,
      enabled: true,
      configured: true,
      layer: 'direct',
      message: info.message,
      botName: info.botName,
      botUsername: info.botUsername,
      apiBase: info.apiBase,
    };
  }

  if (env.img_url) {
    try {
      const page = await env.img_url.list({ limit: 1 });
      status.kv = {
        connected: true,
        enabled: true,
        configured: true,
        layer: 'direct',
        message: 'Connected',
        hasData: Array.isArray(page.keys) && page.keys.length > 0,
      };
    } catch (error) {
      status.kv = {
        connected: false,
        enabled: false,
        configured: true,
        layer: 'direct',
        message: error instanceof Error ? error.message : 'KV check failed',
      };
    }
  }

  const webdav = await checkWebDAVConnection(env);
  status.webdav = {
    connected: webdav.connected,
    enabled: webdav.configured,
    configured: webdav.configured,
    layer: 'mounted',
    message: webdav.message,
  };

  return json(status, 200, { 'Cache-Control': 'no-store' });
});

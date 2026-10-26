import { Hono } from 'hono';
import type { Env } from '../env';
import { requireAdmin } from '../lib/auth';
import { apiError, json } from '../lib/http';

const UI_CONFIG_KEY = 'ui_config';
const EFFECT_STYLES = new Set(['none', 'math', 'particle', 'texture']);

const DEFAULT_UI_CONFIG = {
  version: 1,
  baseColor: '#fafaf8',
  globalBackgroundUrl: '',
  loginBackgroundMode: 'follow-global',
  loginBackgroundUrl: '',
  cardOpacity: 86,
  cardBlur: 14,
  effectStyle: 'math',
  effectIntensity: 22,
  optimizeMobile: true,
};

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeHexColor(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) {
    return DEFAULT_UI_CONFIG.baseColor;
  }
  if (text.length === 4) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return text.toLowerCase();
}

function sanitizeUrl(url: unknown): string {
  const text = String(url || '').trim();
  if (!text) return '';
  if (/^(https?:)?\/\//i.test(text)) return text;
  if (/^\//.test(text)) return text;
  return '';
}

function normalizeUiConfig(raw: Record<string, unknown>): typeof DEFAULT_UI_CONFIG {
  const next = { ...DEFAULT_UI_CONFIG, ...(raw || {}) };
  next.baseColor = normalizeHexColor(next.baseColor);
  next.globalBackgroundUrl = sanitizeUrl(next.globalBackgroundUrl);
  next.loginBackgroundMode = next.loginBackgroundMode === 'custom' ? 'custom' : 'follow-global';
  next.loginBackgroundUrl = sanitizeUrl(next.loginBackgroundUrl);
  next.cardOpacity = Math.round(clampNumber(next.cardOpacity, 0, 100));
  next.cardBlur = Math.round(clampNumber(next.cardBlur, 0, 32));
  next.effectStyle = EFFECT_STYLES.has(String(next.effectStyle))
    ? String(next.effectStyle)
    : DEFAULT_UI_CONFIG.effectStyle;
  next.effectIntensity = Math.round(clampNumber(next.effectIntensity, 0, 100));
  next.optimizeMobile = next.optimizeMobile !== false;
  return next;
}

function extractUiConfigPayload(body: Record<string, unknown>): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
      return body.config as Record<string, unknown>;
    }
    if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
      return body.settings as Record<string, unknown>;
    }
    return body;
  }
  return {};
}

export const uiConfigRoutes = new Hono<{ Bindings: Env }>();

uiConfigRoutes.get('/api/ui-config', async (c) => {
  const env = c.env;
  if (!env.img_url) {
    return apiError('KV_BINDING_MISSING', 'KV binding img_url is not configured.', 500);
  }

  let saved: Record<string, unknown> | null = null;
  try {
    saved = await env.img_url.get<Record<string, unknown>>(UI_CONFIG_KEY, { type: 'json' });
  } catch (error) {
    return apiError(
      'KV_READ_FAILED',
      '读取 UI 配置失败。',
      500,
      error instanceof Error ? error.message : String(error)
    );
  }

  const config = normalizeUiConfig(saved || DEFAULT_UI_CONFIG);
  return json({
    success: true,
    config,
    settings: config,
    source: saved ? 'kv' : 'default',
    binding: 'img_url',
  });
});

uiConfigRoutes.post('/api/ui-config', async (c) => {
  const env = c.env;
  if (!env.img_url) {
    return apiError('KV_BINDING_MISSING', 'KV binding img_url is not configured.', 500);
  }

  const unauthorized = await requireAdmin(c.req.raw, env);
  if (unauthorized) return unauthorized;

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const config = normalizeUiConfig(extractUiConfigPayload(body));

  try {
    await env.img_url.put(UI_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    return apiError(
      'KV_WRITE_FAILED',
      '保存 UI 配置失败。',
      500,
      error instanceof Error ? error.message : String(error)
    );
  }

  return json({
    success: true,
    config,
    settings: config,
    source: 'kv',
    binding: 'img_url',
  });
});

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('v2 worker shell', () => {
  it('serves /api/health', async () => {
    const response = await exports.default.fetch('https://example.com/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('mcloud-storage-v2');
  });

  it('serves the landing page at /', async () => {
    const response = await exports.default.fetch('https://example.com/');
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<title>MCloud');
  });

  it('serves /upload as the upload page', async () => {
    const response = await exports.default.fetch('https://example.com/upload');
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('<title>MCloud');
  });

  it('returns 501 for unimplemented API routes', async () => {
    const response = await exports.default.fetch('https://example.com/api/not-implemented');
    expect(response.status).toBe(501);
  });
});

import { describe, expect, it } from 'vitest';
import { buildFileHeaders } from '../../src/lib/http';

describe('file response headers', () => {
  it('forces dangerous markup and SVG to download', () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'text/css']) {
      const headers = buildFileHeaders('test.bin', type);
      expect(headers.get('Content-Type')).toBe('application/octet-stream');
      expect(headers.get('Content-Disposition')).toContain('attachment');
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(headers.get('Content-Security-Policy')).toBe('sandbox');
    }
  });

  it('keeps images inline', () => {
    const headers = buildFileHeaders('photo.png', 'image/png');
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.get('Content-Disposition')).toContain('inline');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

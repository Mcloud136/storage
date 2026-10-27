export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

export function apiError(
  code: string,
  message: string,
  status = 400,
  detail?: string
): Response {
  return json(
    {
      success: false,
      error: {
        code,
        message,
        ...(detail ? { detail } : {}),
      },
    },
    status
  );
}

export function fileCorsHeaders(): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition'
  );
  headers.set('CDN-Cache-Control', 'no-store');
  return headers;
}

export function fileError(message: string, status = 500): Response {
  const headers = fileCorsHeaders();
  headers.set('Content-Type', 'text/plain;charset=UTF-8');
  headers.set('Cache-Control', 'no-store, max-age=0');
  return new Response(message, { status, headers });
}

const DANGEROUS_INLINE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/css',
]);

export function buildFileHeaders(fileName: string, mimeType: string): Headers {
  const headers = fileCorsHeaders();
  const normalizedType = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const forceDownload = DANGEROUS_INLINE_TYPES.has(normalizedType);
  headers.set('Content-Type', forceDownload ? 'application/octet-stream' : mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (forceDownload) {
    headers.set('Content-Security-Policy', 'sandbox');
  }

  if (fileName) {
    const encoded = encodeURIComponent(fileName);
    const disposition = forceDownload ? 'attachment' : 'inline';
    headers.set('Content-Disposition', `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  return headers;
}

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

export function buildFileHeaders(fileName: string, mimeType: string): Headers {
  const headers = fileCorsHeaders();
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Accept-Ranges', 'bytes');

  if (fileName) {
    const encoded = encodeURIComponent(fileName);
    headers.set('Content-Disposition', `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  return headers;
}

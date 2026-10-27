/**
 * SSRF guard for remote URL imports.
 *
 * Workers cannot perform custom DNS resolution, so this only validates
 * protocol, hostname literals and ports. Redirects are re-validated per hop.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.internal',
]);

export const MAX_REDIRECTS = 5;

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPrivateIPv4(host: string): boolean {
  const value = ipv4ToInt(host);
  if (value == null) return false;
  const first = (value / 16777216) | 0;
  const second = ((value / 65536) | 0) % 256;
  if (first === 0) return true;
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first >= 224) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fe80')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (['fec', 'fed', 'fee', 'fef'].some((prefix) => value.startsWith(prefix))) return true;
  if (value.startsWith('fd00:ec2:')) return true;
  if (value.startsWith('ff')) return true;

  // IPv4-mapped/compatible forms must be treated as IPv4, otherwise
  // [::ffff:127.0.0.1] and ::7f00:1 bypass the literal checks.
  if (value.startsWith('::ffff:') || value.includes(':ffff:')) return true;

  const compatible = /^::([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/.exec(value);
  if (compatible) {
    const high = parseInt(compatible[1], 16);
    const low = parseInt(compatible[2] || '0', 16);
    const mapped = `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
    if (isPrivateIPv4(mapped)) return true;
  }

  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isPrivateIPv4(host)) return true;
  if (host.includes(':')) return isPrivateIPv6(host);
  return false;
}

export function validateRemoteUrl(
  rawUrl: string
): { ok: true; url: URL } | { ok: false; code: string; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'Invalid URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'INVALID_URL', message: 'Only http/https URLs are allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { ok: false, code: 'INVALID_URL', message: 'URL has no hostname.' };
  }
  if (isPrivateHost(hostname)) {
    return {
      ok: false,
      code: 'SSRF_BLOCKED',
      message: 'Requests to private, loopback or metadata addresses are blocked.',
    };
  }

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, code: 'INVALID_URL', message: 'Invalid port.' };
  }
  if (![80, 443, 8080, 8443].includes(port)) {
    return {
      ok: false,
      code: 'SSRF_BLOCKED',
      message: 'Only ports 80, 443, 8080 and 8443 are allowed for remote import.',
    };
  }

  return { ok: true, url: parsed };
}

export function validateRedirectLocation(
  location: string,
  previousUrl: URL
): { ok: true; url: URL } | { ok: false; code: string; message: string } {
  let next: URL;
  try {
    next = new URL(String(location || ''), previousUrl);
  } catch {
    return { ok: false, code: 'INVALID_REDIRECT', message: 'Invalid redirect location.' };
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return { ok: false, code: 'SSRF_BLOCKED', message: 'Redirects to non-http(s) protocols are blocked.' };
  }
  const check = validateRemoteUrl(next.href);
  if (!check.ok) return check;
  return { ok: true, url: next };
}

export class RemoteFetchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RemoteFetchError';
    this.code = code;
    this.status = status;
  }
}

function concatChunks(chunks: Uint8Array[], totalLength: number): ArrayBuffer {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

export async function fetchRemoteStrict(
  rawUrl: string,
  maxBytes: number,
  timeoutMs = 30000
): Promise<{ buffer: ArrayBuffer; contentType: string; finalUrl: string }> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(String(rawUrl || '').trim());
  } catch {
    throw new RemoteFetchError('INVALID_URL', 'Invalid URL.', 400);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = validateRemoteUrl(currentUrl.href);
    if (!check.ok) {
      throw new RemoteFetchError(check.code, check.message, check.code === 'SSRF_BLOCKED' ? 403 : 400);
    }

    let response: Response;
    try {
      response = await fetch(currentUrl.href, {
        redirect: 'manual',
        headers: { 'User-Agent': 'MCloud-v2-Import/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RemoteFetchError(
        'IMPORT_UPSTREAM_ERROR',
        `Remote fetch failed: ${error instanceof Error ? error.message : 'network error'}`,
        502
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (!location) {
        throw new RemoteFetchError('IMPORT_UPSTREAM_ERROR', 'Redirect response without Location header.', 502);
      }
      const redirectCheck = validateRedirectLocation(location, currentUrl);
      if (!redirectCheck.ok) {
        throw new RemoteFetchError(
          redirectCheck.code,
          redirectCheck.message,
          redirectCheck.code === 'SSRF_BLOCKED' ? 403 : 400
        );
      }
      currentUrl = redirectCheck.url;
      continue;
    }

    if (!response.ok) {
      throw new RemoteFetchError('IMPORT_UPSTREAM_ERROR', `Upstream returned HTTP ${response.status}.`, 502);
    }

    const contentLength = Number(response.headers.get('Content-Length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new RemoteFetchError('IMPORT_TOO_LARGE', `Remote file exceeds the ${maxBytes} byte limit.`, 413);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new RemoteFetchError('IMPORT_EMPTY', 'Remote response has no body.', 400);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          throw new RemoteFetchError(
            'IMPORT_TOO_LARGE',
            `Remote file exceeds the ${maxBytes} byte limit.`,
            413
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors.
      }
      if (error instanceof RemoteFetchError) throw error;
      throw new RemoteFetchError(
        'IMPORT_UPSTREAM_ERROR',
        `Download interrupted: ${error instanceof Error ? error.message : 'stream error'}`,
        502
      );
    }

    const buffer = concatChunks(chunks, received);
    if (buffer.byteLength === 0) {
      throw new RemoteFetchError('IMPORT_EMPTY', 'Remote file is empty.', 400);
    }

    return {
      buffer,
      contentType: response.headers.get('Content-Type') || '',
      finalUrl: currentUrl.href,
    };
  }

  throw new RemoteFetchError('SSRF_BLOCKED', `Too many redirects (max ${MAX_REDIRECTS}).`, 403);
}

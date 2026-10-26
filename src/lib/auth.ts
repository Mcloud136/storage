import type { Env } from '../env';
import { apiError } from './http';

const SESSION_COOKIE_NAME = 'k_vault_session';
const LEGACY_SESSION_COOKIE_NAME = 'katelya_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

interface SessionRecord {
  user?: string;
  createdAt?: number;
  expiresAt?: number;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export function isAuthRequired(env: Env): boolean {
  return Boolean(env.BASIC_USER && env.BASIC_PASS);
}

export function verifyCredentials(username: string, password: string, env: Env): boolean {
  if (!isAuthRequired(env)) return false;
  return (
    timingSafeEqualString(username, String(env.BASIC_USER)) &&
    timingSafeEqualString(password, String(env.BASIC_PASS))
  );
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const chunk of String(cookieHeader || '').split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

export function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie') || '';
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE_NAME] || cookies[LEGACY_SESSION_COOKIE_NAME] || null;
}

export async function verifySession(sessionToken: string, env: Env): Promise<boolean> {
  if (!sessionToken || !env.img_url) return false;

  const session = await env.img_url.get<SessionRecord>(`session:${sessionToken}`, { type: 'json' });
  if (!session) return false;

  if (Number(session.expiresAt || 0) <= Date.now()) {
    await env.img_url.delete(`session:${sessionToken}`);
    return false;
  }

  return true;
}

export async function checkAuthentication(
  request: Request,
  env: Env
): Promise<{ authenticated: boolean; reason: string; user?: string }> {
  if (!isAuthRequired(env)) {
    return { authenticated: false, reason: 'admin-not-configured' };
  }

  const sessionToken = getSessionToken(request);
  if (sessionToken && (await verifySession(sessionToken, env))) {
    return { authenticated: true, reason: 'session' };
  }

  const authorization = request.headers.get('Authorization') || '';
  if (authorization.startsWith('Basic ')) {
    try {
      const encoded = authorization.slice('Basic '.length).trim();
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
      );
      const separator = decoded.indexOf(':');
      if (separator !== -1 && !/[\0-\x1F\x7F]/.test(decoded)) {
        const user = decoded.slice(0, separator);
        const pass = decoded.slice(separator + 1);
        if (verifyCredentials(user, pass, env)) {
          return { authenticated: true, reason: 'basic-auth', user };
        }
      }
    } catch {
      // Invalid Basic credentials are treated as unauthenticated.
    }
  }

  return { authenticated: false, reason: 'unauthorized' };
}

export async function createSession(env: Env, user: string): Promise<{ token: string; expiresAt: number }> {
  if (!env.img_url) {
    throw new Error('KV binding img_url is not configured.');
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_DURATION_MS;

  await env.img_url.put(
    `session:${token}`,
    JSON.stringify({ user, createdAt, expiresAt }),
    { expirationTtl: Math.floor(SESSION_DURATION_MS / 1000) }
  );

  return { token, expiresAt };
}

export async function deleteSession(request: Request, env: Env): Promise<void> {
  const token = getSessionToken(request);
  if (token && env.img_url) {
    await env.img_url.delete(`session:${token}`);
  }
}

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    SESSION_DURATION_MS / 1000
  )}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookies(secure: boolean): string[] {
  const suffix = `; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  return [
    `${SESSION_COOKIE_NAME}=${suffix}`,
    `${LEGACY_SESSION_COOKIE_NAME}=${suffix}`,
  ];
}

export async function isAdminRequest(request: Request, env: Env): Promise<boolean> {
  if (!isAuthRequired(env)) return false;
  return (await checkAuthentication(request, env)).authenticated;
}

export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!isAuthRequired(env)) {
    return apiError(
      'ADMIN_AUTH_NOT_CONFIGURED',
      'Admin authentication is not configured.',
      503,
      'Set BASIC_USER and BASIC_PASS. Admin endpoints fail closed.'
    );
  }

  const result = await checkAuthentication(request, env);
  if (!result.authenticated) {
    return apiError('UNAUTHORIZED', 'Admin authentication required.', 401);
  }

  return null;
}

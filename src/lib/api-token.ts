import type { Env } from '../env';
import { randomHex, randomString, sha256Hex, timingSafeEqualString } from './crypto';

const TOKEN_PREFIX = 'kvault_';
const TOKEN_KEY_PREFIX = 'api_token:';
const STAT_KEY_PREFIX = 'token_stat:';
const VALID_SCOPES = new Set(['upload', 'read', 'delete', 'paste']);
const STORAGES = new Set(['telegram', 'webdav', 'huggingface', 'github']);
const STAT_DEBOUNCE_MS = 60 * 1000;

export interface TokenPolicies {
  allowedStorages?: string[];
  allowedMimeTypes?: string[];
  maxFileSize?: number;
  folderPrefix?: string;
  rateLimit?: { windowMs: number; max: number };
  allowedSourceHosts?: string[];
}

export interface ApiTokenRecord {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: number | null;
  createdAt: number;
  enabled: boolean;
  policies: TokenPolicies | null;
  rotatedAt: number | null;
  tokenSalt: string;
  tokenHash: string;
  tokenSuffix: string;
  tokenPreview: string;
}

export interface PublicApiToken {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: number | null;
  createdAt: number;
  enabled: boolean;
  policies: TokenPolicies | null;
  lastUsedAt: number | null;
  tokenPreview: string;
}

export interface TokenUsageStat {
  lastUsedAt?: number;
  usageCount?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastOperation?: string;
  lastClient?: string;
  lastTouchAt?: number;
}

export class TokenError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
    this.status = status;
  }
}

function tokenKey(id: string): string {
  return `${TOKEN_KEY_PREFIX}${id}`;
}

function statKey(id: string): string {
  return `${STAT_KEY_PREFIX}${id}`;
}

function normalizeScopes(scopes: unknown): string[] {
  const values = Array.isArray(scopes) ? scopes : [];
  const normalized = values.map((scope) => String(scope).trim().toLowerCase());
  const invalid = normalized.filter((scope) => !VALID_SCOPES.has(scope));
  if (invalid.length) {
    throw new TokenError('INVALID_SCOPE', `Invalid scopes: ${invalid.join(', ')}`);
  }
  return [...new Set(normalized)];
}

function normalizePolicies(raw: unknown): TokenPolicies | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const policies: TokenPolicies = {};

  if (Array.isArray(source.allowedStorages)) {
    const storages = source.allowedStorages
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => STORAGES.has(item));
    if (storages.length) policies.allowedStorages = [...new Set(storages)];
  }
  if (Array.isArray(source.allowedMimeTypes)) {
    const mimes = source.allowedMimeTypes.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
    if (mimes.length) policies.allowedMimeTypes = [...new Set(mimes)];
  }
  if (source.maxFileSize != null) {
    const maximum = Number(source.maxFileSize);
    if (!Number.isFinite(maximum) || maximum <= 0) {
      throw new TokenError('INVALID_POLICY', 'maxFileSize must be a positive number.');
    }
    policies.maxFileSize = Math.floor(maximum);
  }
  if (source.folderPrefix != null) {
    const prefix = String(source.folderPrefix || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (prefix) policies.folderPrefix = prefix;
  }
  if (source.rateLimit && typeof source.rateLimit === 'object') {
    const rate = source.rateLimit as Record<string, unknown>;
    const windowMs = Number(rate.windowMs);
    const max = Number(rate.max);
    if (Number.isFinite(windowMs) && windowMs > 0 && Number.isFinite(max) && max > 0) {
      policies.rateLimit = { windowMs: Math.floor(windowMs), max: Math.floor(max) };
    }
  }
  if (Array.isArray(source.allowedSourceHosts)) {
    const hosts = source.allowedSourceHosts
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);
    if (hosts.length) policies.allowedSourceHosts = [...new Set(hosts)];
  }

  return Object.keys(policies).length ? policies : null;
}

export function parseTokenExpiry(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new TokenError('INVALID_EXPIRY', 'expiresAt must be a positive epoch-milliseconds value.');
    }
    return Math.floor(raw);
  }
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (numeric > 0) return Math.floor(numeric);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TokenError('INVALID_EXPIRY', `expiresAt "${text}" is not a valid timestamp.`);
  }
  return parsed;
}

async function hashSecret(secret: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${secret}`);
}

async function generateUniqueId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = randomString(12);
    const existing = await env.img_url.get(tokenKey(id));
    if (existing == null) return id;
  }
  throw new TokenError('TOKEN_ID_COLLISION', 'Failed to allocate a token id.', 500);
}

async function readRecord(env: Env, id: string): Promise<ApiTokenRecord | null> {
  return env.img_url.get<ApiTokenRecord>(tokenKey(id), { type: 'json' });
}

async function readStat(env: Env, id: string): Promise<TokenUsageStat | null> {
  return env.img_url.get<TokenUsageStat>(statKey(id), { type: 'json' });
}

function toPublic(record: ApiTokenRecord, stat: TokenUsageStat | null): PublicApiToken {
  return {
    id: record.id,
    name: record.name,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    enabled: record.enabled,
    policies: record.policies,
    lastUsedAt: stat?.lastUsedAt ?? null,
    tokenPreview: record.tokenPreview,
  };
}

function tokenString(id: string, secret: string): string {
  return `${TOKEN_PREFIX}${id}_${secret}`;
}

export async function createApiToken(
  env: Env,
  { name, scopes, expiresAt, policies }: {
    name: string;
    scopes: unknown;
    expiresAt?: unknown;
    policies?: unknown;
  }
): Promise<{ token: string; record: PublicApiToken }> {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new TokenError('VALIDATION_ERROR', 'Token name is required.');

  const normalizedScopes = normalizeScopes(scopes);
  if (!normalizedScopes.length) {
    throw new TokenError('VALIDATION_ERROR', 'At least one scope is required.');
  }

  const id = await generateUniqueId(env);
  const secret = randomString(40);
  const salt = randomHex(8);
  const hash = await hashSecret(secret, salt);
  const suffix = secret.slice(-6);
  const now = Date.now();

  const record: ApiTokenRecord = {
    id,
    name: normalizedName,
    scopes: normalizedScopes,
    expiresAt: parseTokenExpiry(expiresAt),
    createdAt: now,
    enabled: true,
    policies: normalizePolicies(policies),
    rotatedAt: null,
    tokenSalt: salt,
    tokenHash: hash,
    tokenSuffix: suffix,
    tokenPreview: `******${suffix}`,
  };

  await env.img_url.put(tokenKey(id), JSON.stringify(record));
  return { token: tokenString(id, secret), record: toPublic(record, null) };
}

export async function listApiTokens(env: Env): Promise<PublicApiToken[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.img_url.list({ prefix: TOKEN_KEY_PREFIX, limit: 1000, cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const tokens = await Promise.all(
    keys.map(async (key) => {
      const id = key.slice(TOKEN_KEY_PREFIX.length);
      const record = await readRecord(env, id);
      if (!record) return null;
      return toPublic(record, await readStat(env, id));
    })
  );

  return tokens
    .filter((token): token is PublicApiToken => Boolean(token))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateApiToken(
  env: Env,
  id: string,
  patch: { enabled?: unknown; name?: unknown; policies?: unknown }
): Promise<PublicApiToken> {
  const record = await readRecord(env, id);
  if (!record) throw new TokenError('TOKEN_NOT_FOUND', 'Token not found.', 404);

  if (patch.enabled != null) record.enabled = Boolean(patch.enabled);
  if (patch.name != null) {
    const name = String(patch.name).trim();
    if (name) record.name = name;
  }
  if (patch.policies !== undefined) record.policies = normalizePolicies(patch.policies);

  await env.img_url.put(tokenKey(id), JSON.stringify(record));
  return toPublic(record, await readStat(env, id));
}

export async function deleteApiToken(env: Env, id: string): Promise<void> {
  await env.img_url.delete(tokenKey(id));
  await env.img_url.delete(statKey(id));
}

export async function rotateApiToken(
  env: Env,
  id: string
): Promise<{ token: string; record: PublicApiToken }> {
  const record = await readRecord(env, id);
  if (!record) throw new TokenError('TOKEN_NOT_FOUND', 'Token not found.', 404);

  const secret = randomString(40);
  const salt = randomHex(8);
  record.tokenSalt = salt;
  record.tokenHash = await hashSecret(secret, salt);
  record.tokenSuffix = secret.slice(-6);
  record.tokenPreview = `******${record.tokenSuffix}`;
  record.rotatedAt = Date.now();

  await env.img_url.put(tokenKey(id), JSON.stringify(record));
  return { token: tokenString(id, secret), record: toPublic(record, await readStat(env, id)) };
}

export function parseBearerToken(request: Request): string {
  const authorization = String(request.headers.get('Authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? String(match[1] || '').trim() : '';
}

function splitToken(raw: string): { id: string; secret: string } | null {
  const match = /^kvault_([A-Za-z0-9]{6,128})_([A-Za-z0-9]{16,256})$/.exec(String(raw || '').trim());
  if (!match) return null;
  return { id: match[1], secret: match[2] };
}

export type TokenVerification =
  | { ok: true; record: ApiTokenRecord }
  | { ok: false; code: string; message: string; status: number };

export async function verifyApiToken(
  env: Env,
  rawToken: string,
  requiredScope = ''
): Promise<TokenVerification> {
  const split = splitToken(rawToken);
  if (!split) {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid API token.', status: 401 };
  }

  const record = await readRecord(env, split.id);
  if (!record) {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid API token.', status: 401 };
  }
  if (!record.enabled) {
    return { ok: false, code: 'TOKEN_DISABLED', message: 'API token is disabled.', status: 401 };
  }
  if (record.expiresAt && Date.now() > record.expiresAt) {
    return { ok: false, code: 'TOKEN_EXPIRED', message: 'API token has expired.', status: 401 };
  }

  const expected = await hashSecret(split.secret, record.tokenSalt);
  if (!timingSafeEqualString(expected, record.tokenHash)) {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid API token.', status: 401 };
  }

  if (requiredScope && requiredScope !== '@me' && !record.scopes.includes(requiredScope)) {
    return {
      ok: false,
      code: 'SCOPE_REQUIRED',
      message: `API token requires the "${requiredScope}" scope.`,
      status: 403,
    };
  }

  const now = Date.now();
  const stat = (await readStat(env, split.id)) || {};
  const debounce = env.MINIMIZE_KV_WRITES === 'true' ? 60 * 60 * 1000 : STAT_DEBOUNCE_MS;
  if (now - Number(stat.lastTouchAt || 0) >= debounce) {
    await env.img_url.put(
      statKey(split.id),
      JSON.stringify({
        ...stat,
        lastUsedAt: now,
        lastSuccessAt: now,
        lastTouchAt: now,
        usageCount: Number(stat.usageCount || 0) + 1,
      })
    );
  }

  return { ok: true, record };
}

export interface PolicyCheck {
  ok: boolean;
  code?: string;
  message?: string;
  status?: number;
}

export function checkTokenUploadPolicy(
  record: ApiTokenRecord,
  input: { storage: string; mime?: string; sizeBytes: number; folderPath?: string }
): PolicyCheck {
  const policies = record.policies;
  if (!policies) return { ok: true };

  if (policies.allowedStorages?.length && !policies.allowedStorages.includes(input.storage)) {
    return {
      ok: false,
      code: 'POLICY_STORAGE_DENIED',
      message: `Token only allows storage: ${policies.allowedStorages.join(', ')}.`,
      status: 403,
    };
  }
  if (policies.allowedMimeTypes?.length) {
    const mime = String(input.mime || '').split(';')[0].trim().toLowerCase();
    if (!mime || !policies.allowedMimeTypes.includes(mime)) {
      return {
        ok: false,
        code: 'POLICY_MIME_DENIED',
        message: 'Token policy denies this MIME type.',
        status: 403,
      };
    }
  }
  if (policies.maxFileSize && input.sizeBytes > policies.maxFileSize) {
    return {
      ok: false,
      code: 'POLICY_SIZE_EXCEEDED',
      message: `Token policy limits uploads to ${policies.maxFileSize} bytes.`,
      status: 413,
    };
  }
  if (policies.folderPrefix) {
    const folder = String(input.folderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!folder.startsWith(policies.folderPrefix)) {
      return {
        ok: false,
        code: 'POLICY_FOLDER_DENIED',
        message: `Token policy restricts uploads to "${policies.folderPrefix}/".`,
        status: 403,
      };
    }
  }
  return { ok: true };
}

export async function getIdempotentResponse(
  env: Env,
  tokenId: string,
  key: string
): Promise<{ status: number; body: unknown } | null> {
  if (!key) return null;
  const id = await sha256Hex(key);
  return env.img_url.get<{ status: number; body: unknown }>(
    `idem:${tokenId}:${id}`,
    { type: 'json' }
  );
}

export async function saveIdempotentResponse(
  env: Env,
  tokenId: string,
  key: string,
  status: number,
  body: unknown
): Promise<void> {
  if (!key) return;
  const id = await sha256Hex(key);
  await env.img_url.put(
    `idem:${tokenId}:${id}`,
    JSON.stringify({ status, body, createdAt: Date.now() }),
    { expirationTtl: 24 * 3600 }
  );
}

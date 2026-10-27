import type { Env } from '../env';
import { hashPassword, randomString, verifyPassword } from './crypto';

const PASTE_PREFIX = 'paste:';

export interface PasteRecord {
  id: string;
  content: string;
  language: string;
  size: number;
  createdAt: number;
  expiresAt: number | null;
  passwordSalt?: string | null;
  passwordHash?: string | null;
}

function pasteKey(id: string): string {
  return `${PASTE_PREFIX}${id}`;
}

export async function createPaste(
  env: Env,
  { content, language, expiresAt, password }: {
    content: string;
    language?: string;
    expiresAt?: number | null;
    password?: string;
  }
): Promise<{ id: string; record: PasteRecord }> {
  const text = String(content ?? '');
  if (!text.trim()) {
    throw new Error('Paste content is required.');
  }

  const id = randomString(12);
  const salt = password ? randomString(12) : null;
  const record: PasteRecord = {
    id,
    content: text,
    language: String(language || 'text').trim() || 'text',
    size: new TextEncoder().encode(text).byteLength,
    createdAt: Date.now(),
    expiresAt: expiresAt && Number.isFinite(expiresAt) ? Math.floor(expiresAt) : null,
    passwordSalt: salt,
    passwordHash: password ? await hashPassword(password) : null,
  };

  await env.img_url.put(pasteKey(id), JSON.stringify(record), {
    ...(record.expiresAt ? { expirationTtl: Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000)) } : {}),
  });

  return { id, record };
}

export async function getPaste(
  env: Env,
  id: string,
  password = ''
): Promise<{ record: PasteRecord | null; status?: number; error?: string }> {
  const record = await env.img_url.get<PasteRecord>(pasteKey(id), { type: 'json' });
  if (!record) return { record: null, status: 404, error: 'Paste not found.' };

  if (record.expiresAt && Date.now() > record.expiresAt) {
    await env.img_url.delete(pasteKey(id));
    return { record: null, status: 410, error: 'Paste has expired.' };
  }

  if (record.passwordHash) {
    if (!password) return { record: null, status: 401, error: 'Paste password required.' };
    const valid = await verifyPassword(
      password,
      record.passwordHash,
      record.passwordSalt || ''
    );
    if (!valid) {
      return { record: null, status: 403, error: 'Paste password invalid.' };
    }
  }

  return { record };
}

export async function deletePaste(env: Env, id: string): Promise<void> {
  await env.img_url.delete(pasteKey(id));
}

export async function listPastes(env: Env): Promise<PasteRecord[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.img_url.list({ prefix: PASTE_PREFIX, limit: 1000, cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const records = await Promise.all(
    keys.map((key) => env.img_url.get<PasteRecord>(key, { type: 'json' }))
  );

  return records
    .filter((record): record is PasteRecord => Boolean(record))
    .filter((record) => !record.expiresAt || record.expiresAt > Date.now())
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function pastePublic(record: PasteRecord): Omit<PasteRecord, 'passwordHash' | 'passwordSalt'> {
  return {
    id: record.id,
    content: record.content,
    language: record.language,
    size: record.size,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

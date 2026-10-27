import type { FileMetadata } from '../core/keys';
import { inferStorageType } from '../core/keys';
import { getRecordWithKey } from '../core/kv';

export interface StoredFile {
  kvKey: string;
  metadata: FileMetadata;
  storageType: string;
}

const SYSTEM_PREFIXES = [
  'session:',
  'upload:',
  'chunk:',
  'api_token:',
  'token_stat:',
  'token_rl:',
  'share_slug:',
  'sha_dup:',
  'idem:',
  'paste:',
  'audit:',
  'guest:',
  'folder:',
  'webhook:',
];

export function isSystemKey(key: string): boolean {
  return key === 'ui_config' || SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function normalizeFolderPath(value: string | undefined): string {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      segments.pop();
      continue;
    }
    segments.push(piece);
  }
  return segments.join('/');
}

export async function listAllFileRecords(kv: KVNamespace): Promise<StoredFile[]> {
  const records: StoredFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list<FileMetadata>({ limit: 1000, cursor });
    for (const key of page.keys) {
      if (isSystemKey(key.name)) continue;
      if (!key.metadata) continue;
      records.push({
        kvKey: key.name,
        metadata: key.metadata,
        storageType: inferStorageType(key.name, key.metadata),
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return records;
}

export async function listFolderMarkers(kv: KVNamespace): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'folder:', limit: 1000, cursor });
    keys.push(...page.keys.map((key) => key.name.slice('folder:'.length)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys.filter(Boolean);
}

export async function updateMetadata(
  kv: KVNamespace,
  kvKey: string,
  metadata: FileMetadata
): Promise<void> {
  await kv.put(kvKey, '', { metadata });
}

export async function findStoredFile(
  env: { img_url: KVNamespace },
  id: string
): Promise<{ kvKey: string; metadata: FileMetadata; storageType: string } | null> {
  const resolved = await getRecordWithKey(env.img_url, id);
  if (resolved.record?.metadata) {
    return {
      kvKey: resolved.kvKey,
      metadata: resolved.record.metadata,
      storageType: inferStorageType(resolved.kvKey, resolved.record.metadata),
    };
  }

  const files = await listAllFileRecords(env.img_url);
  return (
    files.find((file) => file.metadata.fileName === id) ||
    files.find((file) => file.kvKey.endsWith(id)) ||
    null
  );
}

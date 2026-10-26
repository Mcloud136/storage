#!/usr/bin/env node
/**
 * Read-only KV inventory for the v2 migration.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=... \
 *   KV_NAMESPACE_ID=... \
 *   node scripts/v2-inventory-kv.mjs
 *
 * Prints counts only; file names and ids are never printed.
 */

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const namespaceId = process.env.KV_NAMESPACE_ID;

if (!token || !accountId || !namespaceId) {
  console.error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and KV_NAMESPACE_ID are required.');
  process.exit(1);
}

const KNOWN_PREFIXES = [
  'img:',
  'vid:',
  'aud:',
  'doc:',
  'r2:',
  's3:',
  'discord:',
  'hf:',
  'webdav:',
  'github:',
];

const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`;

function prefixOf(key) {
  return KNOWN_PREFIXES.find((prefix) => key.startsWith(prefix)) ?? '(bare)';
}

async function listAll() {
  const keys = [];
  let cursor = '';

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      throw new Error(`KV list failed: ${response.status} ${JSON.stringify(payload.errors ?? [])}`);
    }

    keys.push(...(payload.result ?? []));
    const nextCursor = payload.result_info?.cursor ?? '';
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return keys;
}

const keys = await listAll();
const byStorageType = {};
const byPrefix = {};
let withMetadata = 0;

for (const key of keys) {
  const metadata = key.metadata ?? null;
  if (metadata) withMetadata += 1;

  const storageType = metadata?.storageType || metadata?.storage || 'unknown';
  byStorageType[storageType] = (byStorageType[storageType] ?? 0) + 1;

  const prefix = prefixOf(key.name);
  byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1;
}

console.log(JSON.stringify({
  namespace: namespaceId,
  totalKeys: keys.length,
  withMetadata,
  byStorageType,
  byPrefix,
}, null, 2));
